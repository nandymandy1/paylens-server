import { Prisma } from "@prisma/client";
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
  const searchRow = () => {
    const { department, ...employee } = row();

    return {
      ...employee,
      departmentId: department.id,
      departmentCode: department.code,
      departmentName: department.name,
    };
  };
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
      update: vi.fn(
        (args: {
          data: Record<string, unknown>;
          where: Record<string, unknown>;
        }): Promise<unknown> => Promise.resolve(row({ ...args.data })),
      ),
      delete: vi.fn((): Promise<unknown> => Promise.resolve(row())),
    },
    department: {
      findFirst: vi.fn((): Promise<unknown> => Promise.resolve({ id: "dept-eng" })),
    },
    employeeCompensation: {
      findUnique: vi.fn((): Promise<unknown> => Promise.resolve(null)),
    },
    compensationHistory: {
      findFirst: vi.fn((): Promise<unknown> => Promise.resolve(null)),
    },
    mutationIdempotency: {
      findUnique: vi.fn((): Promise<unknown> => Promise.resolve(null)),
      create: vi.fn((): Promise<unknown> => Promise.resolve({ id: "idem-1" })),
      update: vi.fn((): Promise<unknown> =>
        Promise.resolve({ id: "idem-1", resourceId: "emp-new" }),
      ),
    },
    $queryRaw: vi.fn((): Promise<unknown> => Promise.resolve([searchRow()])),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      // The service re-reads protection state inside the transaction; reuse
      // the same mocked delegates so tests control both reads.
      return fn(prisma);
    }),
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

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.employee.findMany).not.toHaveBeenCalled();
  });

  it("searches every approved field with one tenant-scoped prefix predicate", async () => {
    const { prisma, service } = harness;

    await service.list(principalFor("HR_MANAGER"), { search: "Olivia@" });
    await service.list(principalFor("HR_MANAGER"), { search: "EMP-001" });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of prisma.$queryRaw.mock.calls as unknown[][]) {
      const sql = query as { strings: readonly string[] };

      expect(sql.strings.join(" ")).toContain('e."organizationId"');
      expect(sql.strings.join(" ")).toContain('LOWER(e."firstName") LIKE');
      expect(sql.strings.join(" ")).toContain('LOWER(e."lastName") LIKE');
      expect(sql.strings.join(" ")).toContain('LOWER(e."workEmail") LIKE');
      expect(sql.strings.join(" ")).toContain('LOWER(e."employeeNumber") LIKE');
      expect(sql.strings.join(" ")).not.toContain('e."jobTitle" ILIKE');
    }
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
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementation(async () => null);

    const created = await service.createEmployee(
      principalFor("HR_MANAGER"),
      createInput(),
      "employee-create-key-0001",
    );

    expect(prisma.department.findFirst).toHaveBeenCalledWith({
      where: { id: "dept-eng", organizationId: "org-1" },
      select: { id: true },
    });

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

  it("replays the immutable creation snapshot after the employee changes or is removed", async () => {
    const { prisma, service } = harness;

    const key = "employee-create-key-replay";
    const created = await service.createEmployee(principalFor("HR_MANAGER"), createInput(), key);
    const reservation = (prisma.mutationIdempotency.create.mock.calls as unknown[][])[0]?.[0] as {
      data: { requestHash: string };
    };

    prisma.mutationIdempotency.findUnique.mockResolvedValueOnce({
      id: "idem-1",
      requestHash: reservation.data.requestHash,
      resourceId: created.id,
      responsePayload: created,
    });
    prisma.employee.create.mockClear();
    prisma.employee.findFirst.mockResolvedValue(null);

    await expect(
      service.createEmployee(principalFor("HR_MANAGER"), createInput(), key),
    ).resolves.toEqual(created);
    expect(prisma.employee.create).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant departments without revealing them", async () => {
    const { prisma, service } = harness;

    prisma.department.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.createEmployee(principalFor("HR_MANAGER"), createInput(), "employee-create-key-0002"),
    ).rejects.toMatchObject({ code: "DEPARTMENT_NOT_FOUND" });
    expect(prisma.employee.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate employee numbers and emails with stable 409s", async () => {
    const { prisma, service } = harness;

    prisma.employee.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        clientVersion: "6.19.0",
        code: "P2002",
        meta: { target: ["employeeNumber"] },
      }),
    );

    await expect(
      service.createEmployee(principalFor("HR_MANAGER"), createInput(), "employee-create-key-0003"),
    ).rejects.toMatchObject({ code: "EMPLOYEE_NUMBER_ALREADY_EXISTS", status: 409 });

    prisma.employee.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        clientVersion: "6.19.0",
        code: "P2002",
        meta: { target: ["workEmail"] },
      }),
    );

    await expect(
      service.createEmployee(
        principalFor("HR_MANAGER"),
        createInput({ workEmail: "olivia@acme.example" }),
        "employee-create-key-0004",
      ),
    ).rejects.toMatchObject({ code: "EMPLOYEE_EMAIL_ALREADY_EXISTS", status: 409 });
  });

  it("denies employee onboarding to read-only roles", async () => {
    const { service } = harness;

    await expect(
      service.createEmployee(principalFor("MANAGER"), createInput(), "employee-create-key-0005"),
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
      "employee-create-key-0006",
    );

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
      service.createEmployee(
        principalFor("HR_MANAGER"),
        createInput({ hireDate: "not-a-date" }),
        "employee-create-key-0007",
      ),
    ).rejects.toMatchObject({ code: "INVALID_HIRE_DATE", status: 400 });

    await expect(
      service.createEmployee(
        principalFor("HR_MANAGER"),
        createInput({ hireDate: "2026-09-18T10:00:00.000Z" }),
        "employee-create-key-0008",
      ),
    ).rejects.toMatchObject({ code: "INVALID_HIRE_DATE", status: 400 });
  });
});

