import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import {
  ensureReviewerDemo,
  isReviewerDemoSeedEnabled,
  readReviewerDemoPassword,
  REVIEWER_DEMO_MEMBERSHIP_ID,
  REVIEWER_DEMO_ORGANIZATION_ID,
  REVIEWER_DEMO_ORGANIZATION_SLUG,
  REVIEWER_DEMO_USER_EMAIL,
  REVIEWER_DEMO_USER_ID,
} from "@/seed/reviewer-demo.js";

const TEST_PASSWORD = "ThereWeGoAgain@123";

type Row = Record<string, unknown>;

type FakeDb = {
  calls: { create: string[]; update: string[] };
  user: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  organizationMembership: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

const fakeDb = (
  seed: {
    user?: Row | null;
    organization?: Row | null;
    membership?: Row | null;
  } = {},
): FakeDb => {
  const calls = { create: [] as string[], update: [] as string[] };
  const store = {
    user: seed.user ?? null,
    organization: seed.organization ?? null,
    membership: seed.membership ?? null,
  };

  const whereMatches = (row: Row | null, where: Row): Row | null => {
    if (!row) return null;
    if (where.email !== undefined) return row.email === where.email ? row : null;
    if (where.slug !== undefined) return row.slug === where.slug ? row : null;
    if (where.organizationId_userId !== undefined) {
      const pair = where.organizationId_userId as Row;

      return row.organizationId === pair.organizationId && row.userId === pair.userId ? row : null;
    }

    return null;
  };

  const fake: FakeDb = {
    calls,
    user: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => whereMatches(store.user, where)),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.create.push("user");
        store.user = { ...data };

        return store.user;
      }),
    },
    organization: {
      findUnique: vi.fn(async ({ where }: { where: Row }) =>
        whereMatches(store.organization, where),
      ),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.create.push("organization");
        store.organization = { ...data };

        return store.organization;
      }),
    },
    organizationMembership: {
      findUnique: vi.fn(async ({ where }: { where: Row }) => whereMatches(store.membership, where)),
      create: vi.fn(async ({ data }: { data: Row }) => {
        calls.create.push("membership");
        store.membership = { ...data };

        return store.membership;
      }),
    },
  };

  return fake;
};

const asDb = (fake: FakeDb): PrismaClient => fake as unknown as PrismaClient;

