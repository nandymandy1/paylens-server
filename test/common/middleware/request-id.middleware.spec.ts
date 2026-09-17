import { describe, expect, it, vi } from "vitest";
import { setAuthUserId } from "@/common/context/request-context.js";
import { RequestContextMiddleware } from "@/common/middleware/request-id.middleware.js";

const FORBIDDEN_LOG_KEYS = [
  "req",
  "headers",
  "body",
  "query",
  "params",
  "cookies",
  "cookie",
  "authorization",
  "remotePort",
  "password",
  "accessToken",
  "refreshToken",
];

function runMiddleware(options?: {
  statusCode?: number;
  headerId?: string | null;
  errorCode?: string;
  authenticateAs?: string;
  finishInNext?: boolean;
}) {
  const statusCode = options?.statusCode ?? 200;
  const trace = {
    now: vi.fn(() => 100),
    debug: vi.fn(),
    durationSince: vi.fn(() => 4.74),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  let finish: () => void = () => undefined;
  const request = {
    header: vi.fn(() => options?.headerId ?? null),
    method: "GET",
    path: "/health",
    errorCode: options?.errorCode,
  };
  const response = {
    on: vi.fn((event: string, callback: () => void) => {
      if (event === "finish") {
        finish = callback;
      }
    }),
    setHeader: vi.fn(),
    statusCode,
  };
  // next() runs inside the middleware's request scope, exactly like the real
  // router pipeline, so auth resolved here is visible to the finish handler.
  // Passing finish through next() mirrors production, where response finish
  // fires downstream of the same async chain.
  const next = vi.fn(() => {
    if (options?.authenticateAs) {
      setAuthUserId(options.authenticateAs);
    }

    if (options?.finishInNext) {
      finish();
    }
  });

  new RequestContextMiddleware(trace as never).use(request as never, response as never, next);

  return { finish, request, response, trace };
}

describe("requestIdMiddleware", () => {
  it("accepts a safe incoming request id", () => {
    const { response } = runMiddleware({ headerId: "req_safe" });

    expect(response.setHeader).toHaveBeenCalledWith("x-request-id", "req_safe");
  });

  it("generates a request id for unsafe incoming values", () => {
    const { response } = runMiddleware({ headerId: "evil id!" });
    const [, generated] = response.setHeader.mock.calls[0] as [string, string];

    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs an allowlisted completion payload with the received request id", () => {
    const { finish, trace } = runMiddleware({ headerId: "req-123" });

    finish();

    // The mocked trace service forwards payloads untouched; the real service
    // attaches the ambient requestId (covered in execution-tracing specs).
    expect(trace.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "http.request.received", method: "GET", path: "/health" }),
    );
    expect(trace.info).toHaveBeenCalledWith({
      event: "http.request.completed",
      requestId: "req-123",
      method: "GET",
      path: "/health",
      statusCode: 200,
      durationMs: 4.74,
    });
  });

  it("never logs raw request material or empty placeholders", () => {
    const { finish, trace } = runMiddleware();

    finish();

    for (const call of [...trace.debug.mock.calls, ...trace.info.mock.calls]) {
      const payload = call[0] as Record<string, unknown>;

      for (const key of FORBIDDEN_LOG_KEYS) {
        expect(payload).not.toHaveProperty(key);
      }

      expect(payload).not.toHaveProperty("authUserId");
    }

    const durationMs = trace.info.mock.calls[0][0].durationMs as number;

    expect(Number.isFinite(durationMs)).toBe(true);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it("inherits the authenticated user id resolved after the middleware ran", () => {
    const { trace } = runMiddleware({ authenticateAs: "usr_789", finishInNext: true });

    expect(trace.info).toHaveBeenCalledWith(expect.objectContaining({ authUserId: "usr_789" }));
  });

  it("maps failures to warn/error levels with the machine-readable code", () => {
    const notFound = runMiddleware({ statusCode: 404, errorCode: "NOT_FOUND" });

    notFound.finish();

    expect(notFound.trace.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "http.request.failed",
        statusCode: 404,
        code: "NOT_FOUND",
      }),
    );
    expect(notFound.trace.info).not.toHaveBeenCalled();

    const serverError = runMiddleware({ statusCode: 500, errorCode: "INTERNAL_SERVER_ERROR" });

    serverError.finish();

    expect(serverError.trace.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "http.request.failed",
        statusCode: 500,
        code: "INTERNAL_SERVER_ERROR",
      }),
    );
  });
});
