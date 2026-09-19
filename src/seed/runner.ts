import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { Client } from "pg";
import { executionTracer, shutdownTelemetry } from "@/common/tracing/telemetry.js";

import {
  COMPENSATION_BATCH_SIZE,
  EMPLOYEE_BATCH_SIZE,
  GENERATED_SIZE_DISTRIBUTION,
  HISTORY_BATCH_SIZE,
  ORGANIZATION_COUNT,
  SEED_AS_OF_DATE,
  SEED_EMPLOYEE_PREFIX,
  SEED_RECONCILE_BATCH_SIZE,
  SEED_VERSION,
  ROLLBACK_BATCH_SIZE,
} from "@/seed/constants.js";

import {
  expectedSeedEmployeeIds as expectedSeedEmployeeIdsFor,
  generateCompensation,
  generateCompensationHistory,
  generateControlledUsers,
  generateDepartments,
  generateEmployees,
  generateMemberships,
  generateOrganizations,
  organizationActorById,
  organizationStatus,
} from "@/seed/data.js";

import { calculateSeedFingerprint } from "@/seed/fingerprint.js";
import { verifySeed, type SeedVerification } from "@/seed/verify.js";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import {
  assertPipelineSucceeded,
  sessionBlockKey,
  sessionKey,
  userSessionsKey,
} from "@/modules/auth/utils/auth.utils.js";

type PhaseTimings = Record<string, number>;

const prisma = new PrismaClient();
const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const runPhase = async <T>(
  timings: PhaseTimings,
  name: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const startedAt = performance.now();
  const span = executionTracer().startSpan(`seed.r1.${name}`, undefined, context.active());

  try {
    const result = await context.with(trace.setSpan(context.active(), span), operation);

    span.setStatus({ code: SpanStatusCode.OK });

    return result;
  } catch (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    const durationMs = performance.now() - startedAt;

    timings[name] = durationMs;

    log(`[${SEED_VERSION}] ${name}: ${durationMs.toFixed(0)}ms`);
    span.end();
  }
};

export const chunks = <T>(rows: T[], batchSize = EMPLOYEE_BATCH_SIZE): T[][] =>
  Array.from({ length: Math.ceil(rows.length / batchSize) }, (_, index) =>
    rows.slice(index * batchSize, (index + 1) * batchSize),
  );

/** Detect-first ownership guard: throws before any write when a unique key is foreign-owned. */
export const assertSeedOwnership = (
  kind: "user email" | "organization slug" | "department code",
  key: string,
  existingId: string | null | undefined,
  expectedId: string,
): void => {
  if (existingId && existingId !== expectedId) {
    throw new Error(`[SEED-R1] Collision: ${kind} is owned by a non-seed row: ${key}`);
  }
};

export const withBatchSpan = async <T>(
  phase: string,
  index: number,
  rowCount: number,
  operation: () => Promise<T>,
): Promise<T> => {
  const batchSpan = executionTracer().startSpan(`seed.r1.${phase}.batch`);

  batchSpan.setAttributes({
    "seed.phase": phase,
    "seed.batch.index": index,
    "seed.batch.rows": rowCount,
  });
  const batchContext = trace.setSpan(context.active(), batchSpan);

  try {
    const result = await context.with(batchContext, operation);

    batchSpan.setStatus({ code: SpanStatusCode.OK });

    return result;
  } catch (error) {
    batchSpan.recordException(error instanceof Error ? error : new Error(String(error)));
    batchSpan.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    batchSpan.end();
  }
};

export const runBatches = async <T>(
  phase: string,
  rows: T[],
  batchSize: number,
  operation: (batch: T[]) => Promise<void>,
): Promise<number> => {
  let batches = 0;

  for (const [index, batch] of chunks(rows, batchSize).entries()) {
    await withBatchSpan(phase, index, batch.length, () => operation(batch));
    batches += 1;
  }

  return batches;
};

const assertPreflight = (requiresPassword: boolean): string | undefined => {
  if (!process.env.DATABASE_URL) {
    throw new Error("[SEED-R1] DATABASE_URL is required");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("[SEED-R1] Refusing to seed NODE_ENV=production");
  }

  const generatedTotal = Object.values(GENERATED_SIZE_DISTRIBUTION).reduce(
    (total, count) => total + count,
    0,
  );

  if (generatedTotal !== 28 || generateOrganizations().length !== ORGANIZATION_COUNT) {
    throw new Error("[SEED-R1] Frozen organization distribution is inconsistent");
  }

  if (SEED_AS_OF_DATE.getTime() !== Date.parse("2026-09-01T00:00:00.000Z")) {
    throw new Error("[SEED-R1] Frozen as-of date is inconsistent");
  }

  const password = process.env.SEED_DEMO_PASSWORD?.trim();

  if (requiresPassword && !password) {
    throw new Error("[SEED-R1] SEED_DEMO_PASSWORD is required for controlled portal users");
  }

  return password;
};

const withSeedLock = async <T>(operation: () => Promise<T>): Promise<T> => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });

  await client.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
      [`paylens:seed:${SEED_VERSION}`],
    );

    if (!lock.rows[0]?.acquired) {
      throw new Error(`[SEED-R1] another seed/rollback process is already running`);
    }

    return await operation();
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [`paylens:seed:${SEED_VERSION}`])
      .catch(() => undefined);
    await client.end();
  }
};

