import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CurrentPrincipal } from "@/modules/auth/decorators/current-principal.decorator.js";
import { SessionGuard } from "@/modules/auth/guards/session.guard.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
/* eslint-disable no-restricted-imports */
import {
  ConfirmEmployeeImportDto,
  CreateEmployeeImportDto,
  ImportReportQueryDto,
} from "./dto/employee-imports.dto.js";
import { EmployeeImportsService } from "./employee-imports.service.js";

@ApiTags("employee-imports")
@Controller("employee-imports")
@UseGuards(SessionGuard)
export class EmployeeImportsController {
  constructor(private readonly imports: EmployeeImportsService) {}

  @Post() create(@CurrentPrincipal() p: RequestPrincipal, @Body() dto: CreateEmployeeImportDto) {
    return this.imports.create(p, dto);
  }

  @Get() list(@CurrentPrincipal() p: RequestPrincipal) {
    return this.imports.list(p);
  }

  @Get(":id") detail(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.imports.detail(p, id);
  }

  @Post(":id/upload-complete") uploadComplete(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param("id") id: string,
  ) {
    return this.imports.uploadComplete(p, id);
  }

  @Post(":id/confirm") confirm(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param("id") id: string,
    @Body() dto: ConfirmEmployeeImportDto,
  ) {
    return this.imports.confirm(p, id, dto.createMissingDepartments);
  }

  @Post(":id/pause") pause(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.imports.pause(p, id);
  }

  @Post(":id/resume") resume(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.imports.resume(p, id);
  }

  @Post(":id/cancel") cancel(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.imports.cancel(p, id);
  }

  @Get(":id/report") report(
    @CurrentPrincipal() p: RequestPrincipal,
    @Param("id") id: string,
    @Query() query: ImportReportQueryDto,
  ) {
    return this.imports.downloadReport(p, id, query.type ?? "validation");
  }
}
