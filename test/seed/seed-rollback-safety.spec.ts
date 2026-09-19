import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { SEED_EMPLOYEE_PREFIX } from "@/seed/constants.js";
import {
  expectedSeedEmployeeIds,
  generateControlledUsers,
  generateOrganizations,
} from "@/seed/data.js";
import { assertRollbackSafe, runRollback } from "@/seed/runner.js";

const seedUsers = generateControlledUsers();
const seedOrganizations = generateOrganizations();

const fakeRollbackDb = (overrides: Record<string, unknown> = {}) => {
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

  for (const [model, methods] of Object.entries(overrides)) {
    Object.assign(db[model as keyof typeof db], methods);
  }

  // runRollback executes the final user boundary in a transaction; the fake
  // runs the callback against itself (shared spies keep recording).
  Object.assign(db, {
    $executeRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  });

  return db as unknown as PrismaClient;
};

describe("SEED-R1 rollback foreign-data safety", () => {
  it("passes preflight on a clean seed-only dataset", async () => {
    await expect(assertRollbackSafe(fakeRollbackDb())).resolves.toBeUndefined();
  });

  it("fails safe when a seed user holds a membership outside seed organizations", async () => {
    const external = [{ userId: seedUsers[0].id, organizationId: "real-developer-org" }];
    const db = fakeRollbackDb({
      organizationMembership: { findMany: vi.fn(async () => external) },
    });

    await expect(assertRollbackSafe(db)).rejects.toThrow(/rollback conflict/);
    await expect(assertRollbackSafe(db)).rejects.toThrow(/externalMembership/);
    expect(
      db.organizationMembership.deleteMany as unknown as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
    expect(db.user.deleteMany as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("fails safe when a seed user changed compensation on a non-seed employee", async () => {
    const offending = [
      { id: "hist-1", employeeId: "real-employee-id", changedByUserId: seedUsers[0].id },
    ];
    const db = fakeRollbackDb({
      compensationHistory: { findMany: vi.fn(async () => offending) },
    });

    await expect(assertRollbackSafe(db)).rejects.toThrow(/rollback conflict/);
    await expect(assertRollbackSafe(db)).rejects.toThrow(/nonSeedAudit/);
    expect(db.user.deleteMany as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("fails safe on invitations, oauth, tokens, or cross-boundary audit rows", async () => {
    const db = fakeRollbackDb({
      organizationInvitation: { count: vi.fn(async () => 1) },
    });

    await expect(assertRollbackSafe(db)).rejects.toThrow(/rollback conflict/);

    // Seed user acting on a non-seed target stays a conflict (seed-only login
    // audit no longer counts, but cross-boundary rows still block).
    const auditDb = fakeRollbackDb({
      authAuditEvent: {
        findMany: vi.fn(async () => [
          {
            id: "audit-foreign-1",
            actorUserId: seedUsers[0].id,
            targetUserId: "real-external-user",
            organizationId: seedOrganizations[0].id,
          },
        ]),
      },
    });

    await expect(assertRollbackSafe(auditDb)).rejects.toThrow(/rollback conflict/);
    await expect(assertRollbackSafe(auditDb)).rejects.toThrow(/foreignAuditSample/);
    expect(
      auditDb.authAuditEvent.deleteMany as unknown as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("does not treat seed-only login audit as a conflict", async () => {
    const db = fakeRollbackDb({
      authAuditEvent: {
        findMany: vi.fn(async () => [
          {
            id: "audit-seed-1",
            actorUserId: seedUsers[0].id,
            targetUserId: seedUsers[0].id,
            organizationId: seedOrganizations[0].id,
          },
          {
            id: "audit-seed-2",
            actorUserId: seedUsers[1].id,
            targetUserId: null,
            organizationId: null,
          },
        ]),
      },
    });

    await expect(assertRollbackSafe(db)).resolves.toBeUndefined();
  });

  it("treats a canonical ID with a renamed number as seed-owned, not manual", async () => {
    const canonicalId = expectedSeedEmployeeIds()[7];
    const db = fakeRollbackDb({
      employee: {
        findMany: vi.fn(async () => [{ id: canonicalId }]),
      },
    });

    await expect(assertRollbackSafe(db)).resolves.toBeUndefined();
  });

  it("treats a normal foreign employee as manual and fails safe", async () => {
    const db = fakeRollbackDb({
      employee: {
        findMany: vi.fn(async () => [{ id: "real-employee-9" }]),
      },
    });

    await expect(assertRollbackSafe(db)).rejects.toThrow(/rollback conflict/);
    await expect(assertRollbackSafe(db)).rejects.toThrow(/foreignEmployees/);
    expect(db.user.deleteMany as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("runs the actual rollback twice: first removes, second passes with zero deletions", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    const savedRedisUrl = process.env.REDIS_URL;

    delete process.env.REDIS_URL;

    try {
      // Genuine canonical IDs so exact-ID scope resolution treats them as seed-owned.
      const ids = expectedSeedEmployeeIds().slice(0, 3);
      let employees = ids.map((id, index) => ({
        id,
        organizationId: seedOrganizations[0].id,
        employeeNumber: `${SEED_EMPLOYEE_PREFIX}TEST-0000${index + 1}`,
      }));
      let compensation = employees.map((row) => ({ employeeId: row.id }));
      let history = employees.map((row) => ({ employeeId: row.id }));
      const inList = (args: unknown, key: "id" | "employeeId"): string[] | null => {
        const where = (args as { where?: Record<string, { in?: string[] }> } | undefined)?.where;
        const clause = where?.[key];

        return clause?.in ?? null;
      };
      const spliceByIds = <T extends { id?: string; employeeId?: string }>(
        rows: T[],
        args: unknown,
      ): { rows: T[]; count: number } => {
        const idsToDelete = new Set([
          ...(inList(args, "id") ?? []),
          ...(inList(args, "employeeId") ?? []),
        ]);
        const kept = rows.filter(
          (row) => !idsToDelete.has(row.id ?? "") && !idsToDelete.has(row.employeeId ?? ""),
        );

        return { rows: kept, count: rows.length - kept.length };
      };
      const db = fakeRollbackDb({
        employee: {
          findMany: vi.fn(async (args: unknown) => {
            const where = (args as { where?: Record<string, unknown> } | undefined)?.where ?? {};

            if ("employeeNumber" in where && where.employeeNumber !== undefined) {
              const clause = where.employeeNumber as Record<string, unknown>;

              // Prefix diagnostic returns the live store; manual-row probe returns none.
              if ("startsWith" in clause) return employees;

              return [];
            }

            const wanted = inList(args, "id");

            return wanted ? employees.filter((row) => wanted.includes(row.id)) : employees;
          }),
          count: vi.fn(async (args: unknown) => {
            const wanted = inList(args, "id");

            return wanted
              ? employees.filter((row) => wanted.includes(row.id)).length
              : employees.length;
          }),
          deleteMany: vi.fn(async (args: unknown) => {
            const result = spliceByIds(employees, args);

            employees = result.rows;

            return { count: result.count };
          }),
        },
        employeeCompensation: {
          count: vi.fn(async (args: unknown) => {
            const wanted = inList(args, "employeeId");

            return wanted
              ? compensation.filter((row) => wanted.includes(row.employeeId)).length
              : compensation.length;
          }),
          deleteMany: vi.fn(async (args: unknown) => {
            const result = spliceByIds(compensation, args);

            compensation = result.rows;

            return { count: result.count };
          }),
        },
        compensationHistory: {
          findMany: vi.fn(async () => []),
          count: vi.fn(async (args: unknown) => {
            const wanted = inList(args, "employeeId");

            return wanted
              ? history.filter((row) => wanted.includes(row.employeeId)).length
              : history.length;
          }),
          deleteMany: vi.fn(async (args: unknown) => {
            const result = spliceByIds(history, args);

            history = result.rows;

            return { count: result.count };
          }),
        },
      }) as unknown as PrismaClient & {
        employee: { deleteMany: ReturnType<typeof vi.fn> };
      };

      const first = await runRollback(db);

      expect(first).toEqual({
        organizations: 0,
        users: 0,
        departments: 0,
        memberships: 0,
        employees: 0,
        compensation: 0,
        history: 0,
        audit: 0,
      });
      expect(employees).toHaveLength(0);
      expect(compensation).toHaveLength(0);
      expect(history).toHaveLength(0);
      const deleteCallsAfterFirst = db.employee.deleteMany.mock.calls.length;

      expect(deleteCallsAfterFirst).toBeGreaterThan(0);

      const second = await runRollback(db);

      expect(second).toEqual(first);
      // Second run resolves an empty scope: no further employee deletes issued.
      expect(db.employee.deleteMany.mock.calls.length).toBe(deleteCallsAfterFirst);
    } finally {
      if (savedRedisUrl !== undefined) process.env.REDIS_URL = savedRedisUrl;
    }
  });
});
