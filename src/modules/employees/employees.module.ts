import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { DepartmentsModule } from "@/modules/departments/departments.module.js";
import { EmployeesController } from "./employees.controller.js";
import { EmployeesService } from "./employees.service.js";

@Module({
  imports: [AuthModule, DepartmentsModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
})
export class EmployeesModule {}
