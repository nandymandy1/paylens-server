import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { AuditService } from "@/modules/auth/services/audit.service.js";
import { AuthService } from "@/modules/auth/services/auth.service.js";
import { GoogleService } from "@/modules/auth/services/google.service.js";
import { InvitationService } from "@/modules/auth/services/invitation.service.js";
import { SessionService } from "@/modules/auth/services/session.service.js";
import { CurrentPrincipal } from "@/modules/auth/decorators/current-principal.decorator.js";
import { Public } from "@/modules/auth/decorators/public.decorator.js";
import {
  ForgotPasswordThrottle,
  GoogleThrottle,
  InvitationThrottle,
  LoginThrottle,
  RefreshThrottle,
  RegisterThrottle,
  ResendVerificationThrottle,
  ResetPasswordThrottle,
} from "@/modules/auth/decorators/auth-throttle.decorator.js";
import {
  AcceptInvitationDto,
  AcceptInvitationNewUserDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SwitchOrganizationDto,
  VerifyEmailDto,
} from "@/modules/auth/dto/auth.dto.js";
import {
  OptionalSessionGuard,
  SessionGuard,
  readRefreshCookie,
  type RequestWithPrincipal,
} from "@/modules/auth/guards/session.guard.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import {
  clearAuthCookies,
  setAccessCookieOnly,
  setAuthCookies,
} from "@/modules/auth/utils/auth-cookies.utils.js";
import { getSafeRedirectPath } from "@/modules/auth/utils/auth.utils.js";

const userAgentOf = (req: Request): string | undefined =>
  typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined;

const GENERIC_EMAIL_RESPONSE =
  "If an eligible account exists, a password reset email has been sent.";

