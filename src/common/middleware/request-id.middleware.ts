import { randomUUID } from "node:crypto";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { requestContext } from "@/common/context/request-context.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { executionMeter } from "@/common/tracing/telemetry.js";
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
    const rootSpan = this.executionTrace.startRequestSpan?.({
      "http.request.method": request.method,
      "url.path": request.path,
    }) ?? {
      traceId: undefined,
      spanId: undefined,
      run: <T>(callback: () => T): T => callback(),
      end: () => undefined,
    };

    rootSpan.run(() =>
      requestContext.run({ requestId, traceId: rootSpan.traceId, spanId: rootSpan.spanId }, () => {
        this.executionTrace.debug({
          event: "http.request.received",
          method: request.method,
          path: request.path,
          ...safeRequestMetadata(request),
        });

        response.on("finish", () => {
          // Auth and error code resolve after this middleware runs, so read
          // them lazily here. Only allowlisted summary fields are logged.
          const authUserId = requestContext.getStore()?.authUserId;
          const event =
            response.statusCode >= 400 ? "http.request.failed" : "http.request.completed";
          const durationMs = this.executionTrace.durationSince(startedAt);
          const route = request.route?.path ?? request.path;
          const payload = {
            event,
            requestId,
            ...(authUserId === undefined ? {} : { authUserId }),
            method: request.method,
            route,
            statusCode: response.statusCode,
            ...(request.errorCode === undefined ? {} : { code: request.errorCode }),
            durationMs,
          };

          httpRequestCounter.add(1, {
            method: request.method,
            route,
            statusCode: response.statusCode,
          });
          httpDurationHistogram.record(durationMs, {
            method: request.method,
            route,
            statusCode: response.statusCode,
          });
          if (response.statusCode >= 400) {
            httpErrorCounter.add(1, {
              method: request.method,
              route,
              statusCode: response.statusCode,
            });
          }

          rootSpan.end(response.statusCode);

          if (response.statusCode >= 500) {
            this.executionTrace.error(payload);
          } else if (response.statusCode >= 400) {
            this.executionTrace.warn(payload);
          } else {
            this.executionTrace.info(payload);
          }
        });

        next();
      }),
    );
  }
}
