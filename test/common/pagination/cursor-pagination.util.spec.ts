import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CURSOR_PAGE_LIMIT,
  MAX_CURSOR_PAGE_LIMIT,
} from "@/common/pagination/cursor-pagination.constants.js";
import {
  buildCursorPage,
  decodeCursor,
  encodeCursor,
  normalizeCursorLimit,
} from "@/common/pagination/cursor-pagination.util.js";

type ExampleCursor = { id: string; value: string };

const isExampleCursor = (value: unknown): value is ExampleCursor =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "value" in value &&
  typeof value.value === "string";

describe("cursor pagination", () => {
  it("encodes URL-safe, versioned cursors without losing typed values", () => {
    const payload = { id: "row_1", value: "2400000.00" };
    const cursor = encodeCursor(payload);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, isExampleCursor)).toEqual(payload);
  });

  it.each(["%%%", "not-json", encodeCursor({ v: 2, data: { id: "a" } })])(
    "rejects malformed or unsupported cursors",
    (cursor) => {
      expect(() => decodeCursor(cursor, isExampleCursor)).toThrow(BadRequestException);
      expect(() => decodeCursor(cursor, isExampleCursor)).toThrow("Invalid cursor.");
    },
  );

  it("uses a bounded default limit and rejects invalid limits", () => {
    expect(normalizeCursorLimit(undefined)).toBe(DEFAULT_CURSOR_PAGE_LIMIT);
    expect(normalizeCursorLimit(MAX_CURSOR_PAGE_LIMIT)).toBe(MAX_CURSOR_PAGE_LIMIT);
    expect(() => normalizeCursorLimit(0)).toThrow(BadRequestException);
    expect(() => normalizeCursorLimit(MAX_CURSOR_PAGE_LIMIT + 1)).toThrow(BadRequestException);
  });

  it("returns no next cursor when rows are fewer than or equal to the limit", () => {
    expect(buildCursorPage({ rows: ["a"], limit: 2, cursorFromItem: (item) => item })).toEqual({
      items: ["a"],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });
    expect(buildCursorPage({ rows: ["a", "b"], limit: 2, cursorFromItem: (item) => item })).toEqual(
      {
        items: ["a", "b"],
        pageInfo: { hasNextPage: false, nextCursor: null },
      },
    );
  });

  it("trims the limit-plus-one row and derives the cursor from the last returned item", () => {
    expect(
      buildCursorPage({
        rows: ["a", "b", "extra"],
        limit: 2,
        cursorFromItem: (item) => `cursor-${item}`,
      }),
    ).toEqual({
      items: ["a", "b"],
      pageInfo: { hasNextPage: true, nextCursor: "cursor-b" },
    });
  });
});
