import { beforeEach, describe, expect, it, vi } from "vitest";
import { InvitationService } from "@/modules/auth/services/invitation.service.js";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import type { MembershipRoleName } from "@/modules/auth/constants/auth.constants.js";

vi.mock("@/modules/auth/utils/auth.utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/auth/utils/auth.utils.js")>();

  return { ...original, generateOpaqueToken: () => "raw-invite-token" };
});

type Principal = {
  userId: string;
  sessionId: string;
  organizationId: string | null;
  membershipId: string | null;
  role: MembershipRoleName | null;
};

const principalFor = (role: MembershipRoleName): Principal => ({
  userId: "inviter-1",
  sessionId: "session-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  role,
});

const createHarness = (inviterRole: MembershipRoleName) => {
  const invitations: Record<string, unknown>[] = [];
  const memberships: Record<string, unknown>[] = [
    {
      id: "membership-1",
      userId: "inviter-1",
      organizationId: "org-1",
      role: inviterRole,
      status: "ACTIVE",
      organization: { id: "org-1", name: "Acme" },
    },
  ];
  const users: Record<string, unknown>[] = [
    { id: "inviter-1", email: "owner@acme.example", emailVerifiedAt: new Date(), status: "ACTIVE" },
  ];

  const prisma = {
    organizationMembership: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        if (where.id) {
          return memberships.find((membership) => membership.id === where.id) ?? null;
        }

        return (
          memberships.find(
            (membership) =>
              membership.userId === where.userId &&
              membership.organizationId === where.organizationId,
          ) ?? null
        );
      }),
      findUnique: vi.fn(async ({ where }: { where: Record<string, Record<string, string>> }) => {
        const key = where.organizationId_userId;

        return (
          memberships.find(
            (membership) =>
              membership.organizationId === key.organizationId && membership.userId === key.userId,
          ) ?? null
        );
      }),
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
    organizationInvitation: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const invitation = {
          id: `invitation-${invitations.length + 1}`,
          acceptedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };

        invitations.push(invitation);

        return invitation;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const invitation = invitations.find((entry) => entry.tokenHash === where.tokenHash) ?? null;

        if (!invitation) {
          return null;
        }

        return { ...invitation, organization: { id: "org-1", name: "Acme" } };
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, string> }) =>
          invitations.find(
            (invitation) =>
              invitation.id === where.id && invitation.organizationId === where.organizationId,
          ) ?? null,
      ),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const role = args?.where?.role;

        if (typeof role === "string") {
          return invitations.filter((invitation) => invitation.role === role);
        }

        return invitations;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const invitation = invitations.find((entry) => entry.id === where.id) as Record<
            string,
            unknown
          >;

          Object.assign(invitation, data);

          return invitation;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;

          for (const invitation of invitations) {
            if (where.id !== undefined && invitation.id !== where.id) {
              continue;
            }

            if (where.acceptedAt === null && invitation.acceptedAt !== null) {
              continue;
            }

            if (where.revokedAt === null && invitation.revokedAt !== null) {
              continue;
            }

            Object.assign(invitation, data);
            count += 1;
          }

          return { count };
        },
      ),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        if (where.id) {
          return users.find((user) => user.id === where.id) ?? null;
        }

        return users.find((user) => user.email === where.email) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const user = { id: `user-${users.length + 1}`, status: "ACTIVE", ...data };

        users.push(user);

        return user;
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        organizationInvitation: {
          updateMany: (args: never) =>
            (prisma.organizationInvitation.updateMany as (...params: never[]) => Promise<unknown>)(
              args,
            ),
        },
        organizationMembership: {
          create: (args: never) =>
            (prisma.organizationMembership.create as (...params: never[]) => Promise<unknown>)(
              args,
            ),
        },
        user: {
          create: (args: never) =>
            (prisma.user.create as (...params: never[]) => Promise<unknown>)(args),
        },
      }),
    ),
  };

  const sessions = {
    createSession: vi.fn(async () => ({
      sessionId: "session-9",
      accessToken: "access",
      refreshToken: "session-9.secret",
    })),
    setActiveOrganization: vi.fn(async () => ({
      sessionId: "session-1",
      userId: "inviter-1",
      activeOrganizationId: "org-1",
      activeMembershipId: "membership-2",
      role: "EMPLOYEE",
      refreshTokenHash: "hash",
      createdAt: new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
      absoluteExpiresAt: new Date().toISOString(),
      userAgentHash: null,
    })),
    getSession: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
    accessTokenFor: vi.fn(() => "rotated-access"),
  };
  const email = { sendInvitationEmail: vi.fn(async () => undefined) };
  const audit = { record: vi.fn(async () => undefined) };
  const config = { getOrThrow: () => "http://localhost:3000" };

  const service = new InvitationService(
    prisma as never,
    new PasswordService(),
    sessions as never,
    email as never,
    audit as never,
    config as never,
  );

  return { service, prisma, sessions, email, invitations, memberships, users };
};

