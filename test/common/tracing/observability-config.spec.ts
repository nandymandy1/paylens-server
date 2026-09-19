import { describe, expect, it } from "vitest";
import {
  GLOBAL_THROTTLE_LIMIT,
  GLOBAL_THROTTLE_TTL_MS,
  SLOW_QUERY_THRESHOLD_MS,
} from "@/config/runtime.constants.js";

describe("runtime observability constants", () => {
  it("keeps global throttling and slow-query policy in code", () => {
    expect(GLOBAL_THROTTLE_LIMIT).toBe(200);
    expect(GLOBAL_THROTTLE_TTL_MS).toBe(60_000);
    expect(SLOW_QUERY_THRESHOLD_MS).toBe(100);
  });
});
