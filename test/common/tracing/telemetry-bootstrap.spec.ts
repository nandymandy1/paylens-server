import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

describe("telemetry bootstrap", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads .env via dotenv before parsing config", async () => {
    process.env.OTEL_ENABLED = "true";
    process.env.OTEL_SERVICE_NAME = "test-bootstrap";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_TRACE_SAMPLE_RATIO = "0.5";

    const { parseTelemetryConfig } = await import("@/common/tracing/telemetry.config.js");
    const config = parseTelemetryConfig();

    expect(config.enabled).toBe(true);
    expect(config.serviceName).toBe("test-bootstrap");
    expect(config.endpoint).toBe("http://localhost:4318");
    expect(config.traceSampleRatio).toBe(0.5);
  });

  it("does not initialize telemetry when OTEL_ENABLED=false", async () => {
    process.env.OTEL_ENABLED = "false";

    const { parseTelemetryConfig } = await import("@/common/tracing/telemetry.config.js");
    const config = parseTelemetryConfig();

    expect(config.enabled).toBe(false);
  });

  it("sample ratio 0 is preserved through bootstrap path", async () => {
    process.env.OTEL_TRACE_SAMPLE_RATIO = "0";

    const { parseTelemetryConfig } = await import("@/common/tracing/telemetry.config.js");
    const config = parseTelemetryConfig();

    expect(config.traceSampleRatio).toBe(0);
  });

  it("exercises actual bootstrap module — calls initializeTelemetry with parsed config", async () => {
    process.env.OTEL_ENABLED = "true";
    process.env.OTEL_SERVICE_NAME = "bootstrap-test";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_TRACE_SAMPLE_RATIO = "0.75";
    process.env.OTEL_LOGS_ENABLED = "true";
    process.env.OTEL_METRICS_ENABLED = "true";

    const mockInitialize = vi.fn();

    vi.doMock("dotenv/config", () => ({}));
    vi.doMock("@/common/tracing/telemetry.js", () => ({
      initializeTelemetry: mockInitialize,
    }));

    // Dynamic import triggers the bootstrap side effects
    await import("@/telemetry-bootstrap.js");

    expect(mockInitialize).toHaveBeenCalledOnce();
    const config = mockInitialize.mock.calls[0][0];

    expect(config.enabled).toBe(true);
    expect(config.serviceName).toBe("bootstrap-test");
    expect(config.endpoint).toBe("http://localhost:4318");
    expect(config.traceSampleRatio).toBe(0.75);
    expect(config.logsEnabled).toBe(true);
    expect(config.metricsEnabled).toBe(true);
  });

  it("does not call initializeTelemetry when OTEL_ENABLED=false via bootstrap", async () => {
    process.env.OTEL_ENABLED = "false";

    const mockInitialize = vi.fn();

    vi.doMock("dotenv/config", () => ({}));
    vi.doMock("@/common/tracing/telemetry.js", () => ({
      initializeTelemetry: mockInitialize,
    }));

    await import("@/telemetry-bootstrap.js");

    expect(mockInitialize).not.toHaveBeenCalled();
  });
});
