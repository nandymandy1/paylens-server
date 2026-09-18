import type { MembershipRoleName } from "@/modules/auth/constants/auth.constants.js";

export const EMPLOYEE_DIRECTORY_ROLES: readonly MembershipRoleName[] = [
  "TENANT_OWNER",
  "HR_ADMIN",
  "HR_MANAGER",
  "MANAGER",
  "VIEWER_AUDITOR",
];

/** Roles allowed to onboard employees (backend authoritative). */
export const EMPLOYEE_WRITE_ROLES: readonly MembershipRoleName[] = [
  "TENANT_OWNER",
  "HR_ADMIN",
  "HR_MANAGER",
];

/** Stable employee-onboarding error codes (AuthException body `code`). */
export const EMPLOYEE_ERROR_CODES = {
  EMPLOYEE_NUMBER_ALREADY_EXISTS: "EMPLOYEE_NUMBER_ALREADY_EXISTS",
  EMPLOYEE_EMAIL_ALREADY_EXISTS: "EMPLOYEE_EMAIL_ALREADY_EXISTS",
} as const;

export const EMPLOYEE_SORTS = ["lastName", "hireDate", "employeeNumber"] as const;

export type EmployeeSort = (typeof EMPLOYEE_SORTS)[number];

export const EMPLOYEE_DIRECTIONS = ["asc", "desc"] as const;

export type EmployeeDirection = (typeof EMPLOYEE_DIRECTIONS)[number];
