-- Compensation and its history are financial evidence. A service precheck gives
-- callers a friendly conflict, while these RESTRICT constraints close the race
-- between that precheck and the employee delete.
ALTER TABLE "EmployeeCompensation"
  DROP CONSTRAINT "EmployeeCompensation_employeeId_fkey",
  ADD CONSTRAINT "EmployeeCompensation_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CompensationHistory"
  DROP CONSTRAINT "CompensationHistory_employeeId_fkey",
  ADD CONSTRAINT "CompensationHistory_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
