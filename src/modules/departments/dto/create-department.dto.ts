import { Transform } from "class-transformer";
import { IsString, Matches, MaxLength, MinLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { trimTransform, trimUppercaseTransform } from "@/common/utils/transform.js";

export class CreateDepartmentDto {
  @ApiProperty({ description: "Department display name", example: "Engineering" })
  @IsString()
  @Transform(trimTransform)
  @MinLength(2)
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    description: "Tenant-unique department code, stored uppercase",
    example: "ENG",
    minLength: 2,
    maxLength: 20,
    pattern: "^[A-Z0-9][A-Z0-9-]{1,19}$",
  })
  @IsString()
  @Transform(trimUppercaseTransform)
  @MinLength(2)
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,19}$/)
  @MaxLength(20)
  code!: string;
}
