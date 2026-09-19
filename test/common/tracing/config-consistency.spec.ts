import { describe, expect, it } from "vitest";
import { parseTelemetryConfig } from "@/common/tracing/telemetry.config.js";

describe("telemetry configuration", () => {
  it("is disabled without an endpoint and uses the fixed runtime protocol", () => {
    expect(parseTelemetryConfig({}).enabled).toBe(false);
    expect(
      parseTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }),
    ).toMatchObject({
      enabled: true,
      serviceName: "paylens-server",
      protocol: "http/protobuf",
    });
  });
});
