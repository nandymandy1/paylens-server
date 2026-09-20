import {
  normalizeDepartmentName,
  EMPLOYEE_INTERCHANGE_COLUMNS,
} from "@/modules/employee-transfer/employee-interchange.js";

export type CanonicalImportColumn = (typeof EMPLOYEE_INTERCHANGE_COLUMNS)[number];

const CANONICAL_BY_LOWER = new Map<string, CanonicalImportColumn>(
  EMPLOYEE_INTERCHANGE_COLUMNS.map((column) => [column.toLocaleLowerCase(), column]),
);

// Conservative deterministic aliases for the headers real HR sheets use.
// Anything not matched here (or by AI) still flows into the existing
// validation error report — never into a blind import.
const HEADER_ALIASES: Record<string, CanonicalImportColumn> = {
  "employee id": "Employee Number",
  "employee no": "Employee Number",
  "emp no": "Employee Number",
  "emp number": "Employee Number",
  "employee code": "Employee Number",
  "staff id": "Employee Number",
  firstname: "First Name",
  first_name: "First Name",
  "given name": "First Name",
  lastname: "Last Name",
  last_name: "Last Name",
  "family name": "Last Name",
  surname: "Last Name",
  email: "Work Email",
  "e-mail": "Work Email",
  "email address": "Work Email",
  "work mail": "Work Email",
  "official email": "Work Email",
  designation: "Job Title",
  role: "Job Title",
  position: "Job Title",
  "job role": "Job Title",
  title: "Job Title",
  dept: "Department",
  "department name": "Department",
  division: "Department",
  team: "Department",
  "country code": "Country",
  nation: "Country",
  "employee type": "Employment Type",
  employment: "Employment Type",
  "job type": "Employment Type",
  "work type": "Employment Type",
  status: "Employment Status",
  "employee status": "Employment Status",
  "job status": "Employment Status",
  grade: "Level",
  band: "Level",
  doj: "Start Date",
  "date of joining": "Start Date",
  "hire date": "Start Date",
  "joining date": "Start Date",
  "join date": "Start Date",
  "employment date": "Start Date",
  "last date": "Termination Date",
  "exit date": "Termination Date",
  "relieving date": "Termination Date",
  "date of exit": "Termination Date",
  "end date": "Termination Date",
  "leaving date": "Termination Date",
};

export const normalizeImportHeader = (value: string): string =>
  // Strip a leading BOM: Excel-saved CSVs start the first header with U+FEFF,
  // which otherwise breaks the "Employee Number" required-header match.
  value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLocaleLowerCase();

export const resolveDeterministicHeader = (header: string): CanonicalImportColumn | null => {
  const normalized = normalizeImportHeader(header);

  return CANONICAL_BY_LOWER.get(normalized) ?? HEADER_ALIASES[normalized] ?? null;
};

// Advisory-only extra target: a sheet may carry a department code column.
// It is never required and never flows into employee fields — it only
// proposes the code used when that department is auto-created, after strict
// format validation. Anything invalid becomes a row error, never a guess.
export const DEPARTMENT_CODE_HEADER = "Department Code";

export type HeaderTarget = CanonicalImportColumn | typeof DEPARTMENT_CODE_HEADER;

const toHeaderTarget = (
  candidate: unknown,
  extraTargets: readonly string[],
): HeaderTarget | null => {
  if (typeof candidate !== "string") return null;

  const canonical = CANONICAL_BY_LOWER.get(candidate.toLocaleLowerCase());

  if (canonical) return canonical;

  const extra = extraTargets.find(
    (target) => target.toLocaleLowerCase() === candidate.toLocaleLowerCase(),
  );

  return (extra ?? null) as HeaderTarget | null;
};

/** Prompt builder: ONLY the given header strings are sent — never row data. */
export const buildHeaderMappingPrompt = (
  unknownHeaders: string[],
  extraTargets: readonly string[] = [],
): { system: string; user: { headers: string[] } } => ({
  system: `Map each spreadsheet column header to exactly one of these canonical columns: ${[...EMPLOYEE_INTERCHANGE_COLUMNS, ...extraTargets].join(", ")}. Use null when nothing fits. Reply with only JSON shaped like {"mapping": {"<input header>": "<canonical column>"}}.`,
  user: { headers: unknownHeaders },
});

