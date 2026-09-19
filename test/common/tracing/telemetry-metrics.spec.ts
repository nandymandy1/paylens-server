import { describe, expect, it, vi, beforeEach } from "vitest";

const spies = {
  metricExporterUrl: vi.fn(),
};

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: vi.fn(function NodeTracerProvider() {
    return {
      register: vi.fn(),
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: vi.fn(),
  ParentBasedSampler: vi.fn(),
  TraceIdRatioBasedSampler: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  LoggerProvider: vi.fn(function LoggerProvider() {
    return {
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }),
  BatchLogRecordProcessor: vi.fn(),
}));

const mockReader = {
  forceFlush: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: vi.fn(function MeterProvider() {
    return {
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }),
  PeriodicExportingMetricReader: vi.fn(function PeriodicExportingMetricReader() {
    return mockReader;
  }),
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: vi.fn(),
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: vi.fn(function OTLPLogExporter() {
    return {
      export: vi.fn((r: unknown[], cb: (r: { code: number }) => void) => cb({ code: 0 })),
    };
  }),
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: vi.fn(function OTLPMetricExporter(args: { url?: string }) {
    spies.metricExporterUrl(args.url);

    return { export: vi.fn() };
  }),
}));

vi.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-ioredis", () => ({
  IORedisInstrumentation: vi.fn(),
}));

vi.mock("@prisma/instrumentation", () => ({
  PrismaInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn().mockReturnValue({}),
}));

vi.mock("@opentelemetry/core", () => ({
  W3CTraceContextPropagator: vi.fn(),
}));

vi.mock("@opentelemetry/api", () => {
  const noopSpan = {
    spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
  };

  return {
    context: {
      active: vi.fn().mockReturnValue({}),
      with: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
    },
    trace: {
      getTracer: vi.fn().mockReturnValue({ startSpan: vi.fn().mockReturnValue(noopSpan) }),
      setSpan: vi.fn().mockReturnValue({}),
      setSpanContext: vi.fn().mockReturnValue({}),
      getSpan: vi.fn().mockReturnValue(null),
    },
    metrics: {
      getMeter: vi.fn().mockReturnValue({
        createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
        createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
      }),
      setGlobalMeterProvider: vi.fn(),
    },
    propagation: {
      setGlobalPropagator: vi.fn(),
    },
    SpanKind: { INTERNAL: 0, SERVER: 1 },
    StatusCode: { OK: 1, ERROR: 2 },
  };
});

vi.mock("@opentelemetry/api-logs", () => ({
  logs: {
    getLogger: vi.fn().mockReturnValue({ emit: vi.fn() }),
    setGlobalLoggerProvider: vi.fn(),
  },
  SeverityNumber: {
    TRACE: 1,
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
    FATAL: 21,
  },
}));

describe("telemetry metrics pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("creates MeterProvider and PeriodicExportingMetricReader when metricsEnabled with endpoint", async () => {
    const { initializeTelemetry } = await import("@/common/tracing/telemetry.js");
    const sdkMetrics = await import("@opentelemetry/sdk-metrics");

    initializeTelemetry({
      enabled: true,
      serviceName: "test-metrics",
      endpoint: "http://localhost:4318",
      protocol: "http/protobuf",
      traceSampleRatio: 1,
      logsEnabled: false,
      metricsEnabled: true,
    });

    expect(sdkMetrics.PeriodicExportingMetricReader).toHaveBeenCalledOnce();
    expect(sdkMetrics.MeterProvider).toHaveBeenCalledOnce();
  });

  it("passes correct /v1/metrics URL to OTLPMetricExporter", async () => {
    const { initializeTelemetry } = await import("@/common/tracing/telemetry.js");

    initializeTelemetry({
      enabled: true,
      serviceName: "test-metrics",
      endpoint: "http://localhost:4318",
      protocol: "http/protobuf",
      traceSampleRatio: 1,
      logsEnabled: false,
      metricsEnabled: true,
    });

    expect(spies.metricExporterUrl).toHaveBeenCalledWith("http://localhost:4318/v1/metrics");
  });

  it("handles trailing slash on endpoint", async () => {
    const { initializeTelemetry } = await import("@/common/tracing/telemetry.js");

    initializeTelemetry({
      enabled: true,
      serviceName: "test-metrics",
      endpoint: "http://localhost:4318/",
      protocol: "http/protobuf",
      traceSampleRatio: 1,
      logsEnabled: false,
      metricsEnabled: true,
    });

    expect(spies.metricExporterUrl).toHaveBeenCalledWith("http://localhost:4318/v1/metrics");
  });

  it("does not create metrics pipeline when metricsEnabled=false", async () => {
    const { initializeTelemetry } = await import("@/common/tracing/telemetry.js");
    const sdkMetrics = await import("@opentelemetry/sdk-metrics");

    initializeTelemetry({
      enabled: true,
      serviceName: "test-no-metrics",
      endpoint: "http://localhost:4318",
      protocol: "http/protobuf",
      traceSampleRatio: 1,
      logsEnabled: false,
      metricsEnabled: false,
    });

    expect(sdkMetrics.MeterProvider).not.toHaveBeenCalled();
  });

  it("does not create metrics pipeline when no endpoint", async () => {
    const { initializeTelemetry } = await import("@/common/tracing/telemetry.js");
    const sdkMetrics = await import("@opentelemetry/sdk-metrics");

    initializeTelemetry({
      enabled: true,
      serviceName: "test-no-endpoint",
      protocol: "http/protobuf",
      traceSampleRatio: 1,
      logsEnabled: false,
      metricsEnabled: true,
    });

    expect(sdkMetrics.MeterProvider).not.toHaveBeenCalled();
  });

  it("executionMeter returns a working meter", async () => {
    const { executionMeter } = await import("@/common/tracing/telemetry.js");
    const meter = executionMeter();

    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe("function");
    expect(typeof meter.createHistogram).toBe("function");
  });
});
