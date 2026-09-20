import { randomUUID } from "node:crypto";
import { parseIntegerInRange, parseOptionalStringEnv } from "@/common/utils/env.js";

export type Environment = "development" | "test" | "production";

export type ValidatedEnvironment = {
  NODE_ENV: Environment;
  PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  FRONTEND_URL: string;
  LOG_LEVEL: "debug" | "info" | "warn" | "error";
  AUTH_ACCESS_TOKEN_SECRET: string;
  AUTH_COOKIE_SAME_SITE: "strict" | "lax" | "none";
  SMTP_URL: string;
  EMAIL_FROM: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_CALLBACK_URL: string;
  OTEL_EXPORTER_OTLP_ENDPOINT: string;
  FILE_STORAGE_ENDPOINT: string;
  FILE_STORAGE_ACCESS_KEY_ID: string;
  FILE_STORAGE_SECRET_ACCESS_KEY: string;
  FILE_STORAGE_BUCKET: string;
  FILE_STORAGE_REGION: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
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

const requireUrl = (value: unknown, name: string, protocols: readonly string[]): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must use one of: ${protocols.join(", ")}`);
  }

  return url.toString();
};

const validateFrontendUrl = (value: unknown, environment: Environment): string => {
  const raw =
    value === undefined || value === ""
      ? environment === "production"
        ? undefined
        : "http://localhost:3000"
      : value;
  const normalized = requireUrl(
    raw,
    "FRONTEND_URL",
    environment === "production" ? ["https:"] : ["http:", "https:"],
  );
  const url = new URL(normalized);

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("FRONTEND_URL must be an origin without a path, query, or hash");
  }

  return url.origin;
};

const validateAuthSecret = (value: unknown, environment: Environment): string => {
  if (value === undefined || value === "") {
    if (environment === "test") return `test-only-ephemeral-${randomUUID()}`;
    throw new Error("AUTH_ACCESS_TOKEN_SECRET is required (minimum 32 characters)");
  }

  if (typeof value !== "string" || value.length < 32) {
    throw new Error("AUTH_ACCESS_TOKEN_SECRET must be at least 32 characters");
  }

  return value;
};

const validateSameSite = (value: unknown): ValidatedEnvironment["AUTH_COOKIE_SAME_SITE"] => {
  if (value === undefined || value === "") return "lax";
  if (value === "strict" || value === "lax" || value === "none") return value;
  throw new Error("AUTH_COOKIE_SAME_SITE must be strict, lax, or none");
};

const validateGoogleGroup = (raw: Record<string, unknown>, environment: Environment) => {
  const clientId = parseOptionalStringEnv(raw.GOOGLE_CLIENT_ID as string) ?? "";
  const clientSecret = parseOptionalStringEnv(raw.GOOGLE_CLIENT_SECRET as string) ?? "";
  const callbackUrl = parseOptionalStringEnv(raw.GOOGLE_CALLBACK_URL as string) ?? "";
  const present = [clientId, clientSecret, callbackUrl].filter(Boolean).length;

  if (present > 0 && present < 3) {
    throw new Error(
      "Google OIDC is all-or-nothing: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL together, or none",
    );
  }

  if (present === 3)
    requireUrl(
      callbackUrl,
      "GOOGLE_CALLBACK_URL",
      environment === "production" ? ["https:"] : ["http:", "https:"],
    );

  return { clientId, clientSecret, callbackUrl };
};

const validateSmtpUrl = (value: unknown, environment: Environment): string => {
  const smtpUrl = parseOptionalStringEnv(value as string) ?? "";

  if (!smtpUrl) {
    if (environment === "production") throw new Error("SMTP_URL is required");

    return "";
  }

  return requireUrl(smtpUrl, "SMTP_URL", ["smtp:", "smtps:"]);
};

const validateFileStorage = (raw: Record<string, unknown>, environment: Environment) => {
  const endpoint = parseOptionalStringEnv(raw.FILE_STORAGE_ENDPOINT as string);
  const accessKeyId = parseOptionalStringEnv(raw.FILE_STORAGE_ACCESS_KEY_ID as string);
  const secretAccessKey = parseOptionalStringEnv(raw.FILE_STORAGE_SECRET_ACCESS_KEY as string);
  const bucket = parseOptionalStringEnv(raw.FILE_STORAGE_BUCKET as string);
  const region = parseOptionalStringEnv(raw.FILE_STORAGE_REGION as string) ?? "auto";
  const values = [endpoint, accessKeyId, secretAccessKey, bucket];

  if (values.some(Boolean) && values.some((value) => !value)) {
    throw new Error(
      "FILE_STORAGE_ENDPOINT, FILE_STORAGE_ACCESS_KEY_ID, FILE_STORAGE_SECRET_ACCESS_KEY, and FILE_STORAGE_BUCKET must be set together",
    );
  }

  if (environment === "production" && values.some((value) => !value)) {
    throw new Error("FILE_STORAGE_* configuration is required in production");
  }

  return {
    endpoint: endpoint
      ? requireUrl(endpoint, "FILE_STORAGE_ENDPOINT", ["http:", "https:"])
      : "http://localhost:9000",
    accessKeyId: accessKeyId ?? "development-file-storage-key",
    secretAccessKey: secretAccessKey ?? "development-file-storage-secret",
    bucket: bucket ?? "paylens-development",
    region,
  };
};

/** The one normalized runtime environment contract used by validation and app config. */
export const loadRuntimeConfig = (raw: Record<string, unknown>): ValidatedEnvironment => {
  const NODE_ENV = validateNodeEnvironment(raw.NODE_ENV);
  const EMAIL_FROM =
    parseOptionalStringEnv(raw.EMAIL_FROM as string) ?? "PayLens <noreply@paylens.local>";

  if (NODE_ENV === "production" && !parseOptionalStringEnv(raw.EMAIL_FROM as string))
    throw new Error("EMAIL_FROM is required");

  const LOG_LEVEL =
    raw.LOG_LEVEL ?? (NODE_ENV === "development" ? "debug" : NODE_ENV === "test" ? "warn" : "info");

  if (
    typeof LOG_LEVEL !== "string" ||
    !logLevels.has(LOG_LEVEL as ValidatedEnvironment["LOG_LEVEL"])
  ) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  const AUTH_COOKIE_SAME_SITE = validateSameSite(raw.AUTH_COOKIE_SAME_SITE);

  if (AUTH_COOKIE_SAME_SITE === "none" && NODE_ENV !== "production") {
    throw new Error(
      "AUTH_COOKIE_SAME_SITE=none requires secure cookies; use HTTPS production deployment",
    );
  }

  const google = validateGoogleGroup(raw, NODE_ENV);
  // Validate the long-standing deployment contract before the newly activated
  // file-storage contract, so diagnostics remain actionable and stable.
  const FRONTEND_URL = validateFrontendUrl(raw.FRONTEND_URL, NODE_ENV);
  const DATABASE_URL = requireUrl(raw.DATABASE_URL, "DATABASE_URL", ["postgres:", "postgresql:"]);
  const REDIS_URL = requireUrl(raw.REDIS_URL, "REDIS_URL", ["redis:", "rediss:"]);
  const fileStorage = validateFileStorage(raw, NODE_ENV);

  return {
    NODE_ENV,
    PORT: parseIntegerInRange(raw.PORT, 4000, "PORT", 1, 65_535),
    DATABASE_URL,
    REDIS_URL,
    FRONTEND_URL,
    LOG_LEVEL: LOG_LEVEL as ValidatedEnvironment["LOG_LEVEL"],
    AUTH_ACCESS_TOKEN_SECRET: validateAuthSecret(raw.AUTH_ACCESS_TOKEN_SECRET, NODE_ENV),
    AUTH_COOKIE_SAME_SITE,
    SMTP_URL: validateSmtpUrl(raw.SMTP_URL, NODE_ENV),
    EMAIL_FROM,
    GOOGLE_CLIENT_ID: google.clientId,
    GOOGLE_CLIENT_SECRET: google.clientSecret,
    GOOGLE_CALLBACK_URL: google.callbackUrl,
    OTEL_EXPORTER_OTLP_ENDPOINT:
      parseOptionalStringEnv(raw.OTEL_EXPORTER_OTLP_ENDPOINT as string) ?? "",
    FILE_STORAGE_ENDPOINT: fileStorage.endpoint,
    FILE_STORAGE_ACCESS_KEY_ID: fileStorage.accessKeyId,
    FILE_STORAGE_SECRET_ACCESS_KEY: fileStorage.secretAccessKey,
    FILE_STORAGE_BUCKET: fileStorage.bucket,
    FILE_STORAGE_REGION: fileStorage.region,
    // Optional: header-mapping AI for employee imports. Absent key means
    // deterministic alias mapping only — validation still rejects unknowns.
    OPENAI_API_KEY: parseOptionalStringEnv(raw.OPENAI_API_KEY as string) ?? "",
    OPENAI_MODEL: parseOptionalStringEnv(raw.OPENAI_MODEL as string) ?? "gpt-4o-mini",
  };
};

export const validateEnvironment = loadRuntimeConfig;
