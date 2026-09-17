import { randomUUID } from "node:crypto";

export type Environment = "development" | "test" | "production";

export type ValidatedEnvironment = {
  NODE_ENV: Environment;
  PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  CORS_ORIGINS: string;
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  EXECUTION_TRACE_ENABLED: boolean;
  THROTTLE_TTL_MS: number;
  THROTTLE_LIMIT: number;
  FRONTEND_URL: string;
  AUTH_ACCESS_TOKEN_SECRET: string;
  AUTH_ACCESS_TTL_SECONDS: number;
  AUTH_REFRESH_TTL_SECONDS: number;
  AUTH_COOKIE_SECURE: boolean;
  AUTH_COOKIE_SAME_SITE: "strict" | "lax" | "none";
  AUTH_COOKIE_DOMAIN: string;
  SMTP_HOST: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  EMAIL_FROM: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_CALLBACK_URL: string;
};

const environments = new Set<Environment>(["development", "test", "production"]);

const logLevels = new Set<ValidatedEnvironment["LOG_LEVEL"]>(["debug", "info", "warn", "error"]);

const validateNodeEnvironment = (value: unknown): Environment => {
  const environment = value ?? "development";

  if (typeof environment !== "string" || !environments.has(environment as Environment)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  return environment as Environment;
};

const validateInteger = (
  value: unknown,
  defaultValue: number,
  name: string,
  minimum: number,
  maximum: number,
): number => {
  const numberValue = Number(value ?? defaultValue);

  if (!Number.isInteger(numberValue) || numberValue < minimum || numberValue > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return numberValue;
};

const validatePort = (value: unknown): number => {
  return validateInteger(value, 4000, "PORT", 1, 65_535);
};

const validateLogLevel = (value: unknown): ValidatedEnvironment["LOG_LEVEL"] => {
  const level = value ?? "info";

  if (typeof level !== "string" || !logLevels.has(level as ValidatedEnvironment["LOG_LEVEL"])) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  return level as ValidatedEnvironment["LOG_LEVEL"];
};

const validateBoolean = (value: unknown, defaultValue: boolean, name: string): boolean => {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  if (value === "true" || value === true) {
    return true;
  }

  if (value === "false" || value === false) {
    return false;
  }

  throw new Error(`${name} must be true or false`);
};

const requireUrl = (value: unknown, name: string, allowedProtocols: readonly string[]): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`${name} must use one of: ${allowedProtocols.join(", ")}`);
  }

  return value;
};

const validateCorsOrigins = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("CORS_ORIGINS must be a comma-separated origin allowlist");
  }

  for (const origin of value.split(",").map((item) => item.trim())) {
    let url: URL;

    try {
      url = new URL(origin);
    } catch {
      throw new Error("CORS_ORIGINS must contain valid HTTP(S) origins");
    }

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("CORS_ORIGINS must contain valid HTTP(S) origins");
    }
  }

  return value;
};

const validateOptionalUrl = (
  value: unknown,
  name: string,
  defaultValue: string,
  allowedProtocols: readonly string[],
): string => {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return requireUrl(value, name, allowedProtocols);
};

const validateAuthSecret = (value: unknown, nodeEnv: Environment): string => {
  if (value === undefined || value === "") {
    if (nodeEnv === "test") {
      // Ephemeral process-local secret: test sessions never leave the process.
      return `test-only-ephemeral-${randomUUID()}`;
    }

    throw new Error("AUTH_ACCESS_TOKEN_SECRET is required (minimum 32 characters)");
  }

  if (typeof value !== "string" || value.length < 32) {
    throw new Error("AUTH_ACCESS_TOKEN_SECRET must be at least 32 characters");
  }

  return value;
};

const validateSameSite = (value: unknown): ValidatedEnvironment["AUTH_COOKIE_SAME_SITE"] => {
  if (value === undefined || value === "") {
    return "lax";
  }

  if (value === "strict" || value === "lax" || value === "none") {
    return value;
  }

  throw new Error("AUTH_COOKIE_SAME_SITE must be strict, lax, or none");
};

const validateGoogleGroup = (
  raw: Record<string, unknown>,
): { clientId: string; clientSecret: string; callbackUrl: string } => {
  const clientId = raw.GOOGLE_CLIENT_ID === undefined ? "" : String(raw.GOOGLE_CLIENT_ID);
  const clientSecret =
    raw.GOOGLE_CLIENT_SECRET === undefined ? "" : String(raw.GOOGLE_CLIENT_SECRET);
  const callbackUrl = raw.GOOGLE_CALLBACK_URL === undefined ? "" : String(raw.GOOGLE_CALLBACK_URL);
  const present = [clientId, clientSecret, callbackUrl].filter((part) => part !== "").length;

  if (present > 0 && present < 3) {
    throw new Error(
      "Google OIDC is all-or-nothing: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL together, or none",
    );
  }

  if (present === 3) {
    requireUrl(callbackUrl, "GOOGLE_CALLBACK_URL", ["http:", "https:"]);
  }

  return { clientId, clientSecret, callbackUrl };
};

