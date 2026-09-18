import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeesService } from "@/modules/employees/employees.service.js";
import { encodeCursor } from "@/common/pagination/cursor-pagination.util.js";
import type { MembershipRoleName } from "@/modules/auth/constants/auth.constants.js";

type Principal = {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  membershipId: string | null;
  role: MembershipRoleName | null;
};

const principalFor = (role: MembershipRoleName, org = "org-1"): Principal => ({
  userId: `user-${role.toLowerCase()}`,
  sessionId: "session-1",
  organizationId: org,
  membershipId: `membership-${role.toLowerCase()}`,
  role,
});

const row = (overrides: Record<string, unknown> = {}) => ({
  id: "emp-1",
  employeeNumber: "PLD-000001",
  firstName: "Olivia",
  lastName: "Carter",
  workEmail: "olivia.carter@acme.example",
  jobTitle: "Engineer",
  level: "L4",
  countryCode: "IN",
  employmentType: "FULL_TIME",
  status: "ACTIVE",
  hireDate: new Date("2022-03-01"),
  terminationDate: null,
  createdAt: new Date("2022-03-01T00:00:00.000Z"),
  updatedAt: new Date("2022-03-02T00:00:00.000Z"),
  department: { id: "dept-eng", code: "ENG", name: "Engineering" },
  ...overrides,
});

const createHarness = () => {
  const prisma = {
    organizationMembership: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: Record<string, string> }).where;

        if (where.organizationId === "org-1" && where.userId.startsWith("user-")) {
          const role = (where.userId.replace("user-", "").toUpperCase() || "HR_MANAGER") as string;

          return { organizationId: "org-1", role };
        }

        return { organizationId: where.organizationId, role: "HR_MANAGER" };
      }),
    },
    employee: {
      findMany: vi.fn((): Promise<unknown> => Promise.resolve([row()])),
      findFirst: vi.fn((): Promise<unknown> => Promise.resolve(row())),
      count: vi.fn(async () => 99),
      create: vi.fn((args: { data: Record<string, unknown> }): Promise<unknown> =>
        Promise.resolve(
          row({
            ...args.data,
            id: "emp-new",
            department: { id: "dept-eng", code: "ENG", name: "Engineering" },
          }),
        ),
      ),
    },
  };

  const departments = {
    findTenantDepartmentOrThrow: vi.fn(async () => ({ id: "dept-eng" })),
  };

  const service = new EmployeesService(
    prisma as never,
    {
      now: () => 0,
      durationSince: () => 0,
      debug: () => undefined,
    } as never,
    departments as never,
  );

  return { prisma, service, departments };
};

