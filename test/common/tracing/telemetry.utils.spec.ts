import { describe, expect, it } from "vitest";
import {
  isValidTraceId,
  isValidSpanId,
  buildOtlpSignalUrl,
} from "@/common/tracing/telemetry.utils.js";

describe("isValidTraceId", () => {
  it("accepts valid 32-char hex trace ID", () => {
    expect(isValidTraceId("abc123def456abc123def456abc123de")).toBe(true);
  });

  it("accepts uppercase hex", () => {
    expect(isValidTraceId("ABC123DEF456ABC123DEF456ABC123DE")).toBe(true);
  });

  it("rejects all-zero trace ID", () => {
    expect(isValidTraceId("00000000000000000000000000000000")).toBe(false);
  });

  it("rejects too-short ID", () => {
    expect(isValidTraceId("abc123def456")).toBe(false);
  });

  it("rejects too-long ID", () => {
    expect(isValidTraceId("abc123def456abc123def456abc123de00")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidTraceId("xyz123def456abc123def456abc123de")).toBe(false);
  });
});

describe("isValidSpanId", () => {
  it("accepts valid 16-char hex span ID", () => {
    expect(isValidSpanId("abcdef1234567890")).toBe(true);
  });

  it("accepts uppercase hex", () => {
    expect(isValidSpanId("ABCDEF1234567890")).toBe(true);
  });

  it("rejects all-zero span ID", () => {
    expect(isValidSpanId("0000000000000000")).toBe(false);
  });

  it("rejects too-short ID (12 chars)", () => {
    expect(isValidSpanId("abc123def456")).toBe(false);
  });

  it("rejects too-long ID", () => {
    expect(isValidSpanId("abcdef123456789000")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidSpanId("xyz123def4567890")).toBe(false);
  });
});

describe("buildOtlpSignalUrl", () => {
  it("builds traces URL", () => {
    expect(buildOtlpSignalUrl("http://localhost:4318", "traces")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("builds logs URL", () => {
    expect(buildOtlpSignalUrl("http://localhost:4318", "logs")).toBe(
      "http://localhost:4318/v1/logs",
    );
  });

  it("builds metrics URL", () => {
    expect(buildOtlpSignalUrl("http://localhost:4318", "metrics")).toBe(
      "http://localhost:4318/v1/metrics",
    );
  });

  it("handles trailing slash", () => {
    expect(buildOtlpSignalUrl("http://localhost:4318/", "traces")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("never produces double /v1/", () => {
    expect(buildOtlpSignalUrl("http://localhost:4318/v1", "traces")).not.toContain("/v1/v1/");
  });

  it("never produces //v1/", () => {
    expect(buildOtlpSignalUrl("http://localhost:4318", "traces")).not.toContain("//v1/");
  });
});
