import { BadRequestException } from "@nestjs/common";
import {
  CURSOR_VERSION,
  DEFAULT_CURSOR_PAGE_LIMIT,
  MAX_CURSOR_PAGE_LIMIT,
} from "@/common/pagination/cursor-pagination.constants.js";
import type {
  CursorPage,
  CursorPayloadValidator,
} from "@/common/pagination/cursor-pagination.type.js";

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

const invalidCursor = (): BadRequestException =>
  new BadRequestException({
    code: "INVALID_CURSOR",
    message: "Invalid cursor.",
  });

const invalidLimit = (): BadRequestException =>
  new BadRequestException({
    code: "INVALID_PAGINATION_LIMIT",
    message: "Invalid pagination limit.",
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const encodeCursor = <TPayload>(payload: TPayload): string =>
  Buffer.from(JSON.stringify({ v: CURSOR_VERSION, data: payload }), "utf8").toString("base64url");

export const decodeCursor = <TPayload>(
  cursor: string,
  isPayload: CursorPayloadValidator<TPayload>,
): TPayload => {
  if (!base64UrlPattern.test(cursor)) throw invalidCursor();

  let decoded: unknown;

  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }

  if (
    !isRecord(decoded) ||
    decoded.v !== CURSOR_VERSION ||
    !("data" in decoded) ||
    !isPayload(decoded.data)
  ) {
    throw invalidCursor();
  }

  return decoded.data;
};

export const normalizeCursorLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_CURSOR_PAGE_LIMIT;

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CURSOR_PAGE_LIMIT) {
    throw invalidLimit();
  }

  return limit;
};

export const buildCursorPage = <T>({
  cursorFromItem,
  limit,
  rows,
}: {
  cursorFromItem: (item: T) => string;
  limit: number;
  rows: readonly T[];
}): CursorPage<T> => {
  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : [...rows];
  const lastItem = items.at(-1);

  return {
    items,
    pageInfo: {
      hasNextPage,
      nextCursor: hasNextPage && lastItem ? cursorFromItem(lastItem) : null,
    },
  };
};