describe("EmployeesService", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    vi.clearAllMocks();
    harness.prisma.organizationMembership.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: Record<string, string> }).where;

      if (where.organizationId === "org-1") {
        const rolePart = where.userId.replace("user-", "").toUpperCase();
        const role = (
          [
            "TENANT_OWNER",
            "HR_ADMIN",
            "HR_MANAGER",
            "MANAGER",
            "EMPLOYEE",
            "VIEWER_AUDITOR",
          ].includes(rolePart)
            ? rolePart
            : "HR_MANAGER"
        ) as MembershipRoleName;

        return { organizationId: "org-1", role };
      }

      return { organizationId: where.organizationId, role: "HR_MANAGER" as MembershipRoleName };
    });
    harness.prisma.employee.findMany.mockImplementation(async () => [row()]);
    harness.prisma.employee.findFirst.mockImplementation(async () => row());
  });

  it("scopes the directory query to the active organization and never counts", async () => {
    const { prisma, service } = harness;

    await service.list(principalFor("HR_MANAGER"), {});

    expect(prisma.employee.findMany).toHaveBeenCalledTimes(1);

    const args = (prisma.employee.findMany.mock.calls as unknown[][])[0]?.[0] as {
      where: Record<string, unknown>;
      take: number;
    };

    expect(args.where.organizationId).toBe("org-1");
    expect(args.take).toBe(26);
    expect(prisma.employee.count).not.toHaveBeenCalled();
  });

  it("uses a targeted select without compensation history", async () => {
    const { prisma, service } = harness;

    await service.list(principalFor("HR_MANAGER"), {});

    const args = (prisma.employee.findMany.mock.calls as unknown[][])[0]?.[0] as {
      select: Record<string, unknown>;
    };

    expect(args.select).toMatchObject({
      id: true,
      employeeNumber: true,
      department: { select: { id: true, code: true, name: true } },
    });
    expect(JSON.stringify(args.select)).not.toContain("compensationHistory");
    expect(JSON.stringify(args.select)).not.toContain("currentCompensation");
  });

  it("combines filters with AND and treats blank search as no search", async () => {
    const { prisma, service } = harness;

    await service.list(principalFor("HR_MANAGER"), {
      departmentId: "dept-eng",
      countryCode: "in",
      status: "ACTIVE",
      employmentType: "FULL_TIME",
      search: "   ",
    });

    const args = (prisma.employee.findMany.mock.calls as unknown[][])[0]?.[0] as {
      where: Record<string, unknown>;
    };

    expect(args.where).toMatchObject({
      organizationId: "org-1",
      departmentId: "dept-eng",
      countryCode: "IN",
      status: "ACTIVE",
      employmentType: "FULL_TIME",
    });
    expect(args.where).not.toHaveProperty("OR");
  });

  it("builds a case-insensitive search across identity fields", async () => {
    const { prisma, service } = harness;

    await service.list(principalFor("HR_MANAGER"), { search: "  oli  " });

    const args = (prisma.employee.findMany.mock.calls as unknown[][])[0]?.[0] as {
      where: { OR: Record<string, unknown>[] };
    };

    expect(args.where.OR).toHaveLength(5);
    expect(args.where.OR[0]).toEqual({
      firstName: { contains: "oli", mode: "insensitive" },
    });
    expect(args.where.OR[3]).toEqual({
      employeeNumber: { contains: "oli", mode: "insensitive" },
    });
  });

  it.each([
    ["lastName", [{ lastName: "asc" }, { id: "asc" }]],
    ["hireDate", [{ hireDate: "desc" }, { id: "desc" }]],
    ["employeeNumber", [{ employeeNumber: "asc" }, { id: "asc" }]],
  ] as const)("orders %s with a deterministic id tie-breaker", async (sort, orderBy) => {
    const { prisma, service } = harness;

    await service.list(principalFor("HR_MANAGER"), {
      direction: sort === "hireDate" ? "desc" : "asc",
      sort,
    });

    const args = (prisma.employee.findMany.mock.calls as unknown[][])[0]?.[0] as {
      orderBy: unknown;
    };

    expect(args.orderBy).toEqual(orderBy);
  });

  it("defaults to lastName ASC with id ASC", async () => {
    const { prisma, service } = harness;

    await service.list(principalFor("HR_MANAGER"), {});

    const args = (prisma.employee.findMany.mock.calls as unknown[][])[0]?.[0] as {
      orderBy: unknown;
    };

    expect(args.orderBy).toEqual([{ lastName: "asc" }, { id: "asc" }]);
  });

  it("paginates with limit+1 and returns deterministic cursors without duplicates", async () => {
    const { prisma, service } = harness;
    const first = row({ id: "emp-1", lastName: "Carter" });
    const second = row({ id: "emp-2", lastName: "Carter" });
    const third = row({ id: "emp-3", lastName: "Dube" });

    prisma.employee.findMany.mockImplementationOnce(async () => [first, second, third]);

    const page = await service.list(principalFor("HR_MANAGER"), { limit: 2 });

    expect(page.items.map((item) => item.id)).toEqual(["emp-1", "emp-2"]);
    expect(page.pageInfo.hasNextPage).toBe(true);
    expect(page.pageInfo.nextCursor).toBeTruthy();

    prisma.employee.findMany.mockImplementationOnce(async () => [third]);

    const next = await service.list(principalFor("HR_MANAGER"), {
      cursor: page.pageInfo.nextCursor ?? undefined,
      limit: 2,
    });

    expect(next.items.map((item) => item.id)).toEqual(["emp-3"]);
    expect(next.pageInfo.hasNextPage).toBe(false);
    expect(next.pageInfo.nextCursor).toBeNull();

    const secondArgs = (prisma.employee.findMany.mock.calls as unknown[][])[1]?.[0] as {
      where: { AND: unknown[] };
    };

    expect(secondArgs.where.AND).toHaveLength(2);
  });

  it("binds cursors to tenant, filters, sort, direction, and page size", async () => {
    const { prisma, service } = harness;

    prisma.employee.findMany.mockImplementationOnce(async () => [row(), row({ id: "emp-2" })]);

    const page = await service.list(principalFor("HR_MANAGER"), {
      departmentId: "dept-eng",
      direction: "asc",
      limit: 1,
      sort: "lastName",
    });
    const cursor = page.pageInfo.nextCursor;

    expect(cursor).toBeTruthy();
    await expect(
      service.list(principalFor("HR_MANAGER"), {
        cursor: cursor ?? undefined,
        departmentId: "dept-eng",
        direction: "asc",
        limit: 1,
        sort: "lastName",
      }),
    ).resolves.toBeDefined();

    await Promise.all([
      expect(
        service.list(principalFor("HR_MANAGER", "org-2"), {
          cursor: cursor ?? undefined,
          departmentId: "dept-eng",
          direction: "asc",
          limit: 1,
          sort: "lastName",
        }),
      ).rejects.toMatchObject({ code: "INVALID_CURSOR" }),
      expect(
        service.list(principalFor("HR_MANAGER"), {
          cursor: cursor ?? undefined,
          departmentId: "dept-other",
          direction: "asc",
          limit: 1,
          sort: "lastName",
        }),
      ).rejects.toMatchObject({ code: "INVALID_CURSOR" }),
      expect(
        service.list(principalFor("HR_MANAGER"), {
          cursor: cursor ?? undefined,
          departmentId: "dept-eng",
          direction: "desc",
          limit: 1,
          sort: "lastName",
        }),
      ).rejects.toMatchObject({ code: "INVALID_CURSOR" }),
      expect(
        service.list(principalFor("HR_MANAGER"), {
          cursor: cursor ?? undefined,
          departmentId: "dept-eng",
          direction: "asc",
          limit: 1,
          sort: "hireDate",
        }),
      ).rejects.toMatchObject({ code: "INVALID_CURSOR" }),
    ]);
  });

  it("rejects malformed cursors with INVALID_CURSOR", async () => {
    const { service } = harness;

    await expect(
      service.list(principalFor("HR_MANAGER"), { cursor: "not-a-cursor!!" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("rejects a cursor encoded for another shape with INVALID_CURSOR", async () => {
    const { service } = harness;
    const foreign = encodeCursor({ hireDate: "2022-01-01", id: "emp-1" });

    await expect(
      service.list(principalFor("HR_MANAGER"), { cursor: foreign }),
    ).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
  });

  it("returns workforce fields without compensation exposure", async () => {
    const { service } = harness;

    const page = await service.list(principalFor("HR_MANAGER"), {});

    expect(page.items[0]).not.toHaveProperty("currentCompensation");
    expect(page.items[0]).toMatchObject({ id: "emp-1", hireDate: "2022-03-01" });
  });

  it("returns 404 for cross-tenant employee detail without leaking existence", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementationOnce(async () => null as never);

    await expect(
      service.detail(principalFor("HR_MANAGER", "org-1"), "emp-other-org"),
    ).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND", status: 404 });

    const args = (prisma.employee.findFirst.mock.calls as unknown[][])[0]?.[0] as {
      where: Record<string, unknown>;
    };

    expect(args.where).toEqual({ id: "emp-other-org", organizationId: "org-1" });
  });

  it("denies EMPLOYEE but allows VIEWER_AUDITOR to read the directory", async () => {
    const { service } = harness;

    await expect(service.list(principalFor("EMPLOYEE"), {})).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
      status: 403,
    });

    await expect(service.list(principalFor("VIEWER_AUDITOR"), {})).resolves.toMatchObject({
      pageInfo: { hasNextPage: false },
    });
  });
});

