import { createHash } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONSUME_OAUTH_STATE_SCRIPT,
  ROTATE_SCRIPT,
  SWITCH_ORGANIZATION_SCRIPT,
} from "@/modules/auth/constants/redis.constant.js";
import { hashOpaqueToken } from "@/modules/auth/utils/auth.utils.js";
import { SessionService } from "@/modules/auth/services/session.service.js";

/** Minimal in-memory ioredis stand-in that faithfully executes the rotation script contract. */
class FakeRedis {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...mode: unknown[]): Promise<string> {
    void mode;
    this.store.set(key, value);

    const exIndex = mode.indexOf("EX");

    if (exIndex >= 0) {
      this.ttls.set(key, Number(mode[exIndex + 1]));
    }

    return "OK";
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.ttls.set(key, seconds);

    return 1;
  }

  async pttl(key: string): Promise<number> {
    if (!this.store.has(key)) {
      return -2;
    }

    return (this.ttls.get(key) ?? 100) * 1000;
  }

  async sadd(key: string, member: string): Promise<number> {
    if (!this.sets.has(key)) {
      this.sets.set(key, new Set());
    }

    const set = this.sets.get(key) as Set<string>;
    const size = set.size;

    set.add(member);

    return set.size - size;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async srem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;

    for (const key of keys) {
      if (this.store.delete(key)) {
        removed += 1;
      }

      this.ttls.delete(key);

      if (this.sets.delete(key)) {
        removed += 1;
      }
    }

    return removed;
  }

  async ttl(cacheKey: string): Promise<number> {
    return this.ttls.get(cacheKey) ?? 100;
  }

  async eval(
    script: string,
    keyCount: number,
    key: string,
    ...args: unknown[]
  ): Promise<number | string | null> {
    void keyCount;

    if (script === CONSUME_OAUTH_STATE_SCRIPT) {
      const raw = this.store.get(key) ?? null;

      if (raw) {
        this.store.delete(key);
        this.ttls.delete(key);
      }

      return raw;
    }

    if (script === ROTATE_SCRIPT) {
      const [expectedHash, nextHash, now] = args as [string, string, string];
      const raw = this.store.get(key);

      if (!raw) {
        return 0;
      }

      const ttlMs = await this.pttl(key);

      if (ttlMs <= 0) {
        return 0;
      }

      const record = JSON.parse(raw) as {
        refreshTokenHash: string;
        [key: string]: unknown;
      };

      if (record.refreshTokenHash !== expectedHash) {
        return -1;
      }

      this.store.set(
        key,
        JSON.stringify({
          ...record,
          refreshTokenHash: nextHash,
          lastRefreshedAt: now,
        }),
      );

      return 1;
    }

    if (script === SWITCH_ORGANIZATION_SCRIPT) {
      const [organizationId, membershipId, role] = args as [string, string, string];
      const raw = this.store.get(key);

      if (!raw) {
        return null;
      }

      const ttlMs = await this.pttl(key);

      if (ttlMs <= 0) {
        return null;
      }

      const record = JSON.parse(raw) as Record<string, unknown>;
      const decodeNullable = (input: string): string | null =>
        input === "__PAYLENS_NULL__" ? null : input;
      const encoded = JSON.stringify({
        ...record,
        activeOrganizationId: decodeNullable(organizationId),
        activeMembershipId: decodeNullable(membershipId),
        role: decodeNullable(role),
      });

      this.store.set(key, encoded);

      return encoded;
    }

    throw new Error("FakeRedis received an unsupported Lua script");
  }
}

const createService = (redis?: FakeRedis) => {
  const jwt = new JwtService({ secret: "test-secret-with-at-least-32-characters!!" });
  const config = {
    getOrThrow: (key: string) => {
      if (key === "app.authRefreshTtlSeconds") {
        return 1_209_600;
      }

      if (key === "app.authAccessTtlSeconds") {
        return 900;
      }

      throw new Error(`unexpected config key ${key}`);
    },
  } as never;

  return new SessionService({ getClient: () => redis ?? new FakeRedis() } as never, jwt, config);
};

