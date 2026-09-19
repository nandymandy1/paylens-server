import { Controller, Get, Headers, Param, Post, Body, Query, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentPrincipal } from "@/modules/auth/decorators/current-principal.decorator.js";
import { SessionGuard } from "@/modules/auth/guards/session.guard.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import {
  ChangeCompensationDto,
  ListCompensationHistoryDto,
} from "@/modules/compensation/dto/compensation.dto.js";
import { CompensationService } from "./compensation.service.js";

@ApiTags("compensation")
@Controller("employees/:employeeId/compensation")
@UseGuards(SessionGuard)
export class CompensationController {
  constructor(private readonly compensation: CompensationService) {}

  @Get()
  @ApiOperation({ summary: "Get current compensation for an employee in the active organization" })
  async current(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param("employeeId") employeeId: string,
  ) {
    return this.compensation.current(principal, employeeId);
  }

  @Get("history")
  @ApiOperation({ summary: "Get bounded compensation history for an active-organization employee" })
  async history(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param("employeeId") employeeId: string,
    @Query() dto: ListCompensationHistoryDto,
  ) {
    return this.compensation.history(principal, employeeId, dto);
  }

  @Post("changes")
  @ApiOperation({ summary: "Append an audited compensation change" })
  async change(
    @CurrentPrincipal() principal: RequestPrincipal,
    @Param("employeeId") employeeId: string,
    @Body() dto: ChangeCompensationDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
  ) {
    return this.compensation.change(principal, employeeId, dto, idempotencyKey);
  }
}
