import { describe, expect, it } from "vitest";
import {
  generateCompensationHistory,
  generateDepartments,
  generateEmployee,
  generateMemberships,
  generateOrganizations,
  organizationActorById,
  seedId,
} from "@/seed/data.js";
import { findHistoryActorViolations as verifyActorRule } from "@/seed/verify.js";

const organizations = generateOrganizations();
const memberships = generateMemberships(organizations);
const membershipKeys = new Set(
  memberships.map((membership) => `${membership.organizationId}:${membership.userId}`),
);
const actors = organizationActorById(organizations, memberships);

const orgBySize = (size: string) =>
  organizations.find((organization) => organization.size === size)!;

describe("SEED-R1 history actor tenancy", () => {
  it("gives every non-null history actor a membership in the employee organization", () => {
    const scope = [
      organizations.find((organization) => organization.slug === "paylens-demo")!,
      orgBySize("MICRO"),
      orgBySize("MEDIUM"),
      orgBySize("LARGE"),
      orgBySize("VERY_LARGE"),
    ];

    for (const organization of scope) {
      const departments = generateDepartments(organization);
      const employee = generateEmployee(organization, departments, 3);
      const history = generateCompensationHistory({
        employee,
        index: 3,
        changedByUserId: actors.get(organization.id) ?? null,
      });
      const employeeOrgById = new Map([[employee.id, organization.id]]);

      expect(history.length).toBeGreaterThan(0);
      expect(verifyActorRule(history, employeeOrgById, membershipKeys)).toEqual([]);
    }
  });

  it("never falls back to unrelated user01 outside paylens-demo", () => {
    const generated = organizations.filter(
      (organization) => organization.size !== "CANONICAL" && organization.size !== "EMPTY",
    );

    for (const organization of generated) {
      const departments = generateDepartments(organization);
      const employee = generateEmployee(organization, departments, 0);
      const history = generateCompensationHistory({
        employee,
        index: 0,
        changedByUserId: actors.get(organization.id) ?? null,
      });

      for (const entry of history) {
        expect(entry.changedByUserId).not.toBe(seedId("user", 1));
        expect(entry.changedByUserId).toBe(actors.get(organization.id));
      }
    }
  });

  it("flags cross-tenant actors but accepts null system actors", () => {
    const demo = organizations.find((organization) => organization.slug === "paylens-demo")!;
    const micro = orgBySize("MICRO");
    const employeeOrgById = new Map([["emp-1", micro.id]]);

    // Demo owner acting on a MICRO employee is a violation.
    expect(
      verifyActorRule(
        [{ employeeId: "emp-1", changedByUserId: actors.get(demo.id)! }],
        employeeOrgById,
        membershipKeys,
      ),
    ).toHaveLength(1);

    // The org's own actor is valid; null system actors are valid.
    expect(
      verifyActorRule(
        [
          { employeeId: "emp-1", changedByUserId: actors.get(micro.id)! },
          { employeeId: "emp-1", changedByUserId: null },
        ],
        employeeOrgById,
        membershipKeys,
      ),
    ).toEqual([]);

    // Unknown employees cannot prove membership.
    expect(
      verifyActorRule(
        [{ employeeId: "ghost", changedByUserId: actors.get(micro.id)! }],
        employeeOrgById,
        membershipKeys,
      ),
    ).toHaveLength(1);
  });
});
