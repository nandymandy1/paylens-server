import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ControllerTraceInterceptor } from "./controller-trace.interceptor.js";
import { ExecutionTraceService } from "./execution-trace.service.js";

/**
 * Global observability infrastructure for NestJS.
 *
 * - ExecutionTraceService: request-scoped trace/log context, span creation, DB query diagnostics.
 * - ControllerTraceInterceptor: automatic controller span + started/completed/failed logging.
 *
 * This module is @Global — business modules inject ExecutionTraceService directly
 * without importing this module. AppModule imports it once for Nest wiring.
 */
@Global()
@Module({
  providers: [
    ExecutionTraceService,
    ControllerTraceInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: ControllerTraceInterceptor },
  ],
  exports: [ExecutionTraceService],
})
export class ObservabilityModule {}
