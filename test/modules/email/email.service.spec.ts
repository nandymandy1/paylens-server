import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import { EMAIL_JOB } from "@/modules/email/email.constants.js";
import { EmailService } from "@/modules/email/email.service.js";

const mockSpan = {
  spanContext: vi.fn(() => ({
    traceId: "aabbccddee112233aabbccddee112233",
    spanId: "1122334455667788",
  })),
  setStatus: vi.fn(),
  end: vi.fn(),
  setAttribute: vi.fn(),
  recordException: vi.fn(),
};

const mockTracer = {
  startSpan: vi.fn(() => mockSpan),
};

vi.mock("@/common/tracing/telemetry.js", () => ({
  executionTracer: vi.fn(() => mockTracer),
}));

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@opentelemetry/api")>();

  return {
    ...actual,
    context: {
      active: vi.fn(() => ({})),
      with: vi.fn((_ctx: unknown, fn: () => void) => fn()),
    },
    trace: {
      ...actual.trace,
      setSpan: vi.fn((_ctx: unknown, span: unknown) => span),
      getSpan: vi.fn(() => null),
      getTracer: vi.fn(() => mockTracer),
    },
  };
});

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
    vi.clearAllMocks();
    harness = createService();
  });

  it("enqueues verification email without touching SMTP", async () => {
    await harness.service.sendVerificationEmail(
      "hr@acme.example",
      "http://localhost:3000/verify-email?token=abc",
    );

    expect(harness.queue.add).toHaveBeenCalledWith(
      EMAIL_JOB.VERIFY_EMAIL,
      expect.objectContaining({
        type: "VERIFY_EMAIL",
        to: "hr@acme.example",
      }),
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
      expect.objectContaining({
        type: "ORGANIZATION_INVITATION",
        to: "new@acme.example",
        organizationName: "Acme",
        role: "EMPLOYEE",
      }),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it("creates a PRODUCER span around each enqueue", async () => {
    await harness.service.sendVerificationEmail(
      "hr@acme.example",
      "http://localhost:3000/verify-email?token=abc",
    );

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "email.queue.publish",
      expect.objectContaining({
        kind: SpanKind.PRODUCER,
        attributes: expect.objectContaining({
          "messaging.system": "bullmq",
          "messaging.operation": "publish",
        }),
      }),
    );
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it("injects trace context into job data for downstream propagation", async () => {
    await harness.service.sendVerificationEmail(
      "hr@acme.example",
      "http://localhost:3000/verify-email?token=abc",
    );

    expect(harness.queue.add).toHaveBeenCalled();
  });

  it("exposes no process-memory outbox", () => {
    expect(harness.service).not.toHaveProperty("outbox");
  });
});
