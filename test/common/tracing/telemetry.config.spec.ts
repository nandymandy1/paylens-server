import { describe, expect, it } from "vitest";
import { parseTelemetryConfig } from "@/common/tracing/telemetry.config.js";

describe("parseTelemetryConfig", () => {
  it("returns defaults when env is empty", () => {
    const config = parseTelemetryConfig({});

    expect(config.enabled).toBe(true);
    expect(config.logsEnabled).toBe(true);
    expect(config.metricsEnabled).toBe(true);
    expect(config.serviceName).toBe("paylens-server");
    expect(config.endpoint).toBeUndefined();
    expect(config.protocol).toBe("http/protobuf");
    expect(config.traceSampleRatio).toBe(1);
  });

  describe("OTEL_ENABLED parsing", () => {
    it("parses 'true' as true", () => {
      expect(parseTelemetryConfig({ OTEL_ENABLED: "true" }).enabled).toBe(true);
    });

    it("parses 'false' as false", () => {
      expect(parseTelemetryConfig({ OTEL_ENABLED: "false" }).enabled).toBe(false);
    });

    it("rejects 'FALSE' as invalid (strict is case-sensitive)", () => {
      expect(() => parseTelemetryConfig({ OTEL_ENABLED: "FALSE" })).toThrow("OTEL_ENABLED");
    });

    it("rejects '1' as invalid boolean", () => {
      expect(() => parseTelemetryConfig({ OTEL_ENABLED: "1" })).toThrow("OTEL_ENABLED");
    });

    it("rejects '0' as invalid boolean", () => {
      expect(() => parseTelemetryConfig({ OTEL_ENABLED: "0" })).toThrow("OTEL_ENABLED");
    });

    it("rejects garbage as invalid boolean", () => {
      expect(() => parseTelemetryConfig({ OTEL_ENABLED: "banana" })).toThrow("OTEL_ENABLED");
    });

    it("treats empty string as unset (returns default)", () => {
      expect(parseTelemetryConfig({ OTEL_ENABLED: "" }).enabled).toBe(true);
    });
  });

  describe("OTEL_TRACE_SAMPLE_RATIO parsing", () => {
    it("accepts 0 as valid", () => {
      expect(parseTelemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: "0" }).traceSampleRatio).toBe(0);
    });

    it("accepts 0.1", () => {
      expect(parseTelemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: "0.1" }).traceSampleRatio).toBe(0.1);
    });

    it("accepts 1", () => {
      expect(parseTelemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: "1" }).traceSampleRatio).toBe(1);
    });

    it("rejects -0.1 and throws", () => {
      expect(() => parseTelemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: "-0.1" })).toThrow(
        "OTEL_TRACE_SAMPLE_RATIO",
      );
    });

    it("rejects 1.1 and throws", () => {
      expect(() => parseTelemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: "1.1" })).toThrow(
        "OTEL_TRACE_SAMPLE_RATIO",
      );
    });

    it("rejects 'abc' and throws", () => {
      expect(() => parseTelemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: "abc" })).toThrow(
        "OTEL_TRACE_SAMPLE_RATIO",
      );
    });

    it("rejects NaN and throws", () => {
      expect(() => parseTelemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: "NaN" })).toThrow(
        "OTEL_TRACE_SAMPLE_RATIO",
      );
    });

    it("rejects Infinity and throws", () => {
      expect(() => parseTelemetryConfig({ OTEL_TRACE_SAMPLE_RATIO: "Infinity" })).toThrow(
        "OTEL_TRACE_SAMPLE_RATIO",
      );
    });
  });

  describe("OTEL_LOGS_ENABLED parsing", () => {
    it("parses 'false' correctly", () => {
      expect(parseTelemetryConfig({ OTEL_LOGS_ENABLED: "false" }).logsEnabled).toBe(false);
    });

    it("defaults to true when unset", () => {
      expect(parseTelemetryConfig({}).logsEnabled).toBe(true);
    });
  });

  describe("OTEL_METRICS_ENABLED parsing", () => {
    it("parses 'false' correctly", () => {
      expect(parseTelemetryConfig({ OTEL_METRICS_ENABLED: "false" }).metricsEnabled).toBe(false);
    });

    it("defaults to true when OTEL_ENABLED is true", () => {
      expect(parseTelemetryConfig({ OTEL_ENABLED: "true" }).metricsEnabled).toBe(true);
    });

    it("defaults to false when OTEL_ENABLED is false", () => {
      expect(parseTelemetryConfig({ OTEL_ENABLED: "false" }).metricsEnabled).toBe(false);
    });
  });

  describe("endpoint parsing", () => {
    it("trims whitespace", () => {
      const config = parseTelemetryConfig({
        OTEL_EXPORTER_OTLP_ENDPOINT: "  http://localhost:4318  ",
      });

      expect(config.endpoint).toBe("http://localhost:4318");
    });

    it("returns undefined for empty string", () => {
      expect(parseTelemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }).endpoint).toBeUndefined();
    });
  });

  describe("serviceName parsing", () => {
    it("trims whitespace", () => {
      expect(parseTelemetryConfig({ OTEL_SERVICE_NAME: "  my-service  " }).serviceName).toBe(
        "my-service",
      );
    });

    it("defaults to paylens-server", () => {
      expect(parseTelemetryConfig({}).serviceName).toBe("paylens-server");
    });
  });

  describe("OTEL_EXPORTER_OTLP_PROTOCOL validation", () => {
    it("accepts http/protobuf", () => {
      expect(parseTelemetryConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" }).protocol).toBe(
        "http/protobuf",
      );
    });

    it("defaults to http/protobuf when undefined", () => {
      expect(parseTelemetryConfig({}).protocol).toBe("http/protobuf");
    });

    it("defaults to http/protobuf when empty", () => {
      expect(parseTelemetryConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: "" }).protocol).toBe(
        "http/protobuf",
      );
    });

    it("rejects grpc", () => {
      expect(() => parseTelemetryConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })).toThrow(
        "not supported",
      );
    });

    it("rejects http/json", () => {
      expect(() => parseTelemetryConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: "http/json" })).toThrow(
        "not supported",
      );
    });

    it("rejects garbage", () => {
      expect(() => parseTelemetryConfig({ OTEL_EXPORTER_OTLP_PROTOCOL: "foobar" })).toThrow(
        "not supported",
      );
    });
  });
});
