import "../src/telemetry-bootstrap.js";
import { PrismaClient } from "@prisma/client";
import {
  ensureReviewerDemo,
  isReviewerDemoSeedEnabled,
  readReviewerDemoPassword,
  REVIEWER_DEMO_TAG,
} from "../src/seed/reviewer-demo.js";

import { PasswordService } from "../src/modules/auth/services/password.service.js";

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

  const password = readReviewerDemoPassword();
  const prisma = new PrismaClient();

  try {
    const result = await ensureReviewerDemo({
      db: prisma,
      passwords: new PasswordService(),
      password,
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
