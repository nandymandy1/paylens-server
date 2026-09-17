import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Transporter } from "nodemailer";
import { createTransport } from "nodemailer";

export type OutboundEmail = {
  to: string;
  subject: string;
  html: string;
};

@Injectable()
export class EmailService {
  private readonly transporter: Transporter | null;
  private readonly from: string;
  readonly outbox: OutboundEmail[] = [];

  constructor(config: ConfigService) {
    const host = config.getOrThrow<string>("app.smtpHost");

    this.from = config.getOrThrow<string>("app.emailFrom");
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

  /** True when a real SMTP transport is configured. */
  get usesSmtp(): boolean {
    return this.transporter !== null;
  }

  async send(email: OutboundEmail): Promise<void> {
    if (this.transporter) {
      await this.transporter.sendMail({ from: this.from, ...email });

      return;
    }

    // Development/test fallback: keep mail in memory (assertable, never lost silently).
    this.outbox.push(email);
  }

  async sendVerificationEmail(to: string, link: string): Promise<void> {
    await this.send({
      to,
      subject: "Verify your PayLens email",
      html: `<p>Welcome to PayLens. Confirm your email address to finish creating your organization:</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p>`,
    });
  }

  async sendPasswordResetEmail(to: string, link: string): Promise<void> {
    await this.send({
      to,
      subject: "Reset your PayLens password",
      html: `<p>Someone requested a password reset for this PayLens account.</p><p><a href="${link}">Reset password</a></p><p>This link expires in 30 minutes. If you did not request it, ignore this email.</p>`,
    });
  }

  async sendInvitationEmail(
    to: string,
    organizationName: string,
    role: string,
    link: string,
  ): Promise<void> {
    await this.send({
      to,
      subject: `You are invited to join ${organizationName} on PayLens`,
      html: `<p>You have been invited to join <strong>${organizationName}</strong> as <strong>${role}</strong>.</p><p><a href="${link}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>`,
    });
  }
}
