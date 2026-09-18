import { Transform, Type } from "class-transformer";
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { EmployeeStatus, EmploymentType } from "@prisma/client";
import {
  optionalEmailTransform,
  trimOptionalTransform,
  trimTransform,
  trimUppercaseTransform,
} from "@/common/utils/transform.js";

const trim = trimTransform;

const trimOrUndefined = trimOptionalTransform;

export class ListEmployeesDto {
  @ApiPropertyOptional({ description: "Search across name, email, and employee number" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  @Transform(trimOrUndefined)
  search?: string;

  @ApiPropertyOptional({ description: "Department id filter" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(trimOrUndefined)
  departmentId?: string;

  @ApiPropertyOptional({ description: "ISO 3166-1 alpha-2 country code", example: "IN" })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  @Matches(/^[A-Za-z]{2}$/)
  @Transform(trimUppercaseTransform)
  countryCode?: string;

  @ApiPropertyOptional({ enum: EmployeeStatus })
  @IsOptional()
  @IsEnum(EmployeeStatus)
  status?: EmployeeStatus;

  @ApiPropertyOptional({ enum: EmploymentType })
  @IsOptional()
  @IsEnum(EmploymentType)
  employmentType?: EmploymentType;

  @ApiPropertyOptional({
    default: "lastName",
    enum: ["lastName", "hireDate", "employeeNumber"],
  })
  @IsOptional()
  @IsIn(["lastName", "hireDate", "employeeNumber"])
  @Transform(trimOrUndefined)
  sort?: string;

  @ApiPropertyOptional({ default: "asc", enum: ["asc", "desc"] })
  @IsOptional()
  @IsIn(["asc", "desc"])
  @Transform(trimOrUndefined)
  direction?: string;

  @ApiPropertyOptional({ description: "Opaque cursor from a previous page" })
  @IsOptional()
  @IsString()
  @Transform(trim)
  cursor?: string;

  @ApiPropertyOptional({ default: 25, maximum: 100, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  limit?: number;
}

const lowerEmail = optionalEmailTransform;

export class CreateEmployeeDto {
  @ApiProperty({ description: "Tenant-unique employee number", example: "EMP-10428" })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(64)
  employeeNumber!: string;

  @ApiProperty({ example: "Olivia" })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: "Carter" })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional({ description: "Tenant-unique when present, stored lowercase" })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  @Transform(lowerEmail)
  workEmail?: string;

  @ApiProperty({ description: "Department id within the active organization" })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(64)
  departmentId!: string;

  @ApiProperty({ example: "Senior Software Engineer" })
  @IsString()
  @Transform(trim)
  @MinLength(1)
  @MaxLength(120)
  jobTitle!: string;

  @ApiPropertyOptional({ example: "L4" })
  @IsOptional()
  @IsString()
  @Transform(trimOrUndefined)
  @MaxLength(32)
  level?: string;

  @ApiProperty({ description: "ISO 3166-1 alpha-2 country code", example: "US" })
  @IsString()
  @Length(2, 2)
  @Matches(/^[A-Za-z]{2}$/)
  @Transform(trimUppercaseTransform)
  countryCode!: string;

  @ApiProperty({ enum: EmploymentType })
  @IsEnum(EmploymentType)
  employmentType!: EmploymentType;

  @ApiProperty({ description: "Hire date (ISO date)", example: "2026-09-18" })
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  hireDate!: string;
}
