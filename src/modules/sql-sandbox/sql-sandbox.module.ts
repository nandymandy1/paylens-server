import { Module } from "@nestjs/common";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { SqlSandboxController } from "./sql-sandbox.controller.js";
import { SqlSandboxService } from "./sql-sandbox.service.js";

@Module({
  controllers: [SqlSandboxController],
  imports: [AuthModule],
  providers: [SqlSandboxService],
})
export class SqlSandboxModule {}
