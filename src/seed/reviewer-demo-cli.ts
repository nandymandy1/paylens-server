import { PrismaClient } from "@prisma/client";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import {
  ensureReviewerDemo,
  isReviewerDemoSeedEnabled,
  readReviewerDemoPassword,
  REVIEWER_DEMO_TAG,
} from "./reviewer-demo.js";

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const main = async (): Promise<void> => {
  if (!process.env.DATABASE_URL) {
    throw new Error(`[${REVIEWER_DEMO_TAG}] DATABASE_URL is required`);
  }

  if (!isReviewerDemoSeedEnabled()) {
    log(`[${REVIEWER_DEMO_TAG}] SEED_REVIEWER_DEMO is not true; skipping.`);

    return;
  }

  const prisma = new PrismaClient();

  try {
    const result = await ensureReviewerDemo({
      db: prisma,
      passwords: new PasswordService(),
      password: readReviewerDemoPassword(),
    });

    if (result.status === "already-exists") {
      log(`[${REVIEWER_DEMO_TAG}] Reviewer demo account already exists; skipping seed.`);
    } else {
      log(
        `[${REVIEWER_DEMO_TAG}] Reviewer demo bootstrap ${result.status} ` +
          `(organization=${result.createdOrganization} user=${result.createdUser} ` +
          `membership=${result.createdMembership}).`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
};

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
