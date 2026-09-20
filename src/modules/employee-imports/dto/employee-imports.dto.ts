import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { EmployeeTransferFormat } from "@prisma/client";
import { EMPLOYEE_IMPORT_MAX_FILE_BYTES } from "@/modules/employee-imports/employee-imports.constants.js";

export class CreateEmployeeImportDto {
  @ApiProperty({ example: "employees.xlsx" })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ enum: EmployeeTransferFormat })
  @IsEnum(EmployeeTransferFormat)
  format!: EmployeeTransferFormat;

  @ApiProperty({ example: 425123 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(EMPLOYEE_IMPORT_MAX_FILE_BYTES)
  sizeBytes!: number;

  @ApiProperty({
    example: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  contentType!: string;
}

export class ConfirmEmployeeImportDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  createMissingDepartments!: boolean;
}

export class ImportReportQueryDto {
  @ApiPropertyOptional({ enum: ["validation", "apply"], default: "validation" })
  @IsOptional()
  @IsString()
  @Matches(/^(validation|apply)$/)
  type?: string;
}
