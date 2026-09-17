import { Processor, WorkerHost } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import type { Job } from "bullmq";
import { createTransport, type Transporter } from "nodemailer";
import { PinoLogger } from "nestjs-pino";
import { EMAIL_QUEUE } from "@/modules/email/email.constants.js";
import type { EmailJob } from "@/modules/email/email.type.js";

type BuiltEmail = {
  subject: string;
  html: string;
  url: string;
};

const buildEmail = (job: EmailJob): BuiltEmail => {
  switch (job.type) {
    case "VERIFY_EMAIL":
      return {
        subject: "Verify your PayLens email",
        html: `<p>Welcome to PayLens. Confirm your email address to finish creating your organization:</p><p><a href="${job.verificationUrl}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
        url: job.verificationUrl,
      };
    case "PASSWORD_RESET":
      return {
        subject: "Reset your PayLens password",
        html: `<p>Someone requested a password reset for this PayLens account.</p><p><a href="${job.resetUrl}">Reset password</a></p><p>This link expires in 30 minutes. If you did not request it, ignore this email.</p>`,
        url: job.resetUrl,
      };
    case "ORGANIZATION_INVITATION":
      return {
        subject: `You are invited to join ${job.organizationName} on PayLens`,
        html: `<p>You have been invited to join <strong>${job.organizationName}</strong> as <strong>${job.role}</strong>.</p><p><a href="${job.invitationUrl}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>`,
        url: job.invitationUrl,
      };
  }
};

/**
 * Owns actual email delivery. SMTP network I/O happens here — never inside
 * HTTP handlers or domain/auth services.
 */
@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly transporter: Transporter | null;
  private readonly from: string;
  private readonly environment: string;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    super();

    const host = config.getOrThrow<string>("app.smtpHost");

    this.from = config.getOrThrow<string>("app.emailFrom");
    this.environment = config.getOrThrow<string>("app.environment");
    this.transporter = host
      ? createTransport({
          host,
          port: config.getOrThrow<number>("app.smtpPort"),
          secure: config.getOrThrow<boolean>("app.smtpSecure"),
          auth: {
            user: config.getOrThrow<string>("app.smtpUser"),
            pass: config.getOrThrow<string>("app.smtpPassword"),
          },
        })
      : null;
  }

  async onModuleDestroy(): Promise<void> {
    // Force-close: a graceful close hangs when Redis is unreachable, which
    // would block process shutdown while /ready already reports Redis down.
    // Aborting in-flight jobs at teardown is correct — Nest is terminating.
    await this.worker.close(true);
  }

  async process(job: Job<EmailJob>): Promise<void> {
    const built = buildEmail(job.data);

    if (this.transporter) {
      await this.transporter.sendMail({
        from: this.from,
        to: job.data.to,
        subject: built.subject,
        html: built.html,
      });

      return;
    }

    if (this.environment === "production") {
      // Never print action tokens/URLs in production; fail explicitly instead.
      throw new Error(`Email delivery unavailable: SMTP is not configured (job ${job.name})`);
    }

    // Narrow, deliberate development exception: the only place action URLs may
    // be logged, so local auth flows stay testable without a mail provider.
    this.logger.info(
      {
        event: "dev.email",
        type: job.data.type,
        to: job.data.to,
        subject: built.subject,
        url: built.url,
        ...(job.data.type === "ORGANIZATION_INVITATION"
          ? { organization: job.data.organizationName, role: job.data.role }
          : {}),
      },
      `[DEV EMAIL] type=${job.data.type} to=${job.data.to}`,
    );
  }
}