export const reconcileUsers = async (
  password: string,
  db: PrismaClient = prisma,
): Promise<{ reconciled: number; unchanged: number }> => {
  const passwords = new PasswordService();
  let reconciled = 0;
  let unchanged = 0;

  for (const user of generateControlledUsers()) {
    // Detect-first: prove ownership before any write.
    const existing = await db.user.findUnique({
      where: { email: user.email },
      select: { id: true, passwordHash: true },
    });

    assertSeedOwnership("user email", user.email, existing?.id, user.id);

    const passwordHash = existing?.passwordHash;
    const canonicalHashIsValid = passwordHash
      ? await passwords.verify(passwordHash, password)
      : false;
    const data = {
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerifiedAt: user.emailVerifiedAt,
      status: user.status,
    };

    if (existing) {
      await db.user.update({
        where: { id: user.id },
        data: canonicalHashIsValid
          ? data
          : { ...data, passwordHash: await passwords.hash(password) },
      });
    } else {
      await db.user.create({
        data: { ...user, passwordHash: await passwords.hash(password) },
      });
    }

    if (existing && canonicalHashIsValid) unchanged += 1;
    else reconciled += 1;
  }

  return { reconciled, unchanged };
};

export const reconcileOrganizations = async (db: PrismaClient = prisma): Promise<void> => {
  for (const organization of generateOrganizations()) {
    // Detect-first: prove ownership before any write.
    const existing = await db.organization.findUnique({
      where: { slug: organization.slug },
      select: { id: true },
    });

    assertSeedOwnership("organization slug", organization.slug, existing?.id, organization.id);

    if (existing) {
      await db.organization.update({
        where: { id: organization.id },
        data: { name: organization.name, status: organizationStatus },
      });
    } else {
      await db.organization.create({
        data: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organizationStatus,
        },
      });
    }
  }
};

const reconcileMemberships = async (): Promise<void> => {
  for (const membership of generateMemberships()) {
    await prisma.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId: membership.organizationId,
          userId: membership.userId,
        },
      },
      create: membership,
      update: { role: membership.role, status: "ACTIVE" },
    });
  }
};

export const reconcileDepartments = async (db: PrismaClient = prisma): Promise<void> => {
  for (const organization of generateOrganizations()) {
    for (const department of generateDepartments(organization)) {
      // Detect-first: prove ownership before any write.
      const existing = await db.department.findUnique({
        where: {
          organizationId_code: { organizationId: department.organizationId, code: department.code },
        },
        select: { id: true },
      });

      assertSeedOwnership(
        "department code",
        `${organization.slug}/${department.code}`,
        existing?.id,
        department.id,
      );

      if (existing) {
        await db.department.update({
          where: { id: department.id },
          data: { name: department.name },
        });
      } else {
        await db.department.create({ data: department });
      }
    }
  }
};

const buildSeedRows = (): {
  employees: number;
  compensation: ReturnType<typeof generateCompensation>[];
  history: ReturnType<typeof generateCompensationHistory>[number][];
  employeeRows: ReturnType<typeof generateEmployees>;
} => {
  const organizations = generateOrganizations();
  // Tenant-correct history actors: each organization's own privileged member.
  const actors = organizationActorById(organizations);
  const employeeRows = organizations.flatMap((organization) =>
    generateEmployees(organization, generateDepartments(organization)),
  );
  const compensation = employeeRows.map((employee, index) => generateCompensation(employee, index));
  const history = employeeRows.flatMap((employee, index) =>
    generateCompensationHistory({
      employee,
      index,
      changedByUserId: actors.get(employee.organizationId) ?? null,
    }),
  );

  return { employees: employeeRows.length, compensation, history, employeeRows };
};

/**
 * Canonical employee scope resolution.
 *
 * OWNERSHIP DISCOVERY uses the exact deterministic ID set only: existing
 * canonical rows are resolved by bounded `id IN` lookups, so a canonical row
 * stays seed-owned even after its employeeNumber is renamed. The prefix
 * select is diagnostic only: it detects reserved-prefix intruders (foreign
 * ID + reserved prefix) and fails safe before any destructive work.
 * Deletion authority never comes from the prefix.
 */
export const resolveSeedEmployeeScope = async (
  db: PrismaClient,
  expectedIds: Set<string>,
  operation: "seed" | "rollback",
): Promise<string[]> => {
  const organizationIds = generateOrganizations().map((organization) => organization.id);
  const prefixed = await db.employee.findMany({
    where: {
      organizationId: { in: organizationIds },
      employeeNumber: { startsWith: SEED_EMPLOYEE_PREFIX },
    },
    select: { id: true, organizationId: true, employeeNumber: true },
  });
  const intruder = prefixed.find((row) => !expectedIds.has(row.id));

  if (intruder) {
    throw new Error(
      `[SEED-R1] Unexpected employee using reserved SEED-R1 employee-number namespace: ` +
        `employeeId=${intruder.id} organizationId=${intruder.organizationId} ` +
        `employeeNumber=${intruder.employeeNumber} (failing safe before ${operation})`,
    );
  }

  const existingSeedIds: string[] = [];

  await runBatches(
    "seed.scope-resolve",
    [...expectedIds],
    SEED_RECONCILE_BATCH_SIZE,
    async (idBatch) => {
      const rows = await db.employee.findMany({
        where: { id: { in: idBatch } },
        select: { id: true },
      });

      existingSeedIds.push(...rows.map((row) => row.id));
    },
  );

  return existingSeedIds;
};

