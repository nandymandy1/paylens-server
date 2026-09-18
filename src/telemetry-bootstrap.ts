/**
 * Telemetry bootstrap — must run BEFORE any Nest module import.
 *
 * Prisma, ioredis, and HTTP instrumentation need the OTel SDK registered
 * before their modules are loaded. This file is imported as the very first
 * line in main.ts so the SDK is ready before AppModule is resolved.
 *
 * Uses process.env directly (ConfigModule is not available yet).
 */
import { initializeTelemetry } from "@/common/tracing/telemetry.js";

const enabled = process.env.OTEL_ENABLED !== "false";
const logsEnabled = process.env.OTEL_LOGS_ENABLED !== "false";
const serviceName = process.env.OTEL_SERVICE_NAME || "paylens-server";
const exporterEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "";
const sampleRatio = Number(process.env.OTEL_TRACE_SAMPLE_RATIO) || 1;

if (enabled) {
  initializeTelemetry({
    enabled,
    logsEnabled,
    serviceName,
    exporterEndpoint,
    sampleRatio: Number.isFinite(sampleRatio) ? sampleRatio : 1,
  });
}
