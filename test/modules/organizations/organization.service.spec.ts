import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationService } from "@/modules/organizations/organization.service.js";
import type { MembershipRoleName } from "@/modules/auth/constants/auth.constants.js";

type Principal = {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  membershipId: string | null;
  role: MembershipRoleName | null;
};

const ownerPrincipal: Principal = {
  userId: "user-owner",
  sessionId: "session-1",
  organizationId: "org-1",
  membershipId: "membership-owner",
  role: "TENANT_OWNER",
};

const createHarness = () => {
  const memberships: Record<string, unknown>[] = [
    {
      id: "membership-owner",
      userId: "user-owner",
      organizationId: "org-1",
      role: "TENANT_OWNER",
      status: "ACTIVE",
      createdAt: new Date("2026-01-01"),
    },
    {
      id: "membership-admin",
      userId: "user-admin",
      organizationId: "org-1",
      role: "HR_ADMIN",
      status: "ACTIVE",
      createdAt: new Date("2026-01-02"),
    },
    {
      id: "membership-emp",
      userId: "user-emp",
      organizationId: "org-1",
      role: "EMPLOYEE",
      status: "ACTIVE",
      createdAt: new Date("2026-01-03"),
    },
  ];
  const orgs: Record<string, unknown>[] = [{ id: "org-1", name: "Acme", slug: "acme" }];
  const users: Record<string, unknown>[] = [
    { id: "user-owner", email: "owner@acme.example", firstName: "O", lastName: "W" },
    { id: "user-admin", email: "admin@acme.example", firstName: "A", lastName: "D" },
    { id: "user-emp", email: "emp@acme.example", firstName: "E", lastName: "M" },
  ];

  const prisma = {
    organizationMembership: {
      findFirst: vi.fn(
        async ({ where, select }: { where: Record<string, string>; select?: unknown }) => {
          const found =
            memberships.find(
              (membership) =>
                (where.id === undefined || membership.id === where.id) &&
                (where.userId === undefined || membership.userId === where.userId) &&
                (where.organizationId === undefined ||
                  membership.organizationId === where.organizationId),
            ) ?? null;

          if (!found) {
            return null;
          }

          const user = users.find((candidate) => candidate.id === found.userId);

          return select
            ? { ...found, user }
            : { ...found, organization: orgs.find((org) => org.id === found.organizationId) };
        },
      ),
      findMany: vi.fn(async () =>
        memberships.map((membership) => ({
          ...membership,
          user: users.find((user) => user.id === membership.userId),
        })),
      ),
      count: vi.fn(
        async ({ where }: { where: Record<string, string> }) =>
          memberships.filter(
            (membership) =>
              membership.organizationId === where.organizationId &&
              membership.role === where.role &&
              membership.status === where.status,
          ).length,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const target = memberships.find((membership) => membership.id === where.id) as Record<
            string,
            unknown
          >;

          Object.assign(target, data);

          return target;
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const membership = {
          id: `membership-${memberships.length + 1}`,
          status: "ACTIVE",
          ...data,
        };

        memberships.push(membership);

        return membership;
      }),
    },
    organization: {
      findUnique: vi.fn(
        async ({ where }: { where: { slug: string } }) =>
          orgs.find((org) => org.slug === where.slug) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const org = { id: `org-${orgs.length + 1}`, ...data };

        orgs.push(org);

        return org;
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        organization: prisma.organization,
        organizationMembership: prisma.organizationMembership,
      }),
    ),
  };

  const sessions = {
    setActiveOrganization: vi.fn(async () => null),
    getSession: vi.fn(async () => null),
    accessTokenFor: vi.fn(() => "access"),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new OrganizationService(prisma as never, sessions as never, audit as never);

  return { service, prisma, memberships, users };
};