/**
 * Canonical workEmail collision preflight (detect-first, before ANY
 * destructive employee work). Ownership stays exact canonical ID; workEmail
 * is collision-protection only for the org-scoped unique key
 * `(organizationId, workEmail)`. A DB row owning a canonical seed workEmail
 * under a non-canonical ID would crash `createMany` AFTER the canonical
 * rows were deleted — so this fails safe first. Bounded per-organization
 * `workEmail IN` chunks; never 13,357 individual queries.
 */
export const assertSeedWorkEmailOwnership = async (
  employees: { id: string; organizationId: string; workEmail: string | null }[],
  db: PrismaClient,
): Promise<void> => {
  const expectedIdByOrgEmail = new Map<string, string>();

  for (const employee of employees) {
    if (employee.workEmail) {
      expectedIdByOrgEmail.set(`${employee.organizationId}:${employee.workEmail}`, employee.id);
    }
  }

  const emailsByOrg = new Map<string, string[]>();

  for (const employee of employees) {
    if (!employee.workEmail) continue;

    const bucket = emailsByOrg.get(employee.organizationId) ?? [];

    bucket.push(employee.workEmail);
    emailsByOrg.set(employee.organizationId, bucket);
  }

  for (const [organizationId, emails] of emailsByOrg) {
    await runBatches(
      "seed.email-collision-probe",
      emails,
      SEED_RECONCILE_BATCH_SIZE,
      async (chunk) => {
        const rows = await db.employee.findMany({
          where: { organizationId, workEmail: { in: chunk } },
          select: { id: true, organizationId: true, employeeNumber: true, workEmail: true },
        });

        const intruder = rows.find(
          (row) =>
            row.workEmail &&
            expectedIdByOrgEmail.get(`${row.organizationId}:${row.workEmail}`) !== row.id,
        );

        if (intruder) {
          throw new Error(
            `[SEED-R1] Collision: canonical seed workEmail is owned by a non-seed row: ` +
              `employeeId=${intruder.id} organizationId=${intruder.organizationId} ` +
              `employeeNumber=${intruder.employeeNumber} workEmail=${intruder.workEmail} ` +
              `(failing safe before seed)`,
          );
        }
      },
    );
  }
};

export const reconcileSeedEmployees = async (
  employees: ReturnType<typeof generateEmployees>,
  db: PrismaClient = prisma,
): Promise<{ batches: number }> => {
  // Collision protection first: canonical emails AND reserved-prefix
  // namespace are proven before any canonical employee row is deleted.
  await assertSeedWorkEmailOwnership(employees, db);
  // Exact canonical IDs own seed rows; fail before destructive work on intruders.
  const existingSeedIds = await resolveSeedEmployeeScope(
    db,
    new Set(employees.map((employee) => employee.id)),
    "seed",
  );

  const deleteBatches = await runBatches(
    "employees.reconcile-delete",
    existingSeedIds,
    SEED_RECONCILE_BATCH_SIZE,
    async (ids) => {
      await db.employee.deleteMany({ where: { id: { in: ids } } });
    },
  );
  const createBatches = await runBatches(
    "employees",
    employees,
    EMPLOYEE_BATCH_SIZE,
    async (batch) => {
      await db.employee.createMany({ data: batch });
    },
  );

  log(
    `[${SEED_VERSION}] employee reconcile batches: delete=${deleteBatches} create=${createBatches}`,
  );

  return { batches: deleteBatches + createBatches };
};

const createCurrentCompensation = async (
  compensation: ReturnType<typeof generateCompensation>[],
): Promise<number> =>
  runBatches("compensation", compensation, COMPENSATION_BATCH_SIZE, async (batch) => {
    await prisma.employeeCompensation.createMany({ data: batch });
  });

const createCompensationHistory = async (
  history: ReturnType<typeof generateCompensationHistory>[number][],
): Promise<number> =>
  runBatches("history", history, HISTORY_BATCH_SIZE, async (batch) => {
    await prisma.compensationHistory.createMany({ data: batch });
  });

export type SeedRunResult = {
  verification: SeedVerification;
  fingerprint: string;
  timings: PhaseTimings;
  credentialReconciliation: { reconciled: number; unchanged: number };
  batches: { employees: number; compensation: number; history: number };
};

const logVerificationSummary = (verification: SeedVerification): void => {
  log(`[${SEED_VERSION}] expected employees: ${verification.expectedEmployees}`);
  log(
    `[${SEED_VERSION}] actual expected employee IDs present: ${verification.expectedEmployeeIdsPresent}`,
  );
  log(
    `[${SEED_VERSION}] missing expected employee IDs: ${verification.missingExpectedEmployeeIds}`,
  );
  log(
    `[${SEED_VERSION}] unexpected reserved-prefix employees: ${verification.unexpectedReservedPrefixEmployees}`,
  );
  log(
    `[${SEED_VERSION}] history actor membership violations: ${verification.historyActorMembershipViolations}`,
  );
  log(
    `[${SEED_VERSION}] organization employee count violations: ${verification.organizationEmployeeCountMismatches}`,
  );
  log(`[${SEED_VERSION}] missing expected memberships: ${verification.missingExpectedMemberships}`);
  log(`[${SEED_VERSION}] unexpected memberships: ${verification.unexpectedMemberships}`);
};

