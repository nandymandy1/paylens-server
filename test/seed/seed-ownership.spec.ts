import { MembershipRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { SEED_EMPLOYEE_PREFIX } from "@/seed/constants.js";
import {
  classifyEmployeeOwnership,
  expectedSeedEmployeeIds,
  generateCompensationHistory,
  generateDepartments,
  generateEmployee,
  generateMemberships,
  generateOrganizations,
  organizationActorById,
  seedId,
} from "@/seed/data.js";

const organizations = generateOrganizations();
const canonicalIds = new Set(expectedSeedEmployeeIds(organizations));

describe("SEED-R1 exact canonical ownership", () => {
  it("treats an exact canonical ID as seed-owned", () => {
    const id = expectedSeedEmployeeIds(organizations)[0];

    expect(
      classifyEmployeeOwnership(
        { id, employeeNumber: `${SEED_EMPLOYEE_PREFIX}PAYLENS-DEMO-00001` },
        canonicalIds,
      ),
    ).toBe("seed-owned");
  });

  it("treats a foreign normal employee as non-seed", () => {
    expect(
      classifyEmployeeOwnership({ id: "real-employee-1", employeeNumber: "EMP-001" }, canonicalIds),
    ).toBe("non-seed");
  });

  it("treats a foreign reserved-prefix employee as a conflict, never seed-owned", () => {
    expect(
      classifyEmployeeOwnership(
        { id: "foreign-manual-1", employeeNumber: `${SEED_EMPLOYEE_PREFIX}MANUAL-001` },
        canonicalIds,
      ),
    ).toBe("reserved-prefix-conflict");
  });

  it("keeps a canonical ID seed-owned even when mutable fields changed", () => {
    const id = expectedSeedEmployeeIds(organizations)[42];

    // Ownership is the canonical ID, not mutable human fields.
    expect(classifyEmployeeOwnership({ id, employeeNumber: "RENAMED-999" }, canonicalIds)).toBe(
      "seed-owned",
    );
  });
});

describe("SEED-R1 deterministic organization actor map", () => {
  it("maps demo to its owner and sandbox to its owner", () => {
    const actors = organizationActorById();
    const demo = organizations.find((organization) => organization.slug === "paylens-demo")!;
    const sandbox = organizations.find((organization) => organization.slug === "acme-sandbox")!;

    expect(actors.get(demo.id)).toBe(seedId("user", 1));
    expect(actors.get(sandbox.id)).toBe(seedId("user", 6));
  });

  it("maps every generated organization to its own controlled owner", () => {
    const actors = organizationActorById();
    const generated = organizations.filter(
      (organization) => organization.size !== "CANONICAL" && organization.size !== "EMPTY",
    );

    expect(generated).toHaveLength(28);

    generated.forEach((organization, index) => {
      expect(actors.get(organization.id)).toBe(seedId("user", index + 8));
    });
  });

  it("prefers OWNER over ADMIN over HR over MANAGER with userId tie-break", () => {
    const synthetic = {
      id: "org-x",
      name: "Org X",
      slug: "org-x",
      size: "MICRO",
      employeeCount: 0,
      departmentCount: 0,
    } as const;
    const actors = organizationActorById(
      [...organizations, { ...synthetic }],
      [
        { organizationId: "org-x", userId: seedId("user", 30), role: MembershipRole.MANAGER },
        {
          organizationId: "org-x",
          userId: seedId("user", 31),
          role: MembershipRole.VIEWER_AUDITOR,
        },
        { organizationId: "org-x", userId: seedId("user", 32), role: MembershipRole.HR_ADMIN },
        { organizationId: "org-x", userId: seedId("user", 33), role: MembershipRole.HR_ADMIN },
      ],
    );

    expect(actors.get("org-x")).toBe(seedId("user", 32));
  });

  it("maps an organization with no controlled member to a null system actor", () => {
    const actors = organizationActorById(organizations, []);

    expect(actors.get(organizations[0].id)).toBeNull();
  });

  it("assigns the explicit actor through the history generator without a global fallback", () => {
    const demo = organizations.find((organization) => organization.slug === "paylens-demo")!;
    const employee = generateEmployee(demo, generateDepartments(demo), 0);
    const actors = organizationActorById();

    const history = generateCompensationHistory({
      employee,
      index: 0,
      changedByUserId: actors.get(demo.id) ?? null,
    });

    expect(history.length).toBeGreaterThan(0);
    expect(history.every((entry) => entry.changedByUserId === seedId("user", 1))).toBe(true);

    const systemic = generateCompensationHistory({ employee, index: 1, changedByUserId: null });

    expect(systemic.every((entry) => entry.changedByUserId === null)).toBe(true);
    expect(generateMemberships()).toHaveLength(35);
  });
});
