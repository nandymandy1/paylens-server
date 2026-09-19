/**
 * Shared OpenTelemetry test mocks.
 *
 * Usage in test files:
 *   import { otelMockSpies, registerStandardMocks } from "@test/fixtures/opentelemetry.js";
 *   registerStandardMocks(); // call before each test or at top-level vi.mock
 *
 * Spies are accessible via otelMockSpies for assertions.
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Spies — importable for assertions
// ---------------------------------------------------------------------------
export const otelMockSpies = {
  // TracerProvider
  traceForceFlush: vi.fn().mockResolvedValue(undefined),
  traceShutdown: vi.fn().mockResolvedValue(undefined),

  // LoggerProvider
  logForceFlush: vi.fn().mockResolvedValue(undefined),
  logShutdown: vi.fn().mockResolvedValue(undefined),

  // MeterProvider
  metricForceFlush: vi.fn().mockResolvedValue(undefined),
  metricShutdown: vi.fn().mockResolvedValue(undefined),

  // MetricReader (owned by MeterProvider — should NOT be independently shut down)
  metricReaderForceFlush: vi.fn().mockResolvedValue(undefined),
  metricReaderShutdown: vi.fn().mockResolvedValue(undefined),

  // API
  setSpanContext: vi.fn((_ctx: unknown, sc: unknown) => sc),
  getSpan: vi.fn().mockReturnValue(null),
  setGlobalMeterProvider: vi.fn(),
  setGlobalLoggerProvider: vi.fn(),

  // Exporters
  traceExporter: vi.fn(),
  logExporter: vi.fn(),
  metricExporter: vi.fn(),
};

// ---------------------------------------------------------------------------
// Mock factory functions
// ---------------------------------------------------------------------------
function createMockTracerProvider() {
  return {
    register: vi.fn(),
    forceFlush: otelMockSpies.traceForceFlush.mockResolvedValue(undefined),
    shutdown: otelMockSpies.traceShutdown.mockResolvedValue(undefined),
  };
}

function createMockLoggerProvider() {
  return {
    forceFlush: otelMockSpies.logForceFlush.mockResolvedValue(undefined),
    shutdown: otelMockSpies.logShutdown.mockResolvedValue(undefined),
  };
}

function createMockMeterProvider() {
  return {
    forceFlush: otelMockSpies.metricForceFlush.mockResolvedValue(undefined),
    shutdown: otelMockSpies.metricShutdown.mockResolvedValue(undefined),
  };
}

function createMockMetricReader() {
  return {
    forceFlush: otelMockSpies.metricReaderForceFlush.mockResolvedValue(undefined),
    shutdown: otelMockSpies.metricReaderShutdown.mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Standard vi.mock registrations
// Call this in beforeEach or at file-level to register all OTel mocks.
// ---------------------------------------------------------------------------
export function registerStandardMocks(): void {
  vi.mock("@opentelemetry/sdk-trace-node", () => ({
    NodeTracerProvider: vi.fn(function NodeTracerProvider() {
      return createMockTracerProvider();
    }),
  }));

  vi.mock("@opentelemetry/sdk-trace-base", () => ({
    BatchSpanProcessor: vi.fn(),
    ParentBasedSampler: vi.fn(),
    TraceIdRatioBasedSampler: vi.fn(),
  }));

  vi.mock("@opentelemetry/sdk-logs", () => ({
    LoggerProvider: vi.fn(function LoggerProvider() {
      return createMockLoggerProvider();
    }),
    BatchLogRecordProcessor: vi.fn(),
  }));

  vi.mock("@opentelemetry/sdk-metrics", () => ({
    MeterProvider: vi.fn(function MeterProvider() {
      return createMockMeterProvider();
    }),
    PeriodicExportingMetricReader: vi.fn(function PeriodicExportingMetricReader() {
      return createMockMetricReader();
    }),
  }));

  vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
    OTLPTraceExporter: vi.fn(function OTLPTraceExporter() {
      return { export: otelMockSpies.traceExporter };
    }),
  }));

  vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
    OTLPLogExporter: vi.fn(function OTLPLogExporter() {
      return {
        export: vi.fn((r: unknown[], cb: (r: { code: number }) => void) => cb({ code: 0 })),
      };
    }),
  }));

  vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
    OTLPMetricExporter: vi.fn(function OTLPMetricExporter() {
      return { export: otelMockSpies.metricExporter };
    }),
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
}

export function registerApiMocks(): void {
  vi.mock("@opentelemetry/api", () => ({
    context: {
      active: vi.fn().mockReturnValue({}),
      with: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
    },
    trace: {
      getTracer: vi.fn().mockReturnValue({
        startSpan: vi.fn().mockReturnValue({
          spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          end: vi.fn(),
          recordException: vi.fn(),
        }),
      }),
      setSpan: vi.fn().mockReturnValue({}),
      setSpanContext: otelMockSpies.setSpanContext,
      getSpan: otelMockSpies.getSpan,
    },
    metrics: {
      getMeter: vi.fn().mockReturnValue({
        createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
        createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
      }),
      setGlobalMeterProvider: otelMockSpies.setGlobalMeterProvider,
    },
    SpanKind: { INTERNAL: 0, SERVER: 1 },
    StatusCode: { OK: 1, ERROR: 2 },
  }));

  vi.mock("@opentelemetry/api-logs", () => ({
    logs: {
      getLogger: vi.fn().mockReturnValue({ emit: vi.fn() }),
      setGlobalLoggerProvider: otelMockSpies.setGlobalLoggerProvider,
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
}