export const runSeed = async (deps: SeedDeps = {}): Promise<SeedRunResult> => {
  const timings: PhaseTimings = {};
  const rootSpan = executionTracer().startSpan("seed.r1");
  const unblockSessions = deps.unblockSessions ?? clearSeedSessionBlocks;

  rootSpan.setAttributes({ "seed.version": SEED_VERSION, "seed.operation": "seed" });

  return context.with(trace.setSpan(context.active(), rootSpan), async () => {
    try {
      const password = await runPhase(timings, "preflight", async () => assertPreflight(true));
      const credentialReconciliation = await runPhase(timings, "users", () =>
        reconcileUsers(password!),
      );

      await runPhase(timings, "organizations", reconcileOrganizations);
      await runPhase(timings, "memberships", reconcileMemberships);
      await runPhase(timings, "departments", reconcileDepartments);
      const rows = buildSeedRows();

      const employeeBatches = await runPhase(timings, "employees", () =>
        reconcileSeedEmployees(rows.employeeRows).then((result) => result.batches),
      );
      const compensationBatches = await runPhase(timings, "compensation", () =>
        createCurrentCompensation(rows.compensation),
      );
      const historyBatches = await runPhase(timings, "history", () =>
        createCompensationHistory(rows.history),
      );
      const verification = await runPhase(timings, "verification", () =>
        verifySeed(prisma, password!),
      );
      const fingerprint = await runPhase(timings, "fingerprint", () =>
        calculateSeedFingerprint(prisma),
      );

      // Blocks clear ONLY here: users recreated + verification + fingerprint
      // passed. Controlled logins are impossible while users are absent or
      // partially recreated. Never cleared inside rollback or on failure.
      await runPhase(timings, "session-unblock", () =>
        unblockSessions(generateControlledUsers().map((user) => user.id)),
      );

      log(
        `[${SEED_VERSION}] controlled credentials reconciled: ${credentialReconciliation.reconciled}/35`,
      );
      log(
        `[${SEED_VERSION}] controlled credentials unchanged: ${credentialReconciliation.unchanged}/35`,
      );
      log(`[${SEED_VERSION}] verification: PASS`);
      logVerificationSummary(verification);
      log(`[${SEED_VERSION}] fingerprint: ${fingerprint}`);
      log(
        `[${SEED_VERSION}] batches: employees=${employeeBatches} compensation=${compensationBatches} history=${historyBatches}`,
      );
      rootSpan.setStatus({ code: SpanStatusCode.OK });

      return {
        verification,
        fingerprint,
        timings,
        credentialReconciliation,
        batches: {
          employees: employeeBatches,
          compensation: compensationBatches,
          history: historyBatches,
        },
      };
    } catch (error) {
      rootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
      rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      rootSpan.end();
    }
  });
};

const seedOwnership = () => {
  const organizations = generateOrganizations();
  const users = generateControlledUsers();
  const memberships = generateMemberships(organizations);
  const departments = organizations.flatMap(generateDepartments);

  return { organizations, users, memberships, departments };
};

/** Bounded exact-ID counts: never one enormous IN list, never a full-table scan. */
const countByIdChunks = async (
  db: PrismaClient,
  model: "employee" | "compensation" | "history",
  ids: string[],
): Promise<number> => {
  let total = 0;

  for (const batch of chunks(ids, ROLLBACK_BATCH_SIZE)) {
    total +=
      model === "employee"
        ? await db.employee.count({ where: { id: { in: batch } } })
        : model === "compensation"
          ? await db.employeeCompensation.count({ where: { employeeId: { in: batch } } })
          : await db.compensationHistory.count({ where: { employeeId: { in: batch } } });
  }

  return total;
};

const verifyRollback = async (db: PrismaClient = prisma): Promise<Record<string, number>> => {
  const { organizations, users, memberships, departments } = seedOwnership();
  const organizationIds = organizations.map((organization) => organization.id);
  const userIds = users.map((user) => user.id);
  const expectedIds = expectedSeedEmployeeIdsFor(organizations);
  const [
    organizationCount,
    userCount,
    departmentCount,
    membershipCount,
    employeeCount,
    compensationCount,
    historyCount,
    seedAuditCount,
  ] = await Promise.all([
    db.organization.count({ where: { id: { in: organizationIds } } }),
    db.user.count({ where: { id: { in: userIds } } }),
    db.department.count({
      where: { id: { in: departments.map((department) => department.id) } },
    }),
    db.organizationMembership.count({
      where: {
        OR: memberships.map((membership) => ({
          organizationId: membership.organizationId,
          userId: membership.userId,
        })),
      },
    }),
    countByIdChunks(db, "employee", expectedIds),
    countByIdChunks(db, "compensation", expectedIds),
    countByIdChunks(db, "history", expectedIds),
    // Same discovery scope as findSeedAuditPartition: actor, target, AND
    // organization — an organization-only survivor must fail verification.
    db.authAuditEvent.count({
      where: {
        OR: [
          { actorUserId: { in: userIds } },
          { targetUserId: { in: userIds } },
          { organizationId: { in: organizationIds } },
        ],
      },
    }),
  ]);
  const counts = {
    organizations: organizationCount,
    users: userCount,
    departments: departmentCount,
    memberships: membershipCount,
    employees: employeeCount,
    compensation: compensationCount,
    history: historyCount,
    audit: seedAuditCount,
  };

  if (Object.values(counts).some((count) => count !== 0))
    throw new Error(`[SEED-R1] rollback verification failed: ${JSON.stringify(counts)}`);

  return counts;
};

