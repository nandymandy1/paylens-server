import { EmployeeStatus, EmploymentType } from "@prisma/client";

/** The single CSV/XLSX contract. Internal identifiers and compensation never cross this boundary. */
export const EMPLOYEE_INTERCHANGE_COLUMNS = [
  "Employee Number",
  "First Name",
  "Last Name",
  "Work Email",
  "Job Title",
  "Department",
  "Country",
  "Employment Type",
  "Employment Status",
  "Level",
  "Start Date",
  "Termination Date",
] as const;

export type EmployeeInterchangeColumn = (typeof EMPLOYEE_INTERCHANGE_COLUMNS)[number];

export type EmployeeInterchangeRow = Record<EmployeeInterchangeColumn, string>;

type EmployeeForInterchange = {
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string | null;
  jobTitle: string;
  level: string | null;
  countryCode: string;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  hireDate: Date;
  terminationDate: Date | null;
  department: { name: string };
};

const dateOnly = (value: Date | null): string => (value ? value.toISOString().slice(0, 10) : "");

export const toEmployeeInterchangeRow = (
  employee: EmployeeForInterchange,
): EmployeeInterchangeRow => ({
  "Employee Number": employee.employeeNumber,
  "First Name": employee.firstName,
  "Last Name": employee.lastName,
  "Work Email": employee.workEmail ?? "",
  "Job Title": employee.jobTitle,
  Department: employee.department.name,
  Country: employee.countryCode,
  "Employment Type": employee.employmentType,
  "Employment Status": employee.status,
  Level: employee.level ?? "",
  "Start Date": dateOnly(employee.hireDate),
  "Termination Date": dateOnly(employee.terminationDate),
});

/** Prevent CSV/XLSX cells controlled by users from becoming formulas when opened. */
export const escapeSpreadsheetCell = (value: string): string =>
  /^[=+\-@]/.test(value) ? `'${value}` : value;

export const normalizeDepartmentName = (value: string): string =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase();

export const normalizeInterchangeHeader = (value: string): string =>
  value.trim().toLocaleLowerCase();
