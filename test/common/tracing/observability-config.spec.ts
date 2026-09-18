import { describe, expect, it } from "vitest";
import { validateEnvironment } from "@/config/env.validation.js";
import { buildLoggerModuleOptions } from "@/config/logger.config.js";
import {
  REDACTED_LOG_VALUE,
  safeRequestMetadata,
  sanitizeForLog,
} from "@/common/utils/log-sanitizer.js";

const validEnv = {
  NODE_ENV: "test",
  PORT: "4000",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/paylens",
  REDIS_URL: "redis://localhost:6379",
  CORS_ORIGINS: "http://localhost:3000",
};

type PinoHttpShape = {
  level?: string;
  redact?: { paths: string[]; censor: string };
  formatters?: { log: (event: Record<string, unknown>) => Record<string, unknown> };
};

function pinoHttpOptions(logLevel = "info"): PinoHttpShape {
  const config = {
    getOrThrow: (key: string) => {
      const map: Record<string, unknown> = {
        "app.logLevel": logLevel,
        "app.logFormat": "json",
        "app.pinoConsoleEnabled": true,
        "app.otelEnabled": false,
        "app.otelLogsEnabled": false,
        "app.otelExporterOtlpEndpoint": "",
      };

      return map[key];
    },
  } as never;

  return (buildLoggerModuleOptions(config).pinoHttp as [PinoHttpShape])[0];
}