/** Strict allowlist validation of the model answer. */
export const parseHeaderMappingResponse = (
  raw: unknown,
  unknownHeaders: string[],
  extraTargets: readonly string[] = [],
): Record<string, HeaderTarget | null> => {
  const result: Record<string, HeaderTarget | null> = {};
  const mapping =
    typeof raw === "object" && raw !== null ? ((raw as { mapping?: unknown }).mapping ?? {}) : {};

  for (const header of unknownHeaders) {
    const candidate =
      typeof mapping === "object" && mapping !== null
        ? (mapping as Record<string, unknown>)[header]
        : undefined;

    result[header] = toHeaderTarget(candidate, extraTargets);
  }

  return result;
};

// ---------------------------------------------------------------------------
// Departments. Same outbound rule as headers: only distinct department name
// strings are sent — never employee rows, never linked to any employee.
// The AI answer only proposes the display name + code used when a missing
// department is auto-created; every proposal is re-validated here and falls
// back to the deterministic generator when invalid.
// ---------------------------------------------------------------------------

export const DEPARTMENT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

export const isValidDepartmentCode = (value: string): boolean =>
  DEPARTMENT_CODE_PATTERN.test(value);

export type DepartmentPlanEntry = {
  /** Exact distinct string as seen in the sheet. */
  from: string;
  /** Canonical display name to create. */
  name: string;
  /** Validated department code to create. */
  code: string;
  source: "ai" | "sheet" | "generated";
};

export const MAX_AI_DEPARTMENT_NAMES = 100;

export const buildDepartmentPrompt = (
  distinctNames: string[],
): { system: string; user: { departments: string[] } } => ({
  system:
    'Normalize each department name variant to a canonical display name plus a short uppercase code (letters, digits, dashes, 2-20 chars, starting with a letter or digit). Reply with only JSON shaped like {"departments": {"<input name>": {"name": "<canonical>", "code": "<CODE>"}}}.',
  user: {
    departments: [...new Set(distinctNames.map((name) => name.trim()).filter(Boolean))].slice(
      0,
      MAX_AI_DEPARTMENT_NAMES,
    ),
  },
});

export const parseDepartmentResponse = (
  raw: unknown,
  distinctNames: string[],
): Record<string, { name: string; code: string }> => {
  const bounded = [...new Set(distinctNames.map((name) => name.trim()).filter(Boolean))].slice(
    0,
    MAX_AI_DEPARTMENT_NAMES,
  );
  const result: Record<string, { name: string; code: string }> = {};
  const departments =
    typeof raw === "object" && raw !== null
      ? ((raw as { departments?: unknown }).departments ?? {})
      : {};

  for (const from of bounded) {
    const candidate =
      typeof departments === "object" && departments !== null
        ? (departments as Record<string, { name?: unknown; code?: unknown }>)[from]
        : undefined;
    const name = typeof candidate?.name === "string" ? candidate.name.trim() : "";
    const code = typeof candidate?.code === "string" ? candidate.code.trim().toUpperCase() : "";

    if (name && name.length <= 100 && isValidDepartmentCode(code)) result[from] = { name, code };
  }

  return result;
};

/** Re-validate a persisted validate-phase plan before apply trusts it. */
export const readDepartmentPlan = (summary: unknown): Map<string, DepartmentPlanEntry> => {
  const plan = new Map<string, DepartmentPlanEntry>();

  if (!summary || typeof summary !== "object") return plan;

  const entries = (summary as { departmentPlan?: unknown }).departmentPlan;

  if (!Array.isArray(entries)) return plan;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    const { from, name, code, source } = entry as Record<string, unknown>;

    if (
      typeof from !== "string" ||
      typeof name !== "string" ||
      typeof code !== "string" ||
      !name.trim() ||
      name.trim().length > 100 ||
      !isValidDepartmentCode(code)
    )
      continue;

    plan.set(normalizeDepartmentName(from), {
      from,
      code,
      name: name.trim(),
      source: source === "ai" || source === "sheet" ? source : "generated",
    });
  }

  return plan;
};
