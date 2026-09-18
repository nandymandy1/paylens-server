import type {
  EmployeeDirection,
  EmployeeSort,
} from "@/modules/employees/constants/employees.constants.js";

export type EmployeeListQuery = {
  search?: string;
  departmentId?: string;
  countryCode?: string;
  status?: string;
  employmentType?: string;
  sort: EmployeeSort;
  direction: EmployeeDirection;
  cursor?: string;
  limit?: number;
};

type EmployeeCursorContext = {
  fingerprint: string;
};

export type EmployeeNameCursor = EmployeeCursorContext & {
  lastName: string;
  id: string;
};

export type EmployeeHireDateCursor = EmployeeCursorContext & {
  hireDate: string;
  id: string;
};

export type EmployeeNumberCursor = EmployeeCursorContext & {
  employeeNumber: string;
  id: string;
};

export type EmployeeCursorPayload =
  EmployeeNameCursor | EmployeeHireDateCursor | EmployeeNumberCursor;

export type EmployeeListItem = {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string | null;
  department: {
    id: string;
    code: string;
    name: string;
  };
  jobTitle: string;
  level: string | null;
  countryCode: string;
  employmentType: string;
  status: string;
  hireDate: string;
};

export type EmployeeDetail = {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string | null;
  department: {
    id: string;
    code: string;
    name: string;
  };
  jobTitle: string;
  level: string | null;
  countryCode: string;
  employmentType: string;
  status: string;
  hireDate: string;
  terminationDate: string | null;
  createdAt: string;
  updatedAt: string;
};
