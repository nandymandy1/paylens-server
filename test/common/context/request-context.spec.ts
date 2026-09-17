import { describe, expect, it } from "vitest";
import { requestContext, setAuthUserId } from "@/common/context/request-context.js";

describe("request context", () => {
  it("leaves authUserId unset for anonymous requests", () => {
    requestContext.run({ requestId: "anonymous-request" }, () => {
      expect(requestContext.getStore()).not.toHaveProperty("authUserId");
    });
  });

  it("stores the authenticated user id without touching the request id", () => {
    requestContext.run({ requestId: "authenticated-request" }, () => {
      setAuthUserId("usr_123");

      expect(requestContext.getStore()).toMatchObject({
        requestId: "authenticated-request",
        authUserId: "usr_123",
      });
    });
  });

  it("ignores auth updates outside a request scope instead of throwing", () => {
    expect(() => setAuthUserId("usr_123")).not.toThrow();
    expect(requestContext.getStore()).toBeUndefined();
  });
});
