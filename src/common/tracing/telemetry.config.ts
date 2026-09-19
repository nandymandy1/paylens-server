import {
  parseBooleanEnvStrict,
  parseNumberEnv,
  parseOptionalStringEnv,
} from "@/common/utils/env.js";
import { validateOtlpProtocol } from "./telemetry.utils.js";

export type TelemetryConfig = {
  enabled: boolean;
  serviceName: string;
  endpoint?: string;
  protocol: "http/protobuf";
  traceSampleRatio: number;
  logsEnabled: boolean;
  metricsEnabled: boolean;
};

/**
 * Parse telemetry configuration from environment variables.
 * Called before Nest ConfigModule loads — reads process.env directly.
 *
 * This is the SINGLE SOURCE OF TRUTH for telemetry configuration.
 * app.config.ts and env.validation.ts must consume these values,
 * never re-parse the same env vars with different rules.
 */
export function parseTelemetryConfig(env?: Record<string, string | undefined>): TelemetryConfig {
  const e = env ?? process.env;

  const enabled = parseBooleanEnvStrict(e.OTEL_ENABLED, true, "OTEL_ENABLED");
  const logsEnabled = parseBooleanEnvStrict(e.OTEL_LOGS_ENABLED, true, "OTEL_LOGS_ENABLED");
  const metricsEnabled = parseBooleanEnvStrict(
    e.OTEL_METRICS_ENABLED,
    enabled,
    "OTEL_METRICS_ENABLED",
  );
  const serviceName = parseOptionalStringEnv(e.OTEL_SERVICE_NAME) ?? "paylens-server";
  const endpoint = parseOptionalStringEnv(e.OTEL_EXPORTER_OTLP_ENDPOINT);
  const protocol = validateOtlpProtocol(e.OTEL_EXPORTER_OTLP_PROTOCOL);
  const traceSampleRatio = parseNumberEnv(e.OTEL_TRACE_SAMPLE_RATIO, {
    fallback: 1,
    min: 0,
    max: 1,
    name: "OTEL_TRACE_SAMPLE_RATIO",
  });

  return {
    enabled,
    serviceName,
    endpoint,
    protocol,
    traceSampleRatio,
    logsEnabled,
    metricsEnabled,
  };
}
