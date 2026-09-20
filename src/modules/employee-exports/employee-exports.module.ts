import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { EMPLOYEE_EXPORT_QUEUE } from "./employee-exports.constants.js";
import { EmployeeExportsController } from "./employee-exports.controller.js";
import { EmployeeExportsProcessor } from "./employee-exports.processor.js";
import { EmployeeExportsCleanupScheduler } from "./employee-exports.scheduler.js";
import { EmployeeExportsService } from "./employee-exports.service.js";

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: EMPLOYEE_EXPORT_QUEUE })],
  controllers: [EmployeeExportsController],
  providers: [EmployeeExportsService, EmployeeExportsProcessor, EmployeeExportsCleanupScheduler],
})
export class EmployeeExportsModule {}
