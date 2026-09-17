import { describe, expect, it } from "vitest";
import {
  getSafeRedirectPath,
  hashOpaqueToken,
  normalizeEmail,
  sessionKey,
  slugifyOrganization,
  userSessionsKey,
} from "@/modules/auth/utils/auth.utils.js";

describe("auth utils", () => {
  it("normalizes email canonically", () => {
    expect(normalizeEmail("  HR@Acme.EXAMPLE ")).toBe("hr@acme.example");
  });

  it("hashes tokens deterministically without exposing the raw value", () => {
    const first = hashOpaqueToken("token-a");
    const second = hashOpaqueToken("token-a");

    expect(first).toBe(second);
    expect(first).not.toContain("token-a");
    expect(first).toHaveLength(64);
  });

  it("slugifies organization names deterministically", () => {
    expect(slugifyOrganization("Acme Industries!")).toBe("acme-industries");
    expect(slugifyOrganization("  ")).toBe("organization");
  });

  it("accepts internal redirect paths only", () => {
    expect(getSafeRedirectPath("/dashboard/members")).toBe("/dashboard/members");
    expect(getSafeRedirectPath("/dashboard?tab=members")).toBe("/dashboard?tab=members");
    expect(getSafeRedirectPath("https://evil.example")).toBe("/dashboard");
    expect(getSafeRedirectPath("//evil.example")).toBe("/dashboard");
    expect(getSafeRedirectPath("javascript:alert(1)")).toBe("/dashboard");
    expect(getSafeRedirectPath(undefined)).toBe("/dashboard");
  });

  it("centralizes Redis key formats", () => {
    expect(sessionKey("sid")).toBe("auth:session:sid");
    expect(userSessionsKey("uid")).toBe("auth:user-sessions:uid");
  });
});
