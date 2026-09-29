import { describe, expect, it } from "vitest";
import {
  formatPostgresError,
  toErrorLineColumn,
  toSingleResult,
} from "@/modules/sql-sandbox/utils/sql-sandbox.utils.js";

describe("toSingleResult", () => {
  it("passes single-statement results through", () => {
    const result = { command: "SELECT", fields: [], rowCount: 1, rows: [{ n: 1 }] };

    expect(toSingleResult(result)).toBe(result);
  });

  it("reports the final statement of multi-statement input", () => {
    const first = { command: "CREATE", fields: [], rowCount: null, rows: [] };
    const last = {
      command: "INSERT",
      fields: [{ dataTypeID: 23, name: "id" }],
      rowCount: 2,
      rows: [{ id: 1 }, { id: 2 }],
    };

    expect(toSingleResult([first, last])).toBe(last);
  });
});

describe("toErrorLineColumn", () => {
  it("maps a 1-based offset to line and column", () => {
    expect(toErrorLineColumn("SELECT 1\nFROM x", 10)).toEqual({ column: 1, line: 2 });
    expect(toErrorLineColumn("SELECT 1", 8)).toEqual({ column: 8, line: 1 });
  });

  it("returns null for missing or invalid positions", () => {
    expect(toErrorLineColumn("SELECT 1", null)).toBeNull();
    expect(toErrorLineColumn("SELECT 1", 0)).toBeNull();
    expect(toErrorLineColumn("SELECT 1", Number.NaN)).toBeNull();
  });
});

describe("formatPostgresError", () => {
  it("surfaces message, SQLSTATE, location, detail, and hint", () => {
    const message = formatPostgresError(
      {
        code: "42601",
        detail: undefined,
        hint: "Did you mean something else?",
        message: 'syntax error at or near "FORM"',
        position: "15",
      },
      'SELECT *\nFORM "Employee"',
    );

    expect(message).toContain('syntax error at or near "FORM"');
    expect(message).toContain("SQLSTATE 42601");
    expect(message).toContain("LINE 2, COLUMN 6");
    expect(message).toContain("HINT: Did you mean something else?");
  });

  it("falls back gracefully for unknown errors", () => {
    expect(formatPostgresError(null, "SELECT 1")).toBe("PostgreSQL returned an unknown error.");
    expect(formatPostgresError(new Error("boom"), "SELECT 1")).toBe("boom");
  });
});