const assertRollbackPhaseEmpty = async (
  db: PrismaClient,
  phase: "history" | "compensation" | "employees",
  employeeIds: string[],
): Promise<void> => {
  const remaining = await countByIdChunks(
    db,
    phase === "employees" ? "employee" : phase,
    employeeIds,
  );

  if (remaining !== 0) {
    throw new Error(`[SEED-R1] rollback ${phase} verification failed: ${remaining} rows remain`);
  }

  log(`[${SEED_VERSION}] rollback ${phase} remaining: 0`);
};

export type SeedAuditRef = {
  id: string;
  actorUserId: string | null;
  targetUserId: string | null;
  organizationId: string | null;
};

/**
 * SEED-R1 audit trust boundary. An AuthAuditEvent is rollback-owned (seed-only)
 * iff every entity reference it carries is SEED-R1-owned or null: actor, target,
 * and organization. These are the only identity/entity FKs on the model
 * (metadata is free-form non-relational telemetry, not an entity reference),
 * so ownership is decided by referenced entities — never by event name.
 * Anything touching a non-seed user/org is foreign and blocks rollback.
 */
export const classifyAuditEvents = (
  rows: SeedAuditRef[],
  seedUserIds: Set<string>,
  seedOrganizationIds: Set<string>,
): { seedOnlyIds: string[]; foreignRows: SeedAuditRef[] } => {
  const seedOnlyIds: string[] = [];
  const foreignRows: SeedAuditRef[] = [];

  for (const row of rows) {
    const inScope = (id: string | null, scope: Set<string>): boolean =>
      id === null || scope.has(id);

    if (
      inScope(row.actorUserId, seedUserIds) &&
      inScope(row.targetUserId, seedUserIds) &&
      inScope(row.organizationId, seedOrganizationIds)
    ) {
      seedOnlyIds.push(row.id);
    } else {
      foreignRows.push(row);
    }
  }

  return { seedOnlyIds, foreignRows };
};

/** Loads seed-scope audit rows (indexed FK/org reads) and partitions them.
 * Discovery covers all three entity references the classifier owns —
 * actor, target, AND organization — so organization-only rows (null actor,
 * null target, seed org) cannot escape classification. */
export const findSeedAuditPartition = async (
  db: PrismaClient,
  userIds: string[],
  organizationIds: string[],
): Promise<{ seedOnlyIds: string[]; foreignRows: SeedAuditRef[] }> => {
  const rows = await db.authAuditEvent.findMany({
    where: {
      OR: [
        { actorUserId: { in: userIds } },
        { targetUserId: { in: userIds } },
        { organizationId: { in: organizationIds } },
      ],
    },
    select: { id: true, actorUserId: true, targetUserId: true, organizationId: true },
  });

  return classifyAuditEvents(rows, new Set(userIds), new Set(organizationIds));
};

/** Deletes ONLY classified seed-only audit rows, in bounded batches. Never a broad purge. */
export const deleteSeedOnlyAuditEvents = async (
  db: PrismaClient,
  seedOnlyIds: string[],
): Promise<number> =>
  runBatches("rollback.audit", seedOnlyIds, ROLLBACK_BATCH_SIZE, async (ids) => {
    await db.authAuditEvent.deleteMany({ where: { id: { in: ids } } });
  });

