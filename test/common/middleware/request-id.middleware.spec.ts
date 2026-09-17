import { describe, expect, it, vi } from "vitest";
import { RequestContextMiddleware } from "@/common/middleware/request-id.middleware.js";

describe("requestIdMiddleware", () => {
  it("accepts a safe incoming request id", () => {
    const request = { header: () => "req_safe" };
    const response = { on: vi.fn(), setHeader: vi.fn(), statusCode: 200 };
    const next = vi.fn();

    new RequestContextMiddleware({
      now: () => 0,
      debug: () => undefined,
      durationSince: () => 0,
      info: () => undefined,
      warn: () => undefined,
    } as never).use(request as never, response as never, next);
    expect(response.setHeader).toHaveBeenCalledWith("x-request-id", "req_safe");
  });
});
