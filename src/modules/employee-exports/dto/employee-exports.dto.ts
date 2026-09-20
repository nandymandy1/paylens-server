import { EmployeeTransferFormat } from "@prisma/client";
import { IsEnum } from "class-validator";

export class CreateEmployeeExportDto {
  @IsEnum(EmployeeTransferFormat)
  format!: EmployeeTransferFormat;
}
