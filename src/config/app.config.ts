import { registerAs } from "@nestjs/config";
import { loadRuntimeConfig } from "./env.validation.js";
import {
  GLOBAL_THROTTLE_LIMIT,
  GLOBAL_THROTTLE_TTL_MS,
  SLOW_QUERY_THRESHOLD_MS,
} from "./runtime.constants.js";

export default registerAs("app", () => {
  const runtime = loadRuntimeConfig(process.env);

  return {
    ...runtime,
    environment: runtime.NODE_ENV,
    port: runtime.PORT,
    databaseUrl: runtime.DATABASE_URL,
    redisUrl: runtime.REDIS_URL,
    frontendUrl: runtime.FRONTEND_URL,
    corsOrigin: runtime.FRONTEND_URL,
    logLevel: runtime.LOG_LEVEL,
    throttleLimit: GLOBAL_THROTTLE_LIMIT,
    throttleTtlMs: GLOBAL_THROTTLE_TTL_MS,
    slowQueryMs: SLOW_QUERY_THRESHOLD_MS,
    authAccessTokenSecret: runtime.AUTH_ACCESS_TOKEN_SECRET,
    authCookieSecure: runtime.NODE_ENV === "production",
    authCookieSameSite: runtime.AUTH_COOKIE_SAME_SITE,
    smtpUrl: runtime.SMTP_URL,
    emailFrom: runtime.EMAIL_FROM,
    googleClientId: runtime.GOOGLE_CLIENT_ID,
    googleClientSecret: runtime.GOOGLE_CLIENT_SECRET,
    googleCallbackUrl: runtime.GOOGLE_CALLBACK_URL,
    otelExporterOtlpEndpoint: runtime.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
});
