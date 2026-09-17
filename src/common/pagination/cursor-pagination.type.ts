import { CURSOR_VERSION } from "@/common/pagination/cursor-pagination.constants.js";

export type CursorEnvelope<TPayload> = {
  v: typeof CURSOR_VERSION;
  data: TPayload;
};

export type CursorPage<T> = {
  items: T[];
  pageInfo: {
    nextCursor: string | null;
    hasNextPage: boolean;
  };
};

export type CursorPayloadValidator<TPayload> = (payload: unknown) => payload is TPayload;
