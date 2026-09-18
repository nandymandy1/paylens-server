import { Module } from "@nestjs/common";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { DepartmentsController } from "@/modules/departments/departments.controller.js";
import { DepartmentsService } from "@/modules/departments/departments.service.js";

@Module({
  imports: [AuthModule],
  controllers: [DepartmentsController],
  providers: [ExecutionTraceService, DepartmentsService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
