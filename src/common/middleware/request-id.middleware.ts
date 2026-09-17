import { randomUUID } from "node:crypto";
import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { requestContext } from "@/common/context/request-context.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";

export type RequestWithId = Request & { requestId: string; errorCode?: string };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly executionTrace: ExecutionTraceService) {}

  use(request: RequestWithId, response: Response, next: NextFunction): void {
    const incoming = request.header("x-request-id");
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    const startedAt = this.executionTrace.now();

    request.requestId = requestId;
    response.setHeader("x-request-id", requestId);

    requestContext.run({ requestId }, () => {
      this.executionTrace.debug({
        event: "http.request.received",
        method: request.method,
        path: request.path,
      });

      response.on("finish", () => {
        // Auth and error code resolve after this middleware runs, so read
        // them lazily here. Only allowlisted summary fields are logged.
        const authUserId = requestContext.getStore()?.authUserId;
        const event = response.statusCode >= 400 ? "http.request.failed" : "http.request.completed";
        const payload = {
          event,
          requestId,
          ...(authUserId === undefined ? {} : { authUserId }),
          method: request.method,
          path: request.path,
          statusCode: response.statusCode,
          ...(request.errorCode === undefined ? {} : { code: request.errorCode }),
          durationMs: this.executionTrace.durationSince(startedAt),
        };

        if (response.statusCode >= 500) {
          this.executionTrace.error(payload);
        } else if (response.statusCode >= 400) {
          this.executionTrace.warn(payload);
        } else {
          this.executionTrace.info(payload);
        }
      });

      next();
    });
  }
}
