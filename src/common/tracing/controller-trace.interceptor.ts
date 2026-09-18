import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Observable } from "rxjs";
import { catchError, tap } from "rxjs/operators";
import { getErrorMetadata as errorMetadata } from "@/common/utils/error.js";
import { ExecutionTraceService } from "./execution-trace.service.js";

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
