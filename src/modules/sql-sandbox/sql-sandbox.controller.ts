import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { SessionGuard } from "@/modules/auth/guards/session.guard.js";
import { ExecuteSqlSandboxDto } from "@/modules/sql-sandbox/dto/sql-sandbox.dto.js";
import { SqlSandboxService } from "@/modules/sql-sandbox/sql-sandbox.service.js";

@ApiTags("sql-sandbox")
@Controller("sql-sandbox")
@UseGuards(SessionGuard)
export class SqlSandboxController {
  constructor(private readonly sandbox: SqlSandboxService) {}

  @Post("execute")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Execute raw SQL against the local disposable database (local-only)",
  })
  @ApiBadRequestResponse({ description: "Empty query or native PostgreSQL error" })
  execute(@Body() dto: ExecuteSqlSandboxDto) {
    return this.sandbox.execute(dto.query);
  }

  @Post("reseed")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Restore the local database via prisma migrate deploy + canonical seed (local-only)",
  })
  @ApiBadRequestResponse({ description: "Reseed failed; message carries the failure reason" })
  reseed() {
    return this.sandbox.reseed();
  }
}
