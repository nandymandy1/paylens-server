import { Global, Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ControllerTraceInterceptor } from "./controller-trace.interceptor.js";
import { ExecutionTraceService } from "./execution-trace.service.js";

/**
 * Consolidates Nest-visible observability infrastructure:
 * - ExecutionTraceService (global via @Global)
 * - ControllerTraceInterceptor (global APP_INTERCEPTOR)
 *
 * Business modules import TracingModule (which re-exports ExecutionTraceService)
 * or rely on @Global(). This module focuses on Nest wiring.
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
