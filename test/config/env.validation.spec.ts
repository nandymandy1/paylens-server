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

  it("supplies safe auth defaults in test while requiring a strong secret otherwise", () => {
    const parsed = validateEnvironment(valid);

    expect(parsed.AUTH_ACCESS_TTL_SECONDS).toBe(900);
    expect(parsed.AUTH_REFRESH_TTL_SECONDS).toBe(1_209_600);
    expect(parsed.AUTH_COOKIE_SAME_SITE).toBe("lax");
    expect(parsed.FRONTEND_URL).toBe("http://localhost:3000");
    expect(parsed.GOOGLE_CLIENT_ID).toBe("");

    expect(() => validateEnvironment({ ...valid, NODE_ENV: "production" })).toThrow(
      "AUTH_ACCESS_TOKEN_SECRET",
    );
    expect(() =>
      validateEnvironment({ ...valid, NODE_ENV: "production", AUTH_ACCESS_TOKEN_SECRET: "short" }),
    ).toThrow("AUTH_ACCESS_TOKEN_SECRET");
  });

  it("treats Google OIDC as an all-or-nothing group", () => {
    expect(() => validateEnvironment({ ...valid, GOOGLE_CLIENT_ID: "id" })).toThrow(
      "all-or-nothing",
    );

    const parsed = validateEnvironment({
      ...valid,
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
      GOOGLE_CALLBACK_URL: "http://localhost:4000/api/v1/auth/google/callback",
    });

    expect(parsed.GOOGLE_CLIENT_ID).toBe("id");
  });

  it("treats SMTP credentials as an all-or-nothing group", () => {
    expect(() => validateEnvironment({ ...valid, SMTP_HOST: "smtp.example" })).toThrow(
      "all-or-nothing",
    );

    const parsed = validateEnvironment({
      ...valid,
      SMTP_HOST: "smtp.example",
      SMTP_USER: "user",
      SMTP_PASSWORD: "password",
    });

    expect(parsed.SMTP_HOST).toBe("smtp.example");
  });
});
