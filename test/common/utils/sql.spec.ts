import { describe, expect, it } from "vitest";
import { getSqlStatementType } from "@/common/utils/sql.js";

describe("getSqlStatementType", () => {
  it("extracts SELECT", () => {
    expect(getSqlStatementType("SELECT * FROM users")).toBe("SELECT");
  });

  it("extracts INSERT", () => {
    expect(getSqlStatementType("INSERT INTO logs (msg) VALUES ('test')")).toBe("INSERT");
  });

  it("extracts UPDATE", () => {
    expect(getSqlStatementType("UPDATE users SET name = 'x'")).toBe("UPDATE");
  });

  it("extracts DELETE", () => {
    expect(getSqlStatementType("DELETE FROM sessions")).toBe("DELETE");
  });

  it("extracts BEGIN", () => {
    expect(getSqlStatementType("BEGIN")).toBe("BEGIN");
  });

  it("extracts COMMIT", () => {
    expect(getSqlStatementType("COMMIT")).toBe("COMMIT");
  });

  it("extracts ROLLBACK", () => {
    expect(getSqlStatementType("ROLLBACK")).toBe("ROLLBACK");
  });

  it("is case-insensitive", () => {
    expect(getSqlStatementType("select * FROM users")).toBe("SELECT");
    expect(getSqlStatementType("insert INTO logs")).toBe("INSERT");
    expect(getSqlStatementType("Update users")).toBe("UPDATE");
    expect(getSqlStatementType("delete FROM sessions")).toBe("DELETE");
  });

  it("trims leading whitespace logically", () => {
    expect(getSqlStatementType("  select * FROM users")).toBe("SELECT");
    expect(getSqlStatementType("\n\tINSERT INTO logs")).toBe("INSERT");
  });

  it("returns UNKNOWN for empty string", () => {
    expect(getSqlStatementType("")).toBe("UNKNOWN");
  });

  it("returns UNKNOWN for unrecognized statements", () => {
    expect(getSqlStatementType("EXPLAIN ANALYZE SELECT 1")).toBe("UNKNOWN");
    expect(getSqlStatementType("WITH cte AS (SELECT 1)")).toBe("UNKNOWN");
    expect(getSqlStatementType("SHOW TABLES")).toBe("UNKNOWN");
  });

  it("never returns raw SQL", () => {
    const result = getSqlStatementType("SELECT * FROM users WHERE password = 'secret'");

    expect(result).not.toContain("password");
    expect(result).not.toContain("secret");
    expect(result).toBe("SELECT");
  });
});
