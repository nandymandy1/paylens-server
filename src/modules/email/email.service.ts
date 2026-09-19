import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { MembershipRole } from "@prisma/client";
import { context as otelContext, SpanKind, trace } from "@opentelemetry/api";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { TraceBusinessService } from "@/common/tracing/trace-method.decorator.js";
import { injectTraceContext } from "@/common/tracing/bullmq-propagation.js";
import { executionTracer } from "@/common/tracing/telemetry.js";
import { EMAIL_JOB, EMAIL_QUEUE } from "@/modules/email/email.constants.js";
import type { EmailJob } from "@/modules/email/email.type.js";

const jobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const;

/**
 * Producer-facing email API. Callers keep the same method calls, but delivery
 * is asynchronous through BullMQ: these methods enqueue and return without
 * touching SMTP. The worker owns actual delivery.
 *
 * Each enqueue is wrapped in a PRODUCER span so downstream BullMQ consumer
 * spans inherit the correct traceId.
 */
@Injectable()
@TraceBusinessService(["sendVerificationEmail", "sendPasswordResetEmail", "sendInvitationEmail"])
export class EmailService {
  constructor(
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue<EmailJob>,
    readonly executionTrace: ExecutionTraceService,
  ) {}

  async sendVerificationEmail(to: string, verificationUrl: string): Promise<void> {
    const data: EmailJob & Record<string, unknown> = {
      type: "VERIFY_EMAIL",
      to,
      verificationUrl,
    };

    await this.enqueueWithSpan(EMAIL_JOB.VERIFY_EMAIL, data);
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    const data: EmailJob & Record<string, unknown> = {
      type: "PASSWORD_RESET",
      to,
      resetUrl,
    };

    await this.enqueueWithSpan(EMAIL_JOB.PASSWORD_RESET, data);
  }

  async sendInvitationEmail(
    to: string,
    organizationName: string,
    role: MembershipRole,
    invitationUrl: string,
  ): Promise<void> {
    const data: EmailJob & Record<string, unknown> = {
      type: "ORGANIZATION_INVITATION",
      to,
      invitationUrl,
      organizationName,
      role,
    };

    await this.enqueueWithSpan(EMAIL_JOB.ORGANIZATION_INVITATION, data);
  }

  private async enqueueWithSpan(
    jobName: string,
    data: EmailJob & Record<string, unknown>,
  ): Promise<void> {
    const tracer = executionTracer();

    return new Promise<void>((resolve, reject) => {
      const span = tracer.startSpan("email.queue.publish", {
        kind: SpanKind.PRODUCER,
        attributes: {
          "messaging.system": "bullmq",
          "messaging.operation": "publish",
          "messaging.destination.name": EMAIL_QUEUE,
        },
      });

      const spanCtx = trace.setSpan(otelContext.active(), span);

      otelContext.with(spanCtx, async () => {
        try {
          // Inject trace context INSIDE the producer span so the carrier
          // inherits the producer's traceId for downstream consumer linkage.
          injectTraceContext(data);
          await this.queue.add(jobName, data, { ...jobOptions });
          span.setStatus({ code: 1 });
          resolve();
        } catch (error) {
          span.setStatus({ code: 2 });
          if (error instanceof Error) span.recordException(error);
          reject(error);
        } finally {
          span.end();
        }
      });
    });
  }
}
