import type { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import {
  ACCESS_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  SESSION_HINT_COOKIE_NAME,
} from "@/modules/auth/constants/auth.constants.js";

type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict" | "lax" | "none";
  path: string;
  maxAge?: number;
  domain?: string;
};

const baseOptions = (config: ConfigService): CookieOptions => {
  const options: CookieOptions = {
    httpOnly: true,
    secure: config.getOrThrow<boolean>("app.authCookieSecure"),
    sameSite: config.getOrThrow<"strict" | "lax" | "none">("app.authCookieSameSite"),
    path: "/",
  };
  const domain = config.getOrThrow<string>("app.authCookieDomain");

  if (domain) {
    options.domain = domain;
  }

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
    maxAge: config.getOrThrow<number>("app.authAccessTtlSeconds") * 1000,
  });
  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
    ...base,
    maxAge: config.getOrThrow<number>("app.authRefreshTtlSeconds") * 1000,
  });
  // UX-only routing hint: no token, no identity, no role. Backend stays authoritative.
  res.cookie(SESSION_HINT_COOKIE_NAME, "1", {
    httpOnly: false,
    secure: base.secure,
    sameSite: base.sameSite,
    path: "/",
    maxAge: config.getOrThrow<number>("app.authRefreshTtlSeconds") * 1000,
    ...(base.domain ? { domain: base.domain } : {}),
  });
};

export const setAccessCookieOnly = (
  res: Response,
  accessToken: string,
  config: ConfigService,
): void => {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...baseOptions(config),
    maxAge: config.getOrThrow<number>("app.authAccessTtlSeconds") * 1000,
  });
};

export const clearAuthCookies = (res: Response, config: ConfigService): void => {
  const base = baseOptions(config);
  const domain = base.domain ? { domain: base.domain } : {};

  res.clearCookie(ACCESS_COOKIE_NAME, { ...base, ...domain });
  res.clearCookie(REFRESH_COOKIE_NAME, { ...base, ...domain });
  res.clearCookie(SESSION_HINT_COOKIE_NAME, {
    httpOnly: false,
    secure: base.secure,
    sameSite: base.sameSite,
    path: "/",
    ...domain,
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
