/** Minimal structural view of a node-postgres result (single or multi-statement). */
export type SandboxRawResult = {
  command: string;
  fields: { dataTypeID: number; name: string }[];
  rowCount: number | null;
  rows: Record<string, unknown>[];
};

/**
 * node-postgres resolves multi-statement input with one result per statement;
 * the sandbox reports the final statement's result.
 */
export const toSingleResult = (raw: SandboxRawResult | SandboxRawResult[]): SandboxRawResult =>
  Array.isArray(raw) ? raw[raw.length - 1] : raw;

type PostgresErrorLike = {
  code?: unknown;
  detail?: unknown;
  hint?: unknown;
  message?: unknown;
  position?: unknown;
  where?: unknown;
};

export type SqlErrorLocation = {
  column: number;
  line: number;
};

/** Translates a PostgreSQL 1-based character offset into a line/column pair. */
export const toErrorLineColumn = (
  sql: string,
  position: number | null,
): SqlErrorLocation | null => {
  if (position === null || !Number.isInteger(position) || position < 1) {
    return null;
  }

  const offset = Math.min(position, sql.length + 1);
  const before = sql.slice(0, offset - 1);
  const line = before.split("\n").length;
  const column = offset - (before.lastIndexOf("\n") + 1);

  return { column, line };
};

const asText = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const asPosition = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  return null;
};

/**
 * Builds a multi-line, learning-friendly message from a native PostgreSQL
 * error. Kept as a single string because the global exception filter only
 * surfaces `code` + `message` on error responses.
 */
export const formatPostgresError = (error: unknown, sql: string): string => {
  if (typeof error !== "object" || error === null) {
    return "PostgreSQL returned an unknown error.";
  }

  const pgError = error as PostgresErrorLike;
  const lines: string[] = [asText(pgError.message) ?? "PostgreSQL returned an error."];
  const code = asText(pgError.code);

  if (code) {
    lines.push(`SQLSTATE ${code}`);
  }

  const location = toErrorLineColumn(sql, asPosition(pgError.position));

  if (location) {
    lines.push(`LINE ${location.line}, COLUMN ${location.column}`);
  }

  const detail = asText(pgError.detail);
  const hint = asText(pgError.hint);
  const where = asText(pgError.where);

  if (detail) {
    lines.push(`DETAIL: ${detail}`);
  }

  if (hint) {
    lines.push(`HINT: ${hint}`);
  }

  if (where) {
    lines.push(`WHERE: ${where}`);
  }

  return lines.join("\n");
};