describe("SessionService", () => {
  let redis: FakeRedis;
  let service: SessionService;

  beforeEach(() => {
    redis = new FakeRedis();
    service = createService(redis);
  });

  it("creates a session with hashed refresh secret and minimal JWT payload", async () => {
    const created = await service.createSession({ userId: "user-1" });
    const [sessionId, secret] = created.refreshToken.split(".");

    expect(sessionId).toBe(created.sessionId);

    const stored = JSON.parse(redis.store.get(`auth:session:${sessionId}`) as string);

    expect(stored.refreshTokenHash).toBe(hashOpaqueToken(secret));
    expect(stored.refreshTokenHash).not.toContain(secret);
    expect(await redis.smembers("auth:user-sessions:user-1")).toEqual([sessionId]);
    expect(created.accessToken.split(".")).toHaveLength(3);
  });

  it("rotates the refresh token atomically on success", async () => {
    const created = await service.createSession({ userId: "user-1" });
    const [sessionId, secret] = created.refreshToken.split(".");
    const rotated = await service.refresh(sessionId, secret);

    expect(rotated.refreshToken).not.toBe(created.refreshToken);

    const stored = JSON.parse(redis.store.get(`auth:session:${sessionId}`) as string);

    expect(stored.refreshTokenHash).toBe(hashOpaqueToken(rotated.refreshToken.split(".")[1]));
  });

  it("revokes the session on refresh reuse and rejects the replay", async () => {
    const created = await service.createSession({ userId: "user-1" });
    const [sessionId, secret] = created.refreshToken.split(".");

    await service.refresh(sessionId, secret);
    await expect(service.refresh(sessionId, secret)).rejects.toMatchObject({
      code: "REFRESH_TOKEN_REUSED",
    });
    await expect(service.getSession(sessionId)).resolves.toBeNull();
  });

  it("rejects refresh for unknown sessions", async () => {
    await expect(service.refresh("missing", "secret")).rejects.toMatchObject({
      code: "REFRESH_TOKEN_INVALID",
    });
  });

  it("revokes one session and all user sessions independently", async () => {
    const first = await service.createSession({ userId: "user-1" });
    const second = await service.createSession({ userId: "user-1" });

    await service.revokeSession(first.sessionId);
    await expect(service.getSession(first.sessionId)).resolves.toBeNull();
    await expect(service.getSession(second.sessionId)).resolves.not.toBeNull();

    await service.revokeAllUserSessions("user-1");
    await expect(service.getSession(second.sessionId)).resolves.toBeNull();
    await expect(redis.smembers("auth:user-sessions:user-1")).resolves.toEqual([]);
  });

  it("cannot resurrect a logged-out session with its pre-logout refresh credential", async () => {
    const created = await service.createSession({ userId: "user-1" });
    const [sessionId, secret] = created.refreshToken.split(".");

    // login → logout: the server revokes the Redis session.
    await service.revokeSession(sessionId);
    await expect(service.getSession(sessionId)).resolves.toBeNull();

    // Attempting refresh with the pre-logout credential issues no session,
    // no access token, and no replacement refresh token.
    await expect(service.refresh(sessionId, secret)).rejects.toMatchObject({
      code: "REFRESH_TOKEN_INVALID",
    });
    await expect(service.getSession(sessionId)).resolves.toBeNull();
    await expect(redis.smembers("auth:user-sessions:user-1")).resolves.toEqual([]);
  });

  it("stores only a hash of the user agent", async () => {
    const created = await service.createSession({ userId: "user-1", userAgent: "TestAgent/1.0" });
    const stored = JSON.parse(redis.store.get(`auth:session:${created.sessionId}`) as string);

    expect(stored.userAgentHash).toBe(createHash("sha256").update("TestAgent/1.0").digest("hex"));
  });

  it("expires the user-sessions index with the session lifetime", async () => {
    const created = await service.createSession({ userId: "user-1" });

    expect(redis.ttls.get("auth:user-sessions:user-1")).toBe(1_209_600);
    expect(redis.ttls.get(`auth:session:${created.sessionId}`)).toBe(1_209_600);
  });

  it("refreshes without extending the absolute session lifetime", async () => {
    const created = await service.createSession({ userId: "user-1" });
    const [sessionId, secret] = created.refreshToken.split(".");

    redis.ttls.set(`auth:session:${sessionId}`, 60);

    const rotated = await service.refresh(sessionId, secret);

    expect(rotated.refreshToken).not.toBe(created.refreshToken);
    expect(redis.ttls.get(`auth:session:${sessionId}`)).toBe(60);
  });

  it("switches organization without replacing the current refresh hash or extending TTL", async () => {
    const created = await service.createSession({
      userId: "user-1",
      activeOrganizationId: "org-1",
      activeMembershipId: "membership-1",
      role: "TENANT_OWNER",
    });
    const sessionKey = `auth:session:${created.sessionId}`;
    const before = JSON.parse(redis.store.get(sessionKey) as string);

    redis.ttls.set(sessionKey, 60);

    const updated = await service.setActiveOrganization(created.sessionId, {
      organizationId: "org-2",
      membershipId: "membership-2",
      role: "HR_ADMIN",
    });
    const after = JSON.parse(redis.store.get(sessionKey) as string);

    expect(updated).toMatchObject({
      activeOrganizationId: "org-2",
      activeMembershipId: "membership-2",
      role: "HR_ADMIN",
    });
    expect(after.refreshTokenHash).toBe(before.refreshTokenHash);
    expect(redis.ttls.get(sessionKey)).toBe(60);
  });

  it("does not recreate an expired session during organization switching", async () => {
    const created = await service.createSession({ userId: "user-1" });
    const key = `auth:session:${created.sessionId}`;

    redis.store.delete(key);
    redis.ttls.delete(key);

    await expect(
      service.setActiveOrganization(created.sessionId, {
        organizationId: "org-2",
        membershipId: "membership-2",
        role: "HR_ADMIN",
      }),
    ).resolves.toBeNull();

    expect(redis.store.has(key)).toBe(false);
  });

  it("keeps refresh rotation valid across an organization switch", async () => {
    const created = await service.createSession({
      userId: "user-1",
      activeOrganizationId: "org-1",
      activeMembershipId: "membership-1",
      role: "TENANT_OWNER",
    });
    const [sessionId, originalSecret] = created.refreshToken.split(".");
    const firstRotation = await service.refresh(sessionId, originalSecret);

    await service.setActiveOrganization(sessionId, {
      organizationId: "org-2",
      membershipId: "membership-2",
      role: "HR_ADMIN",
    });

    const secondRotation = await service.refresh(
      sessionId,
      firstRotation.refreshToken.split(".")[1],
    );

    expect(secondRotation.record.activeOrganizationId).toBe("org-2");
    expect(secondRotation.record.activeMembershipId).toBe("membership-2");
    expect(secondRotation.record.role).toBe("HR_ADMIN");
  });

  it("rejects refresh once the absolute lifetime has expired", async () => {
    const created = await service.createSession({ userId: "user-1" });
    const [sessionId, secret] = created.refreshToken.split(".");

    redis.store.delete(`auth:session:${sessionId}`);
    redis.ttls.delete(`auth:session:${sessionId}`);

    await expect(service.refresh(sessionId, secret)).rejects.toMatchObject({
      code: "REFRESH_TOKEN_INVALID",
    });
  });

  it("consumes OAuth state atomically exactly once", async () => {
    await service.saveOAuthState("state-1", {
      nonce: "nonce-1",
      redirectTo: "/dashboard",
      invitationId: null,
      createdAt: new Date().toISOString(),
    });

    const first = await service.consumeOAuthState("state-1");
    const second = await service.consumeOAuthState("state-1");

    expect(first?.nonce).toBe("nonce-1");
    expect(second).toBeNull();
  });
});
