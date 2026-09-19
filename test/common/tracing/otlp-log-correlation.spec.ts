import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockEmit, mockSetSpanContext, mockGetSpan } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockSetSpanContext: vi.fn((_ctx: unknown, sc: unknown) => sc),
  mockGetSpan: vi.fn().mockReturnValue(null),
}));

vi.mock("@opentelemetry/api-logs", () => ({
  logs: {
    getLogger: vi.fn().mockReturnValue({ emit: mockEmit }),
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

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: vi.fn(),
  ParentBasedSampler: vi.fn(),
  TraceIdRatioBasedSampler: vi.fn(),
}));

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: vi.fn(function NodeTracerProvider() {
    return {
      register: vi.fn(),
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }),
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

vi.mock("@opentelemetry/sdk-metrics", () => ({
  MeterProvider: vi.fn(),
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

vi.mock("@opentelemetry/api", () => ({
  context: {
    active: vi.fn().mockReturnValue({}),
    with: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  },
  trace: {
    getTracer: vi.fn().mockReturnValue({ startSpan: vi.fn() }),
    setSpan: vi.fn().mockReturnValue({}),
    setSpanContext: mockSetSpanContext,
    getSpan: mockGetSpan,
  },
  metrics: {
    getMeter: vi.fn().mockReturnValue({
      createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    }),
  },
  SpanKind: { INTERNAL: 0, SERVER: 1 },
  StatusCode: { OK: 1, ERROR: 2 },
}));

// Valid 16-char hex span IDs for tests
const VALID_SPAN_ID_A = "abcdef1234567890";
const VALID_SPAN_ID_B = "1122334455667788";
const VALID_TRACE_ID = "abc123def456abc123def456abc123de";

describe("OTLP log correlation", () => {
  beforeEach(() => {
    mockEmit.mockClear();
    mockSetSpanContext.mockClear();
    mockSetSpanContext.mockImplementation((_ctx: unknown, sc: unknown) => sc);
    mockGetSpan.mockReturnValue(null);
  });

  it("emits log with active context when no explicit traceId/spanId", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "test log",
      attributes: { event: "test" },
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    const emitted = mockEmit.mock.calls[0][0];

    expect(emitted.body).toBe("test log");
    expect(emitted.severityNumber).toBe(SeverityNumber.INFO);
    // No active span → context is the base context, setSpanContext NOT called
    expect(mockSetSpanContext).not.toHaveBeenCalled();
  });

  it("creates non-recording span context for explicit valid traceId/spanId when no active span", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    // No active span
    mockGetSpan.mockReturnValue(null);

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "correlated log",
      attributes: { event: "test" },
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID_A,
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    const emitted = mockEmit.mock.calls[0][0];

    expect(emitted.body).toBe("correlated log");
    // Must prove setSpanContext was called with exact IDs
    expect(mockSetSpanContext).toHaveBeenCalledOnce();
    const call = mockSetSpanContext.mock.calls[0];
    const spanContext = call[1] as { traceId: string; spanId: string; traceFlags: number };

    expect(spanContext.traceId).toBe(VALID_TRACE_ID);
    expect(spanContext.spanId).toBe(VALID_SPAN_ID_A);
    expect(spanContext.traceFlags).toBe(1);
  });

  it("does not create bogus context for invalid traceId", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    mockSetSpanContext.mockClear();

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "invalid trace",
      attributes: {},
      traceId: "invalid-not-hex",
      spanId: VALID_SPAN_ID_A,
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    expect(mockSetSpanContext).not.toHaveBeenCalled();
  });

  it("does not create bogus context for invalid spanId", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    mockSetSpanContext.mockClear();

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "invalid span",
      attributes: {},
      traceId: VALID_TRACE_ID,
      spanId: "short",
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    expect(mockSetSpanContext).not.toHaveBeenCalled();
  });

  it("does not create bogus context for all-zero traceId", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    mockSetSpanContext.mockClear();

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "zero trace",
      attributes: {},
      traceId: "00000000000000000000000000000000",
      spanId: VALID_SPAN_ID_A,
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    expect(mockSetSpanContext).not.toHaveBeenCalled();
  });

  it("does not create bogus context for all-zero spanId", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    mockSetSpanContext.mockClear();

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "zero span",
      attributes: {},
      traceId: VALID_TRACE_ID,
      spanId: "0000000000000000",
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    expect(mockSetSpanContext).not.toHaveBeenCalled();
  });

  it("does not override active context when both traceId AND spanId match", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    // Active span has traceId=VALID_TRACE_ID, spanId=VALID_SPAN_ID_A
    mockGetSpan.mockReturnValue({
      spanContext: () => ({
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID_A,
        traceFlags: 1,
      }),
    });
    mockSetSpanContext.mockClear();

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "matching context",
      attributes: {},
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID_A,
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    // Same traceId + same spanId → no override
    expect(mockSetSpanContext).not.toHaveBeenCalled();
  });

  it("overrides when same traceId but different spanId", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    // Active span: traceId=VALID_TRACE_ID, spanId=VALID_SPAN_ID_A (controller span)
    mockGetSpan.mockReturnValue({
      spanContext: () => ({
        traceId: VALID_TRACE_ID,
        spanId: VALID_SPAN_ID_A,
        traceFlags: 1,
      }),
    });
    mockSetSpanContext.mockClear();

    // Log has: same traceId, different spanId (service span)
    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "service log",
      attributes: {},
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID_B,
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    // Same trace, different span → MUST override
    expect(mockSetSpanContext).toHaveBeenCalledOnce();
    const spanContext = mockSetSpanContext.mock.calls[0][1] as { traceId: string; spanId: string };

    expect(spanContext.traceId).toBe(VALID_TRACE_ID);
    expect(spanContext.spanId).toBe(VALID_SPAN_ID_B);
  });

  it("overrides when different traceId", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    mockGetSpan.mockReturnValue({
      spanContext: () => ({
        traceId: "11111111111111111111111111111111",
        spanId: VALID_SPAN_ID_A,
        traceFlags: 1,
      }),
    });
    mockSetSpanContext.mockClear();

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "different trace",
      attributes: {},
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID_B,
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    expect(mockSetSpanContext).toHaveBeenCalledOnce();
    const spanContext = mockSetSpanContext.mock.calls[0][1] as { traceId: string; spanId: string };

    expect(spanContext.traceId).toBe(VALID_TRACE_ID);
    expect(spanContext.spanId).toBe(VALID_SPAN_ID_B);
  });

  it("retains traceId/spanId as structured attributes", async () => {
    const { emitOtelLog } = await import("@/common/tracing/telemetry.js");
    const { SeverityNumber } = await import("@opentelemetry/api-logs");

    emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      body: "with attrs",
      attributes: { traceId: VALID_TRACE_ID, spanId: VALID_SPAN_ID_A },
      traceId: VALID_TRACE_ID,
      spanId: VALID_SPAN_ID_A,
    });

    expect(mockEmit).toHaveBeenCalledOnce();
    const emitted = mockEmit.mock.calls[0][0];

    expect(emitted.attributes).toHaveProperty("traceId", VALID_TRACE_ID);
    expect(emitted.attributes).toHaveProperty("spanId", VALID_SPAN_ID_A);
  });
});
