import { describe, expect, it } from "vitest";
import { buildLoggerModuleOptions } from "@/config/logger.config.js";

type PinoHttpShape = {
  autoLogging?: boolean;
  base?: unknown;
  level?: string;
  redact?: { paths: string[]; censor: string };
  serializers?: Record<string, () => unknown>;
  customProps?: (request: unknown) => unknown;
  transport?: unknown;
};

function buildConfig(environment: string, logLevel = "info") {
  return {
    getOrThrow: (key: string) => {
      if (key === "app.environment") {
        return environment;
      }

      if (key === "app.logLevel") {
        return logLevel;
      }

      throw new Error(`Unexpected config key: ${key}`);
    },
  } as never;
}

function httpOptions(environment: string, logLevel = "info"): PinoHttpShape {
  const options = buildLoggerModuleOptions(buildConfig(environment, logLevel));

  return options.pinoHttp as unknown as PinoHttpShape;
}

describe("logger module options", () => {
  it("disables automatic request logging in favor of PayLens tracing", () => {
    expect(httpOptions("production")).toMatchObject({ autoLogging: false });
  });

  it("uses a service base instead of machine pid/hostname noise", () => {
    expect(httpOptions("production").base).toEqual({ service: "paylens-server" });
  });

  it("serializes the bound raw request object away", () => {
    expect(httpOptions("production").serializers?.req()).toBeUndefined();
  });

  it("keeps sensitive redaction as defense-in-depth", () => {
    const redact = httpOptions("production").redact as { paths: string[]; censor: string };

    expect(redact.censor).toBe("[REDACTED]");
    expect(redact.paths).toEqual(
      expect.arrayContaining([
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        "req.body.accessToken",
        "req.body.refreshToken",
      ]),
    );
  });

  it("propagates the request id into request-scoped logs", () => {
    const customProps = httpOptions("production").customProps as (request: unknown) => unknown;

    expect(customProps({ requestId: "req-1" })).toEqual({ requestId: "req-1" });
  });

  it("uses pretty human-readable logs only in development", () => {
    expect(httpOptions("development").transport).toMatchObject({ target: "pino-pretty" });
    expect(httpOptions("production")).not.toHaveProperty("transport");
  });

  it("honors the configured log level", () => {
    expect(httpOptions("production", "debug").level).toBe("debug");
  });
});
