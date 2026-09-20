import { PrismaClient } from "@prisma/client";
import { PasswordService } from "@/modules/auth/services/password.service.js";

export const REVIEWER_DEMO_TAG = "REVIEWER-DEMO";

export const REVIEWER_DEMO_ORGANIZATION_ID = "reviewer-demo-org";

export const REVIEWER_DEMO_ORGANIZATION_SLUG = "demo-company";

export const REVIEWER_DEMO_ORGANIZATION_NAME = "Demo Company";

export const REVIEWER_DEMO_USER_ID = "reviewer-demo-user";

export const REVIEWER_DEMO_USER_EMAIL = "demo.user@demo.company.com";

export const REVIEWER_DEMO_USER_FIRST_NAME = "Demo";

export const REVIEWER_DEMO_USER_LAST_NAME = "User";

export const REVIEWER_DEMO_MEMBERSHIP_ID = "reviewer-demo-membership";

export type ReviewerDemoDb = Pick<PrismaClient, "organization" | "organizationMembership" | "user">;

export type ReviewerDemoResult = {
  status: "created" | "repaired" | "already-exists";
  createdOrganization: boolean;
  createdUser: boolean;
  createdMembership: boolean;
};

export type ReviewerDemoInput = {
  db: ReviewerDemoDb;
  passwords?: PasswordService;
  password: string;
};

/**
 * Deployment gate: the reviewer-demo bootstrap runs only when explicitly
 * opted in, even though it is safe to run in production (unlike SEED-R1).
 */
export const isReviewerDemoSeedEnabled = (raw: NodeJS.ProcessEnv = process.env): boolean =>
  (raw.SEED_REVIEWER_DEMO ?? "false").trim().toLowerCase() === "true";

export const readReviewerDemoPassword = (raw: NodeJS.ProcessEnv = process.env): string => {
  const password = raw.REVIEWER_DEMO_PASSWORD?.trim();

  if (!password) {
    throw new Error(
      `[${REVIEWER_DEMO_TAG}] REVIEWER_DEMO_PASSWORD is required when SEED_REVIEWER_DEMO=true`,
    );
  }

  return password;
};

/**
 * Detect-first ownership guard: throws before any write when a reserved key
 * is owned by a foreign row. Never takes over an existing account/tenant.
 */
const assertReviewerOwnership = (
  kind: "user email" | "organization slug",
  key: string,
  existingId: string | null | undefined,
  expectedId: string,
): void => {
  if (existingId && existingId !== expectedId) {
    throw new Error(`[${REVIEWER_DEMO_TAG}] Collision: ${kind} is owned by a non-demo row: ${key}`);
  }
};

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "P2002";

/**
 * Create-once bootstrap for the intentionally public reviewer account.
 *
 * ensureExists, not forceDesiredState: existing rows are never updated,
 * so repeated deployments never reset reviewer workspace data, timestamps,
 * verification state, or the password hash. Only genuinely missing rows are
 * created (after ownership checks). The P2002 catch makes concurrent
 * container boots converge instead of crashing.
 */
export const ensureReviewerDemo = async ({
  db,
  passwords = new PasswordService(),
  password,
}: ReviewerDemoInput): Promise<ReviewerDemoResult> => {
  passwords.assertPolicy(password);

  const existingUser = await db.user.findUnique({
    where: { email: REVIEWER_DEMO_USER_EMAIL },
    select: { id: true },
  });

  assertReviewerOwnership(
    "user email",
    REVIEWER_DEMO_USER_EMAIL,
    existingUser?.id,
    REVIEWER_DEMO_USER_ID,
  );

  const existingOrganization = await db.organization.findUnique({
    where: { slug: REVIEWER_DEMO_ORGANIZATION_SLUG },
    select: { id: true },
  });

  assertReviewerOwnership(
    "organization slug",
    REVIEWER_DEMO_ORGANIZATION_SLUG,
    existingOrganization?.id,
    REVIEWER_DEMO_ORGANIZATION_ID,
  );

  const existingMembership = await db.organizationMembership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: REVIEWER_DEMO_ORGANIZATION_ID,
        userId: REVIEWER_DEMO_USER_ID,
      },
    },
    select: { id: true },
  });

  let createdOrganization = false;
  let createdUser = false;
  let createdMembership = false;

  if (!existingOrganization) {
    try {
      await db.organization.create({
        data: {
          id: REVIEWER_DEMO_ORGANIZATION_ID,
          name: REVIEWER_DEMO_ORGANIZATION_NAME,
          slug: REVIEWER_DEMO_ORGANIZATION_SLUG,
          status: "ACTIVE",
        },
      });
      createdOrganization = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  if (!existingUser) {
    try {
      await db.user.create({
        data: {
          id: REVIEWER_DEMO_USER_ID,
          email: REVIEWER_DEMO_USER_EMAIL,
          firstName: REVIEWER_DEMO_USER_FIRST_NAME,
          lastName: REVIEWER_DEMO_USER_LAST_NAME,
          passwordHash: await passwords.hash(password),
          emailVerifiedAt: new Date(),
          status: "ACTIVE",
        },
      });
      createdUser = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  if (!existingMembership) {
    try {
      await db.organizationMembership.create({
        data: {
          id: REVIEWER_DEMO_MEMBERSHIP_ID,
          organizationId: REVIEWER_DEMO_ORGANIZATION_ID,
          userId: REVIEWER_DEMO_USER_ID,
          role: "TENANT_OWNER",
          status: "ACTIVE",
        },
      });
      createdMembership = true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  if (createdOrganization || createdUser || createdMembership) {
    return {
      status: existingOrganization || existingUser || existingMembership ? "repaired" : "created",
      createdOrganization,
      createdUser,
      createdMembership,
    };
  }

  return {
    status: "already-exists",
    createdOrganization: false,
    createdUser: false,
    createdMembership: false,
  };
};