export const assertRollbackSafe = async (db: PrismaClient = prisma): Promise<void> => {
  const { organizations, users, memberships, departments } = seedOwnership();
  const organizationIds = organizations.map((organization) => organization.id);
  const userIds = users.map((user) => user.id);
  const expectedMemberships = memberships.map((membership) => ({
    organizationId: membership.organizationId,
    userId: membership.userId,
  }));
  // User FK authority (prisma/schema.prisma):
  // - memberships/oAuthIdentity/actionToken: onDelete Cascade (deleting a seed User
  //   would delete those rows) -> preflight must prove none are foreign-owned.
  // - sentInvitations: onDelete Restrict (DB would reject) -> fail safe first with a summary.
  // - auditActor/auditTarget + compensationChangedBy: onDelete SetNull (deletion would
  //   silently null non-seed audit/history attribution) -> fail safe first.
  const expectedSeedEmployeeIds = new Set(expectedSeedEmployeeIdsFor(organizations));
  // Exact-ID ownership: a row is seed-owned iff its ID is canonical. The
  // narrow prefix select is diagnostic only — non-canonical prefix rows are
  // conflicts, and non-prefix manual rows are counted, never deleted.
  const prefixedEmployees = await db.employee.findMany({
    where: {
      organizationId: { in: organizationIds },
      employeeNumber: { startsWith: SEED_EMPLOYEE_PREFIX },
    },
    select: { id: true, organizationId: true, employeeNumber: true },
  });
  const unexpectedPrefixEmployees = prefixedEmployees.filter(
    (row) => !expectedSeedEmployeeIds.has(row.id),
  );
  const manualCandidates = await db.employee.findMany({
    where: {
      organizationId: { in: organizationIds },
      employeeNumber: { not: { startsWith: SEED_EMPLOYEE_PREFIX } },
    },
    select: { id: true },
  });
  // Exact-ID classification: a canonical ID with a renamed number is still
  // seed-owned; only non-canonical IDs are manual/foreign.
  const manualEmployeeIds = manualCandidates
    .filter((row) => !expectedSeedEmployeeIds.has(row.id))
    .map((row) => row.id);
  // Non-seed audit: seed-user attribution on any non-canonical employee, in
  // or out of seed organizations. Bounded relational + small-ID queries only.
  const nonSeedEmployeeIds = [
    ...unexpectedPrefixEmployees.map((row) => row.id),
    ...manualEmployeeIds,
  ];
  const [
    foreignMemberships,
    foreignDepartments,
    invitations,
    oauth,
    tokens,
    sentInvitations,
    audit,
    externalMemberships,
    outOfOrgAudit,
    inOrgNonSeedAudit,
  ] = await Promise.all([
    db.organizationMembership.count({
      where: { organizationId: { in: organizationIds }, NOT: { OR: expectedMemberships } },
    }),
    db.department.count({
      where: {
        organizationId: { in: organizationIds },
        id: { notIn: departments.map((department) => department.id) },
      },
    }),
    db.organizationInvitation.count({ where: { organizationId: { in: organizationIds } } }),
    db.oAuthIdentity.count({ where: { userId: { in: userIds } } }),
    db.authActionToken.count({ where: { userId: { in: userIds } } }),
    db.organizationInvitation.count({ where: { invitedByUserId: { in: userIds } } }),
    findSeedAuditPartition(db, userIds, organizationIds),
    db.organizationMembership.findMany({
      where: { userId: { in: userIds }, organizationId: { notIn: organizationIds } },
      select: { userId: true, organizationId: true },
      take: 5,
    }),
    db.compensationHistory.findMany({
      where: {
        changedByUserId: { in: userIds },
        employee: { organizationId: { notIn: organizationIds } },
      },
      select: { id: true, employeeId: true, changedByUserId: true },
      take: 5,
    }),
    nonSeedEmployeeIds.length > 0
      ? db.compensationHistory.findMany({
          where: {
            changedByUserId: { in: userIds },
            employeeId: { in: nonSeedEmployeeIds.slice(0, ROLLBACK_BATCH_SIZE) },
          },
          select: { id: true, employeeId: true, changedByUserId: true },
          take: 5,
        })
      : Promise.resolve([]),
  ]);
  const nonSeedAudit = [...outOfOrgAudit, ...inOrgNonSeedAudit];
  // Only cross-boundary audit blocks: seed-only rows (e.g. a seeded login's
  // LOGIN_SUCCEEDED) are rollback-owned and cleaned, never conflicts.
  const { seedOnlyIds: seedOnlyAuditIds, foreignRows: foreignAuditRows } = audit;
  const conflicts = {
    foreignMemberships,
    foreignDepartments,
    foreignEmployees: manualEmployeeIds.length,
    unexpectedPrefixEmployees: unexpectedPrefixEmployees.length,
    invitations,
    oauth,
    tokens,
    sentInvitations,
    audit: foreignAuditRows.length,
    externalMemberships: externalMemberships.length,
    nonSeedAudit: nonSeedAudit.length,
  };

  if (Object.values(conflicts).some((count) => count > 0)) {
    const summary = {
      ...conflicts,
      unexpectedPrefixSample: unexpectedPrefixEmployees.slice(0, 5),
      externalMembershipSample: externalMemberships,
      nonSeedAuditSample: nonSeedAudit,
      foreignAuditSample: foreignAuditRows.slice(0, 5),
    };

    throw new Error(`[SEED-R1] rollback conflict: ${JSON.stringify(summary)}`);
  }

  log(`[${SEED_VERSION}] seed-only audit events eligible for cleanup: ${seedOnlyAuditIds.length}`);
};

/**
 * Required session invalidation for controlled SEED-R1 users. Only touches
 * `auth:user-sessions:<seedUserId>` sets and their session keys — never
 * flushes Redis, never touches non-seed users. Rollback calls this BEFORE
 * deleting user rows: seed user IDs are deterministic, so a stale session
 * left behind could become valid again after a reseed recreates the same
 * ID. When REDIS_URL is absent the skip is logged and permitted; when
 * REDIS_URL is configured but cleanup fails, this THROWS so rollback aborts
 * before any controlled user row is deleted.
 */
