import { context as otelContext, SpanKind, trace } from "@opentelemetry/api";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import type { Job } from "bullmq";
import { createTransport, type Transporter } from "nodemailer";
import { PinoLogger } from "nestjs-pino";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { extractTraceContext, getTraceIdFromCarrier } from "@/common/tracing/bullmq-propagation.js";
import { executionTracer } from "@/common/tracing/telemetry.js";
import { EMAIL_QUEUE } from "@/modules/email/email.constants.js";
import type { EmailJob } from "@/modules/email/email.type.js";

type BuiltEmail = {
  subject: string;
  html: string;
  url: string;
};

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

export const buildEmail = (job: EmailJob): BuiltEmail => {
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
        html: `<p>You have been invited to join <strong>${escapeHtml(job.organizationName)}</strong> as <strong>${job.role}</strong>.</p><p><a href="${job.invitationUrl}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>`,
        url: job.invitationUrl,
      };
    default: {
      const unexpected = (job as { type?: unknown }).type;

      throw new Error(`Unsupported email job type: ${String(unexpected)}`);
    }
  }
};

/**
 * Owns actual email delivery. SMTP network I/O happens here — never inside
 * HTTP handlers or domain/auth services.
 *
 * When trace context was injected by the producer (EmailService), the worker
 * extracts it and wraps the entire job in a CONSUMER span, with SMTP delivery
 * as a nested CLIENT span.
 */
@Processor(EMAIL_QUEUE)
export class EmailProcessor extends WorkerHost {
  private readonly transporter: Transporter | null;
  private readonly from: string;
  private readonly environment: string;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
    private readonly executionTrace?: ExecutionTraceService,
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
    await this.worker.close(true);
  }

  async process(job: Job<EmailJob>): Promise<void> {
    const built = buildEmail(job.data);

    const jobData = job.data as Record<string, unknown>;
    const extractedContext = extractTraceContext(jobData);
    const producerTraceId = getTraceIdFromCarrier(jobData);

    const tracer = executionTracer();

    // CONSUMER span: represents the worker receiving and processing the job.
    const consumerSpan = tracer.startSpan(
      "email.queue.process",
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.system": "bullmq",
          "messaging.operation": "process",
          "messaging.destination.name": EMAIL_QUEUE,
          "messaging.bullmq.job.name": job.name ?? "unknown",
        },
      },
      extractedContext,
    );

    const consumerCtx = trace.setSpan(extractedContext, consumerSpan);

    try {
      await otelContext.with(consumerCtx, async () => {
        if (this.transporter) {
          // CLIENT span: actual external SMTP operation.
          const smtpSpan = tracer.startSpan(
            "email.smtp.send",
            {
              kind: SpanKind.CLIENT,
              attributes: {
                "messaging.system": "smtp",
                "messaging.operation": "send",
                "messaging.destination.name": job.data.type,
                "email.provider": this.config.getOrThrow<string>("app.smtpHost"),
              },
            },
            consumerCtx,
          );

          const smtpCtx = trace.setSpan(consumerCtx, smtpSpan);

          try {
            await otelContext.with(smtpCtx, () =>
              this.transporter!.sendMail({
                from: this.from,
                to: job.data.to,
                subject: built.subject,
                html: built.html,
              }),
            );
            smtpSpan.setStatus({ code: 1 });
          } catch (error) {
            smtpSpan.setStatus({ code: 2 });
            if (error instanceof Error) smtpSpan.recordException(error);
            throw error;
          } finally {
            smtpSpan.end();
          }

          return;
        }

        if (this.environment === "production") {
          throw new Error(`Email delivery unavailable: SMTP is not configured (job ${job.name})`);
        }

        this.logger.info(
          {
            event: "dev.email",
            type: job.data.type,
            subject: built.subject,
            recipientPresent: true,
            ...(producerTraceId !== undefined ? { producerTraceId } : {}),
            ...(job.data.type === "ORGANIZATION_INVITATION"
              ? {
                  organization: job.data.organizationName,
                  role: job.data.role,
                }
              : {}),
          },
          `[DEV EMAIL] type=${job.data.type}`,
        );
      });

      consumerSpan.setStatus({ code: 1 });
    } catch (error) {
      consumerSpan.setStatus({ code: 2 });
      if (error instanceof Error) consumerSpan.recordException(error);
      throw error;
    } finally {
      consumerSpan.end();
    }
  }
}
