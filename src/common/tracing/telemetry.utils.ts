/**
 * Tracing-specific utilities — OTLP URL construction, trace/span validation,
 * OTel severity mapping. These are NOT generic; they belong in the tracing subsystem.
 */

import { SeverityNumber } from "@opentelemetry/api-logs";

// ---------------------------------------------------------------------------
// Trace / Span ID validation
// ---------------------------------------------------------------------------

const TRACE_ID_PATTERN = /^[0-9a-fA-F]{32}$/;
const ALL_ZERO_TRACE_ID = /^0{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-fA-F]{16}$/;
const ALL_ZERO_SPAN_ID = /^0{16}$/;

export function isValidTraceId(id: string): boolean {
  return TRACE_ID_PATTERN.test(id) && !ALL_ZERO_TRACE_ID.test(id);
}

export function isValidSpanId(id: string): boolean {
  return SPAN_ID_PATTERN.test(id) && !ALL_ZERO_SPAN_ID.test(id);
}

// ---------------------------------------------------------------------------
// OTLP URL construction
// ---------------------------------------------------------------------------

type OtlpSignal = "traces" | "logs" | "metrics";

const SIGNAL_PATH: Record<OtlpSignal, string> = {
  traces: "/v1/traces",
  logs: "/v1/logs",
  metrics: "/v1/metrics",
};

const stripTrailingSlash = (s: string): string => s.replace(/\/$/, "");

/**
 * Build the full OTLP HTTP protobuf URL for a given signal.
 * Handles trailing slashes and existing /v1 path segments on the endpoint.
 *   buildOtlpSignalUrl("http://localhost:4318", "traces")
 *   → "http://localhost:4318/v1/traces"
 *   buildOtlpSignalUrl("http://localhost:4318/", "logs")
 *   → "http://localhost:4318/v1/logs"
 *   buildOtlpSignalUrl("http://localhost:4318/v1", "traces")
 *   → "http://localhost:4318/v1/traces"
 */
export function buildOtlpSignalUrl(endpoint: string, signal: OtlpSignal): string {
  const base = stripTrailingSlash(endpoint);
  // If endpoint already ends with /v1, don't double-append /v1/
  const path = base.endsWith("/v1") ? base.slice(0, -3) : base;

  return `${path}${SIGNAL_PATH[signal]}`;
}

// ---------------------------------------------------------------------------
// Pino → OTel severity mapping (single source, no duplicates)
// ---------------------------------------------------------------------------

export type OtelSeverity = {
  number: SeverityNumber;
  text: string;
};

export const PINO_TO_OTEL: Record<number, OtelSeverity> = {
  10: { number: SeverityNumber.TRACE, text: "TRACE" },
  20: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  30: { number: SeverityNumber.INFO, text: "INFO" },
  40: { number: SeverityNumber.WARN, text: "WARN" },
  50: { number: SeverityNumber.ERROR, text: "ERROR" },
  60: { number: SeverityNumber.FATAL, text: "FATAL" },
};

export const DEFAULT_OTEL_SEVERITY: OtelSeverity = {
  number: SeverityNumber.INFO,
  text: "INFO",
};
