import type { MembershipRoleName } from "@/modules/auth/constants/auth.constants.js";

/** Roles allowed to read departments (workforce-read policy, backend authoritative). */
export const DEPARTMENT_READ_ROLES: readonly MembershipRoleName[] = [
  "TENANT_OWNER",
  "HR_ADMIN",
  "HR_MANAGER",
  "MANAGER",
  "VIEWER_AUDITOR",
];

/** Roles allowed to create, update, and delete departments (backend authoritative). */
export const DEPARTMENT_WRITE_ROLES: readonly MembershipRoleName[] = [
  "TENANT_OWNER",
  "HR_ADMIN",
  "HR_MANAGER",
];

/** Stable department-domain error codes (AuthException body `code`). */
export const DEPARTMENT_ERROR_CODES = {
  DEPARTMENT_NOT_FOUND: "DEPARTMENT_NOT_FOUND",
  DEPARTMENT_CODE_ALREADY_EXISTS: "DEPARTMENT_CODE_ALREADY_EXISTS",
  DEPARTMENT_IN_USE: "DEPARTMENT_IN_USE",
} as const;
