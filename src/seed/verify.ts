import type { PrismaClient } from "@prisma/client";
import {
  ACME_SANDBOX_DEPARTMENT_COUNT,
  ACME_SANDBOX_EMPLOYEE_COUNT,
  ACME_SANDBOX_SLUG,
  CONTROLLED_USER_COUNT,
  ORGANIZATION_COUNT,
  PAYLENS_DEMO_DEPARTMENT_COUNT,
  PAYLENS_DEMO_EMPLOYEE_COUNT,
  PAYLENS_DEMO_SLUG,
  SEED_AS_OF_DATE,
  SEED_EMPLOYEE_PREFIX,
} from "./constants.js";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import {
  expectedSeedEmployeeIds,
  expectedTotalEmployees,
  generateControlledUsers,
  generateDepartments,
  generateMemberships,
  generateOrganizations,
} from "./data.js";

/**
 * Pure tenant rule: every non-null history actor must hold a membership in
 * the employee's organization. Null actors are system-generated seed history
 * and are never violations.
 */
export const findHistoryActorViolations = (
  entries: { employeeId: string; changedByUserId: string | null }[],
  employeeOrgById: Map<string, string>,
  membershipKeys: Set<string>,
): { employeeId: string; changedByUserId: string }[] =>
  entries.flatMap((entry) => {
    if (!entry.changedByUserId) return [];

    const organizationId = employeeOrgById.get(entry.employeeId);

    return organizationId && membershipKeys.has(`${organizationId}:${entry.changedByUserId}`)
      ? []
      : [{ employeeId: entry.employeeId, changedByUserId: entry.changedByUserId }];
  });

/**
 * Exact organization employee totals: every seeded org must contain exactly
 * its expected count — canonical-ID presence alone cannot catch a manual
 * row hiding inside a seed org. Pure over a DB `groupBy` result (missing
 * org = 0 rows, e.g. acme-sandbox).
 */
export const findOrganizationEmployeeCountViolations = (
  expected: { id: string; employeeCount: number }[],
  actualByOrganizationId: Map<string, number>,
): string[] =>
  expected.flatMap((organization) =>
    (actualByOrganizationId.get(organization.id) ?? 0) === organization.employeeCount
      ? []
      : [organization.id],
  );

/**
 * Exact membership-set diff over the canonical key
 * `organizationId:userId:role` (membership rows use non-deterministic cuid
 * IDs, so identity is the unique business key). Count-only checks cannot
 * catch a missing expected membership masked by an unrelated extra row.
 * Scope is seed organizations only — unrelated developer memberships
 * outside SEED-R1 orgs are never classified here.
 */
export const diffMembershipSets = (
  expected: { organizationId: string; userId: string; role: string }[],
  actual: { organizationId: string; userId: string; role: string }[],
): { missingExpectedMemberships: string[]; unexpectedMemberships: string[] } => {
  const actualKeys = new Set(
    actual.map((row) => `${row.organizationId}:${row.userId}:${row.role}`),
  );
  const expectedKeys = new Set(
    expected.map((row) => `${row.organizationId}:${row.userId}:${row.role}`),
  );

  return {
    missingExpectedMemberships: expected
      .map((row) => `${row.organizationId}:${row.userId}:${row.role}`)
      .filter((key) => !actualKeys.has(key)),
    unexpectedMemberships: actual
      .map((row) => `${row.organizationId}:${row.userId}:${row.role}`)
      .filter((key) => !expectedKeys.has(key)),
  };
};

export type SeedVerification = {
  organizations: number;
  users: number;
  memberships: number;
  missingExpectedMemberships: number;
  unexpectedMemberships: number;
  departments: number;
  employees: number;
  compensation: number;
  history: number;
  expectedEmployees: number;
  expectedEmployeeIdsPresent: number;
  missingExpectedEmployeeIds: number;
  unexpectedReservedPrefixEmployees: number;
  historyActorMembershipViolations: number;
  duplicateControlledEmails: number;
  duplicateOrganizationSlugs: number;
  duplicateMemberships: number;
  orphanEmployees: number;
  invalidDepartmentReferences: number;
  orphanCompensation: number;
  historyChronologyViolations: number;
  historyChainViolations: number;
  missingHistoryViolations: number;
  currentHistoryReconciliationViolations: number;
  invalidControlledPassword: number;
  organizationEmployeeCountMismatches: number;
};

