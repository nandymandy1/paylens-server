import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "@/config/env.validation.js";

const base = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/paylens",
  REDIS_URL: "redis://localhost:6379",
  AUTH_ACCESS_TOKEN_SECRET: "a-32-character-development-secret!!",
};

const productionFileStorage = {
  FILE_STORAGE_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
  FILE_STORAGE_ACCESS_KEY_ID: "access-key-id",
  FILE_STORAGE_SECRET_ACCESS_KEY: "secret-access-key",
  FILE_STORAGE_BUCKET: "paylens-private",
};

describe("loadRuntimeConfig", () => {
  it("accepts the minimal development contract", () => {
    const config = loadRuntimeConfig(base);

    expect(config.FRONTEND_URL).toBe("http://localhost:3000");
    expect(config.LOG_LEVEL).toBe("debug");
    expect(config.SMTP_URL).toBe("");
  });

  it("requires the production deployment contract", () => {
    expect(() =>
      loadRuntimeConfig({
        ...base,
        NODE_ENV: "production",
        EMAIL_FROM: "PayLens <noreply@example.com>",
        SMTP_URL: "smtp://user:password@smtp.example:587",
      }),
    ).toThrow("FRONTEND_URL");
    const config = loadRuntimeConfig({
      ...base,
      NODE_ENV: "production",
      FRONTEND_URL: "https://app.paylens.example/",
      SMTP_URL: "smtp://user:password@smtp.example:587",
      EMAIL_FROM: "PayLens <noreply@paylens.example>",
      ...productionFileStorage,
    });

    expect(config.FRONTEND_URL).toBe("https://app.paylens.example");
    expect(config.SMTP_URL).toContain("smtp://");
  });

  it("rejects frontend paths and non-HTTPS production origins", () => {
    expect(() => loadRuntimeConfig({ ...base, FRONTEND_URL: "https://app.example/path" })).toThrow(
      "FRONTEND_URL",
    );
    expect(() =>
      loadRuntimeConfig({
        ...base,
        NODE_ENV: "production",
        FRONTEND_URL: "http://app.example",
        SMTP_URL: "smtp://user:password@smtp.example:587",
        EMAIL_FROM: "PayLens <noreply@example.com>",
        ...productionFileStorage,
      }),
    ).toThrow("FRONTEND_URL");
  });

  it("keeps Google all-or-nothing and validates SameSite", () => {
    expect(() => loadRuntimeConfig({ ...base, GOOGLE_CLIENT_ID: "id" })).toThrow("all-or-nothing");
    expect(() => loadRuntimeConfig({ ...base, AUTH_COOKIE_SAME_SITE: "invalid" })).toThrow(
      "AUTH_COOKIE_SAME_SITE",
    );
  });
});
