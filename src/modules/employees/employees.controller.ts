import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentPrincipal } from "@/modules/auth/decorators/current-principal.decorator.js";
import { SessionGuard } from "@/modules/auth/guards/session.guard.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { CreateEmployeeDto, ListEmployeesDto } from "@/modules/employees/dto/employees.dto.js";
import { EmployeesService } from "./employees.service.js";

@ApiTags("employees")
@Controller("employees")
@UseGuards(SessionGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @ApiOperation({ summary: "List employees of the active organization" })
  async list(@CurrentPrincipal() principal: RequestPrincipal, @Query() dto: ListEmployeesDto) {
    return this.employees.list(principal, dto);
  }

  @Post()
  @ApiOperation({ summary: "Onboard an employee into the active organization" })
  async create(@CurrentPrincipal() principal: RequestPrincipal, @Body() dto: CreateEmployeeDto) {
    return this.employees.createEmployee(principal, dto);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get an employee of the active organization" })
  async detail(@CurrentPrincipal() principal: RequestPrincipal, @Param("id") id: string) {
    return this.employees.detail(principal, id);
  }
}
