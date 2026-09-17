import { describe, expect, it } from "vitest";
import { EmailService } from "@/modules/email/email.service.js";

const configFor = (overrides: Record<string, string | number | boolean> = {}) =>
  ({
    getOrThrow: (key: string) => {
      const values: Record<string, string | number | boolean> = {
        "app.smtpHost": "",
        "app.smtpPort": 587,
        "app.smtpSecure": false,
        "app.smtpUser": "",
        "app.smtpPassword": "",
        "app.emailFrom": "PayLens <noreply@paylens.local>",
        ...overrides,
      };

      return values[key];
    },
  }) as never;

describe("EmailService", () => {
  it("keeps mail in memory when SMTP is not configured", async () => {
    const service = new EmailService(configFor());

    expect(service.usesSmtp).toBe(false);

    await service.sendVerificationEmail(
      "hr@acme.example",
      "http://localhost:3000/verify-email?token=abc",
    );
    await service.sendPasswordResetEmail(
      "hr@acme.example",
      "http://localhost:3000/reset-password?token=abc",
    );
    await service.sendInvitationEmail(
      "new@acme.example",
      "Acme",
      "EMPLOYEE",
      "http://localhost:3000/invite/accept?token=abc",
    );

    expect(service.outbox).toHaveLength(3);
    expect(service.outbox[0].to).toBe("hr@acme.example");
    // Email bodies carry single-use links only — never passwords or session tokens.
    expect(service.outbox[0].html).toContain("/verify-email?token=");
    expect(service.outbox[0].html).not.toContain("password");
  });
});
