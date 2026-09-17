import { HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "@/database/prisma.service.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import {
  AUTH_ERROR_CODES,
  OAUTH_STATE_TTL_SECONDS,
} from "@/modules/auth/constants/auth.constants.js";
import type { GoogleProfile } from "@/modules/auth/types/auth.types.js";
import {
  generateOpaqueToken,
  getSafeRedirectPath,
  normalizeEmail,
} from "@/modules/auth/utils/auth.utils.js";
import { AuditService } from "@/modules/auth/services/audit.service.js";
import { AuthService } from "@/modules/auth/services/auth.service.js";
import { GoogleOidcClient } from "@/modules/auth/services/google-oidc.client.js";
import { SessionService, type CreatedSession } from "@/modules/auth/services/session.service.js";

@Injectable()
export class GoogleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly oidc: GoogleOidcClient,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  private requireEnabled(): void {
    if (!this.oidc.enabled) {
      throw new AuthException(
        AUTH_ERROR_CODES.GOOGLE_AUTH_DISABLED,
        "Google sign-in is not enabled.",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  async start(options: { redirectTo?: string; invitationId?: string }): Promise<{
    url: string;
    state: string;
  }> {
    this.requireEnabled();

    let invitationId: string | null = null;

    if (options.invitationId) {
      // Validate early so the OAuth round-trip never starts from a dead invitation.
      const invitation = await this.prisma.organizationInvitation.findUnique({
        where: { id: options.invitationId },
      });

      if (
        !invitation ||
        invitation.revokedAt ||
        invitation.acceptedAt ||
        invitation.expiresAt.getTime() < Date.now()
      ) {
        throw new AuthException(
          AUTH_ERROR_CODES.INVITATION_INVALID,
          "This invitation link is invalid.",
          HttpStatus.BAD_REQUEST,
        );
      }

      invitationId = invitation.id;
    }

    const state = generateOpaqueToken(16);
    const nonce = generateOpaqueToken(16);

    await this.sessions.saveOAuthState(state, {
      nonce,
      redirectTo: getSafeRedirectPath(options.redirectTo),
      invitationId,
      createdAt: new Date().toISOString(),
    });

    // Defense-in-depth: bind the state to the browser that started the flow.
    return { url: this.oidc.generateAuthUrl(state, nonce), state };
  }

  async callback(options: {
    code: string;
    state: string;
    browserState: string | undefined;
    userAgent: string | undefined;
    requestId?: string;
  }): Promise<{ session: CreatedSession; redirectTo: string }> {
    this.requireEnabled();

    if (!options.code || !options.state) {
      throw new AuthException(
        AUTH_ERROR_CODES.OAUTH_STATE_INVALID,
        "Google sign-in failed. Restart the flow.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!options.browserState || options.browserState !== options.state) {
      throw new AuthException(
        AUTH_ERROR_CODES.OAUTH_STATE_INVALID,
        "Google sign-in session expired. Restart the flow.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const stored = await this.sessions.consumeOAuthState(options.state);

    if (!stored) {
      throw new AuthException(
        AUTH_ERROR_CODES.OAUTH_STATE_INVALID,
        "Google sign-in session expired. Restart the flow.",
        HttpStatus.BAD_REQUEST,
      );
    }

    let profile: GoogleProfile;

    try {
      const idToken = await this.oidc.exchangeCode(options.code);

      profile = await this.oidc.verifyIdToken(idToken, stored.nonce);
    } catch {
      throw new AuthException(
        AUTH_ERROR_CODES.GOOGLE_AUTH_FAILED,
        "Google sign-in failed. Restart the flow.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (!profile.emailVerified) {
      throw new AuthException(
        AUTH_ERROR_CODES.GOOGLE_AUTH_FAILED,
        "Google could not verify this email address.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.resolveUser(profile, options.requestId);
    const memberships = await this.auth.activeMemberships(user.id);

    let activeOrganizationId: string | null = null;
    let activeMembershipId: string | null = null;
    let role: (typeof memberships)[number]["role"] | null = null;

    if (stored.invitationId) {
      const accepted = await this.consumeInvitationForGoogleUser(
        stored.invitationId,
        user.id,
        normalizeEmail(profile.email),
        options.requestId,
      );

      activeOrganizationId = accepted.organizationId;
      activeMembershipId = accepted.membershipId;
      role = accepted.role;
    } else if (memberships.length === 1) {
      activeOrganizationId = memberships[0].organizationId;
      activeMembershipId = memberships[0].id;
      role = memberships[0].role;
    }

    const session = await this.sessions.createSession({
      userId: user.id,
      userAgent: options.userAgent,
      activeOrganizationId,
      activeMembershipId,
      role,
    });

    const redirectTo =
      memberships.length === 0 && !stored.invitationId
        ? "/onboarding/organization"
        : memberships.length > 1 && !stored.invitationId
          ? "/select-organization"
          : stored.redirectTo;

    return { session, redirectTo };
  }

  /** Provider-subject identity wins; verified matching email links on first contact only. */
  private async resolveUser(profile: GoogleProfile, requestId?: string) {
    const identity = await this.prisma.oAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: "GOOGLE", providerSubject: profile.sub } },
      include: { user: true },
    });

    if (identity) {
      // Sub already linked: never merge or relink, even if the email now differs (§43).
      if (normalizeEmail(identity.providerEmail ?? "") !== normalizeEmail(profile.email)) {
        await this.audit.record("GOOGLE_ACCOUNT_LINKED", {
          actorUserId: identity.userId,
          targetUserId: identity.userId,
          requestId,
          metadata: { note: "email-changed-sub-stable", conflict: true },
        });
      }

      if (identity.user.status === "SUSPENDED") {
        throw new AuthException(
          AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
          "This account has been suspended.",
          HttpStatus.FORBIDDEN,
        );
      }

      return identity.user;
    }

    const normalized = normalizeEmail(profile.email);
    const existing = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (existing) {
      if (existing.status === "SUSPENDED") {
        throw new AuthException(
          AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
          "This account has been suspended.",
          HttpStatus.FORBIDDEN,
        );
      }

      await this.prisma.oAuthIdentity.create({
        data: {
          userId: existing.id,
          provider: "GOOGLE",
          providerSubject: profile.sub,
          providerEmail: normalized,
        },
      });

      const user =
        existing.emailVerifiedAt === null
          ? await this.prisma.user.update({
              where: { id: existing.id },
              data: { emailVerifiedAt: new Date() },
            })
          : existing;

      await this.audit.record("GOOGLE_ACCOUNT_LINKED", {
        actorUserId: user.id,
        targetUserId: user.id,
        requestId,
      });

      return user;
    }

    const user = await this.prisma.user.create({
      data: {
        email: normalized,
        passwordHash: null,
        firstName: profile.firstName.slice(0, 100),
        lastName: profile.lastName.slice(0, 100),
        emailVerifiedAt: new Date(),
      },
    });

    await this.prisma.oAuthIdentity.create({
      data: {
        userId: user.id,
        provider: "GOOGLE",
        providerSubject: profile.sub,
        providerEmail: normalized,
      },
    });
    await this.audit.record("USER_REGISTERED", {
      actorUserId: user.id,
      targetUserId: user.id,
      requestId,
      metadata: { via: "google" },
    });
    await this.audit.record("GOOGLE_ACCOUNT_LINKED", {
      actorUserId: user.id,
      targetUserId: user.id,
      requestId,
    });

    return user;
  }

  private async consumeInvitationForGoogleUser(
    invitationId: string,
    userId: string,
    googleEmail: string,
    requestId?: string,
  ) {
    const accepted = await this.prisma.$transaction(async (tx) => {
      const invitation = await tx.organizationInvitation.findUnique({
        where: { id: invitationId },
      });

      if (
        !invitation ||
        invitation.revokedAt ||
        invitation.acceptedAt ||
        invitation.expiresAt.getTime() < Date.now()
      ) {
        throw new AuthException(
          AUTH_ERROR_CODES.INVITATION_INVALID,
          "This invitation is no longer valid.",
          HttpStatus.BAD_REQUEST,
        );
      }

      if (normalizeEmail(invitation.email) !== googleEmail) {
        throw new AuthException(
          AUTH_ERROR_CODES.INVITATION_EMAIL_MISMATCH,
          "This invitation belongs to a different email address.",
          HttpStatus.FORBIDDEN,
        );
      }

      const conflicting = await tx.organizationMembership.findUnique({
        where: {
          organizationId_userId: { organizationId: invitation.organizationId, userId },
        },
      });

      if (conflicting) {
        if (conflicting.status === "SUSPENDED") {
          throw new AuthException(
            AUTH_ERROR_CODES.MEMBERSHIP_SUSPENDED,
            "Your membership is suspended.",
            HttpStatus.FORBIDDEN,
          );
        }

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

        return {
          organizationId: invitation.organizationId,
          membershipId: conflicting.id,
          role: conflicting.role,
        };
      }

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
        data: { organizationId: invitation.organizationId, userId, role: invitation.role },
      });

      return {
        organizationId: invitation.organizationId,
        membershipId: membership.id,
        role: membership.role,
      };
    });

    await this.audit.record("INVITATION_ACCEPTED", {
      actorUserId: userId,
      targetUserId: userId,
      organizationId: accepted.organizationId,
      requestId,
      metadata: { invitationId, via: "google" },
    });

    return accepted;
  }

  async providers(): Promise<{ google: boolean }> {
    return { google: this.oidc.enabled };
  }
}

export const GOOGLE_OAUTH_STATE_TTL_SECONDS = OAUTH_STATE_TTL_SECONDS;
