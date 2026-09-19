import { createHash, randomUUID } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Redis } from "ioredis";
import { RedisService } from "@/redis/redis.service.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { TraceBusinessService } from "@/common/tracing/trace-method.decorator.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import {
  AUTH_ERROR_CODES,
  OAUTH_STATE_TTL_SECONDS,
} from "@/modules/auth/constants/auth.constants.js";
import type { OAuthStateRecord, SessionRecord } from "@/modules/auth/types/auth.types.js";
import type { MembershipRoleName } from "@/modules/auth/constants/auth.constants.js";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  assertPipelineSucceeded,
  oauthStateKey,
  sessionBlockKey,
  sessionKey,
  userSessionsKey,
} from "@/modules/auth/utils/auth.utils.js";
import {
  ROTATE_SCRIPT,
  CONSUME_OAUTH_STATE_SCRIPT,
  CREATE_SESSION_SCRIPT,
  SWITCH_ORGANIZATION_SCRIPT,
} from "@/modules/auth/constants/redis.constant.js";
import { secondsFromNow } from "@/common/utils/date.js";

export type CreatedSession = {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
};

@Injectable()
@TraceBusinessService([
  "createSession",
  "getSession",
  "refresh",
  "setActiveOrganization",
  "revokeSession",
  "revokeAllUserSessions",
  "blockSessionCreation",
  "unblockSessionCreation",
  "isSessionCreationBlocked",
  "saveOAuthState",
  "consumeOAuthState",
])
export class SessionService {
  private readonly redis: Redis;

  constructor(
    redisService: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    readonly executionTrace: ExecutionTraceService,
  ) {
    this.redis = redisService.getClient();
  }

  private get refreshTtlSeconds(): number {
    return this.config.getOrThrow<number>("app.authRefreshTtlSeconds");
  }

  accessTokenFor(record: SessionRecord): string {
    return this.jwt.sign({
      sub: record.userId,
      sid: record.sessionId,
      org: record.activeOrganizationId,
      mid: record.activeMembershipId,
      role: record.role,
    });
  }

  async createSession(options: {
    userId: string;
    userAgent?: string;
    activeOrganizationId?: string | null;
    activeMembershipId?: string | null;
    role?: MembershipRoleName | null;
  }): Promise<CreatedSession> {
    const sessionId = randomUUID();
    const secret = generateOpaqueToken();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId,
      userId: options.userId,
      activeOrganizationId: options.activeOrganizationId ?? null,
      activeMembershipId: options.activeMembershipId ?? null,
      role: options.role ?? null,
      refreshTokenHash: hashOpaqueToken(secret),
      createdAt: now,
      lastRefreshedAt: now,
      absoluteExpiresAt: secondsFromNow(this.refreshTtlSeconds).toISOString(),
      userAgentHash: options.userAgent
        ? createHash("sha256").update(options.userAgent).digest("hex")
        : null,
    };

    // Atomic block-check + session registration (single Lua script): either
    // the block wins (BLOCKED, nothing written) or the session wins (OK).
    const created = (await this.redis.eval(
      CREATE_SESSION_SCRIPT,
      3,
      sessionKey(sessionId),
      userSessionsKey(options.userId),
      sessionBlockKey(options.userId),
      JSON.stringify(record),
      sessionId,
      String(this.refreshTtlSeconds),
    )) as string;

