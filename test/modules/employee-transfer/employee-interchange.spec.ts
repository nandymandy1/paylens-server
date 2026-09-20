import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_INTERCHANGE_COLUMNS,
  escapeSpreadsheetCell,
  normalizeDepartmentName,
  toEmployeeInterchangeRow,
} from "@/modules/employee-transfer/employee-interchange.js";

const employee = () => ({
  employeeNumber: "EMP-1001",
  firstName: "Narendra",
  lastName: "Maurya",
  workEmail: "Narendra.Maurya@acme.example",
  jobTitle: "Engineer, Platform",
  level: null,
  countryCode: "IN",
  employmentType: "FULL_TIME",
  status: "ACTIVE",
  hireDate: new Date("2022-03-01T00:00:00.000Z"),
  terminationDate: null,
  department: { name: "Engineering" },
});

describe("employee interchange contract", () => {
  it("maps one canonical row used by CSV export, XLSX export, and import", () => {
    const row = toEmployeeInterchangeRow(employee() as never);

    expect(row["Employee Number"]).toBe("EMP-1001");
    expect(row.Department).toBe("Engineering");
    expect(row["Start Date"]).toBe("2022-03-01");
    expect(row["Termination Date"]).toBe("");
    expect(row["Work Email"]).toBe("Narendra.Maurya@acme.example");
    expect(Object.keys(row)).toEqual([...EMPLOYEE_INTERCHANGE_COLUMNS]);
  });

  it("never exposes internal identifiers or compensation", () => {
    const columns = [...EMPLOYEE_INTERCHANGE_COLUMNS].join("|");

    for (const forbidden of [
      "organizationId",
      "departmentId",
      "salary",
      "compensation",
      "userId",
    ]) {
      expect(columns.toLocaleLowerCase()).not.toContain(forbidden);
    }
  });

  it("escapes spreadsheet formula prefixes", () => {
    expect(escapeSpreadsheetCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(escapeSpreadsheetCell("+123")).toBe("'+123");
    expect(escapeSpreadsheetCell("-5")).toBe("'-5");
    expect(escapeSpreadsheetCell("@mention")).toBe("'@mention");
    expect(escapeSpreadsheetCell("Engineering")).toBe("Engineering");
  });

  it("normalizes department names deterministically for import resolution", () => {
    expect(normalizeDepartmentName(" Engineering ")).toBe("engineering");
    expect(normalizeDepartmentName("ENGINEERING")).toBe("engineering");
    expect(normalizeDepartmentName("Field   Operations")).toBe("field operations");
  });

  it("keeps employee number usable as the tenant-scoped import key", () => {
    const updated = { ...employee(), jobTitle: "Senior Engineer" };
    const before = toEmployeeInterchangeRow(employee() as never);
    const after = toEmployeeInterchangeRow(updated as never);

    expect(after["Employee Number"]).toBe(before["Employee Number"]);
    expect(after["Job Title"]).not.toBe(before["Job Title"]);
  });
});
