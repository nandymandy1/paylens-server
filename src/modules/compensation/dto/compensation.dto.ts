import { Transform, Type } from "class-transformer";
import { IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CompensationChangeReason } from "@prisma/client";
import {
  trimOptionalTransform,
  trimTransform,
  trimUppercaseTransform,
} from "@/common/utils/transform.js";
import { COMPENSATION_CURRENCIES } from "@/modules/compensation/constants/compensation.constants.js";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONEY_PATTERN = /^(?:0|[1-9]\d{0,16})(?:\.\d{1,2})?$/;

export class ListCompensationHistoryDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: "Opaque compensation-history cursor" })
  @IsOptional()
  @IsString()
  @Transform(trimTransform)
  @MaxLength(512)
  cursor?: string;
}

export class ChangeCompensationDto {
  @ApiProperty({ example: "1850000.00", description: "Positive decimal with at most two places" })
  @IsString()
  @Transform(trimTransform)
  @Matches(MONEY_PATTERN, {
    message: "annualBaseSalary must be a positive decimal with at most 2 places",
  })
  annualBaseSalary!: string;

  @ApiProperty({ enum: COMPENSATION_CURRENCIES })
  @IsString()
  @Transform(trimUppercaseTransform)
  @IsEnum(COMPENSATION_CURRENCIES)
  currency!: (typeof COMPENSATION_CURRENCIES)[number];

  @ApiProperty({ example: "2026-04-01" })
  @IsString()
  @Matches(DATE_ONLY_PATTERN)
  effectiveFrom!: string;

  @ApiProperty({ minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @ApiPropertyOptional({ enum: CompensationChangeReason })
  @IsOptional()
  @IsEnum(CompensationChangeReason)
  reason?: CompensationChangeReason;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @Transform(trimOptionalTransform)
  @MaxLength(1000)
  note?: string;
}
