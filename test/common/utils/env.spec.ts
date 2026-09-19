import { describe, expect, it } from "vitest";
import {
  parseBooleanEnv,
  parseBooleanEnvStrict,
  parseOptionalStringEnv,
  parseNumberEnv,
  parseIntegerInRange,
} from "@/common/utils/env.js";

describe("parseBooleanEnv", () => {
  it("parses 'true' as true", () => {
    expect(parseBooleanEnv("true", false)).toBe(true);
  });

  it("parses 'TRUE' case-insensitively", () => {
    expect(parseBooleanEnv("TRUE", false)).toBe(true);
  });

  it("parses 'True' case-insensitively", () => {
    expect(parseBooleanEnv("True", false)).toBe(true);
  });

  it("parses 'false' as false", () => {
    expect(parseBooleanEnv("false", true)).toBe(false);
  });

  it("parses 'FALSE' case-insensitively", () => {
    expect(parseBooleanEnv("FALSE", true)).toBe(false);
  });

  it("returns fallback for undefined", () => {
    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv(undefined, false)).toBe(false);
  });

  it("returns fallback for empty string", () => {
    expect(parseBooleanEnv("", true)).toBe(true);
  });

  it("returns fallback for unrecognized values", () => {
    expect(parseBooleanEnv("1", false)).toBe(false);
    expect(parseBooleanEnv("0", true)).toBe(true);
    expect(parseBooleanEnv("yes", false)).toBe(false);
  });

  it("trims whitespace", () => {
    expect(parseBooleanEnv("  true  ", false)).toBe(true);
    expect(parseBooleanEnv("  false  ", true)).toBe(false);
  });
});

describe("parseBooleanEnvStrict", () => {
  it("parses 'true' as true", () => {
    expect(parseBooleanEnvStrict("true", false, "TEST")).toBe(true);
  });

  it("parses 'false' as false", () => {
    expect(parseBooleanEnvStrict("false", true, "TEST")).toBe(false);
  });

  it("returns default for undefined", () => {
    expect(parseBooleanEnvStrict(undefined, true, "TEST")).toBe(true);
  });

  it("throws on unrecognized values", () => {
    expect(() => parseBooleanEnvStrict("1", false, "MY_FLAG")).toThrow(
      'MY_FLAG must be "true" or "false"',
    );
    expect(() => parseBooleanEnvStrict("yes", false, "MY_FLAG")).toThrow(
      'MY_FLAG must be "true" or "false"',
    );
  });
});

describe("parseOptionalStringEnv", () => {
  it("returns trimmed string for valid input", () => {
    expect(parseOptionalStringEnv("hello")).toBe("hello");
  });

  it("trims whitespace", () => {
    expect(parseOptionalStringEnv("  hello  ")).toBe("hello");
  });

  it("returns undefined for undefined", () => {
    expect(parseOptionalStringEnv(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseOptionalStringEnv("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(parseOptionalStringEnv("   ")).toBeUndefined();
  });
});

describe("parseNumberEnv", () => {
  it("parses valid number", () => {
    expect(parseNumberEnv("42", { fallback: 0 })).toBe(42);
  });

  it("parses 0 as valid", () => {
    expect(parseNumberEnv("0", { fallback: 1 })).toBe(0);
  });

  it("parses negative when no min", () => {
    expect(parseNumberEnv("-5", { fallback: 0 })).toBe(-5);
  });

  it("returns fallback for undefined", () => {
    expect(parseNumberEnv(undefined, { fallback: 7 })).toBe(7);
  });

  it("returns fallback for empty string", () => {
    expect(parseNumberEnv("", { fallback: 7 })).toBe(7);
  });

  it("returns fallback for NaN when no name", () => {
    expect(parseNumberEnv("abc", { fallback: 3 })).toBe(3);
  });

  it("throws for NaN when name provided", () => {
    expect(() => parseNumberEnv("abc", { fallback: 3, name: "PORT" })).toThrow(
      "PORT must be a finite number",
    );
  });

  it("throws for below minimum when name provided", () => {
    expect(() => parseNumberEnv("5", { fallback: 0, min: 10, name: "X" })).toThrow(
      "X must be >= 10",
    );
  });

  it("throws for above maximum when name provided", () => {
    expect(() => parseNumberEnv("100", { fallback: 0, max: 50, name: "X" })).toThrow(
      "X must be <= 50",
    );
  });

  it("returns fallback for below minimum when no name", () => {
    expect(parseNumberEnv("5", { fallback: 0, min: 10 })).toBe(0);
  });

  it("returns fallback for above maximum when no name", () => {
    expect(parseNumberEnv("100", { fallback: 0, max: 50 })).toBe(0);
  });

  it("accepts value at exact min", () => {
    expect(parseNumberEnv("10", { fallback: 0, min: 10 })).toBe(10);
  });

  it("accepts value at exact max", () => {
    expect(parseNumberEnv("50", { fallback: 0, max: 50 })).toBe(50);
  });
});

describe("parseIntegerInRange", () => {
  it("parses valid integer", () => {
    expect(parseIntegerInRange("42", 0, "PORT", 1, 65535)).toBe(42);
  });

  it("uses default when value is undefined", () => {
    expect(parseIntegerInRange(undefined, 4000, "PORT", 1, 65535)).toBe(4000);
  });

  it("throws for non-integer", () => {
    expect(() => parseIntegerInRange("3.5", 0, "PORT", 1, 65535)).toThrow(
      "PORT must be an integer",
    );
  });

  it("throws for below minimum", () => {
    expect(() => parseIntegerInRange("0", 4000, "PORT", 1, 65535)).toThrow(
      "PORT must be an integer between",
    );
  });

  it("throws for above maximum", () => {
    expect(() => parseIntegerInRange("70000", 4000, "PORT", 1, 65535)).toThrow(
      "PORT must be an integer between",
    );
  });
});
