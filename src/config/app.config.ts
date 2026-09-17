import { registerAs } from "@nestjs/config";

export default registerAs("app", () => ({
  redisUrl: process.env.REDIS_URL,
  environment: process.env.NODE_ENV,
  databaseUrl: process.env.DATABASE_URL,
  port: Number(process.env.PORT ?? 4000),
  logLevel: process.env.LOG_LEVEL ?? "info",
  throttleLimit: Number(process.env.THROTTLE_LIMIT ?? 200),
  throttleTtlMs: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
  executionTraceEnabled: process.env.EXECUTION_TRACE_ENABLED !== "false",
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
}));
