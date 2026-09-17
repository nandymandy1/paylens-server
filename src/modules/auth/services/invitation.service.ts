import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/database/prisma.service.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import {
  AUTH_ERROR_CODES,
  INVITATION_TTL_DAYS,
  INVITE_PERMISSIONS,
  type MembershipRoleName,
} from "@/modules/auth/constants/auth.constants.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  normalizeEmail,
} from "@/modules/auth/utils/auth.utils.js";
import { AuditService } from "@/modules/auth/services/audit.service.js";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import { SessionService, type CreatedSession } from "@/modules/auth/services/session.service.js";
import { EmailService } from "@/modules/email/email.service.js";

const daysFromNow = (days: number): Date => new Date(Date.now() + days * 86_400_000);

@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private async requireMembership(principal: RequestPrincipal) {
    if (!principal.organizationId || !principal.membershipId || !principal.role) {
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "Select an organization first.",
        HttpStatus.FORBIDDEN,
      );
    }

    const membership = await this.prisma.organizationMembership.findFirst({
      where: {
        id: principal.membershipId,
        userId: principal.userId,
        organizationId: principal.organizationId,
        status: "ACTIVE",
      },
      include: { organization: true },
    });

    if (!membership) {
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "Your membership is no longer active.",
        HttpStatus.FORBIDDEN,
      );
    }

    return membership;
  }

  async invite(
    inviter: RequestPrincipal,
    email: string,
    role: MembershipRoleName,
    requestId?: string,
  ) {
    const membership = await this.requireMembership(inviter);

    if (!INVITE_PERMISSIONS[membership.role].includes(role)) {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot invite this role.",
        HttpStatus.FORBIDDEN,
      );
    }

    const normalized = normalizeEmail(email);
    const rawToken = generateOpaqueToken();
    const invitation = await this.prisma.organizationInvitation.create({
      data: {
        organizationId: membership.organizationId,
        email: normalized,
        role,
        tokenHash: hashOpaqueToken(rawToken),
        invitedByUserId: inviter.userId,
        expiresAt: daysFromNow(INVITATION_TTL_DAYS),
      },
    });

    const link = `${this.config.getOrThrow<string>("app.frontendUrl")}/invite/accept?token=${rawToken}`;

    await this.email.sendInvitationEmail(normalized, membership.organization.name, role, link);
    await this.audit.record("INVITATION_CREATED", {
      actorUserId: inviter.userId,
      organizationId: membership.organizationId,
      requestId,
      metadata: { invitationId: invitation.id, role },
    });

    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  async preview(rawToken: string) {
    const invitation = await this.findValidInvitation(rawToken);

    return {
      id: invitation.id,
      organization: { id: invitation.organization.id, name: invitation.organization.name },
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  private async findValidInvitation(rawToken: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { tokenHash: hashOpaqueToken(rawToken) },
      include: { organization: true },
    });

    if (!invitation) {
      throw new AuthException(
        AUTH_ERROR_CODES.INVITATION_INVALID,
        "This invitation link is invalid.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (invitation.revokedAt) {
      throw new AuthException(
        AUTH_ERROR_CODES.INVITATION_REVOKED,
        "This invitation was revoked.",
        HttpStatus.GONE,
      );
    }

    if (invitation.acceptedAt) {
      throw new AuthException(
        AUTH_ERROR_CODES.INVITATION_ALREADY_USED,
        "This invitation has already been used.",
        HttpStatus.GONE,
      );
    }

    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new AuthException(
        AUTH_ERROR_CODES.INVITATION_EXPIRED,
        "This invitation has expired.",
        HttpStatus.GONE,
      );
    }

    return invitation;
  }

  async acceptAsAuthenticated(
    principal: RequestPrincipal,
    rawToken: string,
    userAgent: string | undefined,
    requestId?: string,
  ) {
    const invitation = await this.findValidInvitation(rawToken);
    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });

    if (!user || normalizeEmail(user.email) !== normalizeEmail(invitation.email)) {
      throw new AuthException(
        AUTH_ERROR_CODES.INVITATION_EMAIL_MISMATCH,
        "This invitation belongs to a different email address.",
        HttpStatus.FORBIDDEN,
      );
    }

    const conflicting = await this.prisma.organizationMembership.findUnique({
      where: {
        organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
      },
    });

    if (conflicting) {
      throw new AuthException(
        AUTH_ERROR_CODES.INVITATION_ALREADY_USED,
        "You already belong to this organization.",
        HttpStatus.CONFLICT,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.organizationInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });

      if (consumed.count !== 1) {
        throw new AuthException(
          AUTH_ERROR_CODES.INVITATION_ALREADY_USED,
          "This invitation has already been used.",
          HttpStatus.GONE,
        );
      }

      const membership = await tx.organizationMembership.create({
        data: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role },
      });

      return membership;
    });

    await this.sessions.setActiveOrganization(principal.sessionId, {
      organizationId: invitation.organizationId,
      membershipId: result.id,
      role: invitation.role,
    });
    const record = await this.sessions.getSession(principal.sessionId);

    await this.audit.record("INVITATION_ACCEPTED", {
      actorUserId: user.id,
      targetUserId: user.id,
      organizationId: invitation.organizationId,
      requestId,
      metadata: { invitationId: invitation.id },
    });

    return {
      accessToken: record ? this.sessions.accessTokenFor(record) : null,
      membership: { id: result.id, organizationId: result.organizationId, role: result.role },
    };
  }

  async acceptAsNewUser(
    rawToken: string,
    input: { firstName: string; lastName: string; password: string },
    userAgent: string | undefined,
    requestId?: string,
  ): Promise<{ session: CreatedSession; userId: string; membershipId: string }> {
    const invitation = await this.findValidInvitation(rawToken);
    const normalized = normalizeEmail(invitation.email);
    const existing = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (existing) {
      // Existing users must sign in first so the invitation binds to the right account.
      throw new AuthException(
        "INVITATION_LOGIN_REQUIRED",
        "An account with this email already exists. Sign in to accept the invitation.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const passwordHash = await this.passwords.hash(input.password);

    const created = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.organizationInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });

      if (consumed.count !== 1) {
        throw new AuthException(
          AUTH_ERROR_CODES.INVITATION_ALREADY_USED,
          "This invitation has already been used.",
          HttpStatus.GONE,
        );
      }

      // The invitation itself proves control of this mailbox.
      const user = await tx.user.create({
        data: {
          email: normalized,
          passwordHash,
          firstName: input.firstName.trim(),
          lastName: input.lastName.trim(),
          emailVerifiedAt: new Date(),
        },
      });
      const membership = await tx.organizationMembership.create({
        data: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role },
      });

      return { user, membership };
    });

    const session = await this.sessions.createSession({
      userId: created.user.id,
      userAgent,
      activeOrganizationId: invitation.organizationId,
      activeMembershipId: created.membership.id,
      role: invitation.role,
    });

    await this.audit.record("INVITATION_ACCEPTED", {
      actorUserId: created.user.id,
      targetUserId: created.user.id,
      organizationId: invitation.organizationId,
      requestId,
      metadata: { invitationId: invitation.id },
    });

    return { session, userId: created.user.id, membershipId: created.membership.id };
  }

  async revoke(inviter: RequestPrincipal, invitationId: string, requestId?: string): Promise<void> {
    const membership = await this.requireMembership(inviter);
    const invitation = await this.prisma.organizationInvitation.findFirst({
      where: { id: invitationId, organizationId: membership.organizationId },
    });

    if (!invitation || invitation.acceptedAt || invitation.revokedAt) {
      throw new AuthException(
        AUTH_ERROR_CODES.INVITATION_INVALID,
        "This invitation cannot be revoked.",
        HttpStatus.NOT_FOUND,
      );
    }

    if (!INVITE_PERMISSIONS[membership.role].includes(invitation.role)) {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot manage this invitation.",
        HttpStatus.FORBIDDEN,
      );
    }

    await this.prisma.organizationInvitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() },
    });
    await this.audit.record("INVITATION_REVOKED", {
      actorUserId: inviter.userId,
      organizationId: membership.organizationId,
      requestId,
      metadata: { invitationId: invitation.id },
    });
  }

  async list(inviter: RequestPrincipal) {
    const membership = await this.requireMembership(inviter);
    const invitations = await this.prisma.organizationInvitation.findMany({
      where: { organizationId: membership.organizationId },
      orderBy: { createdAt: "desc" },
    });

    return invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
      revokedAt: invitation.revokedAt?.toISOString() ?? null,
      createdAt: invitation.createdAt.toISOString(),
    }));
  }
}
