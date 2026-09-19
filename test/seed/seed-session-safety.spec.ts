import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSeedSessions, runRollback } from "@/seed/runner.js";

/**
 * Production rollback must invalidate controlled-user Redis sessions BEFORE
 * deleting user rows (deterministic IDs could otherwise resurrect stale
 * sessions on reseed). When REDIS_URL is configured but unreachable,
 * rollback aborts before any user deletion.
 */
const fakeEmptySeedDb = () => {
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
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
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

  // runRollback executes the final user boundary in a transaction; the fake
  // runs the callback against itself (shared spies keep recording).
  Object.assign(db, {
    $executeRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  });

  return db as unknown as PrismaClient & {
    user: { deleteMany: ReturnType<typeof vi.fn> };
    organizationMembership: { deleteMany: ReturnType<typeof vi.fn> };
    organization: { deleteMany: ReturnType<typeof vi.fn> };
  };
};

describe("SEED-R1 rollback Redis session safety", () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;

    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
  });

  it("aborts rollback before user deletion when the session block fails", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    // Configured but unreachable: connection refused, block must throw first.
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const db = fakeEmptySeedDb();

    await expect(runRollback(db)).rejects.toThrow(/session block failed.*aborting rollback/);
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    // Block failure aborts before ANY destructive DB delete, not just users.
    expect(db.compensationHistory.deleteMany).not.toHaveBeenCalled();
    expect(db.employeeCompensation.deleteMany).not.toHaveBeenCalled();
    expect(db.employee.deleteMany).not.toHaveBeenCalled();
    // Membership deletion also comes after session blocking.
    expect(db.organizationMembership.deleteMany).not.toHaveBeenCalled();
    expect(db.organization.deleteMany).not.toHaveBeenCalled();
  });

  it("throws directly from session cleanup when Redis is configured but unreachable", async () => {
    process.env.REDIS_URL = "redis://127.0.0.1:1";

    await expect(cleanupSeedSessions(["seed-user-1"])).rejects.toThrow(
      /session cleanup failed.*aborting rollback/,
    );
  });

  it("skips quietly when Redis is not configured and still deletes users", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const db = fakeEmptySeedDb();

    expect(await cleanupSeedSessions(["seed-user-1"])).toBe(0);

    const result = await runRollback(db);

    expect(result).toEqual({
      organizations: 0,
      users: 0,
      departments: 0,
      memberships: 0,
      employees: 0,
      compensation: 0,
      history: 0,
      audit: 0,
    });
    // Session step skipped; controlled users may be deleted.
    expect(db.user.deleteMany).toHaveBeenCalled();
  });

  it("blocks before cleanup #1: a session planted in the race window is removed", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const db = fakeEmptySeedDb();
    // Fake session store standing in for Redis keyspace.
    const sessions = new Set<string>();
    const events: string[] = [];

    (db as unknown as { user: { deleteMany: unknown } }).user.deleteMany = vi.fn(async () => {
      events.push("users-deleted");

      return { count: 0 };
    });

    const result = await runRollback(db, {
      blockSessions: vi.fn(async () => {
        events.push("block");

        return 1;
      }),
      cleanupSessions: vi.fn(async () => {
        events.push("cleanup");
        const removed = sessions.size;

        sessions.clear();

        if (events.filter((event) => event === "cleanup").length === 1) {
          // A login lands after cleanup #1 but before user deletion.
          sessions.add("race-window-sid");
        }

        return removed;
      }),
    });

    expect(result.audit).toBe(0);
    expect(events).toEqual(["block", "cleanup", "users-deleted", "cleanup"]);
    // Cleanup #2 ran after user deletion and removed the race-window session.
    expect(sessions.size).toBe(0);
    expect(db.user.deleteMany).toHaveBeenCalled();
  });

  it("fails rollback when the post-delete cleanup fails", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const db = fakeEmptySeedDb();
    const cleanups: string[][] = [];

    await expect(
      runRollback(db, {
        cleanupSessions: vi.fn(async (userIds: string[]) => {
          cleanups.push(userIds);

          if (cleanups.length === 1) return 0;

          throw new Error("redis went away mid-rollback");
        }),
      }),
    ).rejects.toThrow(/database user deletion completed.*session invalidation incomplete/);
    expect(cleanups).toHaveLength(2);
    // DB work already happened (rollback is rerunnable), but no success reported.
    expect(db.user.deleteMany).toHaveBeenCalled();
  });
});
