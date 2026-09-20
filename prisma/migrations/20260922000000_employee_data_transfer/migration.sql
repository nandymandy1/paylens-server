-- EMP-DATA-IO-R1: Department identity must be deterministic before imports
-- may create tenant-scoped departments.  The generated key implements trim,
-- whitespace collapse, and case-insensitive matching at the database boundary.
ALTER TABLE "Department"
  ADD COLUMN "normalizedName" TEXT GENERATED ALWAYS AS (
    lower(regexp_replace(btrim("name"), '\\s+', ' ', 'g'))
  ) STORED;

CREATE UNIQUE INDEX "Department_organizationId_normalizedName_key"
  ON "Department"("organizationId", "normalizedName");

CREATE TYPE "EmployeeTransferFormat" AS ENUM ('CSV', 'XLSX');
CREATE TYPE "EmployeeExportStatus" AS ENUM (
  'QUEUED', 'PROCESSING', 'PAUSING', 'PAUSED', 'CANCELLING', 'CANCELLED',
  'FINALIZING', 'COMPLETED', 'FAILED', 'EXPIRED'
);
CREATE TYPE "EmployeeImportStatus" AS ENUM (
  'AWAITING_UPLOAD', 'QUEUED', 'VALIDATING', 'PAUSING', 'PAUSED',
  'READY_FOR_REVIEW', 'APPLY_QUEUED', 'APPLYING', 'CANCELLING', 'CANCELLED',
  'CANCELLED_PARTIAL', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'EXPIRED'
);

CREATE TABLE "EmployeeExport" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "format" "EmployeeTransferFormat" NOT NULL,
  "status" "EmployeeExportStatus" NOT NULL DEFAULT 'QUEUED',
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "processedRows" INTEGER NOT NULL DEFAULT 0,
  "progressPercent" INTEGER NOT NULL DEFAULT 0,
  "lastProcessedEmployeeId" TEXT,
  "nextBatchNumber" INTEGER NOT NULL DEFAULT 1,
  "finalObjectKey" TEXT,
  "fileName" TEXT,
  "fileSizeBytes" INTEGER,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeExport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeExport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EmployeeExport_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "EmployeeExport_organizationId_requestedByUserId_createdAt_idx"
  ON "EmployeeExport"("organizationId", "requestedByUserId", "createdAt");
CREATE INDEX "EmployeeExport_organizationId_status_createdAt_idx"
  ON "EmployeeExport"("organizationId", "status", "createdAt");

CREATE TABLE "EmployeeImport" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "requestedByUserId" TEXT NOT NULL,
  "format" "EmployeeTransferFormat" NOT NULL,
  "status" "EmployeeImportStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',
  "originalFileName" TEXT NOT NULL,
  "sourceObjectKey" TEXT NOT NULL,
  "normalizedPrefix" TEXT,
  "validationReportObjectKey" TEXT,
  "applyReportObjectKey" TEXT,
  "totalRows" INTEGER NOT NULL DEFAULT 0,
  "validatedRows" INTEGER NOT NULL DEFAULT 0,
  "validRows" INTEGER NOT NULL DEFAULT 0,
  "invalidRows" INTEGER NOT NULL DEFAULT 0,
  "createRows" INTEGER NOT NULL DEFAULT 0,
  "updateRows" INTEGER NOT NULL DEFAULT 0,
  "unchangedRows" INTEGER NOT NULL DEFAULT 0,
  "processedRows" INTEGER NOT NULL DEFAULT 0,
  "createdRows" INTEGER NOT NULL DEFAULT 0,
  "updatedRows" INTEGER NOT NULL DEFAULT 0,
  "failedRows" INTEGER NOT NULL DEFAULT 0,
  "lastProcessedRow" INTEGER NOT NULL DEFAULT 0,
  "nextBatchNumber" INTEGER NOT NULL DEFAULT 1,
  "createMissingDepartments" BOOLEAN NOT NULL DEFAULT false,
  "previewSummary" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploadedAt" TIMESTAMP(3),
  "validatedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeImport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeImport_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EmployeeImport_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "EmployeeImport_organizationId_requestedByUserId_createdAt_idx"
  ON "EmployeeImport"("organizationId", "requestedByUserId", "createdAt");
CREATE INDEX "EmployeeImport_organizationId_status_createdAt_idx"
  ON "EmployeeImport"("organizationId", "status", "createdAt");
