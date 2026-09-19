import { describe, expect, it } from "vitest";
import {
  ACME_SANDBOX_DEPARTMENT_COUNT,
  ACME_SANDBOX_EMPLOYEE_COUNT,
  CONTROLLED_USER_COUNT,
  GENERATED_SIZE_DISTRIBUTION,
  ORGANIZATION_COUNT,
  PAYLENS_DEMO_DEPARTMENT_COUNT,
  PAYLENS_DEMO_EMPLOYEE_COUNT,
  PAYLENS_DEMO_SLUG,
  SEED_AS_OF_DATE,
} from "@/seed/constants.js";
import {
  generateCompensation,
  generateCompensationHistory,
  generateDepartments,
  generateEmployee,
  generateEmployees,
  generateMemberships,
  generateOrganizations,
  salaryBands,
} from "@/seed/data.js";
import { createEmployeeFaker } from "@/seed/faker.js";

describe("SEED-R1 deterministic dataset factories", () => {
  const organizations = generateOrganizations();
  const demo = organizations.find((organization) => organization.slug === PAYLENS_DEMO_SLUG)!;
  const sandbox = organizations.find((organization) => organization.slug === "acme-sandbox")!;

  it("honors the frozen organization, department, and portal-user contract", () => {
    expect(organizations).toHaveLength(ORGANIZATION_COUNT);
    expect(demo.employeeCount).toBe(PAYLENS_DEMO_EMPLOYEE_COUNT);
    expect(generateDepartments(demo)).toHaveLength(PAYLENS_DEMO_DEPARTMENT_COUNT);
    expect(sandbox.employeeCount).toBe(ACME_SANDBOX_EMPLOYEE_COUNT);
    expect(generateDepartments(sandbox)).toHaveLength(ACME_SANDBOX_DEPARTMENT_COUNT);
    expect(generateMemberships(organizations)).toHaveLength(CONTROLLED_USER_COUNT);
  });

  it("honors the exact generated organization size distribution", () => {
    const actual = organizations
      .filter((organization) => organization.size !== "CANONICAL" && organization.size !== "EMPTY")
      .reduce<Record<string, number>>((counts, organization) => {
        counts[organization.size] = (counts[organization.size] ?? 0) + 1;

        return counts;
      }, {});

    expect(actual).toEqual(GENERATED_SIZE_DISTRIBUTION);
  });

  it("generates stable first and last demo employees without department overflow", () => {
    const departments = generateDepartments(demo);
    const first = generateEmployee(demo, departments, 0);
    const last = generateEmployee(demo, departments, PAYLENS_DEMO_EMPLOYEE_COUNT - 1);

    expect(first).toEqual(generateEmployee(demo, departments, 0));
    expect(last).toEqual(generateEmployee(demo, departments, PAYLENS_DEMO_EMPLOYEE_COUNT - 1));
    expect(departments.map((department) => department.id)).toContain(first.departmentId);
    expect(departments.map((department) => department.id)).toContain(last.departmentId);
    expect(generateEmployees(sandbox, generateDepartments(sandbox))).toHaveLength(0);
  });

  it("keeps compensation and history deterministic, chronological, and reconciled", () => {
    const employee = generateEmployee(demo, generateDepartments(demo), 9_999);
    const compensation = generateCompensation(employee, 9_999);
    const history = generateCompensationHistory({
      employee,
      index: 9_999,
      changedByUserId: "seed-r1-user-1",
    });
    const latest = history.at(-1)!;

    expect(compensation).toEqual(generateCompensation(employee, 9_999));
    expect(history).toEqual(
      generateCompensationHistory({ employee, index: 9_999, changedByUserId: "seed-r1-user-1" }),
    );
    expect(
      history.every(
        (entry) =>
          entry.effectiveFrom <= SEED_AS_OF_DATE && entry.effectiveFrom >= employee.hireDate,
      ),
    ).toBe(true);
    expect(
      history.every(
        (entry, index) => index === 0 || entry.effectiveFrom > history[index - 1].effectiveFrom,
      ),
    ).toBe(true);
    expect(latest.newAnnualBaseSalary).toBe(compensation.annualBaseSalary);
    expect(latest.newCurrency).toBe(compensation.currency);
    expect(latest.effectiveFrom).toEqual(compensation.effectiveFrom);
  });

  it("uses isolated locale-routed Faker instances with materially diverse demo names", () => {
    expect(createEmployeeFaker("US", demo.slug, 1)).toBeInstanceOf(Object);
    expect(createEmployeeFaker("GB", demo.slug, 1)).toBeInstanceOf(Object);
    expect(createEmployeeFaker("DE", demo.slug, 1)).toBeInstanceOf(Object);
    expect(createEmployeeFaker("IN", demo.slug, 1)).toBeInstanceOf(Object);
    const names = new Set(
      generateEmployees(demo, generateDepartments(demo)).map(
        (employee) => `${employee.firstName} ${employee.lastName}`,
      ),
    );

    expect(names.size).toBeGreaterThan(1_000);
  });

  it("uses local-currency BigNumber salary bands with ordered levels", () => {
    for (const [country, bands] of Object.entries(salaryBands)) {
      expect(bands.L1).not.toBe("0");
      expect(Number(bands.L1)).toBeLessThan(Number(bands.L6));
      if (country === "IN") expect(Number(bands.L1)).toBeGreaterThanOrEqual(600_000);
    }

    const employee = generateEmployee(demo, generateDepartments(demo), 0);
    const history = generateCompensationHistory({ employee, index: 0, changedByUserId: null });

    expect(
      history.every(
        (entry, index) =>
          index === 0 || entry.previousAnnualBaseSalary === history[index - 1].newAnnualBaseSalary,
      ),
    ).toBe(true);
  });
});
