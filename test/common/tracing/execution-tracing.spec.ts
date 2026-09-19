import { lastValueFrom, of } from "rxjs";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { requestContext } from "@/common/context/request-context.js";

vi.mock("@/common/tracing/telemetry.js", () => {
  const mockSpan = {
    spanContext: () => ({ traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 }),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
  };

  return {
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
    executionTracer: vi.fn().mockReturnValue({ startSpan: vi.fn().mockReturnValue(mockSpan) }),
    executionMeter: vi.fn().mockReturnValue({
      createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    }),
    context: {
      active: vi.fn().mockReturnValue({}),
      with: vi.fn((_c: unknown, fn: () => unknown) => fn()),
    },
    trace: { setSpan: vi.fn().mockReturnValue({}) },
    SeverityNumber: { TRACE: 1, DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17, FATAL: 21 },
  };
});

// Must import after mock setup
const { ControllerTraceInterceptor } =
  await import("@/common/tracing/controller-trace.interceptor.js");
const { ExecutionTraceService } = await import("@/common/tracing/execution-trace.service.js");
const { TraceMethod } = await import("@/common/tracing/trace-method.decorator.js");

function createTraceService() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const config = { getOrThrow: () => true };
  const trace = new ExecutionTraceService(config as never, logger as never);

  return { logger, trace };
}

describe("execution tracing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("correlates controller start and completion events with a request ID", async () => {
    const { logger, trace } = createTraceService();
    const interceptor = new ControllerTraceInterceptor(trace);

    class HealthController {
      health() {}
    }

    await requestContext.run({ requestId: "controller-request" }, async () => {
      await lastValueFrom(
        interceptor.intercept(
          {
            getClass: () => HealthController,
            getHandler: () => HealthController.prototype.health,
          } as never,
          {
            handle: () => of({ status: "ok" }),
          } as never,
        ),
      );
    });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "controller.started",
        controller: "HealthController",
        method: "health",
        requestId: "controller-request",
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "controller.completed",
        durationMs: expect.any(Number),
        requestId: "controller-request",
      }),
    );
  });

  it("traces a decorated service method without logging arguments or results", async () => {
    const { logger, trace } = createTraceService();

    class ExampleService {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
      constructor(readonly executionTrace: any) {}

      @TraceMethod()
      async execute(secret: string) {
        return { secret };
      }
    }

    const service = new ExampleService(trace);

    await requestContext.run({ requestId: "service-request" }, () => service.execute("private"));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service.started",
        service: "ExampleService",
        method: "execute",
        requestId: "service-request",
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service.completed",
        durationMs: expect.any(Number),
        requestId: "service-request",
      }),
    );
    expect(logger.debug.mock.calls.flat().join(" ")).not.toContain("private");
  });

  it("records service errors with timing and correlation but no stack payload", async () => {
    const { logger, trace } = createTraceService();

    class FailingService {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock
      constructor(readonly executionTrace: any) {}

      @TraceMethod()
      async execute() {
        throw new Error("controlled failure");
      }
    }

    await expect(
      requestContext.run({ requestId: "failure-request" }, () =>
        new FailingService(trace).execute(),
      ),
    ).rejects.toThrow("controlled failure");

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service.failed",
        requestId: "failure-request",
        durationMs: expect.any(Number),
        error: { name: "Error" },
      }),
    );
  });
});

describe("authenticated trace context", () => {
  function createFullTraceService() {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const config = { getOrThrow: () => true };
    const trace = new ExecutionTraceService(config as never, logger as never);

    return { logger, trace };
  }

  it("inherits authUserId from request context without manual passing", () => {
    const { logger, trace } = createFullTraceService();

    requestContext.run({ requestId: "req-123", authUserId: "usr-789" }, () => {
      trace.info({ event: "http.request.completed" });
    });

    expect(logger.info).toHaveBeenCalledWith({
      event: "http.request.completed",
      requestId: "req-123",
      authUserId: "usr-789",
    });
  });

  it("omits authUserId entirely for anonymous requests", () => {
    const { logger, trace } = createFullTraceService();

    requestContext.run({ requestId: "req-anonymous" }, () => {
      trace.info({ event: "http.request.completed" });
    });

    expect(logger.info).toHaveBeenCalledWith({
      event: "http.request.completed",
      requestId: "req-anonymous",
    });
    expect(logger.info.mock.calls[0][0]).not.toHaveProperty("authUserId");
  });

  it("prefers an explicit event identity over ambient context", () => {
    const { logger, trace } = createFullTraceService();

    requestContext.run({ requestId: "req-ambient", authUserId: "usr-ambient" }, () => {
      trace.info({ event: "http.request.completed", requestId: "req-explicit" });
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-explicit", authUserId: "usr-ambient" }),
    );
  });

  it("routes server failures through the error level with shared context", () => {
    const { logger, trace } = createFullTraceService();

    requestContext.run({ requestId: "req-500", authUserId: "usr-789" }, () => {
      trace.error({ event: "http.request.failed", statusCode: 500 });
    });

    expect(logger.error).toHaveBeenCalledWith({
      event: "http.request.failed",
      statusCode: 500,
      requestId: "req-500",
      authUserId: "usr-789",
    });
  });

  it("keeps raw request material out of every trace event", () => {
    const { logger, trace } = createFullTraceService();

    requestContext.run({ requestId: "req-clean" }, () => {
      trace.debug({ event: "controller.start", controller: "C", method: "m" });
      trace.info({ event: "http.request.completed" });
      trace.warn({ event: "http.request.failed" });
    });

    const payloads = [
      ...logger.debug.mock.calls.map((call) => call[0]),
      ...logger.info.mock.calls.map((call) => call[0]),
      ...logger.warn.mock.calls.map((call) => call[0]),
    ];

    for (const payload of payloads) {
      for (const key of ["req", "headers", "body", "query", "params", "cookie", "authorization"]) {
        expect(payload).not.toHaveProperty(key);
      }
    }
  });
});

describe("database execution events", () => {
  it("emits DEBUG for normal queries and WARN for slow queries independently", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const config = {
      getOrThrow: (key: string) => {
        if (key === "app.slowQueryMs") return 100;
        if (key === "app.dbQueryLogEnabled") return true;

        return true;
      },
    };
    const trace = new ExecutionTraceService(config as never, logger as never);

    trace.recordDatabaseQuery({ statementType: "SELECT", durationMs: 99 });
    trace.recordDatabaseQuery({ statementType: "INSERT", durationMs: 101 });

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "db.query.completed", durationMs: 99 }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "db.query.slow", durationMs: 101, thresholdMs: 100 }),
    );
  });
});
