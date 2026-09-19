import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { SEED_VERSION } from "./constants.js";
import {
  expectedSeedEmployeeIds,
  generateControlledUsers,
  generateDepartments,
  generateOrganizations,
} from "./data.js";

export const calculateSeedFingerprint = async (prisma: PrismaClient): Promise<string> => {
  const organizations = generateOrganizations();
  const organizationIds = organizations.map((organization) => organization.id);
  const userIds = generateControlledUsers().map((user) => user.id);
  const departmentIds = organizations
    .flatMap(generateDepartments)
    .map((department) => department.id);
  // Fingerprint scope is the exact canonical ID set, read in bounded chunks.
  const expectedEmployeeIds = expectedSeedEmployeeIds(organizations);

  const readEmployeeChunk = (idChunk: string[]) =>
    prisma.employee.findMany({
      where: { id: { in: idChunk } },
      select: {
        id: true,
        organizationId: true,
        departmentId: true,
        employeeNumber: true,
        firstName: true,
        lastName: true,
        workEmail: true,
        jobTitle: true,
        level: true,
        countryCode: true,
        employmentType: true,
        status: true,
        hireDate: true,
        terminationDate: true,
      },
    });

  type EmployeeRow = Awaited<ReturnType<typeof readEmployeeChunk>>[number];

  const [organizationsRows, users, memberships, departments] = await Promise.all([
    prisma.organization.findMany({
      where: { id: { in: organizationIds } },
      select: { id: true, name: true, slug: true, status: true },
      orderBy: { slug: "asc" },
    }),
    prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        status: true,
        emailVerifiedAt: true,
      },
      orderBy: { email: "asc" },
    }),
    prisma.organizationMembership.findMany({
      where: { organizationId: { in: organizationIds }, userId: { in: userIds } },
      select: { organizationId: true, userId: true, role: true, status: true },
      orderBy: [{ organizationId: "asc" }, { userId: "asc" }],
    }),
    prisma.department.findMany({
      where: { id: { in: departmentIds } },
      select: { id: true, organizationId: true, code: true, name: true },
      orderBy: [{ organizationId: "asc" }, { code: "asc" }],
    }),
  ]);

  const employees: EmployeeRow[] = [];

  for (let index = 0; index < expectedEmployeeIds.length; index += 500) {
    const rows = await readEmployeeChunk(expectedEmployeeIds.slice(index, index + 500));

    employees.push(...rows);
  }

  employees.sort((left, right) =>
    left.organizationId < right.organizationId
      ? -1
      : left.organizationId > right.organizationId
        ? 1
        : left.employeeNumber < right.employeeNumber
          ? -1
          : left.employeeNumber > right.employeeNumber
            ? 1
            : 0,
  );

  const employeeIds = employees.map((employee) => employee.id);
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
      orderBy: { employeeId: "asc" },
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
        reason: true,
        note: true,
        changedByUserId: true,
      },
      orderBy: [{ employeeId: "asc" }, { version: "asc" }],
    });

  type CompensationRow = Awaited<ReturnType<typeof readCompensationChunk>>[number];

  type HistoryRow = Awaited<ReturnType<typeof readHistoryChunk>>[number];

  const compensation: CompensationRow[] = [];
  const history: HistoryRow[] = [];

  for (let index = 0; index < employeeIds.length; index += 500) {
    const idChunk = employeeIds.slice(index, index + 500);
    const [compensationRows, historyRows] = await Promise.all([
      readCompensationChunk(idChunk),
      readHistoryChunk(idChunk),
    ]);

    compensation.push(...compensationRows);
    history.push(...historyRows);
  }

  const projection = {
    seedVersion: SEED_VERSION,
    organizations: organizationsRows.map(({ id, name, slug, status }) => ({
      id,
      name,
      slug,
      status,
    })),
    users: users.map(({ id, email, firstName, lastName, status, emailVerifiedAt }) => ({
      id,
      email,
      firstName,
      lastName,
      status,
      emailVerifiedAt: emailVerifiedAt?.toISOString() ?? null,
    })),
    memberships: memberships.map(({ organizationId, userId, role, status }) => ({
      organizationId,
      userId,
      role,
      status,
    })),
    departments: departments.map(({ id, organizationId, code, name }) => ({
      id,
      organizationId,
      code,
      name,
    })),
    employees: employees.map((employee) => ({
      id: employee.id,
      organizationId: employee.organizationId,
      departmentId: employee.departmentId,
      employeeNumber: employee.employeeNumber,
      firstName: employee.firstName,
      lastName: employee.lastName,
      workEmail: employee.workEmail,
      jobTitle: employee.jobTitle,
      level: employee.level,
      countryCode: employee.countryCode,
      employmentType: employee.employmentType,
      status: employee.status,
      hireDate: employee.hireDate.toISOString(),
      terminationDate: employee.terminationDate?.toISOString() ?? null,
    })),
    compensation: compensation.map((entry) => ({
      employeeId: entry.employeeId,
      annualBaseSalary: entry.annualBaseSalary.toFixed(2),
      currency: entry.currency,
      effectiveFrom: entry.effectiveFrom.toISOString(),
      version: entry.version,
    })),
    history: history.map((entry) => ({
      employeeId: entry.employeeId,
      version: entry.version,
      previousAnnualBaseSalary: entry.previousAnnualBaseSalary?.toFixed(2) ?? null,
      newAnnualBaseSalary: entry.newAnnualBaseSalary.toFixed(2),
      previousCurrency: entry.previousCurrency,
      newCurrency: entry.newCurrency,
      previousEffectiveFrom: entry.previousEffectiveFrom?.toISOString() ?? null,
      effectiveFrom: entry.effectiveFrom.toISOString(),
      reason: entry.reason,
      note: entry.note,
      changedByUserId: entry.changedByUserId,
    })),
  };

  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
};
