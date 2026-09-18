-- Phase 2 corrective: tenant-consistent Employee→Department FK + delete safety.
-- Fails safely if development rows already violate tenant ownership (never moves data).

DO $$
DECLARE
  violation_count integer;
BEGIN
  SELECT COUNT(*) INTO violation_count
  FROM "Employee" e
  LEFT JOIN "Department" d
    ON d."id" = e."departmentId"
    AND d."organizationId" = e."organizationId"
  WHERE d."id" IS NULL;

  IF violation_count > 0 THEN
    RAISE EXCEPTION 'Tenant integrity violation: % employee(s) reference a missing or cross-tenant department', violation_count;
  END IF;
END
$$;

-- Candidate key for the composite tenant-consistent reference.
ALTER TABLE "Department"
  ADD CONSTRAINT "Department_organizationId_id_key" UNIQUE ("organizationId", "id");

-- Replace single-column cascade FK with composite restrict FK.
ALTER TABLE "Employee" DROP CONSTRAINT "Employee_departmentId_fkey";

ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_organizationId_departmentId_fkey"
  FOREIGN KEY ("organizationId", "departmentId")
  REFERENCES "Department"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