    if (created === "BLOCKED") {
      throw new AuthException(
        AUTH_ERROR_CODES.SESSION_REVOKED,
        "Session creation is temporarily blocked for this user.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    return {
      sessionId,
      accessToken: this.accessTokenFor(record),
      refreshToken: `${sessionId}.${secret}`,
    };
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(sessionKey(sessionId));

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as SessionRecord;
    } catch {
      return null;
    }
  }

  async refresh(
    sessionId: string,
    secret: string,
  ): Promise<{ record: SessionRecord; accessToken: string; refreshToken: string }> {
    const key = sessionKey(sessionId);
    const expectedHash = hashOpaqueToken(secret);
    const nextSecret = generateOpaqueToken();
    const now = new Date().toISOString();

    const rotated = (await this.redis.eval(
      ROTATE_SCRIPT,
      1,
      key,
      expectedHash,
      hashOpaqueToken(nextSecret),
      now,
    )) as number;

    if (rotated === 1) {
      const record = await this.getSession(sessionId);

      if (!record) {
        throw new AuthException(
          AUTH_ERROR_CODES.REFRESH_TOKEN_INVALID,
          "Refresh session is no longer valid.",
          HttpStatus.UNAUTHORIZED,
        );
      }

      return {
        record,
        accessToken: this.accessTokenFor(record),
        refreshToken: `${sessionId}.${nextSecret}`,
      };
    }

    if (rotated === -1) {
      // Possible refresh-token replay: revoke the whole session immediately.
      await this.revokeSession(sessionId);
      throw new AuthException(
        AUTH_ERROR_CODES.REFRESH_TOKEN_REUSED,
        "Refresh token was already used. The session has been revoked.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    throw new AuthException(
      AUTH_ERROR_CODES.REFRESH_TOKEN_INVALID,
      "Refresh session is no longer valid.",
      HttpStatus.UNAUTHORIZED,
    );
  }

  async setActiveOrganization(
    sessionId: string,
    active: {
      organizationId: string | null;
      membershipId: string | null;
      role: MembershipRoleName | null;
    },
  ): Promise<SessionRecord | null> {
    const updated = await this.redis.eval(
      SWITCH_ORGANIZATION_SCRIPT,
      1,
      sessionKey(sessionId),
      active.organizationId ?? "__PAYLENS_NULL__",
      active.membershipId ?? "__PAYLENS_NULL__",
      active.role ?? "__PAYLENS_NULL__",
    );

    if (typeof updated !== "string") return null;

    try {
      return JSON.parse(updated) as SessionRecord;
    } catch {
      return null;
    }
  }

  async revokeSession(sessionId: string): Promise<void> {
    const record = await this.getSession(sessionId);

    if (record) {
      await this.redis.srem(userSessionsKey(record.userId), sessionId);
    }

    await this.redis.del(sessionKey(sessionId));
  }

  async revokeAllUserSessions(userId: string): Promise<void> {
    const members = await this.redis.smembers(userSessionsKey(userId));

    if (members.length > 0) {
      await this.redis.del(...members.map((sessionId) => sessionKey(sessionId)));
    }

    await this.redis.del(userSessionsKey(userId));
  }

  /**
   * Temporarily prevents session creation for the given users (SEED-R1
   * rollback window). Pipelined SETs; blocks carry no TTL and are cleared
   * explicitly after a successful reseed. Fail closed: never auto-expire.
   */
  async blockSessionCreation(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;

    const pipeline = this.redis.pipeline();

    for (const userId of userIds) {
      pipeline.set(sessionBlockKey(userId), "1");
    }

    // Fail closed: a partially-failed block must surface, never silently pass.
    assertPipelineSucceeded(await pipeline.exec(), "[auth] session block");
  }

  async unblockSessionCreation(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;

    const pipeline = this.redis.pipeline();

    for (const userId of userIds) {
      pipeline.del(sessionBlockKey(userId));
    }

    assertPipelineSucceeded(await pipeline.exec(), "[auth] session unblock");
  }

  async isSessionCreationBlocked(userId: string): Promise<boolean> {
    return (await this.redis.exists(sessionBlockKey(userId))) === 1;
  }

  async saveOAuthState(state: string, record: OAuthStateRecord): Promise<void> {
    await this.redis.set(
      oauthStateKey(state),
      JSON.stringify(record),
      "EX",
      OAUTH_STATE_TTL_SECONDS,
    );
  }

  async consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
    const key = oauthStateKey(state);
    const raw = (await this.redis.eval(CONSUME_OAUTH_STATE_SCRIPT, 1, key)) as string | null;

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as OAuthStateRecord;
    } catch {
      return null;
    }
  }
}
