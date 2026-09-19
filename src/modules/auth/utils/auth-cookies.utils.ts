import type { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_SECONDS,
  SESSION_HINT_COOKIE_NAME,
} from "@/modules/auth/constants/auth.constants.js";

type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none";
  path: string;
  maxAge?: number;
};

const baseOptions = (config: ConfigService): CookieOptions => {
  const options: CookieOptions = {
    httpOnly: true,
    secure: config.getOrThrow<boolean>("app.authCookieSecure"),
    sameSite: config.getOrThrow<"strict" | "lax" | "none">("app.authCookieSameSite"),
    path: "/",
  };

  return options;
};

export const setAuthCookies = (
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
  config: ConfigService,
): void => {
  const base = baseOptions(config);

  res.cookie(ACCESS_COOKIE_NAME, tokens.accessToken, {
    ...base,
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    ...base,
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
  // UX-only routing hint: no token, no identity, no role. Backend stays authoritative.
  res.cookie(SESSION_HINT_COOKIE_NAME, "1", {
    httpOnly: false,
    secure: base.secure,
    sameSite: base.sameSite,
    path: "/",
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  });
};

export const setAccessCookieOnly = (
  res: Response,
  accessToken: string,
  config: ConfigService,
): void => {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...baseOptions(config),
    maxAge: ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
};

export const clearAuthCookies = (res: Response, config: ConfigService): void => {
  const base = baseOptions(config);

  res.clearCookie(ACCESS_COOKIE_NAME, base);
  res.clearCookie(REFRESH_COOKIE_NAME, base);
  res.clearCookie(SESSION_HINT_COOKIE_NAME, {
    httpOnly: false,
    secure: base.secure,
    sameSite: base.sameSite,
    path: "/",
  });
};

const OAUTH_STATE_COOKIE_PATH = "/api/v1/auth/google";

export const setOAuthStateCookie = (res: Response, state: string, config: ConfigService): void => {
  res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: config.getOrThrow<boolean>("app.authCookieSecure"),
    sameSite: "lax",
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
  });
};

export const clearOAuthStateCookie = (res: Response, config: ConfigService): void => {
  res.clearCookie(OAUTH_STATE_COOKIE_NAME, {
    httpOnly: true,
    secure: config.getOrThrow<boolean>("app.authCookieSecure"),
    sameSite: "lax",
    path: OAUTH_STATE_COOKIE_PATH,
  });
};
