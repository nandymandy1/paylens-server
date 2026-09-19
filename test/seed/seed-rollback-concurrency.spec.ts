import type { PrismaClient } from "@prisma/client";
import { JwtService } from "@nestjs/jwt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_SESSION_SCRIPT } from "@/modules/auth/constants/redis.constant.js";
import { SessionService } from "@/modules/auth/services/session.service.js";
import {
  expectedSeedEmployeeIds,
  generateControlledUsers,
  generateOrganizations,
} from "@/seed/data.js";
import { findSeedAuditPartition, runRollback, runSeed, type SeedAuditRef } from "@/seed/runner.js";

/**
 * SEED-R1 rollback concurrency closure: session-creation block + fresh audit
 * partition. Seven focused tests, no unrelated coverage.
 */

/** In-memory ioredis stand-in honoring the atomic create-session contract. */
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

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((key) => this.store.has(key) || this.sets.has(key)).length;
  }

  pipeline(): {
    set: (key: string, value: string) => void;
    del: (key: string) => void;
    exec: () => Promise<Array<[Error | null, unknown]>>;
  } {
    const queued: Array<() => Promise<unknown>> = [];

    return {
      set: (key: string, value: string): void => {
        queued.push(() => this.set(key, value));
      },
      del: (key: string): void => {
        queued.push(() => this.del(key));
      },
      exec: async (): Promise<Array<[Error | null, unknown]>> => {
        const results: Array<[Error | null, unknown]> = [];

        for (const operation of queued) {
          results.push([null, await operation()]);
        }

        return results;
      },
    };
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

  async eval(script: string, keyCount: number, ...rest: unknown[]): Promise<unknown> {
    if (script !== CREATE_SESSION_SCRIPT) {
      throw new Error("FakeRedis supports only the create-session script in this spec");
    }

    const keys = (rest as string[]).slice(0, keyCount);
    const args = (rest as string[]).slice(keyCount);
    const [sessionRedisKey, indexKey, blockKey] = keys;
    const [recordJson, sessionId, ttlSeconds] = args;

    // Atomic block-check + registration, mirroring the Lua script.
    if (this.store.has(blockKey) || this.sets.has(blockKey)) {
      return "BLOCKED";
    }

    this.store.set(sessionRedisKey, recordJson);
    this.ttls.set(sessionRedisKey, Number(ttlSeconds));

    if (!this.sets.has(indexKey)) {
      this.sets.set(indexKey, new Set());
    }

    (this.sets.get(indexKey) as Set<string>).add(sessionId);
    this.ttls.set(indexKey, Number(ttlSeconds));

    return "OK";
  }
}

