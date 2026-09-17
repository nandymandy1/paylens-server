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
};

const environments = new Set<Environment>(["development", "test", "production"]);

const logLevels = new Set<ValidatedEnvironment["LOG_LEVEL"]>(["debug", "info", "warn", "error"]);

function validateNodeEnvironment(value: unknown): Environment {
  const environment = value ?? "development";

  if (typeof environment !== "string" || !environments.has(environment as Environment)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  return environment as Environment;
}

function validateInteger(
  value: unknown,
  defaultValue: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const numberValue = Number(value ?? defaultValue);

  if (!Number.isInteger(numberValue) || numberValue < minimum || numberValue > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return numberValue;
}

function validatePort(value: unknown): number {
  return validateInteger(value, 4000, "PORT", 1, 65_535);
}

function validateLogLevel(value: unknown): ValidatedEnvironment["LOG_LEVEL"] {
  const level = value ?? "info";

  if (typeof level !== "string" || !logLevels.has(level as ValidatedEnvironment["LOG_LEVEL"])) {
    throw new Error("LOG_LEVEL must be debug, info, warn, or error");
  }

  return level as ValidatedEnvironment["LOG_LEVEL"];
}

function validateBoolean(value: unknown, defaultValue: boolean, name: string): boolean {
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
}

function requireUrl(value: unknown, name: string, allowedProtocols: readonly string[]): string {
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
}

function validateCorsOrigins(value: unknown): string {
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
}

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

  return {
    NODE_ENV: nodeEnv,
    PORT: port,
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    CORS_ORIGINS: corsOrigins,
    LOG_LEVEL: logLevel,
    EXECUTION_TRACE_ENABLED: executionTraceEnabled,
    THROTTLE_TTL_MS: throttleTtl,
    THROTTLE_LIMIT: throttleLimit,
  };
};