@ApiTags("auth")
@Controller("auth")
@UseGuards(SessionGuard)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly invitations: InvitationService,
    private readonly google: GoogleService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post("register")
  @RegisterThrottle()
  @ApiOperation({ summary: "Create a new organization and its initial tenant owner" })
  async register(@Body() dto: RegisterDto, @Req() req: RequestWithPrincipal) {
    return this.auth.register(
      {
        organizationName: dto.organizationName,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        password: dto.password,
      },
      req.requestId,
    );
  }

  @Public()
  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify a credentials email and open a session" })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verifyEmail(dto.token, userAgentOf(req), req.requestId);

    setAuthCookies(
      res,
      { accessToken: result.session.accessToken, refreshToken: result.session.refreshToken },
      this.config,
    );

    return { user: result.user, memberships: result.memberships };
  }

  @Public()
  @Post("resend-verification")
  @HttpCode(HttpStatus.OK)
  @ResendVerificationThrottle()
  @ApiOperation({ summary: "Resend the email-verification link" })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    await this.auth.resendVerification(dto.email);

    return { message: "If this email is registered and unverified, a new link has been sent." };
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @LoginThrottle()
  @ApiOperation({ summary: "Sign in with email and password" })
  async login(
    @Body() dto: LoginDto,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto.email, dto.password, userAgentOf(req), req.requestId);

    setAuthCookies(
      res,
      { accessToken: result.session.accessToken, refreshToken: result.session.refreshToken },
      this.config,
    );

    return { user: result.user, memberships: result.memberships };
  }

  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @RefreshThrottle()
  @ApiOperation({ summary: "Rotate the refresh token and reissue access" })
  async refresh(@Req() req: RequestWithPrincipal, @Res({ passthrough: true }) res: Response) {
    const presented = readRefreshCookie(req);

    if (!presented) {
      clearAuthCookies(res, this.config);

      return { refreshed: false };
    }

    try {
      const result = await this.sessions.refresh(presented.sessionId, presented.secret);

      setAuthCookies(
        res,
        { accessToken: result.accessToken, refreshToken: result.refreshToken },
        this.config,
      );

      return { refreshed: true };
    } catch {
      clearAuthCookies(res, this.config);

      return { refreshed: false };
    }
  }

  @Public()
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke the current session and clear cookies" })
  async logout(@Req() req: RequestWithPrincipal, @Res({ passthrough: true }) res: Response) {
    const presented = readRefreshCookie(req);

    if (presented) {
      await this.sessions.revokeSession(presented.sessionId);
      await this.audit.record("LOGOUT", { requestId: req.requestId });
    }

    clearAuthCookies(res, this.config);

    return { loggedOut: true };
  }

  @Get("me")
  @ApiOperation({ summary: "Current session bootstrap data" })
  async me(@CurrentPrincipal() principal: RequestPrincipal) {
    return this.auth.me(principal);
  }

  @Public()
  @Get("providers")
  @ApiOperation({ summary: "Which external identity providers are enabled" })
  async providers() {
    return this.google.providers();
  }

  @Public()
  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  @ForgotPasswordThrottle()
  @ApiOperation({ summary: "Request a password-reset email" })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: RequestWithPrincipal) {
    await this.auth.forgotPassword(dto.email, req.requestId);

    return { message: GENERIC_EMAIL_RESPONSE };
  }

  @Public()
  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  @ResetPasswordThrottle()
  @ApiOperation({ summary: "Reset a password with a single-use token" })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: RequestWithPrincipal) {
    await this.auth.resetPassword(dto.token, dto.password, req.requestId);

    return { message: "Your password has been changed. Sign in with the new password." };
  }

  @Public()
  @Get("google/start")
  @GoogleThrottle()
  @ApiOperation({ summary: "Start the backend Google OIDC flow (redirects to Google)" })
  async googleStart(
    @Query("redirect_to") redirectTo?: string,
    @Query("invitationId") invitationId?: string,
    @Res() res?: Response,
  ): Promise<void> {
    const { url } = await this.google.start({ redirectTo, invitationId });

    res?.redirect(url);
  }

  @Public()
  @Get("google/callback")
  @GoogleThrottle()
  @ApiOperation({ summary: "Google OIDC callback (code exchange happens server-side)" })
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Req() req: RequestWithPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.google.callback({
      code,
      state,
      userAgent: userAgentOf(req),
      requestId: req.requestId,
    });

    setAuthCookies(
      res,
      { accessToken: result.session.accessToken, refreshToken: result.session.refreshToken },
      this.config,
    );

    const frontend = this.config.getOrThrow<string>("app.frontendUrl");

    res.redirect(`${frontend}${getSafeRedirectPath(result.redirectTo)}`);
  }

  @Public()
  @Get("invitations/preview")
  @InvitationThrottle()
  @ApiOperation({ summary: "Preview an invitation without consuming it" })
  async previewInvitation(@Query("token") token: string) {
    return this.invitations.preview(token);
  }

  @Public()
  @Post("invitations/accept")
  @InvitationThrottle()
  @UseGuards(OptionalSessionGuard)
  @ApiOperation({ summary: "Accept an invitation (new-user registration or signed-in member)" })
  async acceptInvitation(
    @Body() dto: AcceptInvitationDto | AcceptInvitationNewUserDto,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (req.principal) {
      const result = await this.invitations.acceptAsAuthenticated(
        req.principal,
        dto.token,
        userAgentOf(req),
        req.requestId,
      );
      const record = await this.sessions.getSession(req.principal.sessionId);

      if (record) {
        setAccessCookieOnly(res, this.sessions.accessTokenFor(record), this.config);
      }

      return result;
    }

    const created = await this.invitations.acceptAsNewUser(
      dto.token,
      {
        firstName: (dto as AcceptInvitationNewUserDto).firstName,
        lastName: (dto as AcceptInvitationNewUserDto).lastName,
        password: (dto as AcceptInvitationNewUserDto).password,
      },
      userAgentOf(req),
      req.requestId,
    );

    setAuthCookies(
      res,
      { accessToken: created.session.accessToken, refreshToken: created.session.refreshToken },
      this.config,
    );

    return { membershipId: created.membershipId };
  }

  @Post("switch-organization")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Switch the active tenant of the current session" })
  async switchOrganization(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Body() dto: SwitchOrganizationDto,
    @Req() req: RequestWithPrincipal,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.switchOrganization(principal, dto.organizationId, req.requestId);
    const record = await this.sessions.getSession(principal.sessionId);

    if (record) {
      setAccessCookieOnly(res, this.sessions.accessTokenFor(record), this.config);
    }

    return result;
  }
}
