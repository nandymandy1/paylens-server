import { Transform } from "class-transformer";
import { IsString, Matches, MaxLength, MinLength, ValidateIf } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { trimTransform, trimUppercaseTransform } from "@/common/utils/transform.js";

// PATCH semantics: `undefined` (omitted) skips the field, but `null` must
// still validate and fail — these business fields are non-nullable.
// `@ValidateIf((_, value) => value !== undefined)` would skip both, so each field uses an explicit guard.
export class UpdateDepartmentDto {
  @ApiPropertyOptional({ description: "Department display name" })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Transform(trimTransform)
  @MinLength(2)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    description: "Tenant-unique department code, stored uppercase",
    minLength: 2,
    maxLength: 20,
    pattern: "^[A-Z0-9][A-Z0-9-]{1,19}$",
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Transform(trimUppercaseTransform)
  @MinLength(2)
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,19}$/)
  @MaxLength(20)
  code?: string;
}
