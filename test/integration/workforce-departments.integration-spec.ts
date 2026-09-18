import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DepartmentsService } from "@/modules/departments/departments.service.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";

describe("workforce departments integration", () => {
  let postgres: StartedTestContainer;
  let prisma: PrismaClient;
  let service: DepartmentsService;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let sequence = 0;

  const unique = (prefix: string) => `${prefix}-${Date.now()}-${++sequence}`;

  const principalFor = (
    organizationId: string,
    membershipId: string,
    role: RequestPrincipal["role"] = "HR_MANAGER",
    userId = "user-departments",
  ): RequestPrincipal => ({
    userId,
    sessionId: "session-departments",
    organizationId,
    membershipId,
    role,
  });

  const seedOrg = async () => {
    const organization = await prisma.organization.create({
      data: { name: unique("Org"), slug: unique("org") },
    });
    const membership = await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: "user-departments", role: "HR_MANAGER" },
    });

    return { organization, membership };
  };

  const seedEmployee = async (organizationId: string, departmentId: string) => {
    const employee = await prisma.employee.create({
      data: {
        organizationId,
        departmentId,
        employeeNumber: unique("EMP"),
        firstName: "Dept",
        lastName: "Member",
        workEmail: `${unique("emp")}@paylens.test`,
        jobTitle: "Engineer",
        countryCode: "IN",
        employmentType: "FULL_TIME",
        status: "ACTIVE",
        hireDate: new Date("2022-01-15"),
      },
    });

    await prisma.employeeCompensation.create({
      data: {
        employeeId: employee.id,
        annualBaseSalary: "1200000.00",
        currency: "INR",
        effectiveFrom: new Date("2024-04-01"),
      },
    });

    return employee;
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
      where: { email: "departments-integration@paylens.test" },
      create: {
        id: "user-departments",
        email: "departments-integration@paylens.test",
        firstName: "Departments",
        lastName: "Integration",
      },
      update: {},
    });

    service = new DepartmentsService(
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

  it("creates a department and reads it back with counts", async () => {
    const org = await seedOrg();
    const principal = principalFor(org.organization.id, org.membership.id);

    const created = await service.create(principal, { code: "eng", name: "  Engineering  " });

    expect(created.code).toBe("ENG");
    expect(created.name).toBe("Engineering");
    expect(created.employeeCount).toBe(0);

    const detail = await service.detail(principal, created.id);

    expect(detail).toMatchObject({ id: created.id, code: "ENG", employeeCount: 0 });

    const list = await service.list(principal);

    expect(list.map((item) => item.id)).toContain(created.id);
  });

  it("isolates department lists between tenants", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();

    const createdA = await service.create(principalFor(orgA.organization.id, orgA.membership.id), {
      code: unique("AAA"),
      name: "Alpha",
    });
    const createdB = await service.create(principalFor(orgB.organization.id, orgB.membership.id), {
      code: unique("BBB"),
      name: "Beta",
    });

    const listA = await service.list(principalFor(orgA.organization.id, orgA.membership.id));

    expect(listA.map((item) => item.id)).toContain(createdA.id);
    expect(listA.map((item) => item.id)).not.toContain(createdB.id);
  });

  it("returns 404 for cross-tenant detail, update, and delete", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();

    const createdB = await service.create(principalFor(orgB.organization.id, orgB.membership.id), {
      code: unique("CCC"),
      name: "Gamma",
    });
    const foreign = principalFor(orgA.organization.id, orgA.membership.id);

    await expect(service.detail(foreign, createdB.id)).rejects.toMatchObject({
      code: "DEPARTMENT_NOT_FOUND",
      status: 404,
    });
    await expect(service.update(foreign, createdB.id, { name: "Hijacked" })).rejects.toMatchObject({
      code: "DEPARTMENT_NOT_FOUND",
      status: 404,
    });
    await expect(service.remove(foreign, createdB.id)).rejects.toMatchObject({
      code: "DEPARTMENT_NOT_FOUND",
      status: 404,
    });

    const intact = await service.detail(
      principalFor(orgB.organization.id, orgB.membership.id),
      createdB.id,
    );

    expect(intact.name).toBe("Gamma");
  });

  it("rejects duplicate codes within a tenant but allows them across tenants", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const code = unique("DUP");

    await service.create(principalFor(orgA.organization.id, orgA.membership.id), {
      code,
      name: "First",
    });

    await expect(
      service.create(principalFor(orgA.organization.id, orgA.membership.id), {
        code: code.toLowerCase(),
        name: "Second",
      }),
    ).rejects.toMatchObject({ code: "DEPARTMENT_CODE_ALREADY_EXISTS", status: 409 });

    const other = await service.create(principalFor(orgB.organization.id, orgB.membership.id), {
      code,
      name: "Other tenant",
    });

    expect(other.code).toBe(code.toUpperCase());
  });

  it("updates name and code with tenant-scoped duplicate protection", async () => {
    const org = await seedOrg();
    const principal = principalFor(org.organization.id, org.membership.id);

    const created = await service.create(principal, { code: unique("UPD"), name: "Before" });
    const updated = await service.update(principal, created.id, { name: "After" });

    expect(updated.name).toBe("After");
    expect(updated.code).toBe(created.code);

    const sibling = await service.create(principal, { code: unique("SIB"), name: "Sibling" });

    await expect(
      service.update(principal, created.id, { code: sibling.code }),
    ).rejects.toMatchObject({ code: "DEPARTMENT_CODE_ALREADY_EXISTS", status: 409 });
  });

  it("denies department mutations to read-only roles", async () => {
    const org = await seedOrg();

    // The service revalidates the membership from the database, so the
    // read-only principal needs a real VIEWER_AUDITOR membership row.
    await prisma.user.upsert({
      where: { email: "departments-viewer@paylens.test" },
      create: {
        id: "user-departments-viewer",
        email: "departments-viewer@paylens.test",
        firstName: "Viewer",
        lastName: "Integration",
      },
      update: {},
    });
    const viewerMembership = await prisma.organizationMembership.create({
      data: {
        organizationId: org.organization.id,
        userId: "user-departments-viewer",
        role: "VIEWER_AUDITOR",
      },
    });
    const viewer = principalFor(
      org.organization.id,
      viewerMembership.id,
      "VIEWER_AUDITOR",
      "user-departments-viewer",
    );

    await expect(
      service.create(viewer, { code: unique("ZZZ"), name: "Nope" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION", status: 403 });
    await expect(service.remove(viewer, "dept-ghost")).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
      status: 403,
    });
  });

  it("deletes an empty department", async () => {
    const org = await seedOrg();
    const principal = principalFor(org.organization.id, org.membership.id);

    const created = await service.create(principal, { code: unique("DEL"), name: "Temporary" });

    await expect(service.remove(principal, created.id)).resolves.toEqual({ deleted: true });
    await expect(service.detail(principal, created.id)).rejects.toMatchObject({
      code: "DEPARTMENT_NOT_FOUND",
      status: 404,
    });
  });

  it("blocks deleting a department with employees and keeps employee and compensation intact", async () => {
    const org = await seedOrg();
    const principal = principalFor(org.organization.id, org.membership.id);

    const created = await service.create(principal, { code: unique("INUSE"), name: "Staffed" });
    const employee = await seedEmployee(org.organization.id, created.id);

    await expect(service.remove(principal, created.id)).rejects.toMatchObject({
      code: "DEPARTMENT_IN_USE",
      status: 409,
    });

    const intact = await prisma.employee.findFirst({
      where: { id: employee.id, organizationId: org.organization.id },
      include: { currentCompensation: true },
    });

    expect(intact?.employeeNumber).toBe(employee.employeeNumber);
    expect(intact?.currentCompensation?.currency).toBe("INR");

    const detail = await service.detail(principal, created.id);

    expect(detail.employeeCount).toBe(1);
  });

  it("rejects cross-tenant employee/department assignment at the database", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();

    const deptB = await service.create(principalFor(orgB.organization.id, orgB.membership.id), {
      code: unique("XTFK"),
      name: "Foreign",
    });

    // The composite (organizationId, departmentId) FK makes this impossible
    // below the application layer — no service validation involved.
    await expect(
      prisma.employee.create({
        data: {
          organizationId: orgA.organization.id,
          departmentId: deptB.id,
          employeeNumber: unique("XTEMP"),
          firstName: "Cross",
          lastName: "Tenant",
          jobTitle: "Engineer",
          countryCode: "IN",
          employmentType: "FULL_TIME",
          status: "ACTIVE",
          hireDate: new Date("2022-01-15"),
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (typeof error !== "object" || error === null) {
        return false;
      }

      const code = (error as { code?: unknown }).code;

      // Prisma FK violations (P2003) or raw PostgreSQL FK errors (23503).
      if (code === "P2003") {
        return true;
      }

      const message = error instanceof Error ? error.message : String(error);

      return message.includes("23503");
    });
  });

  it("enforces RESTRICT on raw department delete and preserves history", async () => {
    const org = await seedOrg();
    const principal = principalFor(org.organization.id, org.membership.id);

    const created = await service.create(principal, { code: unique("RAW"), name: "Guarded" });
    const employee = await seedEmployee(org.organization.id, created.id);

    await prisma.compensationHistory.create({
      data: {
        employeeId: employee.id,
        version: 1,
        newAnnualBaseSalary: "1200000.00",
        newCurrency: "INR",
        effectiveFrom: new Date("2024-04-01"),
        reason: "INITIAL",
      },
    });

    await expect(prisma.department.delete({ where: { id: created.id } })).rejects.toSatisfy(
      (error: unknown) => {
        if (typeof error !== "object" || error === null) {
          return false;
        }

        const code = (error as { code?: unknown }).code;

        if (code === "P2003" || code === "P2014") {
          return true;
        }

        const message = error instanceof Error ? error.message : String(error);

        return message.includes("23503");
      },
    );

    const employeeIntact = await prisma.employee.findUnique({ where: { id: employee.id } });
    const compensationIntact = await prisma.employeeCompensation.findUnique({
      where: { employeeId: employee.id },
    });
    const historyIntact = await prisma.compensationHistory.findMany({
      where: { employeeId: employee.id },
    });

    expect(employeeIntact?.id).toBe(employee.id);
    expect(compensationIntact?.employeeId).toBe(employee.id);
    expect(historyIntact).toHaveLength(1);
  });
});
