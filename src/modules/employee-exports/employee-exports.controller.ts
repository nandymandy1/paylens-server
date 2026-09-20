import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentPrincipal } from "@/modules/auth/decorators/current-principal.decorator.js";
import { SessionGuard } from "@/modules/auth/guards/session.guard.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
/* eslint-disable no-restricted-imports */
import { CreateEmployeeExportDto } from "./dto/employee-exports.dto.js";
import { EmployeeExportsService } from "./employee-exports.service.js";

@Controller("employee-exports")
@UseGuards(SessionGuard)
export class EmployeeExportsController {
  constructor(private readonly exports: EmployeeExportsService) {}
  @Post() create(@CurrentPrincipal() p: RequestPrincipal, @Body() dto: CreateEmployeeExportDto) {
    return this.exports.create(p, dto.format);
  }

  @Get() list(@CurrentPrincipal() p: RequestPrincipal) {
    return this.exports.list(p);
  }

  @Get(":id") detail(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.exports.detail(p, id);
  }

  @Post(":id/pause") pause(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.exports.pause(p, id);
  }

  @Post(":id/resume") resume(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.exports.resume(p, id);
  }

  @Post(":id/cancel") cancel(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.exports.cancel(p, id);
  }

  @Get(":id/download") download(@CurrentPrincipal() p: RequestPrincipal, @Param("id") id: string) {
    return this.exports.download(p, id);
  }
}
