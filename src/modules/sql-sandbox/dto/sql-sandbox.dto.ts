import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";

export class ExecuteSqlSandboxDto {
  @ApiProperty({
    description:
      "Raw SQL executed directly against the local disposable database. " +
      "Multi-statement input runs as sent; the final statement result is returned.",
    example: 'SELECT e."firstName" FROM "Employee" e LIMIT 10;',
  })
  @IsString()
  @IsNotEmpty({ message: "Provide a SQL statement to execute." })
  @MaxLength(200_000, { message: "Query exceeds the 200,000 character sandbox limit." })
  query!: string;
}
