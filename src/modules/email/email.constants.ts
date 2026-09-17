export const EMAIL_QUEUE = "email";

export const EMAIL_JOB = {
  VERIFY_EMAIL: "verify-email",
  PASSWORD_RESET: "password-reset",
  ORGANIZATION_INVITATION: "organization-invitation",
} as const;

export type EmailJobName = (typeof EMAIL_JOB)[keyof typeof EMAIL_JOB];
