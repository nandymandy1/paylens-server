import { describe, expect, it, vi } from "vitest";
import {
  COMPENSATION_BATCH_SIZE,
  EMPLOYEE_BATCH_SIZE,
  HISTORY_BATCH_SIZE,
  SEED_RECONCILE_BATCH_SIZE,
  ROLLBACK_BATCH_SIZE,
} from "@/seed/constants.js";
import { chunks, runBatches } from "@/seed/runner.js";

describe("SEED-R1 bounded batching", () => {
  it("keeps one centralized batch-size policy at 500 rows", () => {
    expect(EMPLOYEE_BATCH_SIZE).toBe(500);
    expect(COMPENSATION_BATCH_SIZE).toBe(500);
    expect(HISTORY_BATCH_SIZE).toBe(500);
    expect(SEED_RECONCILE_BATCH_SIZE).toBe(500);
    expect(ROLLBACK_BATCH_SIZE).toBe(500);
  });

  it("splits 1,200 seed-owned IDs into 500/500/200 without giant deletes", async () => {
    const ids = Array.from({ length: 1_200 }, (_, index) => `seed-employee-${index}`);
    const seen: number[] = [];
    const operation = vi.fn(async (batch: string[]) => {
      seen.push(batch.length);
    });
    const batches = await runBatches("test", ids, SEED_RECONCILE_BATCH_SIZE, operation);

    expect(batches).toBe(3);
    expect(seen).toEqual([500, 500, 200]);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("chunks an empty workforce into zero batches", async () => {
    const operation = vi.fn(async () => {});
    const batches = await runBatches("test", [], SEED_RECONCILE_BATCH_SIZE, operation);

    expect(batches).toBe(0);
    expect(operation).not.toHaveBeenCalled();
  });

  it("chunks boundaries deterministically", () => {
    expect(chunks([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
    expect(
      chunks(
        Array.from({ length: 1_000 }, (_, i) => i),
        500,
      ),
    ).toHaveLength(2);
    expect(
      chunks(
        Array.from({ length: 501 }, (_, i) => i),
        500,
      ).map((c) => c.length),
    ).toEqual([500, 1]);
  });
});
