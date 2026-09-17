import { describe, expect, it, vi } from "vitest";
import { CsrfOriginMiddleware } from "@/common/middleware/csrf-origin.middleware.js";

const createMiddleware = (origins: string[]) => {
  const config = { get: (key: string) => (key === "app.corsOrigins" ? origins : undefined) };

  return new CsrfOriginMiddleware(config as never);
};

const run = (
  middleware: CsrfOriginMiddleware,
  options: { method?: string; origin?: string; cookie?: string },
): void => {
  const req = {
    method: options.method ?? "POST",
    headers: {
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
  } as never;

  middleware.use(req, {} as never, vi.fn());
};

describe("CsrfOriginMiddleware", () => {
  const origins = ["http://localhost:3000"];

  it("accepts safe methods without an Origin", () => {
    const middleware = createMiddleware(origins);

    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(() => run(middleware, { method })).not.toThrow();
    }
  });

  it("accepts an allowed Origin on authenticated mutations", () => {
    const middleware = createMiddleware(origins);

    expect(() =>
      run(middleware, {
        method: "POST",
        origin: "http://localhost:3000",
        cookie: "paylens_at=abc; paylens_rt=def",
      }),
    ).not.toThrow();
  });

  it("rejects a foreign Origin on authenticated mutations", () => {
    const middleware = createMiddleware(origins);

    expect(() =>
      run(middleware, {
        method: "POST",
        origin: "https://evil.example",
        cookie: "paylens_at=abc",
      }),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });

  it("rejects a foreign Origin on public login mutations", () => {
    const middleware = createMiddleware(origins);

    expect(() => run(middleware, { method: "POST", origin: "https://evil.example" })).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("rejects cookie-authenticated unsafe requests without an Origin", () => {
    const middleware = createMiddleware(origins);

    expect(() => run(middleware, { method: "POST", cookie: "paylens_at=abc" })).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("rejects refresh-cookie authenticated unsafe requests without an Origin", () => {
    const middleware = createMiddleware(origins);

    expect(() => run(middleware, { method: "POST", cookie: "paylens_rt=refresh-token" })).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("does not classify unrelated cookies as PayLens authentication", () => {
    const middleware = createMiddleware(origins);

    expect(() =>
      run(middleware, { method: "POST", cookie: "theme=dark; analytics_id=abc" }),
    ).not.toThrow();
  });

  it("lets cookieless server and test clients through without an Origin", () => {
    const middleware = createMiddleware(origins);

    expect(() => run(middleware, { method: "POST" })).not.toThrow();
  });
});
