import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import type { MembershipRole } from "@prisma/client";
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
 */
@Injectable()
export class EmailService {
  constructor(@InjectQueue(EMAIL_QUEUE) private readonly queue: Queue<EmailJob>) {}

  async sendVerificationEmail(to: string, verificationUrl: string): Promise<void> {
    await this.queue.add(
      EMAIL_JOB.VERIFY_EMAIL,
      { type: "VERIFY_EMAIL", to, verificationUrl },
      { ...jobOptions },
    );
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    await this.queue.add(
      EMAIL_JOB.PASSWORD_RESET,
      { type: "PASSWORD_RESET", to, resetUrl },
      { ...jobOptions },
    );
  }

  async sendInvitationEmail(
    to: string,
    organizationName: string,
    role: MembershipRole,
    invitationUrl: string,
  ): Promise<void> {
    await this.queue.add(
      EMAIL_JOB.ORGANIZATION_INVITATION,
      { type: "ORGANIZATION_INVITATION", to, invitationUrl, organizationName, role },
      { ...jobOptions },
    );
  }
}
