import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "@/modules/auth/services/auth.service.js";
import { PasswordService } from "@/modules/auth/services/password.service.js";

vi.mock("@/modules/auth/utils/auth.utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/auth/utils/auth.utils.js")>();
  let counter = 0;

  return { ...original, generateOpaqueToken: () => `raw-token-${(counter += 1)}` };
});

const createPrisma = () => {
  const users = new Map<string, Record<string, unknown>>();
  const orgs = new Map<string, Record<string, unknown>>();
  const memberships: Record<string, unknown>[] = [];
  const tokens = new Map<string, Record<string, unknown>>();

  const findUserByEmail = (email: string) =>
    [...users.values()].find((user) => user.email === email) ?? null;

  const txApi = {
    user: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const user = {
          id: `user-${users.size + 1}`,
          emailVerifiedAt: null,
          status: "ACTIVE",
          ...data,
        };

        users.set(user.id as string, user);

        return user;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const user = { ...(users.get(where.id) as Record<string, unknown>), ...data };

          users.set(where.id, user);

          return user;
        },
      ),
    },
    organization: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const org = { id: `org-${orgs.size + 1}`, status: "ACTIVE", ...data };

        orgs.set(org.id as string, org);

        return org;
      }),
    },
    organizationMembership: {
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
    authActionToken: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const token: Record<string, unknown> = {
          id: `token-${tokens.size + 1}`,
          consumedAt: null,
          revokedAt: null,
          ...data,
        };

        tokens.set(token.tokenHash as string, token);

        return token;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          let count = 0;

          for (const token of tokens.values()) {
            if (where.id !== undefined && token.id !== where.id) {
              continue;
            }

            if (where.consumedAt === null && token.consumedAt !== null) {
              continue;
            }

            if (where.revokedAt === null && token.revokedAt !== null) {
              continue;
            }

            Object.assign(token, data);
            count += 1;
          }

          return { count };
        },
      ),
    },
  };

  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) {
          return findUserByEmail(where.email);
        }

        return users.get(where.id as string) ?? null;
      }),
      update: txApi.user.update,
    },
    organization: {
      findUnique: vi.fn(
        async ({ where }: { where: { slug: string } }) =>
          [...orgs.values()].find((org) => org.slug === where.slug) ?? null,
      ),
    },
    organizationMembership: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        memberships
          .filter((membership) => membership.userId === where.userId)
          .map((membership) => ({
            ...membership,
            organization: orgs.get(membership.organizationId as string),
          })),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        const found =
          memberships.find(
            (membership) =>
              (where.userId === undefined || membership.userId === where.userId) &&
              (where.organizationId === undefined ||
                membership.organizationId === where.organizationId),
          ) ?? null;

        if (!found) {
          return null;
        }

        return { ...found, organization: orgs.get(found.organizationId as string) };
      }),
    },
    authActionToken: {
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const token = tokens.get(where.tokenHash) ?? null;

        if (!token) {
          return null;
        }

        return { ...token, user: users.get(token.userId as string) };
      }),
      create: txApi.authActionToken.create,
      updateMany: txApi.authActionToken.updateMany,
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(txApi)),
    _tables: { users, orgs, memberships, tokens },
  };

  return prisma;
};

const createService = (prisma: ReturnType<typeof createPrisma>) => {
  const sessions = {
    createSession: vi.fn(async () => ({
      sessionId: "session-1",
      accessToken: "access",
      refreshToken: "session-1.secret",
    })),
    revokeAllUserSessions: vi.fn(async () => undefined),
    accessTokenFor: vi.fn(() => "access"),
    setActiveOrganization: vi.fn(
      async (_sessionId: string, active: Record<string, string | null>) => ({
        sessionId: "session-1",
        userId: "user-1",
        activeOrganizationId: active.organizationId,
        activeMembershipId: active.membershipId,
        role: active.role,
        refreshTokenHash: "hash",
        createdAt: new Date().toISOString(),
        lastRefreshedAt: new Date().toISOString(),
        absoluteExpiresAt: new Date().toISOString(),
        userAgentHash: null,
      }),
    ),
    getSession: vi.fn(async () => sessions.setActiveOrganization.mock.results[0]?.value ?? null),
  };
  const email = {
    sendVerificationEmail: vi.fn(async (to: string, link: string): Promise<void> => {
      void to;
      void link;
    }),
    sendPasswordResetEmail: vi.fn(async (to: string, link: string): Promise<void> => {
      void to;
      void link;
    }),
  };
  const audit = { record: vi.fn(async () => undefined) };
  const config = {
    getOrThrow: (key: string) => {
      if (key === "app.frontendUrl") {
        return "http://localhost:3000";
      }

      throw new Error(key);
    },
  };

  const service = new AuthService(
    prisma as never,
    new PasswordService(),
    sessions as never,
    email as never,
    audit as never,
    config as never,
  );

  return { service, sessions, email, audit, prisma };
};

const validRegistration = {
  organizationName: "Acme Industries",
  firstName: "Asha",
  lastName: "Sharma",
  email: "hr@acme.example",
  password: "correct horse battery staple",
};

const tokenFromLink = (link: string): string => {
  const token = new URL(link).searchParams.get("token");

  if (!token) {
    throw new Error("expected a token link");
  }

  return token;
};