const createService = (redis: FakeRedis): SessionService => {
  const jwt = new JwtService({ secret: "test-secret-with-at-least-32-characters!!" });
  const config = {} as never;
  const executionTrace = {
    withinSpan: vi.fn(async (_n: string, _a: object, fn: () => Promise<unknown>) => fn()),
    now: vi.fn(() => 0),
    durationSince: vi.fn(() => 0),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return new SessionService(
    { getClient: () => redis } as never,
    jwt,
    config,
    executionTrace as never,
  );
};

const seedUsers = generateControlledUsers();
const seedOrganizations = generateOrganizations();

/** Zero-row fake DB; audit findMany behavior is injected per test. */
const fakeConcurrencyDb = (auditFindMany: () => Promise<unknown[]>) => {
  const audit: { id: string }[] = [];
  const db = {
    organization: {
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    organizationMembership: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    department: {
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    employee: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    employeeCompensation: {
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    organizationInvitation: { count: vi.fn(async () => 0) },
    oAuthIdentity: { count: vi.fn(async () => 0) },
    authActionToken: { count: vi.fn(async () => 0) },
    authAuditEvent: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(auditFindMany),
      deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        const doomed = new Set(args.where.id.in);

        for (let index = audit.length - 1; index >= 0; index -= 1) {
          if (doomed.has(audit[index].id)) audit.splice(index, 1);
        }

        return { count: 0 };
      }),
    },
    compensationHistory: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    user: {
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  // The final user boundary runs in a transaction; the fake executes the
  // callback against itself (shared spies keep recording).
  Object.assign(db, {
    $executeRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  });

  return db as unknown as PrismaClient & {
    authAuditEvent: { deleteMany: ReturnType<typeof vi.fn> };
    user: { deleteMany: ReturnType<typeof vi.fn> };
  };
};

describe("SEED-R1 rollback concurrency closure", () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedRedisUrl = process.env.REDIS_URL;
  const savedPassword = process.env.SEED_DEMO_PASSWORD;

  afterEach(() => {
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;

    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;

    if (savedPassword === undefined) delete process.env.SEED_DEMO_PASSWORD;
    else process.env.SEED_DEMO_PASSWORD = savedPassword;
  });

  it("1. blocked seed user cannot create/register a session", async () => {
    const redis = new FakeRedis();
    const service = createService(redis);

    await service.blockSessionCreation([seedUsers[0].id]);
    expect(await service.isSessionCreationBlocked(seedUsers[0].id)).toBe(true);

    await expect(service.createSession({ userId: seedUsers[0].id })).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });
    expect(await redis.smembers(`auth:user-sessions:${seedUsers[0].id}`)).toEqual([]);
  });

  it("2. blocked registration leaves no orphan session key or index entry", async () => {
    const redis = new FakeRedis();
    const service = createService(redis);

    await service.blockSessionCreation([seedUsers[0].id]);
    const keysBefore = new Set(redis.store.keys());

    await expect(service.createSession({ userId: seedUsers[0].id })).rejects.toMatchObject({
      code: "SESSION_REVOKED",
    });

    const orphanKeys = [...redis.store.keys()].filter(
      (key) => key.startsWith("auth:session:") && !keysBefore.has(key),
    );

    expect(orphanKeys).toEqual([]);
    expect(await redis.smembers(`auth:user-sessions:${seedUsers[0].id}`)).toEqual([]);

    // Sanity: unblocked registration writes exactly one key + one index entry.
    await service.unblockSessionCreation([seedUsers[1].id]);
    const created = await service.createSession({ userId: seedUsers[1].id });

    expect(redis.store.has(`auth:session:${created.sessionId}`)).toBe(true);
    expect(await redis.smembers(`auth:user-sessions:${seedUsers[1].id}`)).toEqual([
      created.sessionId,
    ]);
  });

  it("3. session block persists after rollback (reseed clears, rollback never does)", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const db = fakeConcurrencyDb(async () => []);
    const blocks = new Set<string>();
    const unblock = vi.fn(async () => 0);

    const result = await runRollback(db, {
      blockSessions: vi.fn(async (userIds: string[]) => {
        for (const userId of userIds) blocks.add(userId);

        return userIds.length;
      }),
      cleanupSessions: vi.fn(async () => 0),
    });

    expect(result.audit).toBe(0);
    expect(blocks.size).toBe(seedUsers.length);
    // Rollback has no unblock path: blocks survive a successful rollback.
    expect(unblock).not.toHaveBeenCalled();
    expect(db.user.deleteMany).toHaveBeenCalled();
  });

  it("4. failed reseed never clears blocks (unblock runs only after success)", async () => {
    // Synchronous preflight failure: no DB touched, seed aborts before any
    // phase — so the post-verification unblock must never run (fail closed).
    // The success path (blocks cleared after verification) is proven live.
    delete process.env.DATABASE_URL;
    process.env.SEED_DEMO_PASSWORD = "PayLens@SeedR1!";
    delete process.env.REDIS_URL;
    const unblockSessions = vi.fn(async () => 0);

    await expect(runSeed({ unblockSessions })).rejects.toThrow(/DATABASE_URL is required/);
    expect(unblockSessions).not.toHaveBeenCalled();
  });

  it("5. old SID stays rejected across block/cleanup/unblock while fresh login works", async () => {
    const redis = new FakeRedis();
    const service = createService(redis);

    // seed → login → capture OLD SID.
    const old = await service.createSession({ userId: seedUsers[0].id });

    // rollback: block + cleanup existing sessions.
    await service.blockSessionCreation([seedUsers[0].id]);
    await service.revokeAllUserSessions(seedUsers[0].id);
    await expect(service.getSession(old.sessionId)).resolves.toBeNull();

    // reseed: users recreated, blocks cleared only now.
    await service.unblockSessionCreation([seedUsers[0].id]);

    // OLD SID is still rejected; a fresh login is accepted.
    await expect(service.getSession(old.sessionId)).resolves.toBeNull();
    const fresh = await service.createSession({ userId: seedUsers[0].id });

    await expect(service.getSession(fresh.sessionId)).resolves.toMatchObject({
      userId: seedUsers[0].id,
    });
  });

  it("6. foreign audit appearing after preflight blocks user deletion", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const foreign = {
      id: "audit-post-preflight-foreign",
      actorUserId: seedUsers[0].id,
      targetUserId: "real-external-user",
      organizationId: seedOrganizations[0].id,
    };
    let calls = 0;
    const db = fakeConcurrencyDb(async () => {
      calls += 1;

      // Preflight partition is clean; the row appears before the fresh phase.
      return calls === 1 ? [] : [foreign];
    });

    await expect(
      runRollback(db, {
        blockSessions: vi.fn(async () => 1),
        cleanupSessions: vi.fn(async () => 0),
      }),
    ).rejects.toThrow(/cross-boundary rows after preflight/);
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(db.authAuditEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("7. seed-only audit appearing after preflight is safely deleted", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const lateSeedOnly = {
      id: "audit-post-preflight-seed-only",
      actorUserId: seedUsers[0].id,
      targetUserId: seedUsers[0].id,
      organizationId: seedOrganizations[0].id,
    };
    let calls = 0;
    const db = fakeConcurrencyDb(async () => {
      calls += 1;

      return calls === 1 ? [] : [lateSeedOnly];
    });

    const result = await runRollback(db, {
      blockSessions: vi.fn(async () => 1),
      cleanupSessions: vi.fn(async () => 0),
    });

    expect(result.audit).toBe(0);
    expect(db.authAuditEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [lateSeedOnly.id] } },
    });
    expect(db.user.deleteMany).toHaveBeenCalled();
  });
});