export const cleanupSeedSessions = async (userIds: string[]): Promise<number> => {
  if (!process.env.REDIS_URL) {
    log(`[${SEED_VERSION}] session cleanup skipped: REDIS_URL is not configured`);

    return 0;
  }

  const { Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });

  try {
    await redis.connect();
    let removed = 0;

    for (const userId of userIds) {
      const members: string[] = await redis.smembers(userSessionsKey(userId));

      if (members.length > 0) {
        await redis.del(...members.map((sessionId) => sessionKey(sessionId)));
        removed += members.length;
      }

      await redis.del(userSessionsKey(userId));
    }

    log(`[${SEED_VERSION}] session cleanup removed ${removed} seed sessions`);

    return removed;
  } catch (error) {
    throw new Error(
      `[SEED-R1] session cleanup failed with REDIS_URL configured, aborting rollback ` +
        `before user deletion: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    redis.disconnect();
  }
};

/** Injectable seam for rollback orchestration tests; production always uses cleanupSeedSessions. */
export type RollbackDeps = {
  cleanupSessions?: (userIds: string[]) => Promise<number>;
  blockSessions?: (userIds: string[]) => Promise<number>;
};

/** Injectable seam for seed orchestration tests; production clears real Redis blocks. */
export type SeedDeps = {
  unblockSessions?: (userIds: string[]) => Promise<number>;
};

/**
 * Temporarily blocks session creation for controlled SEED-R1 users during
 * rollback (closes the SMEMBERS→SADD race: a login landing after cleanup #1
 * can no longer register an undiscoverable SID). Pipelined SETs of
 * `auth:session-block:<seedUserId>` — never touches non-seed users. Blocks
 * carry no TTL and SURVIVE successful rollback; the next successful reseed
 * clears them. Absent REDIS_URL skips (NOT APPLICABLE); configured-but-failing
 * Redis THROWS so rollback aborts before any user deletion.
 */
export const setSeedSessionBlocks = async (userIds: string[]): Promise<number> => {
  if (!process.env.REDIS_URL) {
    log(`[${SEED_VERSION}] session block skipped: REDIS_URL is not configured`);

    return 0;
  }

  const { Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });

  try {
    await redis.connect();
    const pipeline = redis.pipeline();

    for (const userId of userIds) {
      pipeline.set(sessionBlockKey(userId), "1");
    }

    // Fail closed at command level: a partially-applied block aborts rollback
    // before any destructive DB delete.
    assertPipelineSucceeded(
      await pipeline.exec(),
      "[SEED-R1] session block failed with REDIS_URL configured",
    );
    log(`[${SEED_VERSION}] session creation blocked for ${userIds.length} seed users`);

    return userIds.length;
  } catch (error) {
    throw new Error(
      `[SEED-R1] session block failed with REDIS_URL configured, aborting rollback ` +
        `before user deletion: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    redis.disconnect();
  }
};

/**
 * Clears SEED-R1 session-creation blocks. Called ONLY after a successful
 * reseed (users recreated + verification passed) — never inside rollback, and
 * never on failure (fail closed). Absent REDIS_URL skips; configured-but-failing
 * Redis THROWS so seed reports failure instead of a half-unblocked state.
 */