const assertEquals = (label: string, actual: number, expected: number): void => {
  if (actual !== expected) {
    throw new Error(`[SEED-R1] ${label}: expected ${expected}, received ${actual}`);
  }
};

export const verifySeed = async (
  prisma: PrismaClient,
  password: string,
): Promise<SeedVerification> => {
  const organizations = generateOrganizations();
  const organizationIds = organizations.map((organization) => organization.id);
  const demo = organizations.find((organization) => organization.slug === PAYLENS_DEMO_SLUG)!;
  const sandbox = organizations.find((organization) => organization.slug === ACME_SANDBOX_SLUG)!;
  const expectedDepartments = organizations.flatMap(generateDepartments);
  const expectedMemberships = generateMemberships(organizations);
  // Ownership authority: the exact deterministic ID set, resolved in bounded
  // chunks. The prefix select below is diagnostic only (intruder detection).
  const expectedEmployeeIds = expectedSeedEmployeeIds(organizations);
  const expectedEmployeeIdSet = new Set(expectedEmployeeIds);
  const employeeIdChunks: string[][] = Array.from(
    { length: Math.ceil(expectedEmployeeIds.length / 500) },
    (_, index) => expectedEmployeeIds.slice(index * 500, (index + 1) * 500),
  );

  const [organizationCount, users, memberships, departments] = await Promise.all([
    prisma.organization.count({
      where: {
        id: {
          in: organizationIds,
        },
      },
    }),

    prisma.user.findMany({
      where: {
        id: {
          in: generateControlledUsers().map((user) => user.id),
        },
      },
      select: {
        id: true,
        email: true,
        passwordHash: true,
      },
    }),

    prisma.organizationMembership.findMany({
      where: {
        organizationId: {
          in: organizationIds,
        },
      },
      select: {
        organizationId: true,
        userId: true,
        role: true,
      },
    }),

    prisma.department.findMany({
      where: {
        organizationId: {
          in: organizationIds,
        },
      },
      select: {
        id: true,
        organizationId: true,
        code: true,
      },
    }),
  ]);
  const employees: { id: string; hireDate: Date; departmentId: string; organizationId: string }[] =
    [];

  for (const idChunk of employeeIdChunks) {
    const rows = await prisma.employee.findMany({
      where: { id: { in: idChunk } },
      select: { id: true, hireDate: true, departmentId: true, organizationId: true },
    });

    employees.push(...rows);
  }

  // Diagnostic only: reserved-prefix rows that are NOT canonical IDs.
  const prefixedIds = (
    await prisma.employee.findMany({
      where: {
        organizationId: { in: organizationIds },
        employeeNumber: { startsWith: SEED_EMPLOYEE_PREFIX },
      },
      select: { id: true },
    })
  ).map((row) => row.id);
  // Exact DB totals per seed org via aggregation — never row loading.
  // Catches manual rows hiding inside seed orgs that canonical-ID
  // presence checks cannot see.
  const employeeTotals = await prisma.employee.groupBy({
    by: ["organizationId"],
    where: { organizationId: { in: organizationIds } },
    _count: { _all: true },
  });
  const actualByOrganizationId = new Map(
    employeeTotals.map((row) => [row.organizationId, row._count._all]),
  );
  const { missingExpectedMemberships, unexpectedMemberships } = diffMembershipSets(
    expectedMemberships,
    memberships.map((row) => ({
      organizationId: row.organizationId,
      userId: row.userId,
      role: String(row.role),
    })),
  );
  const unexpectedReservedPrefixEmployees = prefixedIds.filter(
    (id) => !expectedEmployeeIdSet.has(id),
  ).length;
  const expectedEmployeeIdsPresent = employees.length;
  const missingExpectedEmployeeIds = expectedEmployeeIds.length - employees.length;
  // Bounded reads: never one enormous IN list, never a full-table scan.
  const readCompensationChunk = (idChunk: string[]) =>
    prisma.employeeCompensation.findMany({
      where: { employeeId: { in: idChunk } },
      select: {
        employeeId: true,
        annualBaseSalary: true,
        currency: true,
        effectiveFrom: true,
        version: true,
      },
    });
  const readHistoryChunk = (idChunk: string[]) =>
    prisma.compensationHistory.findMany({
      where: { employeeId: { in: idChunk } },
      select: {
        employeeId: true,
        version: true,
        previousAnnualBaseSalary: true,
        newAnnualBaseSalary: true,
        previousCurrency: true,
        newCurrency: true,
        previousEffectiveFrom: true,
        effectiveFrom: true,
        changedByUserId: true,
      },
      orderBy: [{ employeeId: "asc" }, { version: "asc" }],
    });
  const compensation: Awaited<ReturnType<typeof readCompensationChunk>> = [];
  const history: Awaited<ReturnType<typeof readHistoryChunk>> = [];

  for (const idChunk of employeeIdChunks) {
    const [compensationRows, historyRows] = await Promise.all([
      readCompensationChunk(idChunk),
      readHistoryChunk(idChunk),
    ]);

    compensation.push(...compensationRows);
    history.push(...historyRows);
  }

  const departmentKeys = new Set(
    departments.map((department) => `${department.organizationId}:${department.id}`),
  );
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const historyByEmployee = new Map<string, typeof history>();

  for (const entry of history) {
    historyByEmployee.set(entry.employeeId, [
      ...(historyByEmployee.get(entry.employeeId) ?? []),
      entry,
    ]);
  }

  const compensationByEmployee = new Map(compensation.map((entry) => [entry.employeeId, entry]));

  const duplicateControlledEmails = users.length - new Set(users.map((user) => user.email)).size;

  const duplicateOrganizationSlugs =
    organizationCount - new Set(organizations.map((organization) => organization.slug)).size;

  const duplicateMemberships =
    memberships.length -
    new Set(memberships.map((membership) => `${membership.organizationId}:${membership.userId}`))
      .size;

  const orphanEmployees = employees.filter(
    (employee) => !organizationIds.includes(employee.organizationId),
  ).length;

  const invalidDepartmentReferences = employees.filter(
    (employee) => !departmentKeys.has(`${employee.organizationId}:${employee.departmentId}`),
  ).length;

  const orphanCompensation = compensation.filter(
    (entry) => !employeeById.has(entry.employeeId),
  ).length;

  const employeeOrgById = new Map(
    employees.map((employee) => [employee.id, employee.organizationId]),
  );
  const membershipKeys = new Set(
    memberships.map((membership) => `${membership.organizationId}:${membership.userId}`),
  );
  const historyActorMembershipViolations = findHistoryActorViolations(
    history,
    employeeOrgById,
    membershipKeys,
  ).length;

  let historyChronologyViolations = 0;
  let historyChainViolations = 0;
  let missingHistoryViolations = 0;
  let currentHistoryReconciliationViolations = 0;

  for (const employee of employees) {
    const entries = historyByEmployee.get(employee.id) ?? [];
    const current = compensationByEmployee.get(employee.id);
    const latest = entries.at(-1);

    if (entries.length === 0 || (current && entries.length !== current.version))
      missingHistoryViolations += 1;

    if (
      !current ||
      !latest ||
      current.version !== latest.version ||
      current.annualBaseSalary.comparedTo(latest.newAnnualBaseSalary) !== 0 ||
      current.currency !== latest.newCurrency ||
      current.effectiveFrom.getTime() !== latest.effectiveFrom.getTime()
    ) {
      currentHistoryReconciliationViolations += 1;
    }

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const previous = entries[index - 1];

      if (
        entry.effectiveFrom > SEED_AS_OF_DATE ||
        entry.effectiveFrom < employee.hireDate ||
        (previous && entry.effectiveFrom <= previous.effectiveFrom)
      ) {
        historyChronologyViolations += 1;
      }

      if (
        entry.version !== index + 1 ||
        (!previous &&
          (entry.previousAnnualBaseSalary !== null ||
            entry.previousCurrency !== null ||
            entry.previousEffectiveFrom !== null)) ||
        (previous &&
          (entry.previousAnnualBaseSalary?.comparedTo(previous.newAnnualBaseSalary) !== 0 ||
            entry.previousCurrency !== previous.newCurrency ||
            entry.previousEffectiveFrom?.getTime() !== previous.effectiveFrom.getTime()))
      )
        historyChainViolations += 1;
    }
  }

  const organizationEmployeeCountMismatches = findOrganizationEmployeeCountViolations(
    organizations,
    actualByOrganizationId,
  ).length;
  const passwords = new PasswordService();
  const invalidControlledPassword = (
    await Promise.all(
      users.map((user) =>
        user.passwordHash ? passwords.verify(user.passwordHash, password) : false,
      ),
    )
  ).filter((isValid) => !isValid).length;

  const demoEmployees = employees.filter((employee) => employee.organizationId === demo.id).length;

  const demoDepartments = departments.filter(
    (department) => department.organizationId === demo.id,
  ).length;

  const sandboxEmployees = employees.filter(
    (employee) => employee.organizationId === sandbox.id,
  ).length;

  const sandboxDepartments = departments.filter(
    (department) => department.organizationId === sandbox.id,
  ).length;

  assertEquals("organizations", organizationCount, ORGANIZATION_COUNT);
  assertEquals("controlled users", users.length, CONTROLLED_USER_COUNT);
  assertEquals("memberships", memberships.length, expectedMemberships.length);
  assertEquals("missing expected memberships", missingExpectedMemberships.length, 0);
  assertEquals("unexpected memberships", unexpectedMemberships.length, 0);
  assertEquals("departments", departments.length, expectedDepartments.length);
  assertEquals("paylens-demo employees", demoEmployees, PAYLENS_DEMO_EMPLOYEE_COUNT);
  assertEquals("paylens-demo departments", demoDepartments, PAYLENS_DEMO_DEPARTMENT_COUNT);
  assertEquals("acme-sandbox employees", sandboxEmployees, ACME_SANDBOX_EMPLOYEE_COUNT);
  assertEquals("acme-sandbox departments", sandboxDepartments, ACME_SANDBOX_DEPARTMENT_COUNT);
  assertEquals("total seed employees", employees.length, expectedTotalEmployees());
  assertEquals(
    "expected employee IDs present",
    expectedEmployeeIdsPresent,
    expectedEmployeeIds.length,
  );
  assertEquals("missing expected employee IDs", missingExpectedEmployeeIds, 0);
  assertEquals("unexpected reserved-prefix employees", unexpectedReservedPrefixEmployees, 0);
  assertEquals("history actor membership violations", historyActorMembershipViolations, 0);
  assertEquals("organization employee count mismatches", organizationEmployeeCountMismatches, 0);
  assertEquals("duplicate controlled emails", duplicateControlledEmails, 0);
  assertEquals("duplicate organization slugs", duplicateOrganizationSlugs, 0);
  assertEquals("duplicate memberships", duplicateMemberships, 0);
  assertEquals("orphan employees", orphanEmployees, 0);
  assertEquals("invalid department references", invalidDepartmentReferences, 0);
  assertEquals("orphan compensation", orphanCompensation, 0);
  assertEquals("history chronology violations", historyChronologyViolations, 0);
  assertEquals("history chain violations", historyChainViolations, 0);
  assertEquals("missing history violations", missingHistoryViolations, 0);
  assertEquals(
    "current/history reconciliation violations",
    currentHistoryReconciliationViolations,
    0,
  );
  assertEquals("invalid controlled passwords", invalidControlledPassword, 0);

  return {
    organizations: organizationCount,
    users: users.length,
    memberships: memberships.length,
    missingExpectedMemberships: missingExpectedMemberships.length,
    unexpectedMemberships: unexpectedMemberships.length,
    departments: departments.length,
    employees: employees.length,
    compensation: compensation.length,
    history: history.length,
    expectedEmployees: expectedEmployeeIds.length,
    expectedEmployeeIdsPresent,
    missingExpectedEmployeeIds,
    unexpectedReservedPrefixEmployees,
    historyActorMembershipViolations,
    duplicateControlledEmails,
    duplicateOrganizationSlugs,
    duplicateMemberships,
    orphanEmployees,
    invalidDepartmentReferences,
    orphanCompensation,
    historyChronologyViolations,
    historyChainViolations,
    missingHistoryViolations,
    currentHistoryReconciliationViolations,
    invalidControlledPassword,
    organizationEmployeeCountMismatches,
  };
};
