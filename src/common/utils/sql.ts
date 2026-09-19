/**
 * Safe SQL statement type detection.
 * Pure utility — no domain knowledge, no raw SQL/params inspection.
 */

export type SqlStatementType =
  "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "BEGIN" | "COMMIT" | "ROLLBACK" | "UNKNOWN";

const STATEMENT_PATTERN = /^\s*(SELECT|INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)/i;

/**
 * Extract the SQL statement type from a query string.
 * Trims leading whitespace logically, case-insensitive.
 * Never returns raw SQL or inspects bind parameters.
 */
export function getSqlStatementType(query: string): SqlStatementType {
  const match = STATEMENT_PATTERN.exec(query);

  return match ? (match[1].toUpperCase() as SqlStatementType) : "UNKNOWN";
}
