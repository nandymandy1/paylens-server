import { HttpException, HttpStatus, Injectable, NestMiddleware } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NextFunction, Request, Response } from "express";
import { AUTH_ERROR_CODES } from "@/modules/auth/constants/auth.constants.js";
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
} from "@/modules/auth/constants/auth.constants.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const hasAuthCookie = (header: string | undefined): boolean =>
  header
    ?.split(";")
    .map((cookie) => cookie.trim().split("=", 1)[0])
    .some((name) => name === ACCESS_COOKIE_NAME || name === REFRESH_COOKIE_NAME) ?? false;

/**
 * Trusted-Origin enforcement for cookie-authenticated browser mutations.
 * CORS + SameSite are defense-in-depth; this is the explicit backend boundary.
 * GET/HEAD/OPTIONS always pass; unsafe requests with a foreign Origin or with
 * auth cookies but no Origin are rejected. Cookieless server/test clients pass.
 */
@Injectable()
export class CsrfOriginMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();

      return;
    }

    if (!UNSAFE_METHODS.has(req.method)) {
      next();

      return;
    }

    const allowed = this.config.get<string[]>("app.corsOrigins") ?? [];
    const origin = req.headers.origin;

    if (typeof origin === "string" && origin.length > 0) {
      if (!allowed.includes(origin)) {
        throw new HttpException(
          {
            code: AUTH_ERROR_CODES.CSRF_ORIGIN_FORBIDDEN,
            message: "Request origin is not allowed.",
          },
          HttpStatus.FORBIDDEN,
        );
      }

      next();

      return;
    }

    const cookieHeader = req.headers.cookie;

    if (hasAuthCookie(cookieHeader)) {
      throw new HttpException(
        {
          code: AUTH_ERROR_CODES.CSRF_ORIGIN_FORBIDDEN,
          message: "Request origin is not allowed.",
        },
        HttpStatus.FORBIDDEN,
      );
    }

    next();
  }
}
