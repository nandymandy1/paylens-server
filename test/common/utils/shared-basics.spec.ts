import { describe, expect, it } from "vitest";
import { isRecord } from "@/common/utils/object.js";
import { getErrorMetadata } from "@/common/utils/error.js";
import { normalizeEmail } from "@/common/utils/string.js";
import {
  optionalEmailTransform,
  trimOptionalTransform,
  trimTransform,
  trimUppercaseTransform,
} from "@/common/utils/transform.js";

describe("isRecord", () => {
  it("guards plain objects only", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([1])).toBe(false);
    expect(isRecord("x")).toBe(false);
  });
});

describe("getErrorMetadata", () => {
  it("extracts names without leaking payloads", () => {
    expect(getErrorMetadata(new TypeError("nope"))).toEqual({ name: "TypeError" });
    expect(getErrorMetadata("string")).toEqual({ name: "UnknownError" });
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Team@Acme.Example ")).toBe("team@acme.example");
  });
});

describe("DTO transforms", () => {
  it("trims, uppercases, and normalizes emails", () => {
    expect(trimTransform({ value: "  eng " })).toBe("eng");
    expect(trimTransform({ value: 3 })).toBe(3);
    expect(trimOptionalTransform({ value: "   " })).toBeUndefined();
    expect(trimOptionalTransform({ value: " x " })).toBe("x");
    expect(trimUppercaseTransform({ value: " eng-1 " })).toBe("ENG-1");
    expect(optionalEmailTransform({ value: " Team@Acme.Example " })).toBe("team@acme.example");
    expect(optionalEmailTransform({ value: "   " })).toBeUndefined();
  });
});