export const clearSeedSessionBlocks = async (userIds: string[]): Promise<number> => {
  if (!process.env.REDIS_URL) {
    log(`[${SEED_VERSION}] session unblock skipped: REDIS_URL is not configured`);

    return 0;
  }

  const { Redis } = await import("ioredis");
  const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });

  try {
    await redis.connect();

    if (userIds.length === 0) return 0;

    const removed = await redis.del(...userIds.map((userId) => sessionBlockKey(userId)));

    log(`[${SEED_VERSION}] session creation unblocked for ${userIds.length} seed users`);

    return removed;
  } catch (error) {
    throw new Error(
      `[SEED-R1] session unblock failed with REDIS_URL configured: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    redis.disconnect();
  }
};

/**
 * Final sensitive boundary in ONE small transaction — never the whole
 * rollback. The transaction locks the controlled User rows (FOR UPDATE on
 * the transaction's connection), freshly re-reads the seed audit partition
 * INSIDE the lock, and only then deletes seed-only audits, seed memberships,
 * and controlled users. A foreign row appearing after the early preflight
 * aborts here via ROLLBACK: no user row is deleted and no audit attribution
 * is mutated. Departments stay outside (no user FK); organizations are
 * deleted after session cleanup #2.
 */
export const runProtectedUserBoundary = async (
  db: PrismaClient,
  refs: {
    userIds: string[];
    organizationIds: string[];
    memberships: { organizationId: string; userId: string }[];
  },
): Promise<void> => {
  await db.$transaction(
    async (tx) => {
      const txDb = tx as unknown as PrismaClient;

      // Lock controlled User rows: concurrent FK writes involving these users
      // wait on (or fail against) this lock instead of slipping a
      // cross-boundary audit row through the final window.
      if (refs.userIds.length > 0) {
        await tx.$executeRaw(
          Prisma.sql`SELECT "id" FROM "User" WHERE "id" IN (${Prisma.join(refs.userIds)}) FOR UPDATE`,
        );
      }

      // Fresh partition INSIDE the lock: aborts before any audit/user write.
      const { seedOnlyIds, foreignRows } = await findSeedAuditPartition(
        txDb,
        refs.userIds,
        refs.organizationIds,
      );

      if (foreignRows.length > 0) {
        throw new Error(
          `[SEED-R1] rollback conflict: final protected audit partition found ` +
            `${foreignRows.length} cross-boundary rows after preflight, ` +
            `aborting before user deletion: ${JSON.stringify(foreignRows.slice(0, 5))}`,
        );
      }

      await deleteSeedOnlyAuditEvents(txDb, seedOnlyIds);
      await tx.organizationMembership.deleteMany({ where: { OR: refs.memberships } });
      await tx.user.deleteMany({ where: { id: { in: refs.userIds } } });
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
};

export const runRollback = async (
  db: PrismaClient = prisma,
  deps: RollbackDeps = {},
): Promise<Record<string, number>> => {
  const timings: PhaseTimings = {};
  const rootSpan = executionTracer().startSpan("seed.r1.rollback");
  const cleanupSessions = deps.cleanupSessions ?? cleanupSeedSessions;
  const blockSessions = deps.blockSessions ?? setSeedSessionBlocks;

  rootSpan.setAttributes({ "seed.version": SEED_VERSION, "seed.operation": "rollback" });

  return context.with(trace.setSpan(context.active(), rootSpan), async () => {
    try {
      await runPhase(timings, "preflight", async () => {
        assertPreflight(false);
        await assertRollbackSafe(db);
      });
      const { organizations, users, memberships, departments } = seedOwnership();
      const organizationIds = organizations.map((organization) => organization.id);
      const userIds = users.map((user) => user.id);

      // SESSION BLOCK (mandatory, first): prevents new session registration
      // for controlled users for the rest of the dangerous window. Throws
      // when REDIS_URL is configured but unreachable — before any deletion.
      // Blocks are intentionally LEFT ACTIVE on success and on failure;
      // only the next successful reseed clears them.
      await runPhase(timings, "session-block", () => blockSessions(userIds));
      // SESSION CLEANUP #1 (mandatory, second): revoke EXISTING sessions
      // BEFORE any destructive DB delete, so an already-authenticated seeded
      // user cannot act while business data is being removed. A failure here
      // (REDIS_URL configured) aborts before history/compensation/employees.
      await runPhase(timings, "sessions", () => cleanupSessions(userIds));
      // Exact canonical IDs only: intruders fail safe in preflight AND here.
      const employeeIds = await resolveSeedEmployeeScope(
        db,
        new Set(expectedSeedEmployeeIdsFor(organizations)),
        "rollback",
      );

      const historyScope = employeeIds.length;
      const historyBatches = await runPhase(timings, "history", () =>
        runBatches("rollback.history", employeeIds, ROLLBACK_BATCH_SIZE, async (ids) => {
          await db.compensationHistory.deleteMany({ where: { employeeId: { in: ids } } });
        }),
      );

      await assertRollbackPhaseEmpty(db, "history", employeeIds);
      const compensationBatches = await runPhase(timings, "compensation", () =>
        runBatches("rollback.compensation", employeeIds, ROLLBACK_BATCH_SIZE, async (ids) => {
          await db.employeeCompensation.deleteMany({ where: { employeeId: { in: ids } } });
        }),
      );

      await assertRollbackPhaseEmpty(db, "compensation", employeeIds);
      const employeeBatches = await runPhase(timings, "employees", () =>
        runBatches("rollback.employees", employeeIds, ROLLBACK_BATCH_SIZE, async (ids) => {
          await db.employee.deleteMany({ where: { id: { in: ids } } });
        }),
      );

      await assertRollbackPhaseEmpty(db, "employees", employeeIds);

      await runPhase(timings, "departments", async () => {
        await db.department.deleteMany({
          where: { id: { in: departments.map((department) => department.id) } },
        });
      });
      // FINAL PROTECTED BOUNDARY (mandatory): fresh audit partition + seed
      // memberships + controlled users in one small transaction with row
      // locks. Foreign rows appearing after preflight abort here — user rows
      // and audit attribution untouched.
      await runPhase(timings, "user-boundary", () =>
        runProtectedUserBoundary(db, {
          userIds,
          organizationIds,
          memberships: memberships.map((membership) => ({
            organizationId: membership.organizationId,
            userId: membership.userId,
          })),
        }),
      );
      // SESSION CLEANUP #2 (mandatory): catches sessions that existed in unusual timing windows
      // A failure here FAILS rollback: DB deletion may already be done
      // (rerunnable), but the result must never report success.
      // Session blocks REMAIN ACTIVE after this — only reseed clears them.
      await runPhase(timings, "sessions-verify", async () => {
        try {
          await cleanupSessions(userIds);
        } catch (error) {
          throw new Error(
            `[SEED-R1] database user deletion completed but session invalidation ` +
              `incomplete, rollback not complete: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      await runPhase(timings, "organizations", async () => {
        await db.organization.deleteMany({ where: { id: { in: organizationIds } } });
      });
      const result = await runPhase(timings, "verification", () => verifyRollback(db));

      log(
        `[${SEED_VERSION}] rollback batches: history=${historyBatches} compensation=${compensationBatches} employees=${employeeBatches} (size=${ROLLBACK_BATCH_SIZE})`,
      );
      log(
        `[${SEED_VERSION}] rollback scope: employees=${historyScope} (history/compensation cascade per employeeId batch)`,
      );

      rootSpan.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      rootSpan.recordException(error instanceof Error ? error : new Error(String(error)));
      rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      rootSpan.end();
    }
  });
};

export const runVerify = async (): Promise<Pick<SeedRunResult, "verification" | "fingerprint">> => {
  const password = assertPreflight(true)!;
  const verification = await verifySeed(prisma, password);
  const fingerprint = await calculateSeedFingerprint(prisma);

  logVerificationSummary(verification);
  log(`[${SEED_VERSION}] verification: PASS`);
  log(`[${SEED_VERSION}] fingerprint: ${fingerprint}`);

  return { verification, fingerprint };
};

export const main = async (operation: "seed" | "verify" | "rollback" = "seed"): Promise<void> => {
  const totalStartedAt = performance.now();

  try {
    const result = await withSeedLock(async () => {
      if (operation === "verify") return runVerify();
      if (operation === "rollback") return runRollback();

      return runSeed();
    });

    log(`[${SEED_VERSION}] total: ${(performance.now() - totalStartedAt).toFixed(0)}ms`);
    log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
    await shutdownTelemetry();
  }
};
