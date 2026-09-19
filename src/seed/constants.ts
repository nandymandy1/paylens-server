export const SEED_VERSION = "SEED-R1";

export const SEED_AS_OF_DATE = new Date("2026-09-01T00:00:00.000Z");

export const EMPLOYEE_BATCH_SIZE = 500;

export const COMPENSATION_BATCH_SIZE = 500;

export const HISTORY_BATCH_SIZE = 500;

export const SEED_RECONCILE_BATCH_SIZE = 500;

export const ROLLBACK_BATCH_SIZE = 500;

export const CONTROLLED_USER_COUNT = 35;

export const ORGANIZATION_COUNT = 30;

export const CONTROLLED_EMAIL_DOMAIN = "seed.paylens.test";

export const SEED_EMPLOYEE_PREFIX = `${SEED_VERSION}-`;

export const PAYLENS_DEMO_SLUG = "paylens-demo";

export const PAYLENS_DEMO_EMPLOYEE_COUNT = 10_000;

export const PAYLENS_DEMO_DEPARTMENT_COUNT = 16;

export const ACME_SANDBOX_SLUG = "acme-sandbox";

export const ACME_SANDBOX_EMPLOYEE_COUNT = 0;

export const ACME_SANDBOX_DEPARTMENT_COUNT = 4;

export const GENERATED_SIZE_DISTRIBUTION = {
  MICRO: 6,
  SMALL: 8,
  MEDIUM: 7,
  LARGE: 5,
  VERY_LARGE: 2,
} as const;