describe("OrganizationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists members of the active organization", async () => {
    const { service } = createHarness();
    const members = await service.members(ownerPrincipal);

    expect(members).toHaveLength(3);
    expect(members[0].email).toBe("owner@acme.example");
  });

  it("lets HR_ADMIN and HR_MANAGER list members", async () => {
    const { service, memberships, users } = createHarness();

    memberships.push({
      id: "membership-hrm",
      userId: "user-hrm",
      organizationId: "org-1",
      role: "HR_MANAGER",
      status: "ACTIVE",
      createdAt: new Date("2026-01-04"),
    });
    users.push({ id: "user-hrm", email: "hrm@acme.example", firstName: "H", lastName: "M" });

    await expect(
      service.members({
        userId: "user-admin",
        sessionId: "session-2",
        organizationId: "org-1",
        membershipId: "membership-admin",
        role: "HR_ADMIN",
      }),
    ).resolves.toHaveLength(4);
    await expect(
      service.members({
        userId: "user-hrm",
        sessionId: "session-3",
        organizationId: "org-1",
        membershipId: "membership-hrm",
        role: "HR_MANAGER",
      }),
    ).resolves.toHaveLength(4);
  });

  it("returns a safe same-organization member detail", async () => {
    const { service } = createHarness();
    const member = await service.member(ownerPrincipal, "membership-admin");

    expect(member).toMatchObject({
      id: "membership-admin",
      email: "admin@acme.example",
      role: "HR_ADMIN",
    });
    expect(member).not.toHaveProperty("passwordHash");
    expect(member).not.toHaveProperty("sessionId");
  });

  it("returns the same not-found result for unknown and cross-organization members", async () => {
    const { service, memberships } = createHarness();

    memberships.push({
      id: "membership-other-org",
      userId: "user-other",
      organizationId: "org-2",
      role: "EMPLOYEE",
      status: "ACTIVE",
      createdAt: new Date("2026-01-04"),
    });

    await expect(service.member(ownerPrincipal, "unknown-membership")).rejects.toMatchObject({
      code: "MEMBERSHIP_NOT_FOUND",
      status: 404,
    });
    await expect(service.member(ownerPrincipal, "membership-other-org")).rejects.toMatchObject({
      code: "MEMBERSHIP_NOT_FOUND",
      status: 404,
    });
  });

  it("forbids member detail access without member-view permission", async () => {
    const { service } = createHarness();

    await expect(
      service.member(
        {
          userId: "user-emp",
          sessionId: "session-3",
          organizationId: "org-1",
          membershipId: "membership-emp",
          role: "EMPLOYEE",
        },
        "membership-admin",
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION", status: 403 });
  });

  it("forbids MANAGER, EMPLOYEE, and VIEWER_AUDITOR from listing members", async () => {
    const { service, memberships } = createHarness();

    memberships.push(
      {
        id: "membership-manager",
        userId: "user-manager",
        organizationId: "org-1",
        role: "MANAGER",
        status: "ACTIVE",
        createdAt: new Date("2026-01-04"),
      },
      {
        id: "membership-viewer",
        userId: "user-viewer",
        organizationId: "org-1",
        role: "VIEWER_AUDITOR",
        status: "ACTIVE",
        createdAt: new Date("2026-01-05"),
      },
    );

    for (const [userId, membershipId, role] of [
      ["user-manager", "membership-manager", "MANAGER"],
      ["user-emp", "membership-emp", "EMPLOYEE"],
      ["user-viewer", "membership-viewer", "VIEWER_AUDITOR"],
    ] as const) {
      await expect(
        service.members({
          userId,
          sessionId: "session-x",
          organizationId: "org-1",
          membershipId,
          role,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
    }
  });

  it("lets the owner change a non-owner role", async () => {
    const { service } = createHarness();
    const updated = await service.changeRole(ownerPrincipal, "membership-emp", "MANAGER");

    expect(updated.role).toBe("MANAGER");
  });

  it("forbids HR_ADMIN role changes and owner grant/demotion", async () => {
    const { service } = createHarness();
    const admin: Principal = {
      userId: "user-admin",
      sessionId: "session-2",
      organizationId: "org-1",
      membershipId: "membership-admin",
      role: "HR_ADMIN",
    };

    await expect(service.changeRole(admin, "membership-owner", "EMPLOYEE")).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
    });
    await expect(service.changeRole(admin, "membership-emp", "TENANT_OWNER")).rejects.toMatchObject(
      {
        code: "INSUFFICIENT_PERMISSION",
      },
    );
    await expect(service.changeRole(admin, "membership-emp", "HR_MANAGER")).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
    });
  });

  it("keeps the tenant owner role immutable", async () => {
    const { service } = createHarness();

    await expect(
      service.changeRole(ownerPrincipal, "membership-owner", "HR_ADMIN"),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
    });
    await expect(
      service.changeRole(ownerPrincipal, "membership-emp", "TENANT_OWNER"),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSION",
    });
  });

  it("creates organizations with deterministic collision-safe slugs", async () => {
    const { service } = createHarness();
    const userWithoutOrg: Principal = {
      userId: "user-new",
      sessionId: "session-9",
      organizationId: null,
      membershipId: null,
      role: null,
    };
    const created = await service.createOrganization(userWithoutOrg, "Acme", undefined);

    // "acme" is taken → deterministic suffix. Cookie-only: no JWT in JSON.
    expect(created.organization.slug).toBe("acme-2");
    expect(created).not.toHaveProperty("accessToken");
  });
});
