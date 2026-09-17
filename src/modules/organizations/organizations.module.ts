import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { OrganizationService } from "./organization.service.js";
import { OrganizationsController } from "./organizations.controller.js";

@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController],
  providers: [OrganizationService],
})
export class OrganizationsModule {}
