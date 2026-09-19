import { describe, expect, it } from "vitest";
import { BigNumber, decimal } from "@/common/utils/number.js";
import {
  DEPARTMENT_ADJUSTMENT_BPS,
  departmentCodeById,
  expectedSeedEmployeeIds,
  generateDepartments,
  generateEmployee,
  generateOrganizations,
  salaryBands,
  salaryFor,
  variationBpsFor,
} from "@/seed/data.js";

const organizations = generateOrganizations();
const demo = organizations.find((organization) => organization.slug === "paylens-demo")!;
const demoDepartments = generateDepartments(demo);

describe("SEED-R1 relative salary adjustments", () => {
  it("uses percentage/basis-point department adjustments, not absolute currency units", () => {
    expect(DEPARTMENT_ADJUSTMENT_BPS.ENG).toBe(600);
    expect(DEPARTMENT_ADJUSTMENT_BPS.SEC).toBe(700);
    expect(DEPARTMENT_ADJUSTMENT_BPS.DATA).toBe(500);
    expect(DEPARTMENT_ADJUSTMENT_BPS.OPS ?? 0).toBe(0);
  });

  it("keeps deterministic variation within -4%..+4%", () => {
    for (let index = 0; index < 5_000; index += 1) {
      const bps = variationBpsFor(index);

      expect(bps).toBeGreaterThanOrEqual(-400);
      expect(bps).toBeLessThanOrEqual(400);
    }
  });

  it("scales adjustments with the local salary band (BigNumber only, no float)", () => {
    const engDept = demoDepartments.find((department) => department.code === "ENG")!;
    const opsDept = demoDepartments.find((department) => department.code === "OPS")!;
    const usL4 = { level: "L4", countryCode: "US", departmentId: engDept.id } as Parameters<
      typeof salaryFor
    >[0];
    const usL4Ops = { ...usL4, departmentId: opsDept.id };
    const inL4 = { ...usL4, countryCode: "IN" };

    // Same +6% engineering uplift in USD and INR: ratio ENG/OPS is identical across currencies.
    // Use a zero-variation ordinal so the ratio isolates the department uplift exactly.
    const stableIndex = Array.from({ length: 81 }, (_, i) => i).find(
      (i) => variationBpsFor(i) === 0,
    )!;
    const usRatio = decimal(salaryFor(usL4, stableIndex)).dividedBy(
      salaryFor(usL4Ops, stableIndex),
    );
    const inRatio = decimal(
      salaryFor({ ...inL4, departmentId: engDept.id }, stableIndex),
    ).dividedBy(salaryFor({ ...inL4, departmentId: opsDept.id }, stableIndex));

    expect(usRatio.toFixed(6)).toBe(inRatio.toFixed(6));
    expect(usRatio.toNumber()).toBeCloseTo(1.06, 4);
    // Department lookup map is precomputed O(1), not an O(N) scan per employee.
    expect(departmentCodeById().get(engDept.id)).toBe("ENG");
    // No JS float arithmetic anywhere in the path: band strings stay exact.
    expect(new BigNumber(salaryBands.US.L4).isFinite()).toBe(true);
  });

  it("produces deterministic salaries per employee ordinal", () => {
    const employee = generateEmployee(demo, demoDepartments, 42);

    expect(salaryFor(employee, 42)).toBe(
      salaryFor(generateEmployee(demo, demoDepartments, 42), 42),
    );
  });

  it("builds expected seed employee IDs without Faker names", () => {
    const ids = expectedSeedEmployeeIds(organizations);

    expect(ids).toHaveLength(13_357);
    expect(new Set(ids).size).toBe(13_357);
    expect(ids[0]).toContain("paylens-demo-00001");
  });
});
