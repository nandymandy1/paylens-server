import { CanActivate, ExecutionContext, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { setAuthUserId } from "@/common/context/request-context.js";
import type { RequestWithId } from "@/common/middleware/request-id.middleware.js";
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from "@/modules/auth/constants/auth.constants.js";
import { AUTH_ERROR_CODES } from "@/modules/auth/constants/auth.constants.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import { IS_PUBLIC_KEY } from "@/modules/auth/decorators/public.decorator.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { SessionService } from "@/modules/auth/services/session.service.js";
import { PrismaService } from "@/database/prisma.service.js";

export type RequestWithPrincipal = RequestWithId & {
  principal?: RequestPrincipal | null;
};

const parseAccessPayload = (payload: unknown): { sub: string; sid: string } | null => {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const { sub, sid } = payload as { sub?: unknown; sid?: unknown };

  if (typeof sub !== "string" || typeof sid !== "string") {
    return null;
  }

  return { sub, sid };
};

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = await this.resolvePrincipal(request);

    if (!principal) {
      throw new AuthException(
        AUTH_ERROR_CODES.AUTHENTICATION_REQUIRED,
        "Authentication is required.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    request.principal = principal;
    setAuthUserId(principal.userId);

    return true;
  }

  async resolvePrincipal(request: RequestWithPrincipal): Promise<RequestPrincipal | null> {
    const token = request.cookies?.[ACCESS_COOKIE_NAME];

    if (typeof token !== "string" || !token) {
      return null;
    }

    let payload: unknown;

    try {
      payload = await this.jwt.verifyAsync(token);
    } catch (error) {
      if (error instanceof Error && error.name === "TokenExpiredError") {
        throw new AuthException(
          AUTH_ERROR_CODES.ACCESS_TOKEN_EXPIRED,
          "Your session expired. Refresh to continue.",
          HttpStatus.UNAUTHORIZED,
        );
      }

      return null;
    }

    const parsed = parseAccessPayload(payload);

    if (!parsed) {
      return null;
    }

    const record = await this.sessions.getSession(parsed.sid);

    if (!record || record.userId !== parsed.sub) {
      throw new AuthException(
        AUTH_ERROR_CODES.SESSION_REVOKED,
        "Your session is no longer valid.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });

    if (!user) {
      throw new AuthException(
        AUTH_ERROR_CODES.SESSION_REVOKED,
        "Your session is no longer valid.",
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

    return {
      userId: record.userId,
      sessionId: record.sessionId,
      organizationId: record.activeOrganizationId,
      membershipId: record.activeMembershipId,
      role: record.role,
    };
  }
}

/** Attaches a principal when a valid access cookie exists; otherwise continues anonymous. */
@Injectable()
export class OptionalSessionGuard implements CanActivate {
  constructor(private readonly sessionGuard: SessionGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();

    try {
      const principal = await this.sessionGuard.resolvePrincipal(request);

      request.principal = principal;
    } catch {
      request.principal = null;
    }

    return true;
  }
}

export const readRefreshCookie = (req: Request): { sessionId: string; secret: string } | null => {
  const raw = req.cookies?.[REFRESH_COOKIE_NAME];

  if (typeof raw !== "string") {
    return null;
  }

  const dot = raw.indexOf(".");

  if (dot <= 0) {
    return null;
  }

  return { sessionId: raw.slice(0, dot), secret: raw.slice(dot + 1) };
};
