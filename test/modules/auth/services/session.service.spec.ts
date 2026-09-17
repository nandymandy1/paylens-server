import { createHash } from "node:crypto";
import { JwtService } from "@nestjs/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import { hashOpaqueToken } from "@/modules/auth/utils/auth.utils.js";
import { SessionService } from "@/modules/auth/services/session.service.js";

/** Minimal in-memory ioredis stand-in that faithfully executes the rotation script contract. */
class FakeRedis {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...mode: unknown[]): Promise<string> {
    void mode;
    this.store.set(key, value);

    return "OK";
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

      if (this.sets.delete(key)) {
        removed += 1;
      }
    }

    return removed;
  }

  async ttl(cacheKey: string): Promise<number> {
    void cacheKey;

    return 100;
  }

  /** Mirrors ROTATE_SCRIPT: 1 rotated, 0 missing, -1 hash mismatch. */
  async eval(
    _script: string,
    keyCount: number,
    key: string,
    expectedHash: string,
    nextHash: string,
    now: string,
    ttl: number,
  ): Promise<number> {
    void keyCount;
    void ttl;

    const raw = this.store.get(key);

    if (!raw) {
      return 0;
    }

    const record = JSON.parse(raw) as { refreshTokenHash: string };

    if (record.refreshTokenHash !== expectedHash) {
      return -1;
    }

    this.store.set(
      key,
      JSON.stringify({ ...JSON.parse(raw), refreshTokenHash: nextHash, lastRefreshedAt: now }),
    );

    return 1;
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

  it("stores only a hash of the user agent", async () => {
    const created = await service.createSession({ userId: "user-1", userAgent: "TestAgent/1.0" });
    const stored = JSON.parse(redis.store.get(`auth:session:${created.sessionId}`) as string);

    expect(stored.userAgentHash).toBe(createHash("sha256").update("TestAgent/1.0").digest("hex"));
  });
});
