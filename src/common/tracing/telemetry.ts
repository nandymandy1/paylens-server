import { context, metrics, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
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
import { PrismaInstrumentation } from "@prisma/instrumentation";

let initialized = false;
let logProvider: LoggerProvider | undefined;
let lastExporterFailureAt = 0;

const EXPORTER_WARNING_INTERVAL_MS = 30_000;

const reportExporterFailure = (): void => {
  const now = Date.now();

  if (now - lastExporterFailureAt < EXPORTER_WARNING_INTERVAL_MS) return;

  lastExporterFailureAt = now;
  // This diagnostic deliberately bypasses the OTLP pipeline: a broken exporter
  // must never recursively produce more export attempts or silence local logs.
  process.stderr.write(
    `${JSON.stringify({
      level: "warn",
      service: "paylens-server",
      event: "telemetry.export.unavailable",
      message: "stdout logging unaffected",
    })}\n`,
  );
};

const logEndpoint = (endpoint: string): string => endpoint.replace(/\/$/, "") + "/v1/logs";

const traceEndpoint = (endpoint: string): string => endpoint.replace(/\/$/, "") + "/v1/traces";

export const initializeTelemetry = (options: {
  enabled: boolean;
  logsEnabled: boolean;
  serviceName: string;
  exporterEndpoint?: string;
  sampleRatio: number;
}): void => {
  if (initialized || !options.enabled) return;

  const spanProcessors = options.exporterEndpoint
    ? [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: traceEndpoint(options.exporterEndpoint) }),
        ),
      ]
    : [];
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": options.serviceName }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRatio) }),
    spanProcessors,
  });

  provider.register();

  if (options.logsEnabled && options.exporterEndpoint) {
    const exporter = new OTLPLogExporter({ url: logEndpoint(options.exporterEndpoint) });
    const originalExport = exporter.export.bind(exporter);

    exporter.export = (records, resultCallback) => {
      originalExport(records, (result) => {
        if (result.code !== 0) reportExporterFailure();
        resultCallback(result);
      });
    };

    logProvider = new LoggerProvider({
      resource: resourceFromAttributes({ "service.name": options.serviceName }),
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
    logs.setGlobalLoggerProvider(logProvider);
  }

  registerInstrumentations({
    instrumentations: [new PrismaInstrumentation(), new IORedisInstrumentation()],
  });
  initialized = true;
};

export const executionTracer = () => trace.getTracer("paylens.execution");

export const executionMeter = () => metrics.getMeter("paylens.execution");

export function emitOtelLog(record: {
  severityNumber: SeverityNumber;
  severityText: string;
  body: string;
  attributes: Record<string, string | number | boolean | string[]>;
  traceId?: string;
  spanId?: string;
}): void {
  logs.getLogger("paylens.pino").emit({
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    body: record.body,
    attributes: record.attributes,
    // Pino writes this destination synchronously inside the active request
    // context, so the OTel log record inherits the current span naturally.
    context: context.active(),
  });
}

export const shutdownTelemetry = async (): Promise<void> => {
  await Promise.allSettled([logProvider?.forceFlush()]);
};

export { context, trace };
