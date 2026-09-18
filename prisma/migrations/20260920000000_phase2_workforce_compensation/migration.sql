-- Phase 2: organization-scoped workforce and compensation foundations.

CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN');
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'TERMINATED');
CREATE TYPE "CompensationChangeReason" AS ENUM ('INITIAL', 'ANNUAL_REVIEW', 'PROMOTION', 'MARKET_ADJUSTMENT', 'CORRECTION', 'OTHER');

CREATE TABLE "Department" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Department_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Department_organizationId_code_key" ON "Department"("organizationId", "code");
CREATE INDEX "Department_organizationId_name_id_idx" ON "Department"("organizationId", "name", "id");

CREATE TABLE "Employee" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "employeeNumber" TEXT NOT NULL,
  "firstName" TEXT NOT NULL,
  "lastName" TEXT NOT NULL,
  "workEmail" TEXT,
  "jobTitle" TEXT NOT NULL,
  "level" TEXT,
  "countryCode" VARCHAR(2) NOT NULL,
  "employmentType" "EmploymentType" NOT NULL,
  "status" "EmployeeStatus" NOT NULL,
  "hireDate" DATE NOT NULL,
  "terminationDate" DATE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Employee_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Employee_organizationId_employeeNumber_key" ON "Employee"("organizationId", "employeeNumber");
CREATE UNIQUE INDEX "Employee_organizationId_workEmail_key" ON "Employee"("organizationId", "workEmail");
CREATE INDEX "Employee_organizationId_status_lastName_id_idx" ON "Employee"("organizationId", "status", "lastName", "id");
CREATE INDEX "Employee_organizationId_departmentId_lastName_id_idx" ON "Employee"("organizationId", "departmentId", "lastName", "id");
CREATE INDEX "Employee_organizationId_countryCode_lastName_id_idx" ON "Employee"("organizationId", "countryCode", "lastName", "id");

CREATE TABLE "EmployeeCompensation" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "annualBaseSalary" DECIMAL(19, 2) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmployeeCompensation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeCompensation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EmployeeCompensation_annualBaseSalary_nonnegative" CHECK ("annualBaseSalary" >= 0),
  CONSTRAINT "EmployeeCompensation_version_positive" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "EmployeeCompensation_employeeId_key" ON "EmployeeCompensation"("employeeId");
CREATE INDEX "EmployeeCompensation_annualBaseSalary_id_idx" ON "EmployeeCompensation"("annualBaseSalary", "id");

CREATE TABLE "CompensationHistory" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "previousAnnualBaseSalary" DECIMAL(19, 2),
  "newAnnualBaseSalary" DECIMAL(19, 2) NOT NULL,
  "previousCurrency" VARCHAR(3),
  "newCurrency" VARCHAR(3) NOT NULL,
  "previousEffectiveFrom" DATE,
  "effectiveFrom" DATE NOT NULL,
  "reason" "CompensationChangeReason" NOT NULL,
  "note" TEXT,
  "changedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompensationHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CompensationHistory_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CompensationHistory_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "CompensationHistory_newAnnualBaseSalary_nonnegative" CHECK ("newAnnualBaseSalary" >= 0),
  CONSTRAINT "CompensationHistory_previousAnnualBaseSalary_nonnegative" CHECK ("previousAnnualBaseSalary" IS NULL OR "previousAnnualBaseSalary" >= 0),
  CONSTRAINT "CompensationHistory_version_positive" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "CompensationHistory_employeeId_version_key" ON "CompensationHistory"("employeeId", "version");
CREATE INDEX "CompensationHistory_employeeId_effectiveFrom_id_idx" ON "CompensationHistory"("employeeId", "effectiveFrom", "id");