describe("EmployeesService workforce mutations", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    vi.clearAllMocks();
    harness.prisma.organizationMembership.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: Record<string, string> }).where;

      if (where.organizationId === "org-1") {
        const rolePart = where.userId.replace("user-", "").toUpperCase();
        const role = (
          [
            "TENANT_OWNER",
            "HR_ADMIN",
            "HR_MANAGER",
            "MANAGER",
            "EMPLOYEE",
            "VIEWER_AUDITOR",
          ].includes(rolePart)
            ? rolePart
            : "HR_MANAGER"
        ) as MembershipRoleName;

        return { organizationId: "org-1", role };
      }

      return { organizationId: where.organizationId, role: "HR_MANAGER" as MembershipRoleName };
    });
  });

  const createInput = (overrides: Record<string, unknown> = {}) => ({
    employeeNumber: "EMP-10428",
    firstName: "Olivia",
    lastName: "Carter",
    departmentId: "dept-eng",
    jobTitle: "Senior Software Engineer",
    countryCode: "US",
    employmentType: "FULL_TIME" as const,
    hireDate: "2026-09-18",
    ...overrides,
  });

  it("creates an ACTIVE employee under the active organization", async () => {
    const { prisma, service, departments } = harness;

    prisma.employee.findFirst.mockImplementation(async () => null);

    const created = await service.createEmployee(principalFor("HR_MANAGER"), createInput());

    expect(departments.findTenantDepartmentOrThrow).toHaveBeenCalledWith("org-1", "dept-eng");

    const args = (prisma.employee.create.mock.calls as unknown[][])[0]?.[0] as {
      data: Record<string, unknown>;
    };

    expect(args.data).toMatchObject({
      organizationId: "org-1",
      departmentId: "dept-eng",
      employeeNumber: "EMP-10428",
      status: "ACTIVE",
      workEmail: null,
    });
    expect(args.data.hireDate).toBeInstanceOf(Date);
    expect(created.status).toBe("ACTIVE");
    expect(created).not.toHaveProperty("currentCompensation");
  });

  it("rejects cross-tenant departments without revealing them", async () => {
    const { prisma, service, departments } = harness;

    departments.findTenantDepartmentOrThrow.mockRejectedValueOnce({
      code: "DEPARTMENT_NOT_FOUND",
    });

    await expect(
      service.createEmployee(principalFor("HR_MANAGER"), createInput()),
    ).rejects.toMatchObject({ code: "DEPARTMENT_NOT_FOUND" });
    expect(departments.findTenantDepartmentOrThrow).toHaveBeenCalledWith("org-1", "dept-eng");
    expect(prisma.employee.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate employee numbers and emails with stable 409s", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementationOnce(async () => ({ id: "emp-old" }));

    await expect(
      service.createEmployee(principalFor("HR_MANAGER"), createInput()),
    ).rejects.toMatchObject({ code: "EMPLOYEE_NUMBER_ALREADY_EXISTS", status: 409 });

    prisma.employee.findFirst.mockImplementationOnce(async () => null);
    prisma.employee.findFirst.mockImplementationOnce(async () => ({ id: "emp-old" }));

    await expect(
      service.createEmployee(
        principalFor("HR_MANAGER"),
        createInput({ workEmail: "olivia@acme.example" }),
      ),
    ).rejects.toMatchObject({ code: "EMPLOYEE_EMAIL_ALREADY_EXISTS", status: 409 });
  });

  it("denies employee onboarding to read-only roles", async () => {
    const { service } = harness;

    await expect(
      service.createEmployee(principalFor("MANAGER"), createInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION", status: 403 });
  });

  it("normalizes direct service input to the canonical form", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementation(async () => null);

    await service.createEmployee(
      principalFor("HR_MANAGER"),
      createInput({
        employeeNumber: "  EMP-10428  ",
        firstName: "  Olivia ",
        lastName: " Carter  ",
        workEmail: "  Olivia.Carter@Acme.Example  ",
        jobTitle: "  Senior Software Engineer ",
        level: " L4 ",
        countryCode: "us",
      }),
    );

    const emailCheck = (prisma.employee.findFirst.mock.calls as unknown[][])[1]?.[0] as {
      where: Record<string, unknown>;
    };

    expect(emailCheck.where).toMatchObject({
      organizationId: "org-1",
      workEmail: "olivia.carter@acme.example",
    });

    const args = (prisma.employee.create.mock.calls as unknown[][])[0]?.[0] as {
      data: Record<string, unknown>;
    };

    expect(args.data).toMatchObject({
      employeeNumber: "EMP-10428",
      firstName: "Olivia",
      lastName: "Carter",
      workEmail: "olivia.carter@acme.example",
      jobTitle: "Senior Software Engineer",
      level: "L4",
      countryCode: "US",
    });
  });

  it("rejects non-date cursor payloads with INVALID_CURSOR", async () => {
    const { service } = harness;
    const banana = encodeCursor({ hireDate: "banana", id: "emp-1" });

    await expect(
      service.list(principalFor("HR_MANAGER"), { cursor: banana, sort: "hireDate" }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("rejects non-date-only hire dates with INVALID_HIRE_DATE", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementation(async () => null);

    await expect(
      service.createEmployee(principalFor("HR_MANAGER"), createInput({ hireDate: "not-a-date" })),
    ).rejects.toMatchObject({ code: "INVALID_HIRE_DATE", status: 400 });

    await expect(
      service.createEmployee(
        principalFor("HR_MANAGER"),
        createInput({ hireDate: "2026-09-18T10:00:00.000Z" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_HIRE_DATE", status: 400 });
  });
});
