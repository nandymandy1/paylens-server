/**
 * Telemetry bootstrap — must run BEFORE any Nest module import.
 *
 * Loads .env via dotenv, parses telemetry config from process.env,
 * then initializes OTel so Prisma/ioredis/HTTP instrumentation patches
 * apply before their modules load.
 *
 * Required startup order:
 *   process → load .env → parse config → initialize OTel → import Nest
 */
import "dotenv/config";
import { parseTelemetryConfig } from "@/common/tracing/telemetry.config.js";
import { initializeTelemetry } from "@/common/tracing/telemetry.js";

const config = parseTelemetryConfig();

if (config.enabled) {
  initializeTelemetry(config);
}