describe("AuthService credentials", () => {
  let context: ReturnType<typeof createService>;

  beforeEach(() => {
    vi.clearAllMocks();
    context = createService(createPrisma());
  });

  it("registers a tenant owner and sends verification without opening a session", async () => {
    const { service, email, sessions } = context;
    const result = await service.register({ ...validRegistration, email: "HR@acme.example" });

    expect(result.organization.slug).toBe("acme-industries");
    expect(result.user.email).toBe("hr@acme.example");
    expect(result.user.emailVerified).toBe(false);
    expect(email.sendVerificationEmail).toHaveBeenCalledOnce();
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it("rejects duplicate email with a stable conflict code", async () => {
    const { service } = context;

    await service.register(validRegistration);
    await expect(service.register(validRegistration)).rejects.toMatchObject({
      code: "EMAIL_ALREADY_REGISTERED",
      status: 409,
    });
  });

  it("rejects login before email verification", async () => {
    const { service } = context;

    await service.register(validRegistration);
    await expect(
      service.login("hr@acme.example", "correct horse battery staple", undefined),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("verifies once, auto-selects the single membership, and rejects replay", async () => {
    const { service, sessions, email } = context;

    await service.register(validRegistration);

    const verificationToken = tokenFromLink(email.sendVerificationEmail.mock.calls[0][1]);
    const verified = await service.verifyEmail(verificationToken, undefined);

    expect(verified.user.emailVerified).toBe(true);
    expect(verified.memberships).toHaveLength(1);
    expect(verified.memberships[0].role).toBe("TENANT_OWNER");
    expect(sessions.createSession).toHaveBeenCalledOnce();

    await expect(service.verifyEmail(verificationToken, undefined)).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_TOKEN_INVALID",
    });
    await expect(service.verifyEmail("raw-token-unknown", undefined)).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_TOKEN_INVALID",
    });
  });

  it("rotates verification tokens on resend and stays silent for unknown emails", async () => {
    const { service, email } = context;

    await service.register(validRegistration);

    const firstToken = tokenFromLink(email.sendVerificationEmail.mock.calls[0][1]);

    await service.resendVerification("hr@acme.example");

    expect(email.sendVerificationEmail).toHaveBeenCalledTimes(2);

    const secondToken = tokenFromLink(email.sendVerificationEmail.mock.calls[1][1]);

    expect(secondToken).not.toBe(firstToken);

    // The resend revoked the prior token.
    await expect(service.verifyEmail(firstToken, undefined)).rejects.toMatchObject({
      code: "EMAIL_VERIFICATION_TOKEN_INVALID",
    });

    const verified = await service.verifyEmail(secondToken, undefined);

    expect(verified.user.emailVerified).toBe(true);

    // Unknown or already-verified emails produce no new mail and no error.
    await service.resendVerification("ghost@example.com");
    await service.resendVerification("hr@acme.example");
    expect(email.sendVerificationEmail).toHaveBeenCalledTimes(2);
  });

  it("logs in with valid credentials and rejects wrong password generically", async () => {
    const { service, email } = context;

    await service.register(validRegistration);
    await service.verifyEmail(
      tokenFromLink(email.sendVerificationEmail.mock.calls[0][1]),
      undefined,
    );

    const result = await service.login(
      "hr@acme.example",
      "correct horse battery staple",
      undefined,
    );

    expect(result.user.emailVerified).toBe(true);
    expect(result.memberships).toHaveLength(1);

    await expect(
      service.login("hr@acme.example", "wrong password here!", undefined),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(
      service.login("nobody@example.com", "wrong password here!", undefined),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("rejects suspended accounts", async () => {
    const { service, email } = context;

    await service.register(validRegistration);
    await service.verifyEmail(
      tokenFromLink(email.sendVerificationEmail.mock.calls[0][1]),
      undefined,
    );

    const user = [...context.prisma._tables.users.values()][0] as Record<string, unknown>;

    user.status = "SUSPENDED";

    await expect(
      service.login("hr@acme.example", "correct horse battery staple", undefined),
    ).rejects.toMatchObject({ code: "ACCOUNT_SUSPENDED" });
  });

  it("resets a password, consumes the token once, and revokes sessions", async () => {
    const { service, sessions, email } = context;

    await service.register(validRegistration);
    await service.verifyEmail(
      tokenFromLink(email.sendVerificationEmail.mock.calls[0][1]),
      undefined,
    );
    await service.forgotPassword("hr@acme.example");
    await service.forgotPassword("unknown@example.com");

    const resetToken = tokenFromLink(email.sendPasswordResetEmail.mock.calls[0][1]);

    await service.resetPassword(resetToken, "another correct horse battery");

    expect(sessions.revokeAllUserSessions).toHaveBeenCalledOnce();

    await expect(
      service.resetPassword(resetToken, "another correct horse battery"),
    ).rejects.toMatchObject({ code: "PASSWORD_RESET_TOKEN_INVALID" });

    // Old password fails, new password works.
    await expect(
      service.login("hr@acme.example", "correct horse battery staple", undefined),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const result = await service.login(
      "hr@acme.example",
      "another correct horse battery",
      undefined,
    );

    expect(result.user.email).toBe("hr@acme.example");
  });

  it("switches organization only for owned memberships", async () => {
    const { service, sessions, email } = context;

    await service.register(validRegistration);
    await service.verifyEmail(
      tokenFromLink(email.sendVerificationEmail.mock.calls[0][1]),
      undefined,
    );

    sessions.accessTokenFor.mockReturnValue("new-access");

    const switched = await service.switchOrganization(
      {
        userId: "user-1",
        sessionId: "session-1",
        organizationId: null,
        membershipId: null,
        role: null,
      },
      "org-1",
    );

    // Cookie-only model: no access JWT in JSON, only the new active tenant.
    expect(switched).not.toHaveProperty("accessToken");
    expect(switched.activeOrganization.id).toBe("org-1");

    await expect(
      service.switchOrganization(
        {
          userId: "user-1",
          sessionId: "session-1",
          organizationId: null,
          membershipId: null,
          role: null,
        },
        "org-other",
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_REQUIRED" });
  });
});
