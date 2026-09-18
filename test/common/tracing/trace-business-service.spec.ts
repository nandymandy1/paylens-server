import { describe, expect, it, vi } from "vitest";
import { TraceBusinessService, TraceMethod } from "@/common/tracing/trace-method.decorator.js";

const createMockTrace = () => ({
  withinSpan: vi.fn(async (_name: string, _attrs: object, fn: () => Promise<unknown>) => fn()),
  now: vi.fn(() => 100),
  durationSince: vi.fn(() => 42),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

describe("@TraceBusinessService", () => {
  it("wraps listed methods with service.started/completed events", async () => {
    const trace = createMockTrace();

    @TraceBusinessService(["run", "fetch"])
    class ExampleService {
      constructor(readonly executionTrace = trace) {}

      async run() {
        return "ok";
      }

      async fetch() {
        return "data";
      }
    }

    const service = new ExampleService();
    const result = await service.run();

    expect(result).toBe("ok");
    expect(trace.withinSpan).toHaveBeenCalledOnce();
    expect(trace.withinSpan.mock.calls[0][0]).toBe("service.ExampleService.run");
    expect(trace.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "service.started", method: "run" }),
    );
    expect(trace.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "service.completed", method: "run" }),
    );
  });

  it("catches errors and logs service.failed", async () => {
    const trace = createMockTrace();

    @TraceBusinessService(["fail"])
    class FailService {
      constructor(readonly executionTrace = trace) {}

      async fail() {
        throw new Error("boom");
      }
    }

    const service = new FailService();

    await expect(service.fail()).rejects.toThrow("boom");
    expect(trace.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "service.failed", method: "fail" }),
    );
  });

  it("does not wrap unlisted methods", async () => {
    const trace = createMockTrace();

    @TraceBusinessService(["wrapped"])
    class PartialService {
      constructor(readonly executionTrace = trace) {}

      async wrapped() {
        return "traced";
      }

      async untouched() {
        return "plain";
      }
    }

    const service = new PartialService();
    const result = await service.untouched();

    expect(result).toBe("plain");
    expect(trace.withinSpan).not.toHaveBeenCalled();
  });

  it("gracefully falls back when executionTrace is missing", async () => {
    @TraceBusinessService(["run"])
    class NoTraceService {
      executionTrace = undefined;

      async run() {
        return "fallback";
      }
    }

    const service = new NoTraceService();
    const result = await service.run();

    expect(result).toBe("fallback");
  });
});

describe("@TraceMethod", () => {
  it("wraps a single method with tracing", async () => {
    const trace = createMockTrace();

    class ManualService {
      constructor(readonly executionTrace = trace) {}

      @TraceMethod()
      async process() {
        return "processed";
      }
    }

    const service = new ManualService();
    const result = await service.process();

    expect(result).toBe("processed");
    expect(trace.withinSpan).toHaveBeenCalledOnce();
    expect(trace.withinSpan.mock.calls[0][0]).toContain("process");
  });
});
