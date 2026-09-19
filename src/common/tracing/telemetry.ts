import { context, metrics, trace, type SpanContext } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { PrismaInstrumentation } from "@prisma/instrumentation";
import type { TelemetryConfig } from "./telemetry.config.js";
import { buildOtlpSignalUrl, isValidSpanId, isValidTraceId } from "./telemetry.utils.js";

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------
type LifecycleState =
  "uninitialized" | "initializing" | "initialized" | "shutting-down" | "shutdown";

let lifecycleState: LifecycleState = "uninitialized";

// Retained provider references for flush/shutdown
let tracerProvider: NodeTracerProvider | undefined;
let loggerProvider: LoggerProvider | undefined;
let meterProvider: MeterProvider | undefined;

// Retained config for runtime info
let lastConfig: TelemetryConfig | undefined;

let lastExporterFailureAt = 0;
const EXPORTER_WARNING_INTERVAL_MS = 30_000;

const reportExporterFailure = (): void => {
  const now = Date.now();

  if (now - lastExporterFailureAt < EXPORTER_WARNING_INTERVAL_MS) return;
  lastExporterFailureAt = now;
  process.stderr.write(
    `${JSON.stringify({
      level: "warn",
      service: "paylens-server",
      event: "telemetry.export.unavailable",
      message: "stdout logging unaffected",
    })}\n`,
  );
};

// ---------------------------------------------------------------------------
// Initialize OpenTelemetry — idempotent
// ---------------------------------------------------------------------------
export const initializeTelemetry = (config: TelemetryConfig): void => {
  if (lifecycleState !== "uninitialized") return;
  if (!config.enabled) return;

  lifecycleState = "initializing";
  lastConfig = config;
  const resource = resourceFromAttributes({ "service.name": config.serviceName });

  // --- Traces ---
  const spanProcessors = config.endpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: buildOtlpSignalUrl(config.endpoint, "traces") }),
        ),
      ]
    : [];

  const provider = new NodeTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.traceSampleRatio),
    }),
    spanProcessors,
  });

  // Register W3C propagation with the provider so incoming traceparent
  // extraction and outgoing context injection have one global registration.
  provider.register({ propagator: new W3CTraceContextPropagator() });
  tracerProvider = provider;

  // --- Logs ---
  if (config.logsEnabled && config.endpoint) {
    const exporter = new OTLPLogExporter({
      url: buildOtlpSignalUrl(config.endpoint, "logs"),
    });
    const originalExport = exporter.export.bind(exporter);

    exporter.export = (records, resultCallback) => {
      originalExport(records, (result) => {
        if (result.code !== 0) reportExporterFailure();
        resultCallback(result);
      });
    };

    loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter,
          maxQueueSize: 2_048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 1_000,
          exportTimeoutMillis: 3_000,
        }),
      ],
    });
    logs.setGlobalLoggerProvider(loggerProvider);
  }

  // --- Metrics ---
  if (config.metricsEnabled && config.endpoint) {
    const metricExporter = new OTLPMetricExporter({
      url: buildOtlpSignalUrl(config.endpoint, "metrics"),
    });

    const metricReader = new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 15_000,
      exportTimeoutMillis: 5_000,
    });

    meterProvider = new MeterProvider({ resource, readers: [metricReader] });
    metrics.setGlobalMeterProvider(meterProvider);
  }

  // --- Instrumentations (must register after providers so they patch correctly) ---
  // HttpInstrumentation creates real HTTP SERVER spans for incoming requests and
  // HTTP CLIENT spans for outgoing requests (including SMTP). It also propagates
  // W3C traceparent context automatically.
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // Do not record request/response headers (may contain auth/cookies)
        requestHook: () => {},
        responseHook: () => {},
      }),
      new PrismaInstrumentation(),
      new IORedisInstrumentation(),
    ],
  });

  lifecycleState = "initialized";
};

// ---------------------------------------------------------------------------
// Public accessors
// ---------------------------------------------------------------------------
export const executionTracer = () => trace.getTracer("paylens.execution");

export const executionMeter = () => metrics.getMeter("paylens.execution");

/**
 * Runtime telemetry info for startup diagnostics.
 * Exposes only non-secret operational state.
 */
export function getTelemetryRuntimeInfo(): {
  initialized: boolean;
  serviceName: string;
  protocol: string;
  traceSampleRatio: number;
  logsEnabled: boolean;
  metricsEnabled: boolean;
} {
  return {
    initialized: lifecycleState === "initialized",
    serviceName: lastConfig?.serviceName ?? "paylens-server",
    protocol: lastConfig?.protocol ?? "http/protobuf",
    traceSampleRatio: lastConfig?.traceSampleRatio ?? 1,
    logsEnabled: lastConfig?.logsEnabled ?? false,
    metricsEnabled: lastConfig?.metricsEnabled ?? false,
  };
}

export function emitOtelLog(record: {
  severityNumber: SeverityNumber;
  severityText: string;
  body: string;
  attributes: Record<string, string | number | boolean | string[]>;
  traceId?: string;
  spanId?: string;
}): void {
  const activeContext = context.active();

  let logContext = activeContext;

  if (
    record.traceId &&
    record.spanId &&
    isValidTraceId(record.traceId) &&
    isValidSpanId(record.spanId)
  ) {
    const activeSpan = trace.getSpan(activeContext);
    const activeSC = activeSpan?.spanContext();

    // Correlation rule: check BOTH traceId AND spanId match.
    // Same trace but different span must still override (service span vs controller span).
    const explicitContextMatches =
      activeSC?.traceId === record.traceId && activeSC?.spanId === record.spanId;

    if (!explicitContextMatches) {
      const spanContext: SpanContext = {
        traceId: record.traceId,
        spanId: record.spanId,
        traceFlags: 1, // SAMPLED
        isRemote: false,
      };

      logContext = trace.setSpanContext(activeContext, spanContext);
    }
  }

  logs.getLogger("paylens.pino").emit({
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: record.body,
    attributes: record.attributes,
    context: logContext,
  });
}

// ---------------------------------------------------------------------------
// Shutdown — flush + shutdown all providers, idempotent
// MeterProvider owns its readers — do not independently lifecycle-manage readers.
// One lifecycle per Node.js process. Reinitialization after shutdown is NOT
// guaranteed to work (OTel globals may not support clean re-registration).
// ---------------------------------------------------------------------------
export const shutdownTelemetry = async (): Promise<void> => {
  if (lifecycleState !== "initialized") return;
  lifecycleState = "shutting-down";

  // Force flush first — best-effort, don't let one failure block others
  await Promise.allSettled([
    tracerProvider?.forceFlush?.(),
    loggerProvider?.forceFlush?.(),
    meterProvider?.forceFlush?.(),
  ]);

  // Then shutdown — best-effort
  await Promise.allSettled([
    tracerProvider?.shutdown?.(),
    loggerProvider?.shutdown?.(),
    meterProvider?.shutdown?.(),
  ]);

  // Reset provider references — OTel globals may still hold stale references.
  // Reinitialization after shutdown is NOT guaranteed to work; do not claim it.
  tracerProvider = undefined;
  loggerProvider = undefined;
  meterProvider = undefined;
  lastConfig = undefined;
  lifecycleState = "shutdown";
};

export { context, trace, SeverityNumber };