describe("EmployeesService updateEmployee", () => {
  let harness: ReturnType<typeof createHarness>;

  const existing = () =>
    row({
      id: "emp-1",
      employeeNumber: "EMP-1",
      workEmail: "a@acme.example",
      departmentId: "dept-eng",
      hireDate: new Date("2022-03-01"),
      terminationDate: null,
    });

  beforeEach(() => {
    harness = createHarness();
    vi.clearAllMocks();
    harness.prisma.organizationMembership.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: Record<string, string> }).where;
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

      return { organizationId: where.organizationId, role };
    });
    harness.prisma.employee.findFirst.mockImplementation(async () => existing());
  });

  it("applies a partial update and returns the canonical detail", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementationOnce(async () => existing());
    prisma.employee.findFirst.mockImplementationOnce(async () => null);

    const updated = await service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {
      firstName: "Asha",
    });

    const args = (prisma.employee.update.mock.calls as unknown[][])[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    expect(args.where).toEqual({ id: "emp-1" });
    expect(args.data).toEqual({ firstName: "Asha" });
    expect(updated.id).toBe("emp-1");
  });

  it("treats an empty PATCH as a no-op read without writing", async () => {
    const { prisma, service } = harness;

    await service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {});

    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it("returns tenant-safe 404 for foreign employees without writing", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementationOnce(async () => null);

    await expect(
      service.updateEmployee(principalFor("HR_MANAGER"), "emp-other", { firstName: "X" }),
    ).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND", status: 404 });

    const args = (prisma.employee.findFirst.mock.calls as unknown[][])[0]?.[0] as {
      where: Record<string, unknown>;
    };

    expect(args.where).toEqual({ id: "emp-other", organizationId: "org-1" });
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it("validates department changes inside the active organization", async () => {
    const { prisma, service, departments } = harness;

    departments.findTenantDepartmentOrThrow.mockResolvedValueOnce({ id: "dept-fin" });

    await service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {
      departmentId: "dept-fin",
    });

    expect(departments.findTenantDepartmentOrThrow).toHaveBeenCalledWith("org-1", "dept-fin");

    const args = (prisma.employee.update.mock.calls as unknown[][])[0]?.[0] as {
      data: Record<string, unknown>;
    };

    expect(args.data.department).toEqual({ connect: { id: "dept-fin" } });
  });

  it("rejects foreign departments without writing", async () => {
    const { prisma, service, departments } = harness;

    departments.findTenantDepartmentOrThrow.mockRejectedValueOnce({
      code: "DEPARTMENT_NOT_FOUND",
    });

    await expect(
      service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", { departmentId: "dept-foreign" }),
    ).rejects.toMatchObject({ code: "DEPARTMENT_NOT_FOUND" });
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it("rejects duplicate numbers and emails with stable 409s", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementationOnce(async () => existing());
    prisma.employee.findFirst.mockImplementationOnce(async () => ({ id: "emp-other" }));

    await expect(
      service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", { employeeNumber: "EMP-2" }),
    ).rejects.toMatchObject({ code: "EMPLOYEE_NUMBER_ALREADY_EXISTS", status: 409 });

    prisma.employee.findFirst.mockImplementationOnce(async () => existing());
    prisma.employee.findFirst.mockImplementationOnce(async () => ({ id: "emp-other" }));

    await expect(
      service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {
        workEmail: "other@acme.example",
      }),
    ).rejects.toMatchObject({ code: "EMPLOYEE_EMAIL_ALREADY_EXISTS", status: 409 });

    expect(prisma.employee.update).not.toHaveBeenCalled();
  });

  it("normalizes numbers, emails, and countries canonically", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementationOnce(async () => existing());
    prisma.employee.findFirst.mockImplementationOnce(async () => null);
    prisma.employee.findFirst.mockImplementationOnce(async () => null);

    await service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {
      employeeNumber: "  emp-9  ",
      countryCode: "in",
      workEmail: "  New@Acme.Example ",
    });

    const args = (prisma.employee.update.mock.calls as unknown[][])[0]?.[0] as {
      data: Record<string, unknown>;
    };

    expect(args.data).toMatchObject({
      employeeNumber: "emp-9",
      countryCode: "IN",
      workEmail: "new@acme.example",
    });
  });

  it("clears nullable fields explicitly while omissions stay untouched", async () => {
    const { prisma, service } = harness;

    await service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {
      level: null,
      terminationDate: null,
      workEmail: null,
    });

    const args = (prisma.employee.update.mock.calls as unknown[][])[0]?.[0] as {
      data: Record<string, unknown>;
    };

    expect(args.data).toMatchObject({ level: null, terminationDate: null, workEmail: null });
  });

  it("rejects invalid and inconsistent dates", async () => {
    const { service } = harness;

    await expect(
      service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {
        hireDate: "2026-09-18T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_HIRE_DATE", status: 400 });

    await expect(
      service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {
        terminationDate: "not-a-date",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TERMINATION_DATE", status: 400 });

    await expect(
      service.updateEmployee(principalFor("HR_MANAGER"), "emp-1", {
        terminationDate: "2020-01-01",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TERMINATION_DATE", status: 400 });
  });

  it("denies updates to read-only roles", async () => {
    const { prisma, service } = harness;

    await expect(
      service.updateEmployee(principalFor("MANAGER"), "emp-1", { firstName: "X" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION", status: 403 });
    expect(prisma.employee.update).not.toHaveBeenCalled();
  });
});

describe("EmployeesService deleteEmployee", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
    vi.clearAllMocks();
    harness.prisma.organizationMembership.findFirst.mockImplementation(async (args: unknown) => {
      const where = (args as { where: Record<string, string> }).where;
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

      return { organizationId: where.organizationId, role };
    });
    harness.prisma.employee.findFirst.mockImplementation(async () => row({ id: "emp-1" }));
    harness.prisma.employeeCompensation.findUnique.mockImplementation(async () => null);
    harness.prisma.compensationHistory.findFirst.mockImplementation(async () => null);
  });

  it("hard-deletes a safe employee without touching compensation tables", async () => {
    const { prisma, service } = harness;

    const result = await service.deleteEmployee(principalFor("HR_MANAGER"), "emp-1");

    expect(result).toEqual({ deleted: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.employee.delete).toHaveBeenCalledWith({ where: { id: "emp-1" } });
    // Protection reads only; the service never writes salary tables here.
    expect(prisma.employeeCompensation.findUnique).toHaveBeenCalledWith({
      where: { employeeId: "emp-1" },
      select: { id: true },
    });
  });

  it("returns tenant-safe 404 for foreign employees without deleting", async () => {
    const { prisma, service } = harness;

    prisma.employee.findFirst.mockImplementationOnce(async () => null);

    await expect(
      service.deleteEmployee(principalFor("HR_MANAGER"), "emp-foreign"),
    ).rejects.toMatchObject({ code: "EMPLOYEE_NOT_FOUND", status: 404 });
    expect(prisma.employee.delete).not.toHaveBeenCalled();
  });

  it("blocks deletion while current compensation exists", async () => {
    const { prisma, service } = harness;

    prisma.employeeCompensation.findUnique.mockImplementationOnce(async () => ({ id: "comp-1" }));

    await expect(service.deleteEmployee(principalFor("HR_MANAGER"), "emp-1")).rejects.toMatchObject(
      { code: "EMPLOYEE_HAS_COMPENSATION_HISTORY", status: 409 },
    );
    expect(prisma.employee.delete).not.toHaveBeenCalled();
  });

  it("blocks deletion while compensation history exists", async () => {
    const { prisma, service } = harness;

    prisma.compensationHistory.findFirst.mockImplementationOnce(async () => ({ id: "hist-1" }));

    await expect(service.deleteEmployee(principalFor("HR_MANAGER"), "emp-1")).rejects.toMatchObject(
      { code: "EMPLOYEE_HAS_COMPENSATION_HISTORY", status: 409 },
    );
    expect(prisma.employee.delete).not.toHaveBeenCalled();
  });

  it("maps a concurrent compensation FK restriction to the stable conflict", async () => {
    const { prisma, service } = harness;

    prisma.employee.delete.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Foreign key constraint failed", {
        clientVersion: "test",
        code: "P2003",
      }),
    );

    await expect(service.deleteEmployee(principalFor("HR_MANAGER"), "emp-1")).rejects.toMatchObject(
      { code: "EMPLOYEE_HAS_COMPENSATION_HISTORY", status: 409 },
    );
  });

  it("denies deletion to read-only roles", async () => {
    const { prisma, service } = harness;

    await expect(service.deleteEmployee(principalFor("MANAGER"), "emp-1")).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
      status: 403,
    });
    expect(prisma.employee.delete).not.toHaveBeenCalled();
  });
});