describe("observability configuration", () => {
  describe("LOG_LEVEL handling", () => {
    it("honors debug log level", () => {
      expect(pinoHttpOptions("debug").level).toBe("debug");
    });

    it("honors info log level", () => {
      expect(pinoHttpOptions("info").level).toBe("info");
    });

    it("honors warn log level", () => {
      expect(pinoHttpOptions("warn").level).toBe("warn");
    });

    it("honors error log level", () => {
      expect(pinoHttpOptions("error").level).toBe("error");
    });

    it("defaults to info when LOG_LEVEL is unset", () => {
      const parsed = validateEnvironment(validEnv);

      expect(parsed.LOG_LEVEL).toBe("info");
    });

    it("accepts debug LOG_LEVEL", () => {
      const parsed = validateEnvironment({ ...validEnv, LOG_LEVEL: "debug" });

      expect(parsed.LOG_LEVEL).toBe("debug");
    });

    it("rejects invalid LOG_LEVEL", () => {
      expect(() => validateEnvironment({ ...validEnv, LOG_LEVEL: "trace" })).toThrow("LOG_LEVEL");
    });
  });

  describe("EXECUTION_TRACE_ENABLED", () => {
    it("defaults to true when unset", () => {
      const parsed = validateEnvironment(validEnv);

      expect(parsed.EXECUTION_TRACE_ENABLED).toBe(true);
    });

    it("parses string true as boolean true", () => {
      const parsed = validateEnvironment({ ...validEnv, EXECUTION_TRACE_ENABLED: "true" });

      expect(parsed.EXECUTION_TRACE_ENABLED).toBe(true);
    });

    it("parses string false as boolean false", () => {
      const parsed = validateEnvironment({ ...validEnv, EXECUTION_TRACE_ENABLED: "false" });

      expect(parsed.EXECUTION_TRACE_ENABLED).toBe(false);
    });

    it("rejects non-boolean string", () => {
      expect(() => validateEnvironment({ ...validEnv, EXECUTION_TRACE_ENABLED: "yes" })).toThrow(
        "EXECUTION_TRACE_ENABLED",
      );
    });
  });

  describe("DB_QUERY_LOG_ENABLED", () => {
    it("defaults to false when unset", () => {
      const parsed = validateEnvironment(validEnv);

      expect(parsed.DB_QUERY_LOG_ENABLED).toBe(false);
    });

    it("parses string true as boolean true", () => {
      const parsed = validateEnvironment({ ...validEnv, DB_QUERY_LOG_ENABLED: "true" });

      expect(parsed.DB_QUERY_LOG_ENABLED).toBe(true);
    });

    it("parses string false as boolean false", () => {
      const parsed = validateEnvironment({ ...validEnv, DB_QUERY_LOG_ENABLED: "false" });

      expect(parsed.DB_QUERY_LOG_ENABLED).toBe(false);
    });
  });

  describe("SLOW_QUERY_MS", () => {
    it("defaults to 100 when unset", () => {
      const parsed = validateEnvironment(validEnv);

      expect(parsed.SLOW_QUERY_MS).toBe(100);
    });

    it("accepts custom threshold", () => {
      const parsed = validateEnvironment({ ...validEnv, SLOW_QUERY_MS: "50" });

      expect(parsed.SLOW_QUERY_MS).toBe(50);
    });

    it("rejects non-integer values", () => {
      expect(() => validateEnvironment({ ...validEnv, SLOW_QUERY_MS: "abc" })).toThrow(
        "SLOW_QUERY_MS",
      );
    });
  });

  describe("OTEL configuration", () => {
    it("defaults OTEL_ENABLED to true when unset", () => {
      const parsed = validateEnvironment(validEnv);

      expect(parsed.OTEL_ENABLED).toBe(true);
    });

    it("defaults OTEL_LOGS_ENABLED to true when unset", () => {
      const parsed = validateEnvironment(validEnv);

      expect(parsed.OTEL_LOGS_ENABLED).toBe(true);
    });

    it("parses OTEL_ENABLED=false correctly", () => {
      const parsed = validateEnvironment({ ...validEnv, OTEL_ENABLED: "false" });

      expect(parsed.OTEL_ENABLED).toBe(false);
    });

    it("defaults OTEL_TRACE_SAMPLE_RATIO to 1", () => {
      const parsed = validateEnvironment(validEnv);

      expect(parsed.OTEL_TRACE_SAMPLE_RATIO).toBe(1);
    });

    it("accepts OTEL_TRACE_SAMPLE_RATIO between 0 and 1", () => {
      const parsed = validateEnvironment({ ...validEnv, OTEL_TRACE_SAMPLE_RATIO: "0.5" });

      expect(parsed.OTEL_TRACE_SAMPLE_RATIO).toBe(0.5);
    });

    it("rejects OTEL_TRACE_SAMPLE_RATIO outside 0..1", () => {
      expect(() => validateEnvironment({ ...validEnv, OTEL_TRACE_SAMPLE_RATIO: "1.5" })).toThrow(
        "OTEL_TRACE_SAMPLE_RATIO",
      );
    });
  });

  describe("PINO_CONSOLE_ENABLED", () => {
    it("defaults to true when unset", () => {
      const parsed = validateEnvironment(validEnv);

      expect(parsed.PINO_CONSOLE_ENABLED).toBe(true);
    });

    it("parses string false as boolean false", () => {
      const parsed = validateEnvironment({ ...validEnv, PINO_CONSOLE_ENABLED: "false" });

      expect(parsed.PINO_CONSOLE_ENABLED).toBe(false);
    });
  });

  describe("logger redaction", () => {
    it("masks sensitive headers and body fields", () => {
      const options = pinoHttpOptions();
      const redact = options.redact as { paths: string[]; censor: string };

      expect(redact.censor).toBe("***");
      expect(redact.paths).toContain("req.headers.authorization");
      expect(redact.paths).toContain("req.headers.cookie");
      expect(redact.paths).toContain("req.body.password");
      expect(redact.paths).toContain("req.body.accessToken");
      expect(redact.paths).toContain("req.body.refreshToken");
      expect(redact.paths).toContain("req.body.invitationToken");
      expect(redact.paths).toContain("req.body.resetToken");
      expect(redact.paths).toContain("req.query.token");
    });
  });

  describe("sanitizeForLog", () => {
    it("recursively masks all sensitive key patterns", () => {
      const result = sanitizeForLog({
        password: "secret",
        accessToken: "at_secret",
        refreshToken: "rt_secret",
        idToken: "id_secret",
        verificationToken: "vt_secret",
        resetToken: "rst_secret",
        inviteToken: "inv_secret",
        authorization: "Bearer xxx",
        cookie: "session=abc",
        clientSecret: "cs_secret",
        apiKey: "ak_secret",
        oauthCode: "oc_secret",
        verificationCode: "vc_secret",
        resetCode: "rc_secret",
        safeField: "visible",
      });

      expect(result).toEqual({
        password: REDACTED_LOG_VALUE,
        accessToken: REDACTED_LOG_VALUE,
        refreshToken: REDACTED_LOG_VALUE,
        idToken: REDACTED_LOG_VALUE,
        verificationToken: REDACTED_LOG_VALUE,
        resetToken: REDACTED_LOG_VALUE,
        inviteToken: REDACTED_LOG_VALUE,
        authorization: REDACTED_LOG_VALUE,
        cookie: REDACTED_LOG_VALUE,
        clientSecret: REDACTED_LOG_VALUE,
        apiKey: REDACTED_LOG_VALUE,
        oauthCode: REDACTED_LOG_VALUE,
        verificationCode: REDACTED_LOG_VALUE,
        resetCode: REDACTED_LOG_VALUE,
        safeField: "visible",
      });
    });

    it("preserves safe department codes while masking credential codes", () => {
      const result = sanitizeForLog({
        department: { code: "ENG" },
        oauthCode: "private",
        verificationCode: "private",
      });

      expect(result).toEqual({
        department: { code: "ENG" },
        oauthCode: REDACTED_LOG_VALUE,
        verificationCode: REDACTED_LOG_VALUE,
      });
    });

    it("handles arrays and nesting", () => {
      const result = sanitizeForLog({
        items: [{ password: "p", name: "n" }],
        nested: { deep: { token: "t" } },
      });

      expect(result).toEqual({
        items: [{ password: REDACTED_LOG_VALUE, name: "n" }],
        nested: { deep: { token: REDACTED_LOG_VALUE } },
      });
    });

    it("returns non-object primitives unchanged", () => {
      expect(sanitizeForLog("hello")).toBe("hello");
      expect(sanitizeForLog(42)).toBe(42);
      expect(sanitizeForLog(null)).toBe(null);
      expect(sanitizeForLog(true)).toBe(true);
    });
  });

  describe("safeRequestMetadata", () => {
    it("sanitizes query params and preserves safe values", () => {
      const result = safeRequestMetadata({
        query: { countryCode: "IN", status: "ACTIVE", token: "secret" },
        params: { employeeId: "emp_123" },
      });

      expect(result).toEqual({
        params: { employeeId: "emp_123" },
        query: { countryCode: "IN", status: "ACTIVE", token: REDACTED_LOG_VALUE },
      });
    });

    it("replaces raw free-text search with metadata", () => {
      const result = safeRequestMetadata({
        query: { search: "narendra@example.com", countryCode: "IN" },
      });

      expect(result.query).not.toHaveProperty("search");
      expect(result.query).toMatchObject({
        searchPresent: true,
        searchLength: 20,
        countryCode: "IN",
      });
    });

    it("returns empty objects when no params or query", () => {
      const result = safeRequestMetadata({});

      expect(result).toEqual({});
    });
  });
});
