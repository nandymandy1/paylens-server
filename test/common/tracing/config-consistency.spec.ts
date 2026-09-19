import { describe, expect, it } from "vitest";
import { parseTelemetryConfig } from "@/common/tracing/telemetry.config.js";
import { validateEnvironment } from "@/config/env.validation.js";

const validBase = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/paylens",
  REDIS_URL: "redis://localhost:6379",
  CORS_ORIGINS: "http://localhost:3000",
};

describe("config consistency — telemetry single source of truth", () => {
  it("OTEL_ENABLED=false produces same value in parseTelemetryConfig and validateEnvironment", () => {
    const env = { ...validBase, OTEL_ENABLED: "false" };
    const parsed = parseTelemetryConfig(env);
    const validated = validateEnvironment(env);

    expect(parsed.enabled).toBe(false);
    expect(validated.OTEL_ENABLED).toBe(false);
    expect(parsed.enabled).toBe(validated.OTEL_ENABLED);
  });

  it("OTEL_TRACE_SAMPLE_RATIO=0 is preserved in both paths", () => {
    const env = { ...validBase, OTEL_TRACE_SAMPLE_RATIO: "0" };
    const parsed = parseTelemetryConfig(env);
    const validated = validateEnvironment(env);

    expect(parsed.traceSampleRatio).toBe(0);
    expect(validated.OTEL_TRACE_SAMPLE_RATIO).toBe(0);
    expect(parsed.traceSampleRatio).toBe(validated.OTEL_TRACE_SAMPLE_RATIO);
  });

  it("OTEL_ENABLED=true produces consistent true", () => {
    const env = { ...validBase, OTEL_ENABLED: "true" };
    const parsed = parseTelemetryConfig(env);
    const validated = validateEnvironment(env);

    expect(parsed.enabled).toBe(true);
    expect(validated.OTEL_ENABLED).toBe(true);
  });

  it("OTEL_LOGS_ENABLED=false is consistent", () => {
    const env = { ...validBase, OTEL_LOGS_ENABLED: "false" };
    const parsed = parseTelemetryConfig(env);
    const validated = validateEnvironment(env);

    expect(parsed.logsEnabled).toBe(false);
    expect(validated.OTEL_LOGS_ENABLED).toBe(false);
  });

  it("OTEL_METRICS_ENABLED=false is consistent", () => {
    const env = { ...validBase, OTEL_METRICS_ENABLED: "false" };
    const parsed = parseTelemetryConfig(env);
    const validated = validateEnvironment(env);

    expect(parsed.metricsEnabled).toBe(false);
    expect(validated.OTEL_METRICS_ENABLED).toBe(false);
  });

  it("OTEL_TRACE_SAMPLE_RATIO=0.5 is consistent", () => {
    const env = { ...validBase, OTEL_TRACE_SAMPLE_RATIO: "0.5" };
    const parsed = parseTelemetryConfig(env);
    const validated = validateEnvironment(env);

    expect(parsed.traceSampleRatio).toBe(0.5);
    expect(validated.OTEL_TRACE_SAMPLE_RATIO).toBe(0.5);
  });

  it("OTEL_EXPORTER_OTLP_PROTOCOL validation consistent", () => {
    const env = { ...validBase, OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" };
    const parsed = parseTelemetryConfig(env);
    const validated = validateEnvironment(env);

    expect(parsed.protocol).toBe("http/protobuf");
    // validateEnvironment should not throw for valid protocol
    expect(validated.OTEL_ENABLED).toBeDefined();
  });

  it("OTEL_EXPORTER_OTLP_PROTOCOL=grpc rejected by parseTelemetryConfig", () => {
    const env = { ...validBase, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" };

    expect(() => parseTelemetryConfig(env)).toThrow("not supported");
  });
});
