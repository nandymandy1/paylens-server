import { describe, expect, it, vi } from "vitest";
import { buildEmail, EmailProcessor } from "@/modules/email/email.processor.js";

const baseConfig = (overrides: Record<string, unknown> = {}) =>
  ({
    getOrThrow: (key: string) => {
      const values: Record<string, unknown> = {
        "app.smtpHost": "",
        "app.smtpPort": 587,
        "app.smtpSecure": false,
        "app.smtpUser": "",
        "app.smtpPassword": "",
        "app.emailFrom": "PayLens <noreply@paylens.local>",
        "app.environment": "development",
        ...overrides,
      };

      return values[key];
    },
  }) as never;

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
  it("sends through SMTP when configured", async () => {
    const sendMail = vi.fn(async () => ({}));
    const { processor } = createProcessor(
      baseConfig({
        "app.smtpHost": "smtp.example",
        "app.smtpUser": "user",
        "app.smtpPassword": "secret",
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
    expect(context.to).toBe("new@acme.example");
    expect(context.url).toBe("http://x/invite?token=t");
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
});
