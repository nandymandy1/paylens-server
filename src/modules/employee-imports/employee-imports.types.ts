import type { EmployeeImportStatus, EmployeeTransferFormat } from "@prisma/client";

export type EmployeeImportSummary = {
  id: string;
  format: EmployeeTransferFormat;
  status: EmployeeImportStatus;
  originalFileName: string;
  totalRows: number;
  validatedRows: number;
  validRows: number;
  invalidRows: number;
  createRows: number;
  updateRows: number;
  unchangedRows: number;
  processedRows: number;
  createdRows: number;
  updatedRows: number;
  failedRows: number;
  createMissingDepartments: boolean;
  previewSummary: unknown;
  createdAt: Date;
  validatedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
};

export type ImportValidationError = {
  row: number;
  employeeNumber: string;
  column: string;
  errorCode: string;
  message: string;
};

export type ImportPreviewSummary = {
  totalRows: number;
  createRows: number;
  updateRows: number;
  unchangedRows: number;
  invalidRows: number;
  matchedDepartments: string[];
  missingDepartments: string[];
  warnings: string[];
  firstErrors: ImportValidationError[];
};
