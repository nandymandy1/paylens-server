import { describe, expect, it } from "vitest";
import { validateEnvironment } from "@/config/env.validation.js";

const valid = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/paylens",
  REDIS_URL: "redis://localhost:6379",
  CORS_ORIGINS: "http://localhost:3000",
};

describe("validateEnvironment", () => {
  it("accepts validated runtime configuration", () => {
    expect(validateEnvironment(valid).PORT).toBe(4000);
  });

  it("accepts redis and rediss URLs and rejects malformed Redis URLs", () => {
    expect(validateEnvironment({ ...valid, REDIS_URL: "redis://localhost:6379" }).REDIS_URL).toBe(
      "redis://localhost:6379",
    );
    expect(
      validateEnvironment({ ...valid, REDIS_URL: "rediss://user:password@example.com:6380" })
        .REDIS_URL,
    ).toBe("rediss://user:password@example.com:6380");
    expect(() => validateEnvironment({ ...valid, REDIS_URL: "narendra-ka-server" })).toThrow(
      "REDIS_URL",
    );
    expect(() => validateEnvironment({ ...valid, REDIS_URL: "" })).toThrow("REDIS_URL");
  });

  it("rejects unexpected infrastructure URL schemes", () => {
    expect(() => validateEnvironment({ ...valid, DATABASE_URL: "https://example.com" })).toThrow(
      "DATABASE_URL",
    );
    expect(() => validateEnvironment({ ...valid, REDIS_URL: "ftp://example.com" })).toThrow(
      "REDIS_URL",
    );
  });

  it("rejects malformed CORS origins", () => {
    expect(() => validateEnvironment({ ...valid, CORS_ORIGINS: "narendra-ka-server" })).toThrow(
      "CORS_ORIGINS",
    );
  });
});
