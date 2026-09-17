import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { InvitationService } from "@/modules/auth/services/invitation.service.js";
import { CurrentPrincipal } from "@/modules/auth/decorators/current-principal.decorator.js";
import { InvitationThrottle } from "@/modules/auth/decorators/auth-throttle.decorator.js";
import { SessionGuard, type RequestWithPrincipal } from "@/modules/auth/guards/session.guard.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { OrganizationService } from "@/modules/organizations/organization.service.js";
import {
  ChangeMemberRoleDto,
  CreateInvitationDto,
  CreateOrganizationDto,
} from "@/modules/organizations/dto/organization.dto.js";

@ApiTags("organizations")
@Controller("organizations")
@UseGuards(SessionGuard)
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationService,
    private readonly invitations: InvitationService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new organization for the authenticated user" })
  async create(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateOrganizationDto,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.organizations.createOrganization(
      principal,
      dto.name,
      typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      req.requestId,
    );
  }

  @Get("current/members")
  @ApiOperation({ summary: "List members of the active organization" })
  async members(@CurrentPrincipal() principal: RequestPrincipal) {
    return this.organizations.members(principal);
  }

  @Get("current/invitations")
  @ApiOperation({ summary: "List invitations of the active organization" })
  async invitationList(@CurrentPrincipal() principal: RequestPrincipal) {
    return this.invitations.list(principal);
  }

  @Post("current/invitations")
  @InvitationThrottle()
  @ApiOperation({ summary: "Invite a member to the active organization" })
  async invite(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: CreateInvitationDto,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.invitations.invite(principal, dto.email, dto.role, req.requestId);
  }

  @Delete("current/invitations/:id")
  @ApiOperation({ summary: "Revoke a pending invitation" })
  async revokeInvitation(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param("id") id: string,
    @Req() req: RequestWithPrincipal,
  ) {
    await this.invitations.revoke(principal, id, req.requestId);

    return { revoked: true };
  }

  @Patch("current/members/:id/role")
  @ApiOperation({ summary: "Change a member role" })
  async changeRole(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param("id") id: string,
    @Body() dto: ChangeMemberRoleDto,
    @Req() req: RequestWithPrincipal,
  ) {
    return this.organizations.changeRole(principal, id, dto.role, req.requestId);
  }
}
