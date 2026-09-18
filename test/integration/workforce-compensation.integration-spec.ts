import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("workforce and compensation database invariants", () => {
  let postgres: StartedTestContainer;
  let prisma: PrismaClient;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let sequence = 0;

  const unique = (prefix: string) => `${prefix}-${++sequence}`;

  const createOrganization = () =>
    prisma.organization.create({
      data: { name: unique("Organization"), slug: unique("organization") },
    });

  const createDepartment = (organizationId: string, code = unique("DEPT")) =>
    prisma.department.create({
      data: { organizationId, code, name: `${code} Department` },
    });

  const createEmployee = async (
    organizationId: string,
    departmentId: string,
    overrides: Partial<{
      employeeNumber: string;
      workEmail: string | null;
      lastName: string;
    }> = {},
  ) =>
    prisma.employee.create({
      data: {
        organizationId,
        departmentId,
        employeeNumber: overrides.employeeNumber ?? unique("EMP"),
        firstName: "Asha",
        lastName: overrides.lastName ?? "Sharma",
        workEmail:
          overrides.workEmail === undefined
            ? `${unique("employee")}@paylens.test`
            : overrides.workEmail,
        jobTitle: "Engineer",
        countryCode: "IN",
        employmentType: "FULL_TIME",
        status: "ACTIVE",
        hireDate: new Date("2024-01-15T00:00:00.000Z"),
      },
    });

  const createEmployeeFixture = async () => {
    const organization = await createOrganization();
    const department = await createDepartment(organization.id);
    const employee = await createEmployee(organization.id, department.id);

    return { organization, department, employee };
  };

  beforeAll(async () => {
    postgres = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: "paylens",
        POSTGRES_PASSWORD: "paylens",
        POSTGRES_USER: "paylens",
      })
      .withExposedPorts(5432)
      .start();

    process.env.DATABASE_URL = `postgresql://paylens:paylens@${postgres.getHost()}:${postgres.getMappedPort(5432)}/paylens`;
    execSync("npx prisma migrate deploy", {
      cwd: new URL("../..", import.meta.url).pathname,
      env: process.env,
      stdio: "pipe",
    });
    prisma = new PrismaClient();
    await prisma.$connect();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("creates and reads organization-scoped workforce and compensation relations", async () => {
    const { organization, department, employee } = await createEmployeeFixture();

    await prisma.employeeCompensation.create({
      data: {
        employeeId: employee.id,
        annualBaseSalary: "1234567.89",
        currency: "INR",
        effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
      },
    });
    await prisma.compensationHistory.create({
      data: {
        employeeId: employee.id,
        version: 1,
        newAnnualBaseSalary: "1234567.89",
        newCurrency: "INR",
        effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
        reason: "INITIAL",
      },
    });

    const found = await prisma.employee.findUniqueOrThrow({
      where: { id: employee.id },
      include: {
        organization: true,
        department: true,
        currentCompensation: true,
        compensationHistory: true,
      },
    });

    expect(found.organization.id).toBe(organization.id);
    expect(found.department.id).toBe(department.id);
    expect(found.currentCompensation?.annualBaseSalary.toFixed(2)).toBe("1234567.89");
    expect(found.compensationHistory).toHaveLength(1);
  });

  it("enforces tenant-scoped department, employee number, and work email uniqueness", async () => {
    const organizationA = await createOrganization();
    const organizationB = await createOrganization();
    const departmentA = await createDepartment(organizationA.id, "ENG");
    const departmentB = await createDepartment(organizationB.id, "ENG");

    await expect(createDepartment(organizationA.id, "ENG")).rejects.toMatchObject({
      code: "P2002",
    });
    await createEmployee(organizationA.id, departmentA.id, {
      employeeNumber: "EMP-0001",
      workEmail: "employee@paylens.test",
    });
    await expect(
      createEmployee(organizationA.id, departmentA.id, {
        employeeNumber: "EMP-0001",
        workEmail: "another@paylens.test",
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      createEmployee(organizationA.id, departmentA.id, {
        employeeNumber: "EMP-0002",
        workEmail: "employee@paylens.test",
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await createEmployee(organizationB.id, departmentB.id, {
      employeeNumber: "EMP-0001",
      workEmail: "employee@paylens.test",
    });
    await createEmployee(organizationA.id, departmentA.id, { workEmail: null });
    await createEmployee(organizationA.id, departmentA.id, { workEmail: null });
  });

  it("enforces one current compensation and one history record per resulting version", async () => {
    const { employee } = await createEmployeeFixture();
    const current = {
      employeeId: employee.id,
      annualBaseSalary: "100000.00",
      currency: "USD",
      effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
    };
    const history = {
      employeeId: employee.id,
      newAnnualBaseSalary: "100000.00",
      newCurrency: "USD",
      effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
      reason: "INITIAL" as const,
    };

    await prisma.employeeCompensation.create({ data: current });
    await expect(prisma.employeeCompensation.create({ data: current })).rejects.toMatchObject({
      code: "P2002",
    });
    await prisma.compensationHistory.create({ data: { ...history, version: 1 } });
    await expect(
      prisma.compensationHistory.create({ data: { ...history, version: 1 } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      prisma.compensationHistory.create({ data: { ...history, version: 2 } }),
    ).resolves.toMatchObject({
      version: 2,
    });
  });

  it("rejects negative salaries and non-positive compensation versions", async () => {
    const { employee } = await createEmployeeFixture();
    const effectiveFrom = new Date("2025-01-01T00:00:00.000Z");

    // This Prisma version surfaces raw PostgreSQL CHECK violations (23514)
    // as PrismaClientUnknownRequestError instead of mapping them to P2004.
    // Assert the constraint-safe rejection either way — the invariant (no
    // negative salary, no non-positive version) is what matters.
    const rejectsByCheckConstraint = async (operation: Promise<unknown>) => {
      await expect(operation).rejects.toSatisfy((error: unknown) => {
        if (typeof error !== "object" || error === null) {
          return false;
        }

        const code = (error as { code?: unknown }).code;

        if (code === "P2004") {
          return true;
        }

        const message = error instanceof Error ? error.message : String(error);

        return message.includes("23514");
      });
    };

    await rejectsByCheckConstraint(
      prisma.employeeCompensation.create({
        data: {
          employeeId: employee.id,
          annualBaseSalary: "-1.00",
          currency: "USD",
          effectiveFrom,
        },
      }),
    );
    await rejectsByCheckConstraint(
      prisma.employeeCompensation.create({
        data: {
          employeeId: employee.id,
          annualBaseSalary: "1.00",
          currency: "USD",
          effectiveFrom,
          version: 0,
        },
      }),
    );
    await rejectsByCheckConstraint(
      prisma.compensationHistory.create({
        data: {
          employeeId: employee.id,
          version: 0,
          newAnnualBaseSalary: "-1.00",
          newCurrency: "USD",
          effectiveFrom,
          reason: "INITIAL",
        },
      }),
    );
  });

  it("retains compensation history and nulls its actor when the user is deleted", async () => {
    const { employee } = await createEmployeeFixture();
    const actor = await prisma.user.create({
      data: {
        email: `${unique("actor")}@paylens.test`,
        firstName: "Actor",
        lastName: "User",
      },
    });
    const history = await prisma.compensationHistory.create({
      data: {
        employeeId: employee.id,
        version: 1,
        newAnnualBaseSalary: "100000.00",
        newCurrency: "USD",
        effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
        reason: "INITIAL",
        changedByUserId: actor.id,
      },
    });

    await prisma.user.delete({ where: { id: actor.id } });

    await expect(
      prisma.compensationHistory.findUniqueOrThrow({ where: { id: history.id } }),
    ).resolves.toMatchObject({
      changedByUserId: null,
    });
  });
});
