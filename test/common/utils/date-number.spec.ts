import { describe, expect, it } from "vitest";
import {
  daysFromNow,
  hoursFromNow,
  isExpired,
  minutesFromNow,
  secondsFromNow,
  toDateOnly,
} from "@/common/utils/date.js";
import { toMoneyString } from "@/common/utils/number.js";

describe("date utilities", () => {
  it("serializes UTC date-only days", () => {
    expect(toDateOnly(new Date("2026-01-05T22:00:00.000Z"))).toBe("2026-01-05");
  });

  it("builds future instants and detects expiry", () => {
    expect(secondsFromNow(60).getTime()).toBeGreaterThan(Date.now());
    expect(minutesFromNow(1).getTime()).toBeGreaterThan(Date.now());
    expect(hoursFromNow(1).getTime()).toBeGreaterThan(Date.now());
    expect(daysFromNow(1).getTime()).toBeGreaterThan(Date.now());
    expect(isExpired(new Date(Date.now() - 1000))).toBe(true);
    expect(isExpired(new Date(Date.now() + 60_000))).toBe(false);
  });
});

describe("toMoneyString", () => {
  it("preserves decimal precision as strings", () => {
    expect(toMoneyString("1850000")).toBe("1850000.00");
    expect(toMoneyString("1850000.1")).toBe("1850000.10");
    expect(toMoneyString(null)).toBe("0.00");
  });
});