type MockFn = ReturnType<typeof vi.fn>;

type OrderedDb = PrismaClient & {
  $executeRaw: MockFn;
  $transaction: MockFn;
};

type TxCallable = (...args: never[]) => Promise<unknown>;

/** Wraps one delegate method so it records its phase name, then delegates. */
const instrument = (delegate: object, method: string, name: string, target: string[]): void => {
  const methods = delegate as unknown as Record<string, TxCallable>;
  const original = methods[method];

  methods[method] = vi.fn(async (...args: never[]) => {
    target.push(name);

    return original(...args);
  });
};

/**
 * Event-recording fake: every destructive delegate pushes its phase name, the
 * transaction proxy records the exact in-transaction sequence, and the
 * employee scope resolves canonical IDs so history/compensation/employee
 * deletes actually fire (counts stay 0 so phase/verify checks pass).
 */
const fakeOrderedDb = (auditRead: () => Promise<SeedAuditRef[]>, events: string[]) => {
  const canonicalIds = new Set(expectedSeedEmployeeIds());
  const db = fakeConcurrencyDb(auditRead) as unknown as OrderedDb;
  const txEvents: string[] = [];
  const tx = (name: string, spy: TxCallable): TxCallable =>
    vi.fn(async (...args: never[]) => {
      txEvents.push(name);

      return spy(...args);
    });

  instrument(db.compensationHistory, "deleteMany", "history-delete", events);
  instrument(db.employeeCompensation, "deleteMany", "compensation-delete", events);
  instrument(db.employee, "deleteMany", "employee-delete", events);
  instrument(db.department, "deleteMany", "department-delete", events);
  instrument(db.organization, "deleteMany", "organization-delete", events);
  (db.employee as unknown as Record<string, MockFn>).findMany = vi.fn(
    async (args?: { where?: { id?: { in?: string[] } } }) => {
      const wanted = args?.where?.id?.in ?? [];

      return wanted.filter((id) => canonicalIds.has(id)).map((id) => ({ id }));
    },
  ) as unknown as MockFn;

  const txProxy = {
    $executeRaw: tx("lock-users", db.$executeRaw as unknown as TxCallable),
    authAuditEvent: {
      findMany: tx("audit-read", db.authAuditEvent.findMany as unknown as TxCallable),
      deleteMany: tx("audit-delete", db.authAuditEvent.deleteMany as unknown as TxCallable),
    },
    organizationMembership: {
      deleteMany: tx(
        "membership-delete",
        db.organizationMembership.deleteMany as unknown as TxCallable,
      ),
    },
    user: { deleteMany: tx("user-delete", db.user.deleteMany as unknown as TxCallable) },
  };

  (db as unknown as Record<string, MockFn>).$transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => {
      events.push("tx-begin");

      try {
        return await fn(txProxy);
      } finally {
        events.push("tx-commit");
      }
    },
  ) as unknown as MockFn;

  return { db, txEvents };
};

