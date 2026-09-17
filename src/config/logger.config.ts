import type { ConfigService } from "@nestjs/config";
import type { Params } from "nestjs-pino";

// Canonical Pino/nestjs-pino options. HTTP completion shape is allowlist-based:
// PayLens tracing (ExecutionTraceService) owns request received/completed/failed
// events, so pino-http automatic logging stays off and the request-scoped logger
// never carries the raw req object. Redaction remains as defense-in-depth.
export const buildLoggerModuleOptions = (config: ConfigService): Params => {
  const environment = config.getOrThrow<string>("app.environment");

  return {
    pinoHttp: {
      autoLogging: false,
      base: { service: "paylens-server" },
      level: config.getOrThrow<string>("app.logLevel"),
      // The request-scoped logger binds the raw req object; serialize it away
      // so normal logs stay allowlisted. Redaction below is defense-in-depth.
      serializers: {
        req: () => undefined,
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "req.body.password",
          "req.body.passwordHash",
          "req.body.accessToken",
          "req.body.refreshToken",
          "req.body.invitationToken",
          "req.body.resetToken",
          "req.body.token",
          "req.body.code",
          "req.body.secret",
          "req.query.code",
          "req.query.state",
          "req.query.token",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
      customProps: (request) => ({
        requestId: (request as { requestId?: string }).requestId,
      }),
      ...(environment === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                colorize: true,
                translateTime: "HH:MM:ss",
                ignore: "pid,hostname",
              },
            },
          }
        : {}),
    },
  };
};
