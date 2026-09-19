import { describe, expect, it, vi, beforeEach } from "vitest";

const spies = {
  traceForceFlush: vi.fn().mockResolvedValue(undefined),
  traceShutdown: vi.fn().mockResolvedValue(undefined),
  logForceFlush: vi.fn().mockResolvedValue(undefined),
  logShutdown: vi.fn().mockResolvedValue(undefined),
  metricForceFlush: vi.fn().mockResolvedValue(undefined),
  metricShutdown: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: vi.fn(function NodeTracerProvider() {
    return {
      register: vi.fn(),
      forceFlush: spies.traceForceFlush,
      shutdown: spies.traceShutdown,
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
      forceFlush: spies.logForceFlush,
      shutdown: spies.logShutdown,
    };
  }),
  BatchLogRecordProcessor: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: vi.fn(function MeterProvider() {
    return {
      forceFlush: spies.metricForceFlush,
      shutdown: spies.metricShutdown,
    };
  }),
  PeriodicExportingMetricReader: vi.fn(),
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
  OTLPMetricExporter: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation-http", () => ({
  HttpInstrumentation: vi.fn(),
}));

vi.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: vi.fn(),
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

const validConfig = {
  enabled: true,
  serviceName: "test",
  endpoint: "http://localhost:4318",
  protocol: "http/protobuf" as const,
  traceSampleRatio: 1,
  logsEnabled: true,
  metricsEnabled: true,
};

describe("telemetry shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("shutdown is safe to call when not initialized", async () => {
    const { shutdownTelemetry } = await import("@/common/tracing/telemetry.js");

    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it("shutdown is idempotent", async () => {
    const { initializeTelemetry, shutdownTelemetry } =
      await import("@/common/tracing/telemetry.js");

    initializeTelemetry(validConfig);

    await shutdownTelemetry();
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it("initialization is idempotent", async () => {
    const { initializeTelemetry } = await import("@/common/tracing/telemetry.js");

    initializeTelemetry(validConfig);
    initializeTelemetry(validConfig); // second call should be no-op
  });

  it("skips initialization when enabled=false", async () => {
    const { initializeTelemetry } = await import("@/common/tracing/telemetry.js");

    initializeTelemetry({
      enabled: false,
      serviceName: "test",
      protocol: "http/protobuf",
      traceSampleRatio: 1,
      logsEnabled: true,
      metricsEnabled: true,
    });
  });

  it("flushes all providers exactly once before shutdown", async () => {
    const { initializeTelemetry, shutdownTelemetry } =
      await import("@/common/tracing/telemetry.js");

    initializeTelemetry(validConfig);
    await shutdownTelemetry();

    expect(spies.traceForceFlush).toHaveBeenCalledOnce();
    expect(spies.logForceFlush).toHaveBeenCalledOnce();
    expect(spies.metricForceFlush).toHaveBeenCalledOnce();

    expect(spies.traceShutdown).toHaveBeenCalledOnce();
    expect(spies.logShutdown).toHaveBeenCalledOnce();
    expect(spies.metricShutdown).toHaveBeenCalledOnce();
  });

  it("continues flushing remaining providers when one flush fails", async () => {
    const { initializeTelemetry, shutdownTelemetry } =
      await import("@/common/tracing/telemetry.js");

    spies.traceForceFlush.mockRejectedValueOnce(new Error("flush failed"));

    initializeTelemetry(validConfig);
    await shutdownTelemetry();

    // Trace flush failed, but log and metric flush still attempted
    expect(spies.traceForceFlush).toHaveBeenCalledOnce();
    expect(spies.logForceFlush).toHaveBeenCalledOnce();
    expect(spies.metricForceFlush).toHaveBeenCalledOnce();

    // All shutdowns still attempted
    expect(spies.traceShutdown).toHaveBeenCalledOnce();
    expect(spies.logShutdown).toHaveBeenCalledOnce();
    expect(spies.metricShutdown).toHaveBeenCalledOnce();
  });

  it("continues shutting down remaining providers when one shutdown fails", async () => {
    const { initializeTelemetry, shutdownTelemetry } =
      await import("@/common/tracing/telemetry.js");

    spies.traceShutdown.mockRejectedValueOnce(new Error("shutdown failed"));

    initializeTelemetry(validConfig);
    await shutdownTelemetry();

    expect(spies.traceShutdown).toHaveBeenCalledOnce();
    expect(spies.logShutdown).toHaveBeenCalledOnce();
    expect(spies.metricShutdown).toHaveBeenCalledOnce();
  });

  it("does not reinitialize after shutdown (one lifecycle per process)", async () => {
    const { initializeTelemetry, shutdownTelemetry } =
      await import("@/common/tracing/telemetry.js");
    const sdkTrace = await import("@opentelemetry/sdk-trace-node");

    initializeTelemetry(validConfig);

    // First cycle created one NodeTracerProvider
    expect(sdkTrace.NodeTracerProvider).toHaveBeenCalledOnce();

    await shutdownTelemetry();

    // Clear call counts for the second initialize attempt
    vi.clearAllMocks();

    // Second initialize should be a no-op (lifecycle state is "shutdown",
    // not "uninitialized"). Do not claim same-process reinitialization works.
    initializeTelemetry(validConfig);

    // No additional NodeTracerProvider should be created
    expect(sdkTrace.NodeTracerProvider).not.toHaveBeenCalled();
  });
});
