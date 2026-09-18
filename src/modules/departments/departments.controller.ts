import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentPrincipal } from "@/modules/auth/decorators/current-principal.decorator.js";
import { SessionGuard } from "@/modules/auth/guards/session.guard.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { DepartmentsService } from "@/modules/departments/departments.service.js";
import { CreateDepartmentDto } from "@/modules/departments/dto/create-department.dto.js";
import { UpdateDepartmentDto } from "@/modules/departments/dto/update-department.dto.js";

@ApiTags("departments")
@Controller("departments")
@UseGuards(SessionGuard)
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @ApiOperation({ summary: "List departments of the active organization" })
  async list(@CurrentPrincipal() principal: RequestPrincipal) {
    return this.departments.list(principal);
  }

  @Post()
  @ApiOperation({ summary: "Create a department in the active organization" })
  async create(@CurrentPrincipal() principal: RequestPrincipal, @Body() dto: CreateDepartmentDto) {
    return this.departments.create(principal, dto);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a department of the active organization" })
  async detail(@CurrentPrincipal() principal: RequestPrincipal, @Param("id") id: string) {
    return this.departments.detail(principal, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a department of the active organization" })
  async update(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param("id") id: string,
    @Body() dto: UpdateDepartmentDto,
  ) {
    return this.departments.update(principal, id, dto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete an empty department of the active organization" })
  async remove(@CurrentPrincipal() principal: RequestPrincipal, @Param("id") id: string) {
    return this.departments.remove(principal, id);
  }
}
