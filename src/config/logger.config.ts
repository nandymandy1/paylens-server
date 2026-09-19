import type { ConfigService } from "@nestjs/config";
import type { IncomingMessage } from "node:http";
import type { Params } from "nestjs-pino";
import pino, { type DestinationStream } from "pino";
import type { Options } from "pino-http";
import { requestContext } from "@/common/context/request-context.js";
import { sanitizeForLog } from "@/common/utils/log-sanitizer.js";
import { OtlpLogDestination } from "./otlp-log.destination.js";

// One Pino event is formatted and sanitized once, then fanned out to console
// and (when configured) OTLP. Business code never emits separate log copies.
export const buildLoggerModuleOptions = (config: ConfigService): Params => {
  const environment = config.getOrThrow<string>("app.environment");
  const otelEndpoint = config.getOrThrow<string>("app.otelExporterOtlpEndpoint");

  const pinoHttp: Options = {
    autoLogging: false,
    base: { service: "paylens-server" },
    level: config.getOrThrow<string>("app.logLevel"),
    serializers: { req: () => undefined },
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
      censor: "***",
    },
    customProps: (request: IncomingMessage & { requestId?: string }) => ({
      requestId: request.requestId,
    }),
    formatters: {
      log: (event) => {
        const context = requestContext.getStore();

        return sanitizeForLog({
          ...event,
          requestId: event.requestId ?? context?.requestId,
          traceId: event.traceId ?? context?.traceId,
          spanId: event.spanId ?? context?.spanId,
        }) as Record<string, unknown>;
      },
    },
  };

  // Every stream explicitly inherits the configured log level so that DEBUG
  // events are not silently dropped by the multistream default threshold (info).
  type LevelStream = { level: number | string; stream: DestinationStream };

  const streams: LevelStream[] = [];
  const destLevel = config.getOrThrow<string>("app.logLevel");

  streams.push({
    level: destLevel,
    stream:
      environment === "development"
        ? pino.transport({
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
          })
        : pino.destination({ dest: 1, sync: false }),
  });

  if (otelEndpoint) {
    streams.push({ level: destLevel, stream: new OtlpLogDestination() });
  }

  return {
    pinoHttp: [
      pinoHttp,
      pino.multistream(
        streams.length ? streams : [{ level: destLevel, stream: pino.destination(1) }],
      ),
    ],
  };
};
