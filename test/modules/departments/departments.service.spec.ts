import { beforeEach, describe, expect, it, vi } from "vitest";
import { DepartmentsService } from "@/modules/departments/departments.service.js";
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

const departmentRow = (overrides: Record<string, unknown> = {}) => ({
  id: "dept-eng",
  code: "ENG",
  name: "Engineering",
  createdAt: new Date("2022-01-02T00:00:00.000Z"),
  updatedAt: new Date("2022-01-03T00:00:00.000Z"),
  _count: { employees: 5 },
  ...overrides,
});

const createHarness = () => {
  const prisma = {
    organizationMembership: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: Record<string, string> }).where;

        return { organizationId: where.organizationId, role: "HR_MANAGER" };
      }),
    },
    department: {
      findMany: vi.fn((): Promise<unknown> =>
        Promise.resolve([
          departmentRow({
            id: "dept-fin",
            code: "FIN",
            name: "Finance",
            _count: { employees: 3 },
          }),
          departmentRow(),
        ]),
      ),
      findFirst: vi.fn((): Promise<unknown> => Promise.resolve(null)),
      create: vi.fn((args: { data: Record<string, string> }): Promise<unknown> =>
        Promise.resolve({
          id: "dept-new",
          createdAt: new Date("2026-09-18T00:00:00.000Z"),
          updatedAt: new Date("2026-09-18T00:00:00.000Z"),
          ...args.data,
        }),
      ),
      update: vi.fn((args: { data: Record<string, string> }): Promise<unknown> =>
        Promise.resolve({ ...departmentRow(), ...args.data }),
      ),
      delete: vi.fn((): Promise<unknown> => Promise.resolve({ id: "dept-eng" })),
    },
    employee: {
      count: vi.fn(async () => 0),
    },
  };

  const service = new DepartmentsService(
    prisma as never,
    {
      now: () => 0,
      durationSince: () => 0,
      debug: () => undefined,
    } as never,
  );

  return { prisma, service };
};

