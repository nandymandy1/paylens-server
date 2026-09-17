import { registerAs } from "@nestjs/config";

export default registerAs("app", () => ({
  environment: process.env.NODE_ENV,
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  logLevel: process.env.LOG_LEVEL ?? "info",
  executionTraceEnabled: process.env.EXECUTION_TRACE_ENABLED !== "false",
  throttleTtlMs: Number(process.env.THROTTLE_TTL_MS ?? 60_000),
  throttleLimit: Number(process.env.THROTTLE_LIMIT ?? 100),
  corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()),
}));
