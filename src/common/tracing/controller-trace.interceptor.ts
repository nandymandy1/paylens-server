import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { catchError, tap } from "rxjs/operators";
import { ExecutionTraceService } from "./execution-trace.service.js";

function errorMetadata(error: unknown): Record<string, string> {
  return {
    name: error instanceof Error ? error.name : "UnknownError",
  };
}

@Injectable()
export class ControllerTraceInterceptor implements NestInterceptor {
  constructor(private readonly executionTrace: ExecutionTraceService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = this.executionTrace.now();
    const controller = context.getClass().name;
    const method = context.getHandler().name;

    this.executionTrace.debug({ event: "controller.start", controller, method });

    return next.handle().pipe(
      tap(() => {
        this.executionTrace.debug({
          event: "controller.complete",
          controller,
          method,
          durationMs: this.executionTrace.durationSince(startedAt),
        });
      }),

      catchError((error: unknown) => {
        this.executionTrace.debug({
          event: "controller.error",
          controller,
          method,
          durationMs: this.executionTrace.durationSince(startedAt),
          error: errorMetadata(error),
        });

        throw error;
      }),
    );
  }
}
