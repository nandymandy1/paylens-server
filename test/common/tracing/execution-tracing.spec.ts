import { lastValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { requestContext } from "@/common/context/request-context.js";
import { ControllerTraceInterceptor } from "@/common/tracing/controller-trace.interceptor.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { TraceMethod } from "@/common/tracing/trace-method.decorator.js";

function createTraceService() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const config = { getOrThrow: () => true };
  const trace = new ExecutionTraceService(config as never, logger as never);

  return { logger, trace };
}

describe("execution tracing", () => {
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
        event: "controller.start",
        controller: "HealthController",
        method: "health",
        requestId: "controller-request",
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "controller.complete",
        durationMs: expect.any(Number),
        requestId: "controller-request",
      }),
    );
  });

  it("traces a decorated service method without logging arguments or results", async () => {
    const { logger, trace } = createTraceService();

    class ExampleService {
      constructor(readonly executionTrace: ExecutionTraceService) {}

      @TraceMethod()
      async execute(secret: string) {
        return { secret };
      }
    }

    const service = new ExampleService(trace);

    await requestContext.run({ requestId: "service-request" }, () => service.execute("private"));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service.start",
        service: "ExampleService",
        method: "execute",
        requestId: "service-request",
      }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service.complete",
        durationMs: expect.any(Number),
        requestId: "service-request",
      }),
    );
    expect(logger.debug.mock.calls.flat().join(" ")).not.toContain("private");
  });

  it("records service errors with timing and correlation but no stack payload", async () => {
    const { logger, trace } = createTraceService();

    class FailingService {
      constructor(readonly executionTrace: ExecutionTraceService) {}

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

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "service.error",
        requestId: "failure-request",
        durationMs: expect.any(Number),
        error: { name: "Error" },
      }),
    );
  });
});
