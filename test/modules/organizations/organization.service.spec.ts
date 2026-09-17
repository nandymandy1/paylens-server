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
      findFirst: vi.fn(async ({ where }: { where: Record<string, string> }) => {
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

        return { ...found, organization: orgs.find((org) => org.id === found.organizationId) };
      }),
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

  return { service, prisma, memberships };
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

  it("lets the owner change a non-owner role", async () => {
    const { service } = createHarness();
    const updated = await service.changeRole(ownerPrincipal, "membership-emp", "MANAGER");

    expect(updated.role).toBe("MANAGER");
  });

  it("prevents HR_ADMIN from touching owners or granting ownership", async () => {
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

    const updated = await service.changeRole(admin, "membership-emp", "HR_MANAGER");

    expect(updated.role).toBe("HR_MANAGER");
  });

  it("keeps at least one active owner", async () => {
    const { service } = createHarness();

    await expect(
      service.changeRole(ownerPrincipal, "membership-owner", "HR_ADMIN"),
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

    // "acme" is taken → deterministic suffix.
    expect(created.organization.slug).toBe("acme-2");
  });
});
