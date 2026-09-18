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
});
