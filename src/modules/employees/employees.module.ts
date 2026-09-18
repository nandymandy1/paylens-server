import { Module } from "@nestjs/common";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { DepartmentsModule } from "@/modules/departments/departments.module.js";
import { EmployeesController } from "./employees.controller.js";
import { EmployeesService } from "./employees.service.js";

@Module({
  imports: [AuthModule, DepartmentsModule],
  controllers: [EmployeesController],
  providers: [ExecutionTraceService, EmployeesService],
})
export class EmployeesModule {}