describe("InvitationService permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets the owner invite HR_ADMIN and lower roles", async () => {
    const { service, email } = createHarness("TENANT_OWNER");
    const created = await service.invite(
      principalFor("TENANT_OWNER"),
      "New@acme.example",
      "HR_ADMIN",
    );

    expect(created.email).toBe("new@acme.example");
    expect(email.sendInvitationEmail).toHaveBeenCalledOnce();
  });

  it("lets HR_ADMIN invite HR_MANAGER but never TENANT_OWNER", async () => {
    const { service } = createHarness("HR_ADMIN");

    await service.invite(principalFor("HR_ADMIN"), "manager@acme.example", "HR_MANAGER");
    await expect(
      service.invite(principalFor("HR_ADMIN"), "owner@acme.example", "TENANT_OWNER"),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
  });

  it("lets HR_MANAGER invite EMPLOYEE only", async () => {
    const { service } = createHarness("HR_MANAGER");

    await service.invite(principalFor("HR_MANAGER"), "employee@acme.example", "EMPLOYEE");
    await expect(
      service.invite(principalFor("HR_MANAGER"), "manager@acme.example", "MANAGER"),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSION" });
  });

  it("rejects invites from members without an active tenant context", async () => {
    const { service } = createHarness("TENANT_OWNER");

    await expect(
      service.invite(
        { userId: "x", sessionId: "s", organizationId: null, membershipId: null, role: null },
        "employee@acme.example",
        "EMPLOYEE",
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
  });

  it("previews without consuming and rejects expired, revoked, and reused tokens", async () => {
    const { service, invitations } = createHarness("TENANT_OWNER");

    await service.invite(principalFor("TENANT_OWNER"), "employee@acme.example", "EMPLOYEE");

    const preview = await service.preview("raw-invite-token");

    expect(preview.email).toBe("employee@acme.example");
    expect(preview.role).toBe("EMPLOYEE");

    // Still unused after preview.
    expect(invitations[0].acceptedAt).toBeNull();

    (invitations[0] as Record<string, unknown>).expiresAt = new Date(Date.now() - 1000);
    await expect(service.preview("raw-invite-token")).rejects.toMatchObject({
      code: "INVITATION_EXPIRED",
    });
  });

  it("accepts for a new credentials user and marks the email verified", async () => {
    const { service, users, sessions } = createHarness("TENANT_OWNER");

    await service.invite(principalFor("TENANT_OWNER"), "new@acme.example", "EMPLOYEE");

    const result = await service.acceptAsNewUser(
      "raw-invite-token",
      { firstName: "New", lastName: "Hire", password: "correct horse battery staple" },
      undefined,
    );

    const created = users.find((user) => user.email === "new@acme.example") as Record<
      string,
      unknown
    >;

    expect(created.emailVerifiedAt).not.toBeNull();
    expect(result.membershipId).toBeDefined();
    expect(sessions.createSession).toHaveBeenCalledOnce();
  });

  it("requires login when the invite email already exists", async () => {
    const { service, users } = createHarness("TENANT_OWNER");

    users.push({
      id: "user-existing",
      email: "old@acme.example",
      emailVerifiedAt: new Date(),
      status: "ACTIVE",
    });

    await service.invite(principalFor("TENANT_OWNER"), "old@acme.example", "EMPLOYEE");
    await expect(
      service.acceptAsNewUser(
        "raw-invite-token",
        { firstName: "Old", lastName: "User", password: "correct horse battery staple" },
        undefined,
      ),
    ).rejects.toMatchObject({ code: "INVITATION_LOGIN_REQUIRED" });
  });

  it("accepts for the authenticated matching user and rejects email mismatch", async () => {
    const { service, users, sessions } = createHarness("TENANT_OWNER");

    users.push({
      id: "user-matching",
      email: "match@acme.example",
      emailVerifiedAt: new Date(),
      status: "ACTIVE",
    });

    await service.invite(principalFor("TENANT_OWNER"), "match@acme.example", "EMPLOYEE");

    const matching: Principal = {
      userId: "user-matching",
      sessionId: "session-match",
      organizationId: null,
      membershipId: null,
      role: null,
    };

    sessions.getSession.mockResolvedValueOnce({
      sessionId: "session-match",
      userId: "user-matching",
      activeOrganizationId: "org-1",
      activeMembershipId: "membership-9",
      role: "EMPLOYEE",
      refreshTokenHash: "hash",
      createdAt: new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
      absoluteExpiresAt: new Date().toISOString(),
      userAgentHash: null,
    });

    const accepted = await (async () => {
      await expect(
        service.acceptAsAuthenticated(principalFor("TENANT_OWNER"), "raw-invite-token", undefined),
      ).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });

      return service.acceptAsAuthenticated(matching, "raw-invite-token", undefined);
    })();

    // Cookie-only model: membership data only, no access JWT in JSON.
    expect(accepted).not.toHaveProperty("accessToken");
    expect(accepted.membership.organizationId).toBe("org-1");
  });

  it("rejects invitation acceptance for suspended users", async () => {
    const { service, users } = createHarness("TENANT_OWNER");

    users.push({
      id: "user-suspended",
      email: "suspended@acme.example",
      emailVerifiedAt: new Date(),
      status: "SUSPENDED",
    });

    await service.invite(principalFor("TENANT_OWNER"), "suspended@acme.example", "EMPLOYEE");

    await expect(
      service.acceptAsAuthenticated(
        {
          userId: "user-suspended",
          sessionId: "session-s",
          organizationId: null,
          membershipId: null,
          role: null,
        },
        "raw-invite-token",
        undefined,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED" });
  });

  it("restricts invitation listing to member admins and scopes HR_MANAGER to employees", async () => {
    const owner = createHarness("TENANT_OWNER");

    await owner.service.invite(principalFor("TENANT_OWNER"), "employee@acme.example", "EMPLOYEE");
    await owner.service.invite(principalFor("TENANT_OWNER"), "manager@acme.example", "MANAGER");

    await expect(owner.service.list(principalFor("TENANT_OWNER"))).resolves.toHaveLength(2);

    const admin = createHarness("HR_ADMIN");

    admin.invitations.push(...owner.invitations);
    await expect(admin.service.list(principalFor("HR_ADMIN"))).resolves.toHaveLength(2);

    const manager = createHarness("HR_MANAGER");

    manager.invitations.push(...owner.invitations);

    const scoped = await manager.service.list(principalFor("HR_MANAGER"));

    expect(scoped).toHaveLength(1);
    expect(scoped[0].role).toBe("EMPLOYEE");
  });

  it("forbids invitation listing for MANAGER, EMPLOYEE, and VIEWER_AUDITOR", async () => {
    for (const role of ["MANAGER", "EMPLOYEE", "VIEWER_AUDITOR"] as const) {
      const { service } = createHarness(role);

      await expect(service.list(principalFor(role))).rejects.toMatchObject({
        code: "INSUFFICIENT_PERMISSION",
      });
    }
  });
});