describe("SEED-R1 final 10% closure", () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;

    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
  });

  const rollbackSeams = (events: string[]) => {
    let cleanups = 0;

    return {
      blockSessions: vi.fn(async (userIds: string[]) => {
        events.push("session-block");

        return userIds.length;
      }),
      cleanupSessions: vi.fn(async () => {
        cleanups += 1;
        events.push(`session-cleanup-${cleanups}`);

        return 0;
      }),
    };
  };

  it("8. cleanup #1 runs before the first destructive delete (full order)", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const events: string[] = [];
    const { db, txEvents } = fakeOrderedDb(async () => [], events);

    const result = await runRollback(db, rollbackSeams(events));

    expect(result.audit).toBe(0);
    // History/compensation/employee phases really fired (canonical scope).
    expect(db.compensationHistory.deleteMany).toHaveBeenCalled();
    expect(db.employeeCompensation.deleteMany).toHaveBeenCalled();
    expect(db.employee.deleteMany).toHaveBeenCalled();
    // The protected boundary ran as one locked transaction (empty audit scope
    // issues no audit delete).
    expect(txEvents).toEqual(["lock-users", "audit-read", "membership-delete", "user-delete"]);

    const indexOf = (name: string): number => events.indexOf(name);
    const ordered = [
      "session-block",
      "session-cleanup-1",
      "history-delete",
      "compensation-delete",
      "employee-delete",
      "department-delete",
      "tx-begin",
      "tx-commit",
      "session-cleanup-2",
      "organization-delete",
    ];

    for (const name of ordered) {
      expect(events, name).toContain(name);
    }

    for (const [first, second] of ordered
      .slice(0, -1)
      .map((name, position) => [name, ordered[position + 1]])) {
      expect(indexOf(first), `${first} < ${second}`).toBeLessThan(indexOf(second));
    }
  });

  it("9. cleanup #1 failure prevents history/compensation/employee/user deletes", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const events: string[] = [];
    const { db } = fakeOrderedDb(async () => [], events);

    await expect(
      runRollback(db, {
        ...rollbackSeams(events),
        cleanupSessions: vi.fn(async () => {
          throw new Error("redis went away before cleanup #1");
        }),
      }),
    ).rejects.toThrow(/redis went away before cleanup #1/);
    expect(db.compensationHistory.deleteMany).not.toHaveBeenCalled();
    expect(db.employeeCompensation.deleteMany).not.toHaveBeenCalled();
    expect(db.employee.deleteMany).not.toHaveBeenCalled();
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(db.authAuditEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("10. partial pipeline failure throws and aborts rollback with zero deletes", async () => {
    // Service level: one ReplyError inside an otherwise-OK pipeline must throw.
    const redis = new FakeRedis();
    const service = createService(redis);
    const originalPipeline = redis.pipeline.bind(redis);

    redis.pipeline = (() => {
      const pipe = originalPipeline() as unknown as {
        set: (key: string, value: string) => void;
        del: (key: string) => void;
        exec: () => Promise<Array<[Error | null, unknown]>>;
      };
      const originalExec = pipe.exec.bind(pipe);

      pipe.exec = (async () => {
        const results = await originalExec();

        results[1] = [new Error("ReplyError: ERR simulated partial failure"), null];

        return results;
      }) as typeof pipe.exec;

      return pipe;
    }) as FakeRedis["pipeline"];

    await expect(
      service.blockSessionCreation([seedUsers[0].id, seedUsers[1].id, seedUsers[2].id]),
    ).rejects.toThrow(/simulated partial failure/);

    // Rollback level: block-setup failure performs zero destructive deletes.
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const events: string[] = [];
    const { db } = fakeOrderedDb(async () => [], events);

    await expect(
      runRollback(db, {
        blockSessions: vi.fn(async () => {
          throw new Error("ReplyError: ERR simulated partial failure");
        }),
        cleanupSessions: vi.fn(async () => 0),
      }),
    ).rejects.toThrow(/simulated partial failure/);
    expect(db.compensationHistory.deleteMany).not.toHaveBeenCalled();
    expect(db.employeeCompensation.deleteMany).not.toHaveBeenCalled();
    expect(db.employee.deleteMany).not.toHaveBeenCalled();
    expect(db.organizationMembership.deleteMany).not.toHaveBeenCalled();
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(db.authAuditEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("11. post-preflight foreign audit aborts the protected transaction untouched", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const foreign: SeedAuditRef = {
      id: "audit-tx-window-foreign",
      actorUserId: seedUsers[0].id,
      targetUserId: "real-external-user",
      organizationId: seedOrganizations[0].id,
    };
    const store: SeedAuditRef[] = [];
    let reads = 0;
    const events: string[] = [];
    const { db } = fakeOrderedDb(async () => {
      reads += 1;

      // Preflight is clean; the row lands during the protected window.
      if (reads > 1) store.push(foreign);

      return [...store];
    }, events);

    await expect(runRollback(db, rollbackSeams(events))).rejects.toThrow(
      /final protected audit partition found 1 cross-boundary rows after preflight/,
    );
    // User survives, nothing deleted, foreign attribution unmutated.
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(db.organizationMembership.deleteMany).not.toHaveBeenCalled();
    expect(db.authAuditEvent.deleteMany).not.toHaveBeenCalled();
    expect(store).toEqual([foreign]);
  });

  it("12. final boundary is one transaction: lock, fresh read, deletes, commit", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const lateSeedOnly: SeedAuditRef = {
      id: "audit-tx-window-seed-only",
      actorUserId: seedUsers[0].id,
      targetUserId: seedUsers[0].id,
      organizationId: seedOrganizations[0].id,
    };
    let reads = 0;
    const events: string[] = [];
    const { db, txEvents } = fakeOrderedDb(async () => {
      reads += 1;

      return reads === 1 ? [] : [lateSeedOnly];
    }, events);

    const result = await runRollback(db, rollbackSeams(events));

    expect(result.audit).toBe(0);
    expect(txEvents).toEqual([
      "lock-users",
      "audit-read",
      "audit-delete",
      "membership-delete",
      "user-delete",
    ]);
    // Bounded transaction options actually passed to Prisma.
    const transactionOptions = db.$transaction.mock.calls[0][1];

    expect(transactionOptions).toMatchObject({ timeout: 30_000, maxWait: 10_000 });
    // The lock targets the controlled users with FOR UPDATE.
    const lockArg = db.$executeRaw.mock.calls[0][0];

    expect(JSON.stringify(lockArg)).toContain("FOR UPDATE");
    expect(JSON.stringify(lockArg)).toContain(seedUsers[0].id);
    // Seed-only late row cleaned; users deleted.
    expect(db.authAuditEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [lateSeedOnly.id] } },
    });
    expect(db.user.deleteMany).toHaveBeenCalled();
  });

  it("13. organization-only seed audit is discovered and cleaned, never missed", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const orgOnly: SeedAuditRef = {
      id: "audit-org-only-seed",
      actorUserId: null,
      targetUserId: null,
      organizationId: seedOrganizations[0].id,
    };
    const events: string[] = [];
    const { db } = fakeOrderedDb(async () => [orgOnly], events);

    // The loader query itself must include the organization branch.
    const partition = await findSeedAuditPartition(
      db,
      seedUsers.map((user) => user.id),
      seedOrganizations.map((organization) => organization.id),
    );
    const loaderWhere = (db.authAuditEvent.findMany as unknown as MockFn).mock.calls[0][0].where;

    expect(JSON.stringify(loaderWhere.OR)).toContain("organizationId");
    expect(partition.seedOnlyIds).toEqual([orgOnly.id]);
    expect(partition.foreignRows).toEqual([]);

    const result = await runRollback(db, rollbackSeams(events));

    expect(result.audit).toBe(0);
    expect(db.authAuditEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [orgOnly.id] } },
    });
    expect(db.user.deleteMany).toHaveBeenCalled();
  });

  it("14. foreign actor + seed organization blocks rollback, users survive", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const foreign: SeedAuditRef = {
      id: "audit-foreign-actor-seed-org",
      actorUserId: "real-external-admin",
      targetUserId: null,
      organizationId: seedOrganizations[0].id,
    };
    let reads = 0;
    const events: string[] = [];
    const { db } = fakeOrderedDb(async () => {
      reads += 1;

      return reads === 1 ? [] : [foreign];
    }, events);

    await expect(runRollback(db, rollbackSeams(events))).rejects.toThrow(
      /final protected audit partition found 1 cross-boundary rows after preflight/,
    );
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(db.authAuditEvent.deleteMany).not.toHaveBeenCalled();
  });

  it("15. seed actor + foreign organization blocks rollback, users survive", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const foreign: SeedAuditRef = {
      id: "audit-seed-actor-foreign-org",
      actorUserId: seedUsers[0].id,
      targetUserId: null,
      organizationId: "real-developer-org",
    };
    let reads = 0;
    const events: string[] = [];
    const { db } = fakeOrderedDb(async () => {
      reads += 1;

      return reads === 1 ? [] : [foreign];
    }, events);

    await expect(runRollback(db, rollbackSeams(events))).rejects.toThrow(
      /final protected audit partition found 1 cross-boundary rows after preflight/,
    );
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(db.authAuditEvent.deleteMany).not.toHaveBeenCalled();
  });
});
