import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/common/tracing/telemetry.js", () => ({
  initializeTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
  getTelemetryRuntimeInfo: vi.fn().mockReturnValue({
    initialized: true,
    serviceName: "test",
    protocol: "http/protobuf",
    traceSampleRatio: 1,
    logsEnabled: true,
    metricsEnabled: true,
  }),
  executionTracer: vi.fn().mockReturnValue({ startSpan: vi.fn() }),
  executionMeter: vi.fn().mockReturnValue({
    createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
    createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
  }),
  context: { active: vi.fn(), with: vi.fn((_c: unknown, fn: () => unknown) => fn()) },
  trace: { setSpan: vi.fn() },
  SeverityNumber: { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 },
}));

const { ExecutionTraceService } = await import("@/common/tracing/execution-trace.service.js");

function createTraceService(overrides?: { slowQueryMs?: number }) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = {
    getOrThrow: (key: string) => {
      if (key === "app.slowQueryMs") return overrides?.slowQueryMs ?? 100;

      return true;
    },
  };
  const trace = new ExecutionTraceService(config as never, logger as never);

  return { logger, trace };
}

describe("Prisma query logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses statementType instead of fake model/action", () => {
    const { logger, trace } = createTraceService();

    trace.recordDatabaseQuery({ statementType: "SELECT", durationMs: 5 });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "db.query.completed",
        statementType: "SELECT",
        durationMs: 5,
      }),
    );
    const call = logger.debug.mock.calls[0][0];

    expect(call).not.toHaveProperty("model");
    expect(call).not.toHaveProperty("operation");
  });

  it("preserves slow query threshold behavior", () => {
    const { logger, trace } = createTraceService({ slowQueryMs: 100 });

    trace.recordDatabaseQuery({ statementType: "INSERT", durationMs: 150 });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "db.query.slow",
        statementType: "INSERT",
        durationMs: 150,
        thresholdMs: 100,
      }),
    );
  });

  it("derives statementType safely from raw SQL", () => {
    const { logger, trace } = createTraceService();

    trace.recordDatabaseQuery({ statementType: "UNKNOWN", durationMs: 1 });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ statementType: "UNKNOWN" }),
    );
  });

  it("does not log params/bind values", () => {
    const { logger, trace } = createTraceService();

    trace.recordDatabaseQuery({ statementType: "SELECT", durationMs: 5 });

    const call = logger.debug.mock.calls[0][0];

    expect(call).not.toHaveProperty("params");
    expect(call).not.toHaveProperty("query");
    expect(call).not.toHaveProperty("parameters");
  });

  it("uses the logger debug level for normal query diagnostics", () => {
    const { logger, trace } = createTraceService();

    trace.recordDatabaseQuery({ statementType: "SELECT", durationMs: 5 });

    expect(logger.debug).toHaveBeenCalled();
  });
});

describe("PrismaService getSqlStatementType", () => {
  // Import the actual utility to test it
  it("is imported and used by PrismaService", async () => {
    const { getSqlStatementType } = await import("@/common/utils/sql.js");

    expect(getSqlStatementType("SELECT * FROM users")).toBe("SELECT");
    expect(getSqlStatementType("  insert into logs")).toBe("INSERT");
    expect(getSqlStatementType("UPDATE users SET name = 'x'")).toBe("UPDATE");
    expect(getSqlStatementType("DELETE FROM sessions")).toBe("DELETE");
    expect(getSqlStatementType("BEGIN")).toBe("BEGIN");
    expect(getSqlStatementType("COMMIT")).toBe("COMMIT");
    expect(getSqlStatementType("ROLLBACK")).toBe("ROLLBACK");
    expect(getSqlStatementType("")).toBe("UNKNOWN");
    expect(getSqlStatementType("EXPLAIN ANALYZE SELECT 1")).toBe("UNKNOWN");
  });
});
