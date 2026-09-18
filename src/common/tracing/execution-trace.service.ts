import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import { requestContext } from "@/common/context/request-context.js";
import { sanitizeForLog } from "@/common/utils/log-sanitizer.js";
import { context, executionTracer, initializeTelemetry, trace } from "./telemetry.js";
import { shutdownTelemetry } from "./telemetry.js";

type TraceEvent = Record<string, unknown> & { event: string };

@Injectable()
export class ExecutionTraceService {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    const enabled = this.config.getOrThrow<unknown>("app.otelEnabled");
    const logsEnabled = this.config.getOrThrow<unknown>("app.otelLogsEnabled");
    const serviceName = this.config.getOrThrow<unknown>("app.otelServiceName");
    const exporterEndpoint = this.config.getOrThrow<unknown>("app.otelExporterOtlpEndpoint");
    const sampleRatio = this.config.getOrThrow<unknown>("app.otelTraceSampleRatio");
    const logLevel = this.config.getOrThrow<string>("app.logLevel");
    const logFormat = this.config.getOrThrow<string>("app.logFormat");
    const executionTraceEnabled = this.config.getOrThrow<boolean>("app.executionTraceEnabled");
    const dbQueryLogEnabled = this.config.getOrThrow<boolean>("app.dbQueryLogEnabled");
    const slowQueryMs = this.config.getOrThrow<number>("app.slowQueryMs");

    initializeTelemetry({
      enabled: enabled !== false,
      logsEnabled: logsEnabled !== false,
      serviceName: typeof serviceName === "string" ? serviceName : "paylens-server",
      exporterEndpoint: typeof exporterEndpoint === "string" ? exporterEndpoint : "",
      sampleRatio: typeof sampleRatio === "number" ? sampleRatio : 1,
    });

    this.logger.info({
      event: "observability.initialized",
      logLevel,
      logFormat,
      executionTraceEnabled,
      dbQueryLogEnabled,
      slowQueryMs,
      otelEnabled: enabled !== false,
      otelLogsEnabled:
        logsEnabled !== false && typeof exporterEndpoint === "string" && !!exporterEndpoint,
      serviceName: typeof serviceName === "string" ? serviceName : "paylens-server",
      otlpProtocol: "http/protobuf",
    });
  }

  get requestId(): string | undefined {
    return requestContext.getStore()?.requestId;
  }

  get authUserId(): string | undefined {
    return requestContext.getStore()?.authUserId;
  }

  get traceId(): string | undefined {
    return requestContext.getStore()?.traceId;
  }

  get spanId(): string | undefined {
    return requestContext.getStore()?.spanId;
  }

  now(): number {
    return performance.now();
  }

  durationSince(startedAt: number): number {
    return Number((performance.now() - startedAt).toFixed(2));
  }

  debug(event: TraceEvent): void {
    if (!this.config.getOrThrow<boolean>("app.executionTraceEnabled")) {
      return;
    }

    this.logger.debug(this.withContext(event));
  }

  info(event: TraceEvent): void {
    this.logger.info(this.withContext(event));
  }

  warn(event: TraceEvent): void {
    this.logger.warn(this.withContext(event));
  }

  error(event: TraceEvent): void {
    this.logger.error(this.withContext(event));
  }

  async withinSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean | undefined>,
    execute: () => Promise<T> | T,
  ): Promise<T> {
    const parent = requestContext.getStore();
    const span = executionTracer().startSpan(name);
    const spanContext = span.spanContext();
    const active = trace.setSpan(context.active(), span);

    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }

    return context.with(active, () =>
      requestContext.run(
        {
          ...(parent ?? { requestId: "background" }),
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
        },
        async () => {
          try {
            const result = await execute();

            span.setStatus({ code: 1 });

            return result;
          } catch (error) {
            span.setStatus({ code: 2 });
            if (error instanceof Error) span.recordException(error);
            throw error;
          } finally {
            span.end();
          }
        },
      ),
    );
  }

  startRequestSpan(attributes: Record<string, string | number | boolean | undefined>) {
    const span = executionTracer().startSpan("http.request");
    const spanContext = span.spanContext();
    const active = trace.setSpan(context.active(), span);

    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }

    return {
      context: active,
      run: <T>(callback: () => T): T => context.with(active, callback),
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      end: (statusCode: number) => {
        span.setAttribute("http.response.status_code", statusCode);
        span.setStatus({ code: statusCode >= 500 ? 2 : 1 });
        span.end();
      },
    };
  }

  recordDatabaseQuery(event: { model?: string; action?: string; durationMs: number }): void {
    // Prisma $on("query") fires AFTER the query completes. Creating a span here
    // would produce a fake post-query child span with zero real duration.
    // Real Prisma spans come from @prisma/instrumentation. Query events are used
    // only for terminal diagnostics (slow-query warnings, DEBUG timing logs).
    if (event.durationMs >= this.config.getOrThrow<number>("app.slowQueryMs")) {
      this.warn({
        event: "db.query.slow",
        model: event.model ?? "raw",
        operation: event.action ?? "query",
        durationMs: event.durationMs,
        thresholdMs: this.config.getOrThrow<number>("app.slowQueryMs"),
      });
    } else if (this.config.getOrThrow<boolean>("app.dbQueryLogEnabled")) {
      this.debug({
        event: "db.query.completed",
        model: event.model ?? "raw",
        operation: event.action ?? "query",
        durationMs: event.durationMs,
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }

  private withContext(event: TraceEvent): TraceEvent {
    const authUserId = event.authUserId ?? this.authUserId;

    const traceId = event.traceId ?? this.traceId;
    const spanId = event.spanId ?? this.spanId;

    return {
      ...(sanitizeForLog(event) as TraceEvent),
      requestId: event.requestId ?? this.requestId,
      ...(traceId === undefined ? {} : { traceId }),
      ...(spanId === undefined ? {} : { spanId }),
      ...(authUserId === undefined ? {} : { authUserId }),
    };
  }
}
