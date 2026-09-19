import { describe, expect, it } from "vitest";
import { parseTelemetryConfig } from "@/common/tracing/telemetry.config.js";

describe("parseTelemetryConfig", () => {
  it("uses the endpoint as the telemetry opt-in switch", () => {
    expect(parseTelemetryConfig({}).enabled).toBe(false);
    expect(
      parseTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" }).enabled,
    ).toBe(true);
  });
});
