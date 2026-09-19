import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import { requestContext } from "@/common/context/request-context.js";
import { sanitizeForLog } from "@/common/utils/log-sanitizer.js";
import { context, executionTracer, getTelemetryRuntimeInfo, trace } from "./telemetry.js";
import { shutdownTelemetry } from "./telemetry.js";
import { isValidSpanId, isValidTraceId } from "./telemetry.utils.js";

type TraceEvent = Record<string, unknown> & { event: string };

@Injectable()
export class ExecutionTraceService {
  // Immutable config cached once in constructor — never re-read on hot paths.
  private readonly executionTraceEnabled: boolean;
  private readonly dbQueryLogEnabled: boolean;
  private readonly slowQueryMs: number;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.executionTraceEnabled = this.config.getOrThrow<boolean>("app.executionTraceEnabled");
    this.dbQueryLogEnabled = this.config.getOrThrow<boolean>("app.dbQueryLogEnabled");
    this.slowQueryMs = this.config.getOrThrow<number>("app.slowQueryMs");

    // Log actual telemetry runtime state — no second initialization.
    const telemetry = getTelemetryRuntimeInfo();

    this.logger.info({
      event: "observability.initialized",
      logLevel: this.config.getOrThrow<string>("app.logLevel"),
      logFormat: this.config.getOrThrow<string>("app.logFormat"),
      executionTraceEnabled: this.executionTraceEnabled,
      dbQueryLogEnabled: this.dbQueryLogEnabled,
      slowQueryMs: this.slowQueryMs,
      otelEnabled: telemetry.initialized,
      otelLogsEnabled: telemetry.logsEnabled,
      otelMetricsEnabled: telemetry.metricsEnabled,
      serviceName: telemetry.serviceName,
      traceSampleRatio: telemetry.traceSampleRatio,
      protocol: telemetry.protocol,
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
    if (!this.executionTraceEnabled) return;
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
    const validTrace = isValidTraceId(spanContext.traceId) && isValidSpanId(spanContext.spanId);

    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }

    return context.with(active, () =>
      requestContext.run(
        {
          ...(parent ?? { requestId: "background" }),
          ...(validTrace ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}),
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

  recordDatabaseQuery(event: { statementType?: string; durationMs: number }): void {
    // Prisma $on("query") fires AFTER the query completes. Creating a span here
    // would produce a fake post-query child span with zero real duration.
    // Real Prisma spans come from @prisma/instrumentation. Query events are used
    // only for terminal diagnostics (slow-query warnings, DEBUG timing logs).
    if (event.durationMs >= this.slowQueryMs) {
      this.warn({
        event: "db.query.slow",
        statementType: event.statementType ?? "UNKNOWN",
        durationMs: event.durationMs,
        thresholdMs: this.slowQueryMs,
      });
    } else if (this.dbQueryLogEnabled) {
      this.debug({
        event: "db.query.completed",
        statementType: event.statementType ?? "UNKNOWN",
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
