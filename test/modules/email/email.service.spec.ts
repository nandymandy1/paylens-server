import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_JOB } from "@/modules/email/email.constants.js";
import { EmailService } from "@/modules/email/email.service.js";

const createService = () => {
  const queue = { add: vi.fn(async () => ({})) };
  const executionTrace = {
    withinSpan: vi.fn(async (_n: string, _a: object, fn: () => Promise<unknown>) => fn()),
    now: vi.fn(() => 0),
    durationSince: vi.fn(() => 0),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = new EmailService(queue as never, executionTrace as never);

  return { service, queue };
};

describe("EmailService producer", () => {
  let harness: ReturnType<typeof createService>;

  beforeEach(() => {
    harness = createService();
  });

  it("enqueues verification email without touching SMTP", async () => {
    await harness.service.sendVerificationEmail(
      "hr@acme.example",
      "http://localhost:3000/verify-email?token=abc",
    );

    expect(harness.queue.add).toHaveBeenCalledWith(
      EMAIL_JOB.VERIFY_EMAIL,
      {
        type: "VERIFY_EMAIL",
        to: "hr@acme.example",
        verificationUrl: "http://localhost:3000/verify-email?token=abc",
      },
      expect.objectContaining({
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it("enqueues password-reset email", async () => {
    await harness.service.sendPasswordResetEmail(
      "hr@acme.example",
      "http://localhost:3000/reset-password?token=abc",
    );

    expect(harness.queue.add).toHaveBeenCalledWith(
      EMAIL_JOB.PASSWORD_RESET,
      expect.objectContaining({ type: "PASSWORD_RESET", to: "hr@acme.example" }),
      expect.objectContaining({
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it("enqueues organization invitations with tenant context", async () => {
    await harness.service.sendInvitationEmail(
      "new@acme.example",
      "Acme",
      "EMPLOYEE",
      "http://localhost:3000/invite/accept?token=abc",
    );

    expect(harness.queue.add).toHaveBeenCalledWith(
      EMAIL_JOB.ORGANIZATION_INVITATION,
      {
        type: "ORGANIZATION_INVITATION",
        to: "new@acme.example",
        invitationUrl: "http://localhost:3000/invite/accept?token=abc",
        organizationName: "Acme",
        role: "EMPLOYEE",
      },
      expect.objectContaining({
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it("exposes no process-memory outbox", () => {
    expect(harness.service).not.toHaveProperty("outbox");
  });
});
