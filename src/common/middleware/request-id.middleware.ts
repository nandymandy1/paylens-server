import { randomUUID } from "node:crypto";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { context, trace } from "@opentelemetry/api";
import { requestContext } from "@/common/context/request-context.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { executionMeter } from "@/common/tracing/telemetry.js";
import { isValidSpanId, isValidTraceId } from "@/common/tracing/telemetry.utils.js";
import { resolveRequestRouteForLog, resolveRequestRouteForMetric } from "@/common/utils/http.js";
import { safeRequestMetadata } from "@/common/utils/log-sanitizer.js";

export type RequestWithId = Request & { requestId: string; errorCode?: string };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const httpRequestCounter = executionMeter().createCounter("paylens.http.requests");
const httpErrorCounter = executionMeter().createCounter("paylens.http.errors");
const httpDurationHistogram = executionMeter().createHistogram("paylens.http.duration", {
  unit: "ms",
});

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly executionTrace: ExecutionTraceService) {}

  use(request: RequestWithId, response: Response, next: NextFunction): void {
    const incoming = request.header("x-request-id");
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    const startedAt = this.executionTrace.now();

    request.requestId = requestId;
    response.setHeader("x-request-id", requestId);

    // Retrieve the active HTTP SERVER span created by HttpInstrumentation.
    const activeSpan = trace.getSpan(context.active());
    const spanCtx = activeSpan?.spanContext();
    const hasValidTrace =
      spanCtx !== undefined &&
      spanCtx !== null &&
      isValidTraceId(spanCtx.traceId) &&
      isValidSpanId(spanCtx.spanId);
    const resolvedTraceId = hasValidTrace ? spanCtx.traceId : undefined;
    const resolvedSpanId = hasValidTrace ? spanCtx.spanId : undefined;

    // Idempotent finalizer — ensures logging/metrics happen exactly once
    // regardless of how the request terminates (finish, close, abort, error).
    // HttpInstrumentation owns the SERVER span lifecycle (start/status/end).
    let finalized = false;

    const finalize = (statusCode?: number): void => {
      if (finalized) return;
      finalized = true;

      const authUserId = requestContext.getStore()?.authUserId;
      const event =
        statusCode !== undefined
          ? statusCode >= 400
            ? "http.request.failed"
            : "http.request.completed"
          : "http.request.aborted";
      const durationMs = this.executionTrace.durationSince(startedAt);
      const logRoute = resolveRequestRouteForLog(request);
      const metricRoute = resolveRequestRouteForMetric(request);
      const payload = {
        event,
        requestId,
        ...(authUserId === undefined ? {} : { authUserId }),
        method: request.method,
        route: logRoute,
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(request.errorCode === undefined ? {} : { code: request.errorCode }),
        durationMs,
      };

      httpRequestCounter.add(1, {
        method: request.method,
        route: metricRoute,
        ...(statusCode !== undefined ? { statusCode } : {}),
      });
      httpDurationHistogram.record(durationMs, {
        method: request.method,
        route: metricRoute,
        ...(statusCode !== undefined ? { statusCode } : {}),
      });
      if (statusCode !== undefined && statusCode >= 400) {
        httpErrorCounter.add(1, {
          method: request.method,
          route: metricRoute,
          statusCode,
        });
      }

      if (statusCode !== undefined && statusCode >= 500) {
        this.executionTrace.error(payload);
      } else if (statusCode !== undefined && statusCode >= 400) {
        this.executionTrace.warn(payload);
      } else {
        this.executionTrace.info(payload);
      }
    };

    // Run inside the active HTTP SERVER span context so controller/service
    // spans become children. Store traceId/spanId from the SERVER span.
    requestContext.run({ requestId, traceId: resolvedTraceId, spanId: resolvedSpanId }, () => {
      this.executionTrace.debug({
        event: "http.request.received",
        method: request.method,
        path: request.path,
        ...safeRequestMetadata(request),
      });

      response.on("finish", () => finalize(response.statusCode));
      response.on("close", () => {
        if (!response.writableFinished) {
          finalize(undefined);
        }
      });
      request.on("error", () => finalize(undefined));

      next();
    });
  }
}
