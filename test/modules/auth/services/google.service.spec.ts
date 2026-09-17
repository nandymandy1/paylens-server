import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleService } from "@/modules/auth/services/google.service.js";

const googleProfile = {
  sub: "google-sub-1",
  email: "Priya@acme.example",
  emailVerified: true,
  firstName: "Priya",
  lastName: "Nair",
};

const createHarness = (
  options: { enabled?: boolean; state?: Record<string, unknown> | null } = {},
) => {
  const enabled = options.enabled ?? true;
  const identities: Record<string, unknown>[] = [];
  const users: Record<string, unknown>[] = [];
  const memberships: Record<string, unknown>[] = [];
  const invitations: Record<string, unknown>[] = [
    {
      id: "invitation-1",
      organizationId: "org-1",
      email: "priya@acme.example",
      role: "EMPLOYEE",
      revokedAt: null,
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  ];

  const oidc = {
    enabled,
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth?state=abc"),
    exchangeCode: vi.fn(async () => "id-token"),
    verifyIdToken: vi.fn(async () => googleProfile),
  };

  const prisma = {
    oAuthIdentity: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, Record<string, string>> }) => {
        const key = where.provider_providerSubject;
        const identity =
          identities.find(
            (entry) =>
              entry.provider === key.provider && entry.providerSubject === key.providerSubject,
          ) ?? null;

        if (!identity) {
          return null;
        }

        return { ...identity, user: users.find((user) => user.id === identity.userId) };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const identity = { id: `identity-${identities.length + 1}`, ...data };

        identities.push(identity);

        return identity;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, string> }) => {
        if (where.email) {
          return users.find((user) => user.email === where.email) ?? null;
        }

        return users.find((user) => user.id === where.id) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const user = { id: `user-${users.length + 1}`, status: "ACTIVE", ...data };

        users.push(user);

        return user;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const user = users.find((entry) => entry.id === where.id) as Record<string, unknown>;

          Object.assign(user, data);

          return user;
        },
      ),
    },
    organizationInvitation: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          invitations.find((invitation) => invitation.id === where.id) ?? null,
      ),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(invitations[0], data);

        return { count: 1 };
      }),
    },
    organizationMembership: {
      findUnique: vi.fn(async () => null),
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
  };

  const sessions = {
    saveOAuthState: vi.fn(async () => undefined),
    consumeOAuthState: vi.fn(async () => options.state ?? null),
    createSession: vi.fn(async (input: Record<string, unknown>) => ({
      sessionId: "session-google",
      accessToken: "access",
      refreshToken: "session-google.secret",
      input,
    })),
  };
  const auth = {
    activeMemberships: vi.fn(async () => []),
    toSafeUser: (user: Record<string, unknown>) => user,
  };
  const audit = { record: vi.fn(async () => undefined) };

  const service = new GoogleService(
    prisma as never,
    oidc as never,
    sessions as never,
    auth as never,
    audit as never,
  );

  return {
    service,
    prisma,
    oidc,
    sessions,
    auth,
    audit,
    users,
    identities,
    memberships,
    invitations,
  };
};

