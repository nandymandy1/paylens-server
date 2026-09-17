import { Module } from "@nestjs/common";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

@Module({
  controllers: [HealthController],
  providers: [ExecutionTraceService, HealthService],
})
export class HealthModule {}
