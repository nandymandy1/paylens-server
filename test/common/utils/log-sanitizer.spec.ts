import { describe, expect, it } from "vitest";
import {
  REDACTED_LOG_VALUE,
  safeRequestMetadata,
  sanitizeForLog,
  sanitizeUrlString,
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

  it("redacts sensitive query params inside URL strings", () => {
    const result = sanitizeForLog({
      redirect_to: "/invite/accept?token=SUPER_SECRET_INVITE_TOKEN_789",
    });

    expect(result).toEqual({
      redirect_to: "/invite/accept?token=***",
    });
  });

  it("preserves safe URL query params", () => {
    const result = sanitizeForLog({
      url: "/dashboard?tab=employees&sort=name",
    });

    expect(result).toEqual({
      url: "/dashboard?tab=employees&sort=name",
    });
  });

  it("redacts multiple sensitive params in a URL", () => {
    const result = sanitizeForLog({
      callback: "/auth?code=SUPER_SECRET_OAUTH_CODE_123&state=SUPER_SECRET_OAUTH_STATE_456",
    });

    expect(result).toEqual({
      callback: "/auth?code=***&state=***",
    });
  });

  it("redacts nested redirect_to URLs with tokens", () => {
    const result = sanitizeForLog({
      redirect_to: "/login?redirect_to=/invite/accept?token=SUPER_SECRET_RESET_TOKEN_999",
    });

    expect(result).toEqual({
      redirect_to: "/login?redirect_to=/invite/accept?token=***",
    });
  });

  it("does not crash on malformed URL strings", () => {
    const result = sanitizeForLog({
      note: "just a plain string with no URL",
    });

    expect(result).toEqual({
      note: "just a plain string with no URL",
    });
  });

  it("preserves legitimate business codes while redacting secrets in URLs", () => {
    const result = sanitizeForLog({
      departmentCode: "PAYGRADE_L4",
      redirect_to: "/invite/accept?token=SUPER_SECRET_INVITE_TOKEN_789",
    });

    expect(result).toEqual({
      departmentCode: "PAYGRADE_L4",
      redirect_to: "/invite/accept?token=***",
    });
  });
});

describe("sanitizeUrlString", () => {
  it("redacts token param in relative URL", () => {
    expect(sanitizeUrlString("/invite/accept?token=abc123")).toBe("/invite/accept?token=***");
  });

  it("redacts multiple sensitive params", () => {
    expect(sanitizeUrlString("/auth?code=X&state=Y")).toBe("/auth?code=***&state=***");
  });

  it("preserves safe params", () => {
    expect(sanitizeUrlString("/dashboard?tab=employees")).toBe("/dashboard?tab=employees");
  });

  it("redacts in absolute URLs", () => {
    expect(sanitizeUrlString("https://app.example/callback?code=secret&state=abc")).toBe(
      "https://app.example/callback?code=***&state=***",
    );
  });

  it("returns original string for malformed URLs", () => {
    expect(sanitizeUrlString("not a url at all")).toBe("not a url at all");
  });

  it("handles URL with no query params", () => {
    expect(sanitizeUrlString("/invite/accept")).toBe("/invite/accept");
  });

  it("redacts access_token, refresh_token, id_token", () => {
    expect(sanitizeUrlString("/cb?access_token=at&refresh_token=rt&id_token=id")).toBe(
      "/cb?access_token=***&refresh_token=***&id_token=***",
    );
  });

  it("redacts password, client_secret, authorization", () => {
    expect(sanitizeUrlString("/auth?password=pw&client_secret=cs&authorization=bearer")).toBe(
      "/auth?password=***&client_secret=***&authorization=***",
    );
  });
});
