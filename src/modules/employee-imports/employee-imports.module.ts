import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { EMPLOYEE_IMPORT_QUEUE } from "./employee-imports.constants.js";
import { EmployeeImportsController } from "./employee-imports.controller.js";
import { EmployeeImportsProcessor } from "./employee-imports.processor.js";
import { EmployeeImportsService } from "./employee-imports.service.js";

@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: EMPLOYEE_IMPORT_QUEUE })],
  controllers: [EmployeeImportsController],
  providers: [EmployeeImportsService, EmployeeImportsProcessor],
})
export class EmployeeImportsModule {}
