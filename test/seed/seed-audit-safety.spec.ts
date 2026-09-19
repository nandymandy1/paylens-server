import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateControlledUsers, generateOrganizations } from "@/seed/data.js";
import {
  assertRollbackSafe,
  classifyAuditEvents,
  runRollback,
  type SeedAuditRef,
} from "@/seed/runner.js";

const seedUsers = generateControlledUsers();
const seedOrganizations = generateOrganizations();

type AuditRow = {
  id: string;
  action: string;
  actorUserId: string | null;
  targetUserId: string | null;
  organizationId: string | null;
};

const seedLoginAudit = (): AuditRow[] => [
  {
    id: "audit-login-1",
    action: "LOGIN_SUCCEEDED",
    actorUserId: seedUsers[0].id,
    targetUserId: seedUsers[0].id,
    organizationId: seedOrganizations[0].id,
  },
  {
    id: "audit-logout-1",
    action: "LOGOUT",
    actorUserId: seedUsers[0].id,
    targetUserId: null,
    organizationId: null,
  },
  {
    id: "audit-switch-1",
    action: "ORGANIZATION_SWITCHED",
    actorUserId: seedUsers[1].id,
    targetUserId: seedUsers[1].id,
    organizationId: seedOrganizations[1].id,
  },
];

/**
 * In-memory fake whose audit methods apply the real production predicates:
 * findMany/count match actor, target, OR organization (FIX4 discovery scope);
 * deleteMany removes by ID.
 */
const fakeAuditDb = (audit: AuditRow[]) => {
  const userIds = new Set(seedUsers.map((user) => user.id));
  const orgIds = new Set(seedOrganizations.map((organization) => organization.id));
  const inScope = (row: AuditRow): boolean =>
    userIds.has(row.actorUserId ?? "") ||
    userIds.has(row.targetUserId ?? "") ||
    orgIds.has(row.organizationId ?? "");
  const toRef = (row: AuditRow): SeedAuditRef => ({
    id: row.id,
    actorUserId: row.actorUserId,
    targetUserId: row.targetUserId,
    organizationId: row.organizationId,
  });
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
      count: vi.fn(async () => audit.filter(inScope).length),
      findMany: vi.fn(async () => audit.filter(inScope).map(toRef)),
      deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        const doomed = new Set(args.where.id.in);
        let removed = 0;

        for (let index = audit.length - 1; index >= 0; index -= 1) {
          if (doomed.has(audit[index].id)) {
            audit.splice(index, 1);
            removed += 1;
          }
        }

        return { count: removed };
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

  // runRollback executes the final user boundary in a transaction; the fake
  // runs the callback against itself (shared spies keep recording).
  Object.assign(db, {
    $executeRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  });

  return db as unknown as PrismaClient & {
    authAuditEvent: { deleteMany: ReturnType<typeof vi.fn> };
    user: { deleteMany: ReturnType<typeof vi.fn> };
  };
};

describe("SEED-R1 audit trust boundary", () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;

    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
  });

  it("classifies by referenced entities, never by event name", () => {
    const userIds = new Set(seedUsers.map((user) => user.id));
    const orgIds = new Set(seedOrganizations.map((organization) => organization.id));

    const { seedOnlyIds, foreignRows } = classifyAuditEvents(
      [
        { id: "a", actorUserId: seedUsers[0].id, targetUserId: null, organizationId: null },
        { id: "b", actorUserId: null, targetUserId: null, organizationId: null },
        { id: "c", actorUserId: seedUsers[0].id, targetUserId: "real-user", organizationId: null },
        { id: "d", actorUserId: "real-user", targetUserId: seedUsers[0].id, organizationId: null },
        {
          id: "e",
          actorUserId: seedUsers[0].id,
          targetUserId: seedUsers[0].id,
          organizationId: "real-org",
        },
      ],
      userIds,
      orgIds,
    );

    expect(seedOnlyIds).toEqual(["a", "b"]);
    expect(foreignRows.map((row) => row.id)).toEqual(["c", "d", "e"]);
  });

  it("rolls back a normal seeded login: audit cleaned, users removed, PASS", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const audit = seedLoginAudit();
    const db = fakeAuditDb(audit);

    await expect(assertRollbackSafe(db)).resolves.toBeUndefined();

    const result = await runRollback(db);

    expect(result.audit).toBe(0);
    expect(audit).toHaveLength(0);
    expect(db.authAuditEvent.deleteMany).toHaveBeenCalled();
    expect(db.user.deleteMany).toHaveBeenCalled();
  });

  it("fails safe when a seed user acts on a non-seed user", async () => {
    const audit: AuditRow[] = [
      {
        id: "audit-cross-1",
        action: "LOGIN_SUCCEEDED",
        actorUserId: seedUsers[0].id,
        targetUserId: "real-external-user",
        organizationId: seedOrganizations[0].id,
      },
    ];
    const db = fakeAuditDb(audit);

    await expect(assertRollbackSafe(db)).rejects.toThrow(/rollback conflict/);
    await expect(runRollback(db)).rejects.toThrow(/rollback conflict/);
    expect(audit).toHaveLength(1);
    expect(db.authAuditEvent.deleteMany).not.toHaveBeenCalled();
    expect(db.user.deleteMany).not.toHaveBeenCalled();
  });

  it("fails safe when a seed user acts inside a non-seed organization", async () => {
    const audit: AuditRow[] = [
      {
        id: "audit-cross-org-1",
        action: "ORGANIZATION_SWITCHED",
        actorUserId: seedUsers[0].id,
        targetUserId: seedUsers[0].id,
        organizationId: "real-developer-org",
      },
    ];
    const db = fakeAuditDb(audit);

    await expect(assertRollbackSafe(db)).rejects.toThrow(/rollback conflict/);
    expect(audit).toHaveLength(1);
    expect(db.user.deleteMany).not.toHaveBeenCalled();
  });

  it("fails safe when a non-seed actor targets a seed user", async () => {
    const audit: AuditRow[] = [
      {
        id: "audit-external-actor-1",
        action: "MEMBERSHIP_ROLE_CHANGED",
        actorUserId: "real-external-admin",
        targetUserId: seedUsers[0].id,
        organizationId: seedOrganizations[0].id,
      },
    ];
    const db = fakeAuditDb(audit);

    await expect(assertRollbackSafe(db)).rejects.toThrow(/rollback conflict/);
    expect(audit).toHaveLength(1);
    expect(db.authAuditEvent.deleteMany).not.toHaveBeenCalled();
    expect(db.user.deleteMany).not.toHaveBeenCalled();
  });

  it("cleans several seed-only events without a generic purge", async () => {
    process.env.DATABASE_URL ??= "postgresql://seed-test.invalid/seed";
    delete process.env.REDIS_URL;
    const audit = seedLoginAudit();
    const db = fakeAuditDb(audit);
    const deleteMany = db.authAuditEvent.deleteMany;

    await runRollback(db);

    expect(audit).toHaveLength(0);
    // Bounded ID-scoped deletes only — never a broad unscoped purge.
    for (const call of deleteMany.mock.calls) {
      const where = (call[0] as { where: Record<string, unknown> }).where;

      expect(Object.keys(where)).toEqual(["id"]);
    }
  });
});
