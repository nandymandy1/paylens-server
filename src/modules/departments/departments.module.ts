import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { DepartmentsController } from "@/modules/departments/departments.controller.js";
import { DepartmentsService } from "@/modules/departments/departments.service.js";

@Module({
  imports: [AuthModule],
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
