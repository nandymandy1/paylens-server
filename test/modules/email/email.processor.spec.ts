import { describe, expect, it, vi, beforeEach } from "vitest";
import { SpanKind } from "@opentelemetry/api";
import { buildEmail, EmailProcessor } from "@/modules/email/email.processor.js";

const baseConfig = (overrides: Record<string, unknown> = {}) =>
  ({
    getOrThrow: (key: string) => {
      const values: Record<string, unknown> = {
        "app.smtpUrl": "",
        "app.emailFrom": "PayLens <noreply@paylens.local>",
        "app.environment": "development",
        ...overrides,
      };

      return values[key];
    },
  }) as never;

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
    },
  };
});

const createProcessor = (config: never) => {
  const logger = {
    info: vi.fn((...args: unknown[]) => {
      void args;
    }),
    warn: vi.fn((...args: unknown[]) => {
      void args;
    }),
    error: vi.fn((...args: unknown[]) => {
      void args;
    }),
  };

  return { processor: new EmailProcessor(config, logger as never), logger };
};

describe("EmailProcessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends through SMTP when configured", async () => {
    const sendMail = vi.fn(async () => ({}));
    const { processor } = createProcessor(
      baseConfig({
        "app.smtpUrl": "smtp://user:secret@smtp.example:587",
      }),
    );

    (processor as unknown as { transporter: unknown }).transporter = { sendMail };

    await processor.process({
      name: "verify-email",
      data: {
        type: "VERIFY_EMAIL",
        to: "hr@acme.example",
        verificationUrl: "http://x/verify?token=t",
      },
    } as never);

    expect(sendMail).toHaveBeenCalledOnce();

    const sent = sendMail.mock.calls[0] as unknown as Record<string, unknown>[];

    expect(sent[0]).toMatchObject({
      to: "hr@acme.example",
      subject: "Verify your PayLens email",
    });
    expect(sent[0]).not.toHaveProperty("url");
  });

  it("emits dev email details without SMTP in non-production and succeeds", async () => {
    const { processor, logger } = createProcessor(baseConfig({}));

    await processor.process({
      name: "organization-invitation",
      data: {
        type: "ORGANIZATION_INVITATION",
        to: "new@acme.example",
        invitationUrl: "http://x/invite?token=t",
        organizationName: "Acme",
        role: "EMPLOYEE",
      },
    } as never);

    expect(logger.info).toHaveBeenCalledOnce();

    const [context, message] = logger.info.mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];

    expect(context.event).toBe("dev.email");
    expect(context.recipientPresent).toBe(true);
    expect(context).not.toHaveProperty("to");
    expect(context).not.toHaveProperty("url");
    expect(context.organization).toBe("Acme");
    expect(message).toContain("[DEV EMAIL]");
  });

  it("fails explicitly in production without SMTP and never logs the URL", async () => {
    const { processor, logger } = createProcessor(baseConfig({ "app.environment": "production" }));

    await expect(
      processor.process({
        name: "password-reset",
        data: {
          type: "PASSWORD_RESET",
          to: "hr@acme.example",
          resetUrl: "http://x/reset?token=secret",
        },
      } as never),
    ).rejects.toThrow("SMTP is not configured");

    const logged = (logger.info.mock.calls as unknown[][])
      .concat(logger.warn.mock.calls as unknown[][], logger.error.mock.calls as unknown[][])
      .map((call) => JSON.stringify(call));

    expect(logged.join("\n")).not.toContain("http://x/reset?token=secret");
  });

  it("rejects malformed job payloads without logging them", async () => {
    const { processor, logger } = createProcessor(baseConfig({}));

    await expect(
      processor.process({ name: "bogus", data: { type: "BOGUS", to: "x@y.z" } } as never),
    ).rejects.toThrow("Unsupported email job type: BOGUS");

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("creates no transporter without SMTP config", () => {
    const { processor } = createProcessor(baseConfig({}));

    expect((processor as unknown as { transporter: unknown }).transporter).toBeNull();
  });

  it("escapes user-controlled organization names in invitation HTML", () => {
    const built = buildEmail({
      type: "ORGANIZATION_INVITATION",
      to: "new@acme.example",
      invitationUrl: "http://localhost:3000/invite/accept?token=test",
      organizationName: 'ACME <script>alert("x")</script> & Sons',
      role: "EMPLOYEE",
    });

    expect(built.html).not.toContain("<script>");
    expect(built.html).toContain(
      "ACME &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Sons",
    );
  });

  it("creates a CONSUMER span for job processing", async () => {
    const { processor } = createProcessor(baseConfig({}));

    await processor.process({
      name: "verify-email",
      data: {
        type: "VERIFY_EMAIL",
        to: "hr@acme.example",
        verificationUrl: "http://x/verify?token=t",
      },
    } as never);

    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "email.queue.process",
      expect.objectContaining({
        kind: SpanKind.CONSUMER,
        attributes: expect.objectContaining({
          "messaging.system": "bullmq",
          "messaging.operation": "process",
        }),
      }),
      expect.anything(),
    );
  });

  it("creates a CLIENT span for SMTP send", async () => {
    const sendMail = vi.fn(async () => ({}));
    const { processor } = createProcessor(
      baseConfig({
        "app.smtpUrl": "smtp://user:secret@smtp.example:587",
      }),
    );

    (processor as unknown as { transporter: unknown }).transporter = { sendMail };

    mockTracer.startSpan.mockClear();

    await processor.process({
      name: "verify-email",
      data: {
        type: "VERIFY_EMAIL",
        to: "hr@acme.example",
        verificationUrl: "http://x/verify?token=t",
      },
    } as never);

    // First call is CONSUMER, second is CLIENT (SMTP)
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "email.smtp.send",
      expect.objectContaining({
        kind: SpanKind.CLIENT,
        attributes: expect.objectContaining({
          "messaging.system": "smtp",
        }),
      }),
      expect.anything(),
    );
  });

  it("propagates traceId from producer to consumer", async () => {
    const { processor } = createProcessor(baseConfig({}));

    // Pass trace context in job data
    await processor.process({
      name: "verify-email",
      data: {
        type: "VERIFY_EMAIL",
        to: "hr@acme.example",
        verificationUrl: "http://x/verify?token=t",
        __traceContext: {
          traceparent: "00-aabbccddee112233aabbccddee112233-1122334455667788-01",
        },
      },
    } as never);

    // The CONSUMER span should be created with the extracted context
    expect(mockTracer.startSpan).toHaveBeenCalledWith(
      "email.queue.process",
      expect.anything(),
      expect.anything(),
    );
  });
});