const validateSmtpGroup = (parts: {
  smtpHost: string;
  smtpUser: string;
  smtpPassword: string;
}): void => {
  const present = [parts.smtpHost, parts.smtpUser, parts.smtpPassword].filter(
    (part) => part !== "",
  ).length;

  if (present > 0 && present < 3) {
    throw new Error(
      "SMTP is all-or-nothing: set SMTP_HOST, SMTP_USER, and SMTP_PASSWORD together, or none (development/test fallback keeps mail in memory)",
    );
  }
};

export const validateEnvironment = (raw: Record<string, unknown>): ValidatedEnvironment => {
  const nodeEnv = validateNodeEnvironment(raw.NODE_ENV);
  const port = validatePort(raw.PORT);
  const databaseUrl = requireUrl(raw.DATABASE_URL, "DATABASE_URL", ["postgres:", "postgresql:"]);
  const redisUrl = requireUrl(raw.REDIS_URL, "REDIS_URL", ["redis:", "rediss:"]);
  const corsOrigins = validateCorsOrigins(raw.CORS_ORIGINS);
  const logLevel = validateLogLevel(raw.LOG_LEVEL);
  const executionTraceEnabled = validateBoolean(
    raw.EXECUTION_TRACE_ENABLED,
    true,
    "EXECUTION_TRACE_ENABLED",
  );
  const throttleTtl = validateInteger(raw.THROTTLE_TTL_MS, 60_000, "THROTTLE_TTL_MS", 1, 3_600_000);
  const throttleLimit = validateInteger(raw.THROTTLE_LIMIT, 100, "THROTTLE_LIMIT", 1, 10_000);
  const frontendUrl = validateOptionalUrl(
    raw.FRONTEND_URL,
    "FRONTEND_URL",
    "http://localhost:3000",
    ["http:", "https:"],
  );
  const authAccessTokenSecret = validateAuthSecret(raw.AUTH_ACCESS_TOKEN_SECRET, nodeEnv);
  const authAccessTtl = validateInteger(
    raw.AUTH_ACCESS_TTL_SECONDS,
    900,
    "AUTH_ACCESS_TTL_SECONDS",
    60,
    3_600,
  );
  const authRefreshTtl = validateInteger(
    raw.AUTH_REFRESH_TTL_SECONDS,
    1_209_600,
    "AUTH_REFRESH_TTL_SECONDS",
    3_600,
    2_592_000,
  );
  const authCookieSecure = validateBoolean(
    raw.AUTH_COOKIE_SECURE,
    nodeEnv === "production",
    "AUTH_COOKIE_SECURE",
  );
  const authCookieSameSite = validateSameSite(raw.AUTH_COOKIE_SAME_SITE);
  const authCookieDomain =
    raw.AUTH_COOKIE_DOMAIN === undefined || raw.AUTH_COOKIE_DOMAIN === ""
      ? ""
      : String(raw.AUTH_COOKIE_DOMAIN);
  const smtpHost = raw.SMTP_HOST === undefined ? "" : String(raw.SMTP_HOST);
  const smtpPort = validateInteger(raw.SMTP_PORT, 587, "SMTP_PORT", 1, 65_535);
  const smtpSecure = validateBoolean(raw.SMTP_SECURE, false, "SMTP_SECURE");
  const smtpUser = raw.SMTP_USER === undefined ? "" : String(raw.SMTP_USER);
  const smtpPassword = raw.SMTP_PASSWORD === undefined ? "" : String(raw.SMTP_PASSWORD);
  const emailFrom =
    raw.EMAIL_FROM === undefined || raw.EMAIL_FROM === ""
      ? "PayLens <noreply@paylens.local>"
      : String(raw.EMAIL_FROM);
  const google = validateGoogleGroup(raw);

  validateSmtpGroup({ smtpHost, smtpUser, smtpPassword });

  return {
    PORT: port,
    NODE_ENV: nodeEnv,
    REDIS_URL: redisUrl,
    LOG_LEVEL: logLevel,
    CORS_ORIGINS: corsOrigins,
    DATABASE_URL: databaseUrl,
    THROTTLE_TTL_MS: throttleTtl,
    THROTTLE_LIMIT: throttleLimit,
    EXECUTION_TRACE_ENABLED: executionTraceEnabled,
    FRONTEND_URL: frontendUrl,
    AUTH_ACCESS_TOKEN_SECRET: authAccessTokenSecret,
    AUTH_ACCESS_TTL_SECONDS: authAccessTtl,
    AUTH_REFRESH_TTL_SECONDS: authRefreshTtl,
    AUTH_COOKIE_SECURE: authCookieSecure,
    AUTH_COOKIE_SAME_SITE: authCookieSameSite,
    AUTH_COOKIE_DOMAIN: authCookieDomain,
    SMTP_HOST: smtpHost,
    SMTP_PORT: smtpPort,
    SMTP_SECURE: smtpSecure,
    SMTP_USER: smtpUser,
    SMTP_PASSWORD: smtpPassword,
    EMAIL_FROM: emailFrom,
    GOOGLE_CLIENT_ID: google.clientId,
    GOOGLE_CLIENT_SECRET: google.clientSecret,
    GOOGLE_CALLBACK_URL: google.callbackUrl,
  };
};