describe("GoogleService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports disabled without env and rejects start/callback", async () => {
    const { service } = createHarness({ enabled: false });

    await expect(service.providers()).resolves.toEqual({ google: false });
    await expect(service.start({})).rejects.toMatchObject({ code: "GOOGLE_AUTH_DISABLED" });
    await expect(
      service.callback({ code: "code", state: "state", userAgent: undefined }),
    ).rejects.toMatchObject({ code: "GOOGLE_AUTH_DISABLED" });
  });

  it("starts the flow with server-side state and short TTL semantics", async () => {
    const { service, sessions, oidc } = createHarness();

    const { url } = await service.start({ redirectTo: "/dashboard/members" });

    expect(url).toContain("accounts.google.com");
    expect(sessions.saveOAuthState).toHaveBeenCalledOnce();
    expect(oidc.generateAuthUrl).toHaveBeenCalledOnce();
  });

  it("rejects unknown or replayed OAuth state", async () => {
    const { service } = createHarness({ state: null });

    await expect(
      service.callback({ code: "code", state: "unknown", userAgent: undefined }),
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
  });

  it("resolves an already-linked Google identity without duplicating the user", async () => {
    const harness = createHarness({
      state: {
        nonce: "nonce-1",
        redirectTo: "/dashboard",
        invitationId: null,
        createdAt: new Date().toISOString(),
      },
    });

    harness.users.push({
      id: "user-1",
      email: "priya@acme.example",
      emailVerifiedAt: new Date(),
      status: "ACTIVE",
    });
    harness.identities.push({
      id: "identity-1",
      userId: "user-1",
      provider: "GOOGLE",
      providerSubject: "google-sub-1",
      providerEmail: "priya@acme.example",
    });

    const result = await harness.service.callback({
      code: "code",
      state: "state",
      userAgent: undefined,
    });

    expect(harness.users).toHaveLength(1);
    expect(result.session.sessionId).toBe("session-google");
    expect(result.redirectTo).toBe("/onboarding/organization");
  });

  it("links a verified matching email to an existing credentials account", async () => {
    const harness = createHarness({
      state: {
        nonce: "nonce-1",
        redirectTo: "/dashboard",
        invitationId: null,
        createdAt: new Date().toISOString(),
      },
    });

    harness.users.push({
      id: "user-1",
      email: "priya@acme.example",
      passwordHash: "argon2-hash",
      emailVerifiedAt: null,
      status: "ACTIVE",
    });

    await harness.service.callback({ code: "code", state: "state", userAgent: undefined });

    expect(harness.users).toHaveLength(1);
    expect(harness.identities).toHaveLength(1);

    const user = harness.users[0] as Record<string, unknown>;

    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it("creates a verified Google-only user with no password", async () => {
    const harness = createHarness({
      state: {
        nonce: "nonce-1",
        redirectTo: "/dashboard",
        invitationId: null,
        createdAt: new Date().toISOString(),
      },
    });

    await harness.service.callback({ code: "code", state: "state", userAgent: undefined });

    const user = harness.users[0] as Record<string, unknown>;

    expect(user.passwordHash).toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();
  });

  it("rejects unverified Google emails", async () => {
    const harness = createHarness({
      state: {
        nonce: "nonce-1",
        redirectTo: "/dashboard",
        invitationId: null,
        createdAt: new Date().toISOString(),
      },
    });

    harness.oidc.verifyIdToken.mockResolvedValueOnce({ ...googleProfile, emailVerified: false });

    await expect(
      harness.service.callback({ code: "code", state: "state", userAgent: undefined }),
    ).rejects.toMatchObject({ code: "GOOGLE_AUTH_FAILED" });
    expect(harness.users).toHaveLength(0);
  });

  it("never merges: sub wins over a conflicting matching email", async () => {
    const harness = createHarness({
      state: {
        nonce: "nonce-1",
        redirectTo: "/dashboard",
        invitationId: null,
        createdAt: new Date().toISOString(),
      },
    });

    harness.users.push(
      { id: "user-a", email: "a@acme.example", emailVerifiedAt: new Date(), status: "ACTIVE" },
      { id: "user-b", email: "priya@acme.example", emailVerifiedAt: new Date(), status: "ACTIVE" },
    );
    harness.identities.push({
      id: "identity-a",
      userId: "user-a",
      provider: "GOOGLE",
      providerSubject: "google-sub-1",
      providerEmail: "a@acme.example",
    });

    await harness.service.callback({ code: "code", state: "state", userAgent: undefined });

    expect(harness.users).toHaveLength(2);
    expect(harness.identities).toHaveLength(1);
  });

  it("consumes invitation context only on exact email match", async () => {
    const harness = createHarness({
      state: {
        nonce: "nonce-1",
        redirectTo: "/dashboard",
        invitationId: "invitation-1",
        createdAt: new Date().toISOString(),
      },
    });

    harness.users.push({
      id: "user-1",
      email: "priya@acme.example",
      emailVerifiedAt: new Date(),
      status: "ACTIVE",
    });

    const result = await harness.service.callback({
      code: "code",
      state: "state",
      userAgent: undefined,
    });

    expect(harness.memberships).toHaveLength(1);
    expect(result.redirectTo).toBe("/dashboard");

    const mismatch = createHarness({
      state: {
        nonce: "nonce-1",
        redirectTo: "/dashboard",
        invitationId: "invitation-1",
        createdAt: new Date().toISOString(),
      },
    });

    mismatch.users.push({
      id: "user-1",
      email: "someone-else@acme.example",
      emailVerifiedAt: new Date(),
      status: "ACTIVE",
    });
    mismatch.oidc.verifyIdToken.mockResolvedValueOnce({
      ...googleProfile,
      email: "someone-else@acme.example",
    });

    await expect(
      mismatch.service.callback({ code: "code", state: "state", userAgent: undefined }),
    ).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });
  });
});
