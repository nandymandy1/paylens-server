-- Prisma cannot model PostgreSQL functional pattern indexes. SEARCH-R1 uses
-- LOWER(column) LIKE 'prefix%' for tenant-scoped, case-insensitive directory search.
CREATE INDEX "employee_org_first_name_prefix_idx"
  ON "Employee" ("organizationId", LOWER("firstName") text_pattern_ops);

CREATE INDEX "employee_org_last_name_prefix_idx"
  ON "Employee" ("organizationId", LOWER("lastName") text_pattern_ops);

CREATE INDEX "employee_org_work_email_prefix_idx"
  ON "Employee" ("organizationId", LOWER("workEmail") text_pattern_ops)
  WHERE "workEmail" IS NOT NULL;

CREATE INDEX "employee_org_employee_number_prefix_idx"
  ON "Employee" ("organizationId", LOWER("employeeNumber") text_pattern_ops);
