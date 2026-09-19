import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DepartmentsService } from "@/modules/departments/departments.service.js";
import { EmployeesService } from "@/modules/employees/employees.service.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";

describe("employee directory integration", () => {
  let postgres: StartedTestContainer;
  let prisma: PrismaClient;
  let service: EmployeesService;
  let departments: DepartmentsService;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let sequence = 0;

  const unique = (prefix: string) => `${prefix}-${Date.now()}-${++sequence}`;

  const principalFor = (organizationId: string): RequestPrincipal => ({
    userId: "user-integration",
    sessionId: "session-integration",
    organizationId,
    membershipId: "membership-integration",
    role: "HR_MANAGER",
  });

  const createOrg = () =>
    prisma.organization.create({ data: { name: unique("Org"), slug: unique("org") } });

  const createDept = (organizationId: string, code: string, name: string) =>
    prisma.department.create({ data: { organizationId, code, name } });

  const createEmployee = (
    organizationId: string,
    departmentId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    prisma.employee.create({
      data: {
        organizationId,
        departmentId,
        employeeNumber: unique("EMP"),
        firstName: "Test",
        lastName: "Sharma",
        workEmail: `${unique("emp")}@paylens.test`,
        jobTitle: "Engineer",
        countryCode: "IN",
        employmentType: "FULL_TIME",
        status: "ACTIVE",
        hireDate: new Date("2022-01-15"),
        ...(overrides as Record<string, never>),
      },
    });

  const withCompensation = (employeeId: string, salary: string, currency = "INR") =>
    prisma.employeeCompensation.create({
      data: {
        employeeId,
        annualBaseSalary: salary,
        currency,
        effectiveFrom: new Date("2024-04-01"),
      },
    });

  const withHistory = (employeeId: string, version = 1) =>
    prisma.compensationHistory.create({
      data: {
        employeeId,
        version,
        newAnnualBaseSalary: "1000000.00",
        newCurrency: "INR",
        effectiveFrom: new Date("2024-04-01"),
        reason: "INITIAL",
      },
    });

  const seedOrg = async () => {
    const organization = await createOrg();
    const engineering = await createDept(organization.id, unique("ENG"), "Engineering");
    const finance = await createDept(organization.id, unique("FIN"), "Finance");

    const membership = await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: "user-integration", role: "HR_MANAGER" },
    });

    return { organization, engineering, finance, membership };
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

    execSync("npx prisma migrate deploy", { cwd: process.cwd(), stdio: "pipe" });

    prisma = new PrismaClient();
    await prisma.$connect();

    await prisma.user.upsert({
      where: { email: "directory-integration@paylens.test" },
      create: {
        id: "user-integration",
        email: "directory-integration@paylens.test",
        firstName: "Directory",
        lastName: "Integration",
      },
      update: {},
    });

    service = new EmployeesService(
      prisma as never,
      {
        now: () => Date.now(),
        durationSince: () => 0,
        debug: () => undefined,
      } as never,
      new DepartmentsService(
        prisma as never,
        {
          now: () => Date.now(),
          durationSince: () => 0,
          debug: () => undefined,
        } as never,
      ),
    );
    departments = new DepartmentsService(
      prisma as never,
      {
        now: () => Date.now(),
        durationSince: () => 0,
        debug: () => undefined,
      } as never,
    );
  }, 180000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await postgres?.stop();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("isolates tenants on list and detail", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const employeeA = await createEmployee(orgA.organization.id, orgA.engineering.id);
    const employeeB = await createEmployee(orgB.organization.id, orgB.engineering.id);

    const page = await service.list(
      { ...principalFor(orgA.organization.id), membershipId: orgA.membership.id },
      { limit: 25 },
    );

    expect(page.items.map((item) => item.id)).toContain(employeeA.id);
    expect(page.items.map((item) => item.id)).not.toContain(employeeB.id);

    await expect(
      service.detail(
        { ...principalFor(orgA.organization.id), membershipId: orgA.membership.id },
        employeeB.id,
      ),
    ).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND", status: 404 });
  });

  it("paginates duplicate last names deterministically without duplicates", async () => {
    const org = await seedOrg();

    for (let index = 0; index < 5; index += 1) {
      const employee = await createEmployee(org.organization.id, org.engineering.id, {
        employeeNumber: unique(`DUP-${index}`),
        lastName: "Carter",
      });

      await withCompensation(employee.id, "1000000.00");
    }

    const principal = { ...principalFor(org.organization.id), membershipId: org.membership.id };
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await service.list(principal, { limit: 2, cursor });

      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }

      pages += 1;
      cursor = page.pageInfo.nextCursor ?? undefined;

      if (!page.pageInfo.hasNextPage) {
        break;
      }
    } while (cursor && pages < 10);

    expect(seen.size).toBeGreaterThanOrEqual(5);
  });

  it("rejects malformed cursors", async () => {
    const org = await seedOrg();

    await expect(
      service.list(
        { ...principalFor(org.organization.id), membershipId: org.membership.id },
        { cursor: "!!not-base64!!" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("filters and searches workforce fields without compensation", async () => {
    const org = await seedOrg();
    const priya = await createEmployee(org.organization.id, org.engineering.id, {
      employeeNumber: unique("PRIYA"),
      firstName: "Priya",
      lastName: "Nair",
      workEmail: `${unique("priya")}@paylens.test`,
      countryCode: "IN",
      status: "ACTIVE",
    });

    await withCompensation(priya.id, "1850000.00", "INR");

    const onLeave = await createEmployee(org.organization.id, org.finance.id, {
      lastName: "Nair",
      countryCode: "US",
      status: "ON_LEAVE",
    });

    await withCompensation(onLeave.id, "128000.00", "USD");

    const principal = { ...principalFor(org.organization.id), membershipId: org.membership.id };

    const byDepartment = await service.list(principal, {
      departmentId: org.finance.id,
      limit: 25,
    });

    expect(byDepartment.items.map((item) => item.id)).toContain(onLeave.id);
    expect(byDepartment.items.map((item) => item.id)).not.toContain(priya.id);

    const combined = await service.list(principal, {
      countryCode: "IN",
      limit: 25,
      status: "ACTIVE",
    });

    expect(combined.items.map((item) => item.id)).toContain(priya.id);

    const searched = await service.list(principal, { search: "pRiYa", limit: 25 });

    expect(searched.items.map((item) => item.id)).toContain(priya.id);

    const workforce = searched.items.find((item) => item.id === priya.id);

    expect(workforce).not.toHaveProperty("currentCompensation");
    expect(workforce).toMatchObject({ hireDate: expect.any(String) });
  });

  it("searches approved prefixes case-insensitively without crossing tenant boundaries", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const shared = {
      employeeNumber: "EMP-SEARCH-0001",
      firstName: "Narendra",
      lastName: "Smith-Jones",
      workEmail: "narendra.search@paylens.test",
    };
    const employeeA = await createEmployee(orgA.organization.id, orgA.engineering.id, shared);
    const employeeB = await createEmployee(orgB.organization.id, orgB.engineering.id, shared);
    const principalA = { ...principalFor(orgA.organization.id), membershipId: orgA.membership.id };

    for (const search of ["nar", "smith-j", "narendra.search", "emp-search", "  NAR  "]) {
      const page = await service.list(principalA, { limit: 25, search });
      const ids = page.items.map((item) => item.id);

      expect(ids).toContain(employeeA.id);
      expect(ids).not.toContain(employeeB.id);
    }
  });

  it("sorts by hire date with tie-breaker ordering", async () => {
    const org = await seedOrg();
    const early = await createEmployee(org.organization.id, org.engineering.id, {
      hireDate: new Date("2020-01-10"),
      lastName: "Early",
    });
    const late = await createEmployee(org.organization.id, org.engineering.id, {
      hireDate: new Date("2024-06-01"),
      lastName: "Late",
    });
    const principal = { ...principalFor(org.organization.id), membershipId: org.membership.id };

    const asc = await service.list(principal, {
      direction: "asc",
      limit: 25,
      sort: "hireDate",
    });
    const desc = await service.list(principal, {
      direction: "desc",
      limit: 25,
      sort: "hireDate",
    });

    expect(asc.items.findIndex((item) => item.id === early.id)).toBeLessThan(
      asc.items.findIndex((item) => item.id === late.id),
    );
    expect(desc.items.findIndex((item) => item.id === late.id)).toBeLessThan(
      desc.items.findIndex((item) => item.id === early.id),
    );
  });

  it("lists only active-organization departments", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();

    const options = await departments.list({
      ...principalFor(orgA.organization.id),
      membershipId: orgA.membership.id,
    });

    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options.map((department) => department.name)).toEqual(
      [...options.map((department) => department.name)].sort(),
    );

    const names = options.map((department) => department.name);

    expect(names).toContain("Engineering");
    expect(names).toContain("Finance");

    const other = await prisma.department.findMany({
      where: { organizationId: orgB.organization.id },
    });

    for (const department of other) {
      expect(options.map((item) => item.id)).not.toContain(department.id);
    }
  });

  it("persists partial updates inside the active organization", async () => {
    const org = await seedOrg();
    const employee = await createEmployee(org.organization.id, org.engineering.id);
    const principal = { ...principalFor(org.organization.id), membershipId: org.membership.id };

    const updated = await service.updateEmployee(principal, employee.id, {
      firstName: "Asha",
      departmentId: org.finance.id,
      level: "L5",
      terminationDate: null,
    });

    expect(updated.firstName).toBe("Asha");
    expect(updated.department.id).toBe(org.finance.id);
    expect(updated.level).toBe("L5");

    const stored = await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });

    expect(stored.firstName).toBe("Asha");
    expect(stored.departmentId).toBe(org.finance.id);

    // Omitted fields are untouched; no compensation row is manufactured.
    expect(stored.employeeNumber).toBe(employee.employeeNumber);
    expect(
      await prisma.employeeCompensation.findUnique({ where: { employeeId: employee.id } }),
    ).toBeNull();
  });

  it("rejects cross-tenant update, delete, and department assignment safely", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const employeeB = await createEmployee(orgB.organization.id, orgB.engineering.id);
    const principalA = { ...principalFor(orgA.organization.id), membershipId: orgA.membership.id };

    await expect(
      service.updateEmployee(principalA, employeeB.id, { firstName: "X" }),
    ).rejects.toMatchObject({
      code: "EMPLOYEE_NOT_FOUND",
      status: 404,
    });

    await expect(service.deleteEmployee(principalA, employeeB.id)).rejects.toMatchObject({
      code: "EMPLOYEE_NOT_FOUND",
      status: 404,
    });

    const employeeA = await createEmployee(orgA.organization.id, orgA.engineering.id);

    await expect(
      service.updateEmployee(principalA, employeeA.id, { departmentId: orgB.engineering.id }),
    ).rejects.toMatchObject({ code: "DEPARTMENT_NOT_FOUND" });

    expect(await prisma.employee.findUnique({ where: { id: employeeB.id } })).not.toBeNull();
  });

  it("maps duplicate numbers to stable conflicts", async () => {
    const org = await seedOrg();
    const first = await createEmployee(org.organization.id, org.engineering.id);
    const second = await createEmployee(org.organization.id, org.engineering.id);
    const principal = { ...principalFor(org.organization.id), membershipId: org.membership.id };

    await expect(
      service.updateEmployee(principal, second.id, { employeeNumber: first.employeeNumber }),
    ).rejects.toMatchObject({ code: "EMPLOYEE_NUMBER_ALREADY_EXISTS", status: 409 });
  });

  it("deletes safe employees but protects compensation and history", async () => {
    const org = await seedOrg();
    const principal = { ...principalFor(org.organization.id), membershipId: org.membership.id };

    const safe = await createEmployee(org.organization.id, org.engineering.id);
    const result = await service.deleteEmployee(principal, safe.id);

    expect(result).toEqual({ deleted: true });
    expect(await prisma.employee.findUnique({ where: { id: safe.id } })).toBeNull();

    const protectedCurrent = await createEmployee(org.organization.id, org.engineering.id);

    await withCompensation(protectedCurrent.id, "2000000.00");

    await expect(service.deleteEmployee(principal, protectedCurrent.id)).rejects.toMatchObject({
      code: "EMPLOYEE_HAS_COMPENSATION_HISTORY",
      status: 409,
    });
    expect(await prisma.employee.findUnique({ where: { id: protectedCurrent.id } })).not.toBeNull();
    expect(
      await prisma.employeeCompensation.findUnique({ where: { employeeId: protectedCurrent.id } }),
    ).not.toBeNull();

    const protectedHistory = await createEmployee(org.organization.id, org.engineering.id);

    await withHistory(protectedHistory.id);

    await expect(service.deleteEmployee(principal, protectedHistory.id)).rejects.toMatchObject({
      code: "EMPLOYEE_HAS_COMPENSATION_HISTORY",
      status: 409,
    });
    expect(await prisma.employee.findUnique({ where: { id: protectedHistory.id } })).not.toBeNull();
    expect(
      await prisma.compensationHistory.findFirst({ where: { employeeId: protectedHistory.id } }),
    ).not.toBeNull();
  });

  it("enforces compensation delete protection directly in PostgreSQL", async () => {
    const org = await seedOrg();
    const protectedEmployee = await createEmployee(org.organization.id, org.engineering.id);

    await withCompensation(protectedEmployee.id, "2000000.00");
    await withHistory(protectedEmployee.id);

    await expect(
      prisma.employee.delete({ where: { id: protectedEmployee.id } }),
    ).rejects.toMatchObject({
      code: "P2003",
    });
    expect(
      await prisma.employee.findUnique({ where: { id: protectedEmployee.id } }),
    ).not.toBeNull();
    expect(
      await prisma.employeeCompensation.findUnique({ where: { employeeId: protectedEmployee.id } }),
    ).not.toBeNull();
    expect(
      await prisma.compensationHistory.findFirst({ where: { employeeId: protectedEmployee.id } }),
    ).not.toBeNull();
  });
});
