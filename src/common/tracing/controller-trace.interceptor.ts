import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { defer, from, lastValueFrom, type Observable } from "rxjs";
import { getErrorMetadata as errorMetadata } from "@/common/utils/error.js";
import { safeRequestMetadata } from "@/common/utils/log-sanitizer.js";
import { ExecutionTraceService } from "./execution-trace.service.js";

@Injectable()
export class ControllerTraceInterceptor implements NestInterceptor {
  constructor(private readonly executionTrace: ExecutionTraceService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = this.executionTrace.now();
    const controller = context.getClass().name;
    const method = context.getHandler().name;
    const request =
      context.getType?.() === "http"
        ? context.switchToHttp().getRequest<{
            method?: string;
            route?: { path?: string };
            query?: Record<string, unknown>;
            params?: Record<string, unknown>;
            path?: string;
          }>()
        : {};

    return defer(() =>
      from(
        this.executionTrace.withinSpan(
          `controller.${controller}.${method}`,
          {
            controller,
            method,
            "http.request.method": request.method,
            "http.route": request.route?.path,
          },
          async () => {
            this.executionTrace.debug({
              event: "controller.started",
              controller,
              method,
              route: request.route?.path ?? request.path,
              ...safeRequestMetadata(request),
            });
            try {
              const result = await lastValueFrom(next.handle());

              this.executionTrace.debug({
                event: "controller.completed",
                controller,
                method,
                route: request.route?.path ?? request.path,
                durationMs: this.executionTrace.durationSince(startedAt),
                ...safeRequestMetadata(request),
              });

              return result;
            } catch (error) {
              this.executionTrace.error({
                event: "controller.failed",
                controller,
                method,
                route: request.route?.path ?? request.path,
                durationMs: this.executionTrace.durationSince(startedAt),
                error: errorMetadata(error),
                ...safeRequestMetadata(request),
              });
              throw error;
            }
          },
        ),
      ),
    );
  }
}
