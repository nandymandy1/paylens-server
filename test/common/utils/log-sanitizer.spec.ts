import { describe, expect, it } from "vitest";
import {
  REDACTED_LOG_VALUE,
  safeRequestMetadata,
  sanitizeForLog,
} from "@/common/utils/log-sanitizer.js";

describe("sanitizeForLog", () => {
  it("recursively masks canonical sensitive names while preserving safe diagnostic values", () => {
    expect(
      sanitizeForLog({
        password: "secret",
        refreshToken: "refresh",
        countryCode: "IN",
        nested: [{ Authorization: "Bearer token" }],
      }),
    ).toEqual({
      password: REDACTED_LOG_VALUE,
      refreshToken: REDACTED_LOG_VALUE,
      countryCode: "IN",
      nested: [{ Authorization: REDACTED_LOG_VALUE }],
    });
  });

  it("keeps safe filters, masks token query values, and replaces free-text search", () => {
    expect(
      safeRequestMetadata({
        params: { employeeId: "emp_123" },
        query: { countryCode: "IN", sort: "lastName", token: "secret", search: "Ada Lovelace" },
      }),
    ).toEqual({
      params: { employeeId: "emp_123" },
      query: {
        countryCode: "IN",
        sort: "lastName",
        token: REDACTED_LOG_VALUE,
        searchPresent: true,
        searchLength: 12,
      },
    });
  });

  it("keeps generic business codes while masking context-specific secret codes", () => {
    expect(
      sanitizeForLog({
        department: { code: "ENG" },
        oauthCode: "private",
        verificationCode: "private",
      }),
    ).toEqual({
      department: { code: "ENG" },
      oauthCode: REDACTED_LOG_VALUE,
      verificationCode: REDACTED_LOG_VALUE,
    });
  });
});