const reviewerUser = (overrides: Row = {}): Row => ({
  id: REVIEWER_DEMO_USER_ID,
  email: REVIEWER_DEMO_USER_EMAIL,
  firstName: "Demo",
  lastName: "User",
  passwordHash: "argon2id-hash",
  emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  status: "ACTIVE",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const reviewerOrganization = (overrides: Row = {}): Row => ({
  id: REVIEWER_DEMO_ORGANIZATION_ID,
  name: "Demo Company",
  slug: REVIEWER_DEMO_ORGANIZATION_SLUG,
  status: "ACTIVE",
  ...overrides,
});

const reviewerMembership = (overrides: Row = {}): Row => ({
  id: REVIEWER_DEMO_MEMBERSHIP_ID,
  organizationId: REVIEWER_DEMO_ORGANIZATION_ID,
  userId: REVIEWER_DEMO_USER_ID,
  role: "TENANT_OWNER",
  status: "ACTIVE",
  ...overrides,
});

describe("reviewer-demo seed", () => {
  describe("deployment gate", () => {
    it("is disabled unless SEED_REVIEWER_DEMO is exactly true", () => {
      expect(isReviewerDemoSeedEnabled({} as NodeJS.ProcessEnv)).toBe(false);
      expect(isReviewerDemoSeedEnabled({ SEED_REVIEWER_DEMO: "false" })).toBe(false);
      expect(isReviewerDemoSeedEnabled({ SEED_REVIEWER_DEMO: "1" })).toBe(false);
      expect(isReviewerDemoSeedEnabled({ SEED_REVIEWER_DEMO: "true" })).toBe(true);
      expect(isReviewerDemoSeedEnabled({ SEED_REVIEWER_DEMO: " TRUE " })).toBe(true);
    });

    it("requires REVIEWER_DEMO_PASSWORD when enabled", () => {
      expect(() => readReviewerDemoPassword({} as NodeJS.ProcessEnv)).toThrow(
        /REVIEWER_DEMO_PASSWORD is required/,
      );
      expect(readReviewerDemoPassword({ REVIEWER_DEMO_PASSWORD: "  secret  " })).toBe("secret");
    });
  });

  describe("ensureReviewerDemo", () => {
    let passwords: PasswordService;

    beforeAll(() => {
      passwords = new PasswordService();
    });

    it("first run creates organization, verified user, and owner membership", async () => {
      const fake = fakeDb();

      const result = await ensureReviewerDemo({
        db: asDb(fake),
        passwords,
        password: TEST_PASSWORD,
      });

      expect(result.status).toBe("created");
      expect(fake.calls.create).toEqual(["organization", "user", "membership"]);

      const createdUser = fake.user.create.mock.calls[0][0].data as Row;

      expect(createdUser.id).toBe(REVIEWER_DEMO_USER_ID);
      expect(createdUser.email).toBe(REVIEWER_DEMO_USER_EMAIL);
      expect(createdUser.emailVerifiedAt).toBeInstanceOf(Date);
      expect(createdUser.status).toBe("ACTIVE");
      expect(await passwords.verify(createdUser.passwordHash as string, TEST_PASSWORD)).toBe(true);

      const createdMembership = fake.organizationMembership.create.mock.calls[0][0].data as Row;

      expect(createdMembership.role).toBe("TENANT_OWNER");
      expect(createdMembership.status).toBe("ACTIVE");
      expect(createdMembership.organizationId).toBe(REVIEWER_DEMO_ORGANIZATION_ID);
      expect(createdMembership.userId).toBe(REVIEWER_DEMO_USER_ID);
    });

    it("second run creates nothing and touches no existing row", async () => {
      const fake = fakeDb({
        user: reviewerUser(),
        organization: reviewerOrganization(),
        membership: reviewerMembership(),
      });

      const result = await ensureReviewerDemo({
        db: asDb(fake),
        passwords,
        password: TEST_PASSWORD,
      });

      expect(result.status).toBe("already-exists");
      expect(fake.calls.create).toEqual([]);
    });

    it("missing membership only creates the membership", async () => {
      const fake = fakeDb({
        user: reviewerUser(),
        organization: reviewerOrganization(),
        membership: null,
      });

      const result = await ensureReviewerDemo({
        db: asDb(fake),
        passwords,
        password: TEST_PASSWORD,
      });

      expect(result.status).toBe("repaired");
      expect(fake.calls.create).toEqual(["membership"]);
      expect(result.createdUser).toBe(false);
      expect(result.createdOrganization).toBe(false);
    });

    it("foreign email collision fails safe with zero writes", async () => {
      const fake = fakeDb({
        user: reviewerUser({ id: "foreign-user-id" }),
        organization: reviewerOrganization(),
        membership: null,
      });

      await expect(
        ensureReviewerDemo({ db: asDb(fake), passwords, password: TEST_PASSWORD }),
      ).rejects.toThrow(/Collision.*user email/);
      expect(fake.calls.create).toEqual([]);
    });

    it("foreign slug collision fails safe with zero writes", async () => {
      const fake = fakeDb({
        user: null,
        organization: reviewerOrganization({ id: "foreign-org-id" }),
        membership: null,
      });

      await expect(
        ensureReviewerDemo({ db: asDb(fake), passwords, password: TEST_PASSWORD }),
      ).rejects.toThrow(/Collision.*organization slug/);
      expect(fake.calls.create).toEqual([]);
    });

    it("rejects a password that violates the auth policy", async () => {
      const fake = fakeDb();

      await expect(
        ensureReviewerDemo({ db: asDb(fake), passwords, password: "short" }),
      ).rejects.toThrow(/between 12 and 128/);
      expect(fake.calls.create).toEqual([]);
    });
  });
});