describe("DepartmentsService", () => {
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

  it("lists only active-organization departments in name order with counts", async () => {
    const { prisma, service } = harness;

    const departments = await service.list(principalFor("MANAGER"));

    expect(prisma.department.findMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1" },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { employees: true } },
      },
    });
    expect(departments).toEqual([
      {
        id: "dept-fin",
        code: "FIN",
        name: "Finance",
        employeeCount: 3,
        createdAt: "2022-01-02T00:00:00.000Z",
        updatedAt: "2022-01-03T00:00:00.000Z",
      },
      {
        id: "dept-eng",
        code: "ENG",
        name: "Engineering",
        employeeCount: 5,
        createdAt: "2022-01-02T00:00:00.000Z",
        updatedAt: "2022-01-03T00:00:00.000Z",
      },
    ]);
  });

  it("denies department reads to EMPLOYEE but allows VIEWER_AUDITOR", async () => {
    const { service } = harness;

    await expect(service.list(principalFor("EMPLOYEE"))).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
      status: 403,
    });

    await expect(service.list(principalFor("VIEWER_AUDITOR"))).resolves.toHaveLength(2);
  });

  it("returns 404 for cross-tenant department detail without leaking existence", async () => {
    const { prisma, service } = harness;

    await expect(
      service.detail(principalFor("HR_MANAGER"), "dept-other-org"),
    ).rejects.toMatchObject({ code: "DEPARTMENT_NOT_FOUND", status: 404 });

    const args = (prisma.department.findFirst.mock.calls as unknown[][])[0]?.[0] as {
      where: Record<string, unknown>;
    };

    expect(args.where).toEqual({ id: "dept-other-org", organizationId: "org-1" });
  });

  it("creates a department scoped to the active organization", async () => {
    const { prisma, service } = harness;

    const created = await service.create(principalFor("HR_MANAGER"), {
      code: "ENG",
      name: "Engineering",
    });

    expect(prisma.department.create).toHaveBeenCalledWith({
      data: { organizationId: "org-1", code: "ENG", name: "Engineering" },
      select: { id: true, code: true, name: true, createdAt: true, updatedAt: true },
    });
    expect(created).toMatchObject({ code: "ENG", name: "Engineering", employeeCount: 0 });
  });

  it("rejects duplicate department codes with a stable 409", async () => {
    const { prisma, service } = harness;

    prisma.department.findFirst.mockImplementationOnce(async () => ({ id: "dept-old" }));

    await expect(
      service.create(principalFor("HR_ADMIN"), { code: "ENG", name: "Engineering" }),
    ).rejects.toMatchObject({ code: "DEPARTMENT_CODE_ALREADY_EXISTS", status: 409 });
    expect(prisma.department.create).not.toHaveBeenCalled();
  });

  it("denies department writes to MANAGER and VIEWER_AUDITOR", async () => {
    const { service } = harness;

    await expect(
      service.create(principalFor("MANAGER"), { code: "ENG", name: "Engineering" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION", status: 403 });

    await expect(service.remove(principalFor("VIEWER_AUDITOR"), "dept-eng")).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
      status: 403,
    });
  });

  it("updates a department and rejects a code taken by a sibling", async () => {
    const { prisma, service } = harness;

    prisma.department.findFirst.mockImplementationOnce(async () => ({
      id: "dept-eng",
      code: "ENG",
    }));

    const updated = await service.update(principalFor("TENANT_OWNER"), "dept-eng", {
      name: "Engineering Org",
    });

    expect(prisma.department.update).toHaveBeenCalledWith({
      where: { id: "dept-eng" },
      data: { name: "Engineering Org" },
      select: { id: true, code: true, name: true, createdAt: true, updatedAt: true },
    });
    expect(updated).toMatchObject({ id: "dept-eng", name: "Engineering Org" });

    prisma.department.findFirst.mockImplementationOnce(async () => ({
      id: "dept-eng",
      code: "ENG",
    }));
    prisma.department.findFirst.mockImplementationOnce(async () => ({ id: "dept-fin" }));

    await expect(
      service.update(principalFor("TENANT_OWNER"), "dept-eng", { code: "FIN" }),
    ).rejects.toMatchObject({ code: "DEPARTMENT_CODE_ALREADY_EXISTS", status: 409 });
  });

  it("returns 404 when updating or deleting a foreign-tenant department", async () => {
    const { service } = harness;

    await expect(
      service.update(principalFor("HR_ADMIN"), "dept-other-org", { name: "Xy" }),
    ).rejects.toMatchObject({ code: "DEPARTMENT_NOT_FOUND", status: 404 });

    await expect(service.remove(principalFor("HR_ADMIN"), "dept-other-org")).rejects.toMatchObject({
      code: "DEPARTMENT_NOT_FOUND",
      status: 404,
    });
  });

  it("deletes an empty department but blocks one with employees", async () => {
    const { prisma, service } = harness;

    prisma.department.findFirst.mockImplementation(async () => ({ id: "dept-eng" }));
    prisma.employee.count.mockImplementationOnce(async () => 0);

    await expect(service.remove(principalFor("HR_MANAGER"), "dept-eng")).resolves.toEqual({
      deleted: true,
    });
    expect(prisma.department.delete).toHaveBeenCalledWith({ where: { id: "dept-eng" } });

    prisma.employee.count.mockImplementationOnce(async () => 4);

    await expect(service.remove(principalFor("HR_MANAGER"), "dept-eng")).rejects.toMatchObject({
      code: "DEPARTMENT_IN_USE",
      status: 409,
    });
    expect(prisma.department.delete).toHaveBeenCalledTimes(1);
  });

  it("exposes a narrow tenant-safe lookup for cross-module use", async () => {
    const { prisma, service } = harness;

    prisma.department.findFirst.mockImplementationOnce(async () => ({ id: "dept-eng" }));

    await expect(service.findTenantDepartmentOrThrow("org-1", "dept-eng")).resolves.toEqual({
      id: "dept-eng",
    });

    const args = (prisma.department.findFirst.mock.calls as unknown[][])[0]?.[0] as {
      where: Record<string, unknown>;
    };

    expect(args.where).toEqual({ id: "dept-eng", organizationId: "org-1" });

    await expect(service.findTenantDepartmentOrThrow("org-1", "dept-ghost")).rejects.toMatchObject({
      code: "DEPARTMENT_NOT_FOUND",
      status: 404,
    });
  });
});
