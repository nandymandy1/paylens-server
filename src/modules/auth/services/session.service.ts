import { createHash, randomUUID } from "node:crypto";
import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Redis } from "ioredis";
import { RedisService } from "@/redis/redis.service.js";
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
  oauthStateKey,
  sessionKey,
  userSessionsKey,
} from "@/modules/auth/utils/auth.utils.js";
import {
  ROTATE_SCRIPT,
  CONSUME_OAUTH_STATE_SCRIPT,
  SWITCH_ORGANIZATION_SCRIPT,
} from "@/modules/auth/constants/redis.constant.js";

export type CreatedSession = {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class SessionService {
  private readonly redis: Redis;

  constructor(
    redisService: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
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
      absoluteExpiresAt: new Date(Date.now() + this.refreshTtlSeconds * 1000).toISOString(),
      userAgentHash: options.userAgent
        ? createHash("sha256").update(options.userAgent).digest("hex")
        : null,
    };

    await this.redis.set(
      sessionKey(sessionId),
      JSON.stringify(record),
      "EX",
      this.refreshTtlSeconds,
    );
    await this.redis.sadd(userSessionsKey(options.userId), sessionId);
    await this.redis.expire(userSessionsKey(options.userId), this.refreshTtlSeconds);

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
