import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("telemetry bootstrap", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("initializes telemetry only when an endpoint is configured", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    const initializeTelemetry = vi.fn();

    vi.doMock("dotenv/config", () => ({}));
    vi.doMock("@/common/tracing/telemetry.js", () => ({ initializeTelemetry }));

    await import("@/telemetry-bootstrap.js");

    expect(initializeTelemetry).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("does not initialize without an endpoint", async () => {
    const initializeTelemetry = vi.fn();

    vi.doMock("dotenv/config", () => ({}));
    vi.doMock("@/common/tracing/telemetry.js", () => ({ initializeTelemetry }));

    await import("@/telemetry-bootstrap.js");

    expect(initializeTelemetry).not.toHaveBeenCalled();
  });
});
