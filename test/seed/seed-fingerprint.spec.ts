import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { expectedSeedEmployeeIds } from "@/seed/data.js";
import { calculateSeedFingerprint } from "@/seed/fingerprint.js";

const money = (value: string) => new Prisma.Decimal(value);
const day = (iso: string) => new Date(iso);

// A genuine canonical ID so bounded id-IN chunk reads resolve this fixture row.
const CANONICAL_EMPLOYEE_ID = expectedSeedEmployeeIds()[0];

const baseRows = () => ({
  organizations: [{ id: "o1", name: "Org", slug: "org", status: "ACTIVE" }],
  users: [
    {
      id: "u1",
      email: "seed-r1.user01@seed.paylens.test",
      firstName: "Demo01",
      lastName: "User",
      status: "ACTIVE",
      emailVerifiedAt: day("2026-09-01T00:00:00.000Z"),
      passwordHash: "hash-v1",
      createdAt: day("2026-09-02T00:00:00.000Z"),
      updatedAt: day("2026-09-03T00:00:00.000Z"),
    },
  ],
  memberships: [{ organizationId: "o1", userId: "u1", role: "TENANT_OWNER", status: "ACTIVE" }],
  departments: [{ id: "d1", organizationId: "o1", code: "ENG", name: "Engineering" }],
  employees: [
    {
      id: CANONICAL_EMPLOYEE_ID,
      organizationId: "o1",
      departmentId: "d1",
      employeeNumber: "SEED-R1-ORG-00001",
      firstName: "Jane",
      lastName: "Doe",
      workEmail: "org.employee00001@seed.paylens.test",
      jobTitle: "Lead",
      level: "L4",
      countryCode: "US",
      employmentType: "FULL_TIME",
      status: "ACTIVE",
      hireDate: day("2020-01-15"),
      terminationDate: null,
    },
  ],
  compensation: [
    {
      employeeId: CANONICAL_EMPLOYEE_ID,
      annualBaseSalary: money("137800.00"),
      currency: "USD",
      effectiveFrom: day("2026-06-01"),
      version: 2,
    },
  ],
  history: [
    {
      employeeId: CANONICAL_EMPLOYEE_ID,
      version: 1,
      previousAnnualBaseSalary: null,
      newAnnualBaseSalary: money("121264.00"),
      previousCurrency: null,
      newCurrency: "USD",
      previousEffectiveFrom: null,
      effectiveFrom: day("2024-06-01"),
      reason: "INITIAL",
      note: "SEED-R1 deterministic compensation version 1",
      changedByUserId: "u1",
    },
    {
      employeeId: CANONICAL_EMPLOYEE_ID,
      version: 2,
      previousAnnualBaseSalary: money("121264.00"),
      newAnnualBaseSalary: money("137800.00"),
      previousCurrency: "USD",
      newCurrency: "USD",
      previousEffectiveFrom: day("2024-06-01"),
      effectiveFrom: day("2026-06-01"),
      reason: "ANNUAL_REVIEW",
      note: "SEED-R1 deterministic compensation version 2",
      changedByUserId: "u1",
    },
  ],
});

type Rows = ReturnType<typeof baseRows>;

const fakePrisma = (rows: Rows): PrismaClient => {
  const inIds = (args: unknown): string[] | null => {
    const where = (args as { where?: { id?: { in?: string[] } } } | undefined)?.where;

    return where?.id?.in ?? null;
  };
  const inEmployeeIds = (args: unknown): string[] | null => {
    const where = (args as { where?: { employeeId?: { in?: string[] } } } | undefined)?.where;

    return where?.employeeId?.in ?? null;
  };

  return {
    organization: { findMany: vi.fn(async () => rows.organizations) },
    user: { findMany: vi.fn(async () => rows.users) },
    organizationMembership: { findMany: vi.fn(async () => rows.memberships) },
    department: { findMany: vi.fn(async () => rows.departments) },
    employee: {
      findMany: vi.fn(async (args: unknown) => {
        const ids = inIds(args);

        return ids ? rows.employees.filter((row) => ids.includes(row.id)) : rows.employees;
      }),
    },
    employeeCompensation: {
      findMany: vi.fn(async (args: unknown) => {
        const ids = inEmployeeIds(args);

        return ids
          ? rows.compensation.filter((row) => ids.includes(row.employeeId))
          : rows.compensation;
      }),
    },
    compensationHistory: {
      findMany: vi.fn(async (args: unknown) => {
        const ids = inEmployeeIds(args);

        return ids ? rows.history.filter((row) => ids.includes(row.employeeId)) : rows.history;
      }),
    },
  } as unknown as PrismaClient;
};

describe("SEED-R1 fingerprint behavior", () => {
  it("changes when identity, department, salary, or history change", async () => {
    const baseline = await calculateSeedFingerprint(fakePrisma(baseRows()));

    const renamed = baseRows();

    renamed.employees[0].firstName = "Janet";
    await expect(calculateSeedFingerprint(fakePrisma(renamed))).resolves.not.toBe(baseline);

    const movedDept = baseRows();

    movedDept.employees[0].departmentId = "d2";
    await expect(calculateSeedFingerprint(fakePrisma(movedDept))).resolves.not.toBe(baseline);

    const raised = baseRows();

    raised.compensation[0].annualBaseSalary = money("150000.00");
    await expect(calculateSeedFingerprint(fakePrisma(raised))).resolves.not.toBe(baseline);

    const editedHistory = baseRows();

    editedHistory.history[1].note = "edited note";
    await expect(calculateSeedFingerprint(fakePrisma(editedHistory))).resolves.not.toBe(baseline);
  });

  it("does not depend on passwordHash, createdAt, or updatedAt", async () => {
    const baseline = await calculateSeedFingerprint(fakePrisma(baseRows()));
    const touched = baseRows();

    touched.users[0].passwordHash = "hash-v2-rotated";
    touched.users[0].createdAt = day("2026-10-01T00:00:00.000Z");
    touched.users[0].updatedAt = day("2026-10-02T00:00:00.000Z");

    await expect(calculateSeedFingerprint(fakePrisma(touched))).resolves.toBe(baseline);
  });
});
