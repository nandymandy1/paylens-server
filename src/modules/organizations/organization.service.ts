import { HttpStatus, Injectable } from "@nestjs/common";
import { PrismaService } from "@/database/prisma.service.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import {
  AUTH_ERROR_CODES,
  type MembershipRoleName,
} from "@/modules/auth/constants/auth.constants.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { slugifyOrganization, generateOpaqueToken } from "@/modules/auth/utils/auth.utils.js";
import { AuditService } from "@/modules/auth/services/audit.service.js";
import { SessionService } from "@/modules/auth/services/session.service.js";
import { activeTenantMembershipWhere } from "@/modules/auth/utils/tenant-access.utils.js";

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  private async requireActiveMembership(principal: RequestPrincipal) {
    if (!principal.organizationId || !principal.membershipId || !principal.role) {
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "Select an organization first.",
        HttpStatus.FORBIDDEN,
      );
    }

    const membership = await this.prisma.organizationMembership.findFirst({
      where: activeTenantMembershipWhere({
        id: principal.membershipId,
        userId: principal.userId,
        organizationId: principal.organizationId,
      }),
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

  private assertCanViewMembers(role: MembershipRoleName) {
    if (role !== "TENANT_OWNER" && role !== "HR_ADMIN" && role !== "HR_MANAGER") {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot view organization members.",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** Creates an organization for an authenticated user with no tenant yet (Google onboarding). */
  async createOrganization(
    principal: RequestPrincipal,
    name: string,
    userAgent: string | undefined,
    requestId?: string,
  ) {
    const trimmed = name.trim();

    if (!trimmed) {
      throw new AuthException(
        "ORGANIZATION_NAME_REQUIRED",
        "Organization name is required.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const base = slugifyOrganization(trimmed);
    let slug = base;

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const existing = await this.prisma.organization.findUnique({ where: { slug } });

      if (!existing) {
        break;
      }

      slug = `${base}-${attempt + 1}`;
    }

    if (await this.prisma.organization.findUnique({ where: { slug } })) {
      slug = `${base}-${generateOpaqueToken(4)}`;
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({ data: { name: trimmed, slug } });
      const membership = await tx.organizationMembership.create({
        data: { organizationId: organization.id, userId: principal.userId, role: "TENANT_OWNER" },
      });

      return { organization, membership };
    });

    await this.sessions.setActiveOrganization(principal.sessionId, {
      organizationId: created.organization.id,
      membershipId: created.membership.id,
      role: "TENANT_OWNER",
    });

    await this.audit.record("ORGANIZATION_CREATED", {
      actorUserId: principal.userId,
      targetUserId: principal.userId,
      organizationId: created.organization.id,
      requestId,
    });

    return {
      // The fresh access JWT travels in the HttpOnly cookie only — never in JSON.
      organization: {
        id: created.organization.id,
        name: created.organization.name,
        slug: created.organization.slug,
      },
    };
  }

  async members(principal: RequestPrincipal) {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanViewMembers(membership.role);

    const members = await this.prisma.organizationMembership.findMany({
      where: { organizationId: membership.organizationId },
      select: {
        id: true,
        role: true,
        status: true,
        createdAt: true,
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return members.map((member) => ({
      id: member.id,
      userId: member.user.id,
      email: member.user.email,
      firstName: member.user.firstName,
      lastName: member.user.lastName,
      role: member.role,
      status: member.status,
      createdAt: member.createdAt.toISOString(),
    }));
  }

  async member(principal: RequestPrincipal, membershipId: string) {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanViewMembers(membership.role);

    const member = await this.prisma.organizationMembership.findFirst({
      where: { id: membershipId, organizationId: membership.organizationId },
      select: {
        id: true,
        role: true,
        status: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (!member) {
      throw new AuthException(
        "MEMBERSHIP_NOT_FOUND",
        "Membership was not found.",
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      id: member.id,
      userId: member.user.id,
      email: member.user.email,
      firstName: member.user.firstName,
      lastName: member.user.lastName,
      role: member.role,
      status: member.status,
      createdAt: member.createdAt.toISOString(),
    };
  }

  async changeRole(
    principal: RequestPrincipal,
    membershipId: string,
    role: MembershipRoleName,
    requestId?: string,
  ) {
    const membership = await this.requireActiveMembership(principal);

    if (membership.role !== "TENANT_OWNER") {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Only the tenant owner can change member roles.",
        HttpStatus.FORBIDDEN,
      );
    }

    const target = await this.prisma.organizationMembership.findFirst({
      where: { id: membershipId, organizationId: membership.organizationId },
    });

    if (!target) {
      throw new AuthException(
        "MEMBERSHIP_NOT_FOUND",
        "Membership was not found.",
        HttpStatus.NOT_FOUND,
      );
    }

    // TENANT_OWNER is immutable in H6: no ownership transfer, no demotion.
    if (target.role === "TENANT_OWNER" || role === "TENANT_OWNER") {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "The tenant owner role cannot be changed in this phase.",
        HttpStatus.FORBIDDEN,
      );
    }

    const updated = await this.prisma.organizationMembership.update({
      where: { id: target.id },
      data: { role },
    });

    // Security-first: the target's active Redis sessions still carry the old
    // role. Revoke them all so stale authorization can never be reused. The
    // target signs in again; the actor's own session is untouched unless the
    // actor changed their own membership (impossible for TENANT_OWNER here).
    if (target.userId !== principal.userId) {
      await this.sessions.revokeAllUserSessions(target.userId);
    }

    await this.audit.record("MEMBERSHIP_ROLE_CHANGED", {
      actorUserId: principal.userId,
      targetUserId: target.userId,
      organizationId: membership.organizationId,
      requestId,
      metadata: { membershipId: target.id, from: target.role, to: role },
    });

    return { id: updated.id, role: updated.role, status: updated.status };
  }
}
