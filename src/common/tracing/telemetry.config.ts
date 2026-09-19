import { parseOptionalStringEnv } from "@/common/utils/env.js";
import { TRACE_SAMPLE_RATIO } from "@/config/runtime.constants.js";

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
 * Early bootstrap has one optional telemetry setting. The endpoint is the
 * opt-in switch; absent means no remote exporter or instrumentation setup.
 */
export function parseTelemetryConfig(
  env: Record<string, string | undefined> = process.env,
): TelemetryConfig {
  const endpoint = parseOptionalStringEnv(env.OTEL_EXPORTER_OTLP_ENDPOINT);

  return {
    enabled: Boolean(endpoint),
    serviceName: "paylens-server",
    endpoint,
    protocol: "http/protobuf",
    traceSampleRatio: TRACE_SAMPLE_RATIO,
    logsEnabled: true,
    metricsEnabled: true,
  };
}
