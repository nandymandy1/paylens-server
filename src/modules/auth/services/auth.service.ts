import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { User } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service.js";
import { isPrismaUniqueViolationOn } from "@/common/utils/prisma.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { TraceBusinessService } from "@/common/tracing/trace-method.decorator.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import {
  AUTH_ERROR_CODES,
  EMAIL_VERIFICATION_TTL_HOURS,
  PASSWORD_RESET_TTL_MINUTES,
} from "@/modules/auth/constants/auth.constants.js";
import type {
  RequestPrincipal,
  SafeMembership,
  SafeUser,
  SessionRecord,
} from "@/modules/auth/types/auth.types.js";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  normalizeEmail,
  slugifyOrganization,
} from "@/modules/auth/utils/auth.utils.js";
import { activeTenantMembershipWhere } from "@/modules/auth/utils/tenant-access.utils.js";
import { hoursFromNow, isExpired, minutesFromNow } from "@/common/utils/date.js";
import { AuditService } from "@/modules/auth/services/audit.service.js";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import { SessionService, type CreatedSession } from "@/modules/auth/services/session.service.js";
import { EmailService } from "@/modules/email/email.service.js";

export type RegistrationInput = {
  organizationName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
};

@Injectable()
@TraceBusinessService([
  "activeMemberships",
  "register",
  "verifyEmail",
  "resendVerification",
  "login",
  "forgotPassword",
  "resetPassword",
  "revalidateSessionTenant",
  "me",
  "switchOrganization",
])
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    readonly executionTrace: ExecutionTraceService,
  ) {}

  toSafeUser(user: User): SafeUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      emailVerified: user.emailVerifiedAt !== null,
      status: user.status,
    };
  }

  async activeMemberships(userId: string): Promise<SafeMembership[]> {
    const memberships = await this.prisma.organizationMembership.findMany({
      where: activeTenantMembershipWhere({ userId }),
      include: { organization: true },
      orderBy: { createdAt: "asc" },
    });

    return memberships.map((membership) => ({
      id: membership.id,
      organizationId: membership.organizationId,
      organizationName: membership.organization.name,
      organizationSlug: membership.organization.slug,
      role: membership.role,
      status: membership.status,
    }));
  }

  private verificationLink(rawToken: string): string {
    return `${this.config.getOrThrow<string>("app.frontendUrl")}/verify-email?token=${rawToken}`;
  }

  private resetLink(rawToken: string): string {
    return `${this.config.getOrThrow<string>("app.frontendUrl")}/reset-password?token=${rawToken}`;
  }

  private async uniqueOrgSlug(baseName: string): Promise<string> {
    const base = slugifyOrganization(baseName);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const existing = await this.prisma.organization.findUnique({ where: { slug: candidate } });

      if (!existing) {
        return candidate;
      }
    }

    return `${base}-${generateOpaqueToken(4)}`;
  }

  async register(input: RegistrationInput, requestId?: string) {
    const email = normalizeEmail(input.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      // Stable conflict code instead of a generic 409 envelope.
      throw new AuthException(
        "EMAIL_ALREADY_REGISTERED",
        "An account with this email already exists.",
        HttpStatus.CONFLICT,
      );
    }

    const passwordHash = await this.passwords.hash(input.password);
    const slug = await this.uniqueOrgSlug(input.organizationName);
    const rawToken = generateOpaqueToken();

    let created: {
      user: User;
      organization: { id: string; name: string; slug: string };
      membership: { id: string };
    };

    try {
      created = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email,
            passwordHash,
            firstName: input.firstName.trim(),
            lastName: input.lastName.trim(),
          },
        });
        const organization = await tx.organization.create({
          data: { name: input.organizationName.trim(), slug },
        });
        const membership = await tx.organizationMembership.create({
          data: { organizationId: organization.id, userId: user.id, role: "TENANT_OWNER" },
        });

        await tx.authActionToken.create({
          data: {
            userId: user.id,
            type: "EMAIL_VERIFICATION",
            tokenHash: hashOpaqueToken(rawToken),
            expiresAt: hoursFromNow(EMAIL_VERIFICATION_TTL_HOURS),
          },
        });

        return { user, organization, membership };
      });
    } catch (error) {
      if (isPrismaUniqueViolationOn(error, "email")) {
        throw new AuthException(
          "EMAIL_ALREADY_REGISTERED",
          "An account with this email already exists.",
          HttpStatus.CONFLICT,
        );
      }

      if (isPrismaUniqueViolationOn(error, "slug")) {
        throw new AuthException(
          "ORGANIZATION_SLUG_CONFLICT",
          "Organization registration could not be completed. Try again.",
          HttpStatus.CONFLICT,
        );
      }

      throw error;
    }

    // DB transaction is closed before sending email (§48).
    await this.email.sendVerificationEmail(email, this.verificationLink(rawToken));
    await this.audit.record("USER_REGISTERED", {
      actorUserId: created.user.id,
      targetUserId: created.user.id,
      organizationId: created.organization.id,
      requestId,
    });
    await this.audit.record("ORGANIZATION_CREATED", {
      actorUserId: created.user.id,
      targetUserId: created.user.id,
      organizationId: created.organization.id,
      requestId,
    });

    return {
      user: this.toSafeUser(created.user),
      organization: {
        id: created.organization.id,
        name: created.organization.name,
        slug: created.organization.slug,
      },
    };
  }

  async verifyEmail(rawToken: string, userAgent: string | undefined, requestId?: string) {
    const tokenHash = hashOpaqueToken(rawToken);
    const record = await this.prisma.authActionToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!record || record.type !== "EMAIL_VERIFICATION") {
      throw new AuthException(
        AUTH_ERROR_CODES.EMAIL_VERIFICATION_TOKEN_INVALID,
        "This verification link is invalid.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (record.revokedAt || record.consumedAt) {
      throw new AuthException(
        AUTH_ERROR_CODES.EMAIL_VERIFICATION_TOKEN_INVALID,
        "This verification link has already been used.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (isExpired(record.expiresAt)) {
      throw new AuthException(
        AUTH_ERROR_CODES.EMAIL_VERIFICATION_TOKEN_EXPIRED,
        "This verification link has expired.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (record.user.status === "SUSPENDED") {
      throw new AuthException(
        AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
        "This account has been suspended.",
        HttpStatus.FORBIDDEN,
      );
    }

    const consumed = await this.prisma.authActionToken.updateMany({
      where: { id: record.id, consumedAt: null, revokedAt: null },
      data: { consumedAt: new Date() },
    });

    if (consumed.count !== 1) {
      throw new AuthException(
        AUTH_ERROR_CODES.EMAIL_VERIFICATION_TOKEN_INVALID,
        "This verification link has already been used.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const user =
      record.user.emailVerifiedAt === null
        ? await this.prisma.user.update({
            where: { id: record.userId },
            data: { emailVerifiedAt: new Date() },
          })
        : record.user;

    await this.audit.record("EMAIL_VERIFIED", {
      actorUserId: user.id,
      targetUserId: user.id,
      requestId,
    });

    const memberships = await this.activeMemberships(user.id);
    const single = memberships.length === 1 ? memberships[0] : undefined;
    const session: CreatedSession = await this.sessions.createSession({
      userId: user.id,
      userAgent,
      activeOrganizationId: single?.organizationId ?? null,
      activeMembershipId: single?.id ?? null,
      role: single?.role ?? null,
    });

    return { session, user: this.toSafeUser(user), memberships };
  }

  async resendVerification(email: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (!user || user.emailVerifiedAt !== null || user.status !== "ACTIVE") {
      return;
    }

    await this.prisma.authActionToken.updateMany({
      where: { userId: user.id, type: "EMAIL_VERIFICATION", consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const rawToken = generateOpaqueToken();

    await this.prisma.authActionToken.create({
      data: {
        userId: user.id,
        type: "EMAIL_VERIFICATION",
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: hoursFromNow(EMAIL_VERIFICATION_TTL_HOURS),
      },
    });
    await this.email.sendVerificationEmail(normalized, this.verificationLink(rawToken));
  }

  async login(email: string, password: string, userAgent: string | undefined, requestId?: string) {
    const normalized = normalizeEmail(email);
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (
      !user ||
      !user.passwordHash ||
      !(await this.passwords.verify(user.passwordHash, password))
    ) {
      await this.audit.record("LOGIN_FAILED", { requestId, metadata: {} });

      throw new AuthException(
        AUTH_ERROR_CODES.INVALID_CREDENTIALS,
        "Email or password is incorrect.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (user.status === "SUSPENDED") {
      throw new AuthException(
        AUTH_ERROR_CODES.ACCOUNT_SUSPENDED,
        "This account has been suspended.",
        HttpStatus.FORBIDDEN,
      );
    }

    if (user.emailVerifiedAt === null) {
      throw new AuthException(
        AUTH_ERROR_CODES.EMAIL_NOT_VERIFIED,
        "Verify your email address before signing in.",
        HttpStatus.FORBIDDEN,
      );
    }

    const memberships = await this.activeMemberships(user.id);
    const single = memberships.length === 1 ? memberships[0] : undefined;
    const session: CreatedSession = await this.sessions.createSession({
      userId: user.id,
      userAgent,
      activeOrganizationId: single?.organizationId ?? null,
      activeMembershipId: single?.id ?? null,
      role: single?.role ?? null,
    });

    await this.audit.record("LOGIN_SUCCEEDED", {
      actorUserId: user.id,
      targetUserId: user.id,
      organizationId: single?.organizationId ?? null,
      requestId,
    });

    return { session, user: this.toSafeUser(user), memberships };
  }

  async forgotPassword(email: string, requestId?: string): Promise<void> {
    const normalized = normalizeEmail(email);
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    // Always generic: never reveal existence, Google-only, or suspended state.
    if (!user || user.status !== "ACTIVE" || !user.passwordHash) {
      return;
    }

    await this.prisma.authActionToken.updateMany({
      where: { userId: user.id, type: "PASSWORD_RESET", consumedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const rawToken = generateOpaqueToken();

    await this.prisma.authActionToken.create({
      data: {
        userId: user.id,
        type: "PASSWORD_RESET",
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: minutesFromNow(PASSWORD_RESET_TTL_MINUTES),
      },
    });
    await this.email.sendPasswordResetEmail(normalized, this.resetLink(rawToken));
    await this.audit.record("PASSWORD_RESET_REQUESTED", {
      targetUserId: user.id,
      requestId,
    });
  }

  async resetPassword(rawToken: string, newPassword: string, requestId?: string): Promise<void> {
    const tokenHash = hashOpaqueToken(rawToken);
    const record = await this.prisma.authActionToken.findUnique({ where: { tokenHash } });

    if (!record || record.type !== "PASSWORD_RESET") {
      throw new AuthException(
        AUTH_ERROR_CODES.PASSWORD_RESET_TOKEN_INVALID,
        "This reset link is invalid.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (record.revokedAt || record.consumedAt) {
      throw new AuthException(
        AUTH_ERROR_CODES.PASSWORD_RESET_TOKEN_INVALID,
        "This reset link has already been used.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (isExpired(record.expiresAt)) {
      throw new AuthException(
        AUTH_ERROR_CODES.PASSWORD_RESET_TOKEN_EXPIRED,
        "This reset link has expired.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const passwordHash = await this.passwords.hash(newPassword);

    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.authActionToken.updateMany({
        where: { id: record.id, consumedAt: null, revokedAt: null },
        data: { consumedAt: new Date() },
      });

      if (consumed.count !== 1) {
        throw new AuthException(
          AUTH_ERROR_CODES.PASSWORD_RESET_TOKEN_INVALID,
          "This reset link has already been used.",
          HttpStatus.BAD_REQUEST,
        );
      }

      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
    });

    // All old sessions become unusable; the user logs in again explicitly.
    await this.sessions.revokeAllUserSessions(record.userId);
    await this.audit.record("PASSWORD_RESET_COMPLETED", {
      targetUserId: record.userId,
      requestId,
    });
  }

  /**
   * Refresh tokens outlive an access JWT, so a session's selected tenant must
   * be checked again before issuing a new access token. A suspended tenant is
   * cleared rather than copied into the refreshed session.
   */
  async revalidateSessionTenant(record: SessionRecord): Promise<SessionRecord> {
    if (!record.activeOrganizationId || !record.activeMembershipId) {
      return record;
    }

    const membership = await this.prisma.organizationMembership.findFirst({
      where: activeTenantMembershipWhere({
        id: record.activeMembershipId,
        organizationId: record.activeOrganizationId,
        userId: record.userId,
      }),
      select: { id: true },
    });

    if (membership) {
      return record;
    }

    const cleared = await this.sessions.setActiveOrganization(record.sessionId, {
      organizationId: null,
      membershipId: null,
      role: null,
    });

    if (!cleared) {
      throw new AuthException(
        AUTH_ERROR_CODES.SESSION_REVOKED,
        "Your session is no longer valid.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    return cleared;
  }

  async me(principal: RequestPrincipal) {
    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });

    if (!user || user.status !== "ACTIVE") {
      throw new AuthException(
        AUTH_ERROR_CODES.AUTHENTICATION_REQUIRED,
        "Authentication is required.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const memberships = await this.activeMemberships(user.id);
    const active =
      memberships.find((membership) => membership.organizationId === principal.organizationId) ??
      null;

    return {
      user: this.toSafeUser(user),
      memberships,
      activeOrganization: active
        ? {
            id: active.organizationId,
            name: active.organizationName,
            slug: active.organizationSlug,
          }
        : null,
      activeMembership: active ? { id: active.id, role: active.role, status: active.status } : null,
      onboardingRequired: memberships.length === 0,
      organizationSelectionRequired: memberships.length > 1 && !active,
    };
  }

  async switchOrganization(
    principal: RequestPrincipal,
    organizationId: string,
    requestId?: string,
  ) {
    const membership = await this.prisma.organizationMembership.findFirst({
      where: activeTenantMembershipWhere({
        userId: principal.userId,
        organizationId,
      }),
      include: { organization: true },
    });

    if (!membership) {
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "You do not belong to this organization.",
        HttpStatus.FORBIDDEN,
      );
    }

    const record = await this.sessions.setActiveOrganization(principal.sessionId, {
      organizationId: membership.organizationId,
      membershipId: membership.id,
      role: membership.role,
    });

    if (!record) {
      throw new AuthException(
        AUTH_ERROR_CODES.SESSION_REVOKED,
        "Your session is no longer valid.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    await this.audit.record("ORGANIZATION_SWITCHED", {
      actorUserId: principal.userId,
      organizationId: membership.organizationId,
      requestId,
      metadata: {
        previousOrganizationId: principal.organizationId ?? null,
        organizationId: membership.organizationId,
      },
    });

    return {
      // The fresh access JWT travels in the HttpOnly cookie only — never in JSON.
      activeOrganization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
      },
      activeMembership: { id: membership.id, role: membership.role, status: membership.status },
    };
  }
}
