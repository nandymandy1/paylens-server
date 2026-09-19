import { registerAs } from "@nestjs/config";
import { parseTelemetryConfig } from "@/common/tracing/telemetry.config.js";

export default registerAs("app", () => {
  const telemetry = parseTelemetryConfig();

  return {
    redisUrl: process.env.REDIS_URL,
    environment: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    port: Number(process.env.PORT ?? 4000),
    logLevel: process.env.LOG_LEVEL ?? "info",
    logFormat: process.env.LOG_FORMAT ?? "json",
    pinoConsoleEnabled: process.env.PINO_CONSOLE_ENABLED !== "false",
    throttleLimit: Number(process.env.THROTTLE_LIMIT ?? 200),
    throttleTtlMs: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
    executionTraceEnabled: process.env.EXECUTION_TRACE_ENABLED !== "false",
    // Telemetry values from canonical single source — never re-parse process.env here.
    otelEnabled: telemetry.enabled,
    otelLogsEnabled: telemetry.logsEnabled,
    otelMetricsEnabled: telemetry.metricsEnabled,
    otelServiceName: telemetry.serviceName,
    otelExporterOtlpEndpoint: telemetry.endpoint ?? "",
    otelTraceSampleRatio: telemetry.traceSampleRatio,
    otelProtocol: telemetry.protocol,
    slowQueryMs: Number(process.env.SLOW_QUERY_MS ?? 100),
    dbQueryLogEnabled: process.env.DB_QUERY_LOG_ENABLED === "true",
    corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()),
    frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",
    authAccessTokenSecret: process.env.AUTH_ACCESS_TOKEN_SECRET ?? "",
    authAccessTtlSeconds: Number(process.env.AUTH_ACCESS_TTL_SECONDS ?? 900),
    authRefreshTtlSeconds: Number(process.env.AUTH_REFRESH_TTL_SECONDS ?? 1_209_600),
    authCookieSecure: process.env.AUTH_COOKIE_SECURE
      ? process.env.AUTH_COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    authCookieSameSite: process.env.AUTH_COOKIE_SAME_SITE ?? "lax",
    authCookieDomain: process.env.AUTH_COOKIE_DOMAIN ?? "",
    smtpHost: process.env.SMTP_HOST ?? "",
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpSecure: process.env.SMTP_SECURE === "true",
    smtpUser: process.env.SMTP_USER ?? "",
    smtpPassword: process.env.SMTP_PASSWORD ?? "",
    emailFrom: process.env.EMAIL_FROM ?? "PayLens <noreply@paylens.local>",
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL ?? "",
  };
});
