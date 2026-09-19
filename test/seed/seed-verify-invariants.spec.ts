import { MembershipRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { diffMembershipSets, findOrganizationEmployeeCountViolations } from "@/seed/verify.js";
import { generateMemberships as expectedMemberships, generateOrganizations } from "@/seed/data.js";

const organizations = generateOrganizations();

describe("SEED-R1 exact organization employee counts", () => {
  it("passes when every seeded org holds exactly its expected total", () => {
    const actualByOrg = new Map(
      organizations.map((organization) => [organization.id, organization.employeeCount]),
    );

    expect(findOrganizationEmployeeCountViolations(organizations, actualByOrg)).toEqual([]);
  });

  it("fails when a manual employee hides inside a seed org, even with all canonical IDs present", () => {
    // Canonical-ID presence: all 10 expected IDs exist.
    const expectedIds = new Set(Array.from({ length: 10 }, (_, index) => `seed-employee-${index}`));
    const presentIds = new Set([...expectedIds]);
    const missingExpectedIds = [...expectedIds].filter((id) => !presentIds.has(id));

    expect(missingExpectedIds).toEqual([]);

    // DB truth via groupBy: 10 expected + 1 manual = 11 rows in the org.
    const orgId = organizations[0].id;
    const actualByOrg = new Map([[orgId, 11]]);

    expect(
      findOrganizationEmployeeCountViolations([{ id: orgId, employeeCount: 10 }], actualByOrg),
    ).toEqual([orgId]);
  });

  it("treats a missing groupBy row as zero rows (e.g. acme-sandbox)", () => {
    const sandbox = organizations.find((organization) => organization.slug === "acme-sandbox")!;

    expect(findOrganizationEmployeeCountViolations([sandbox], new Map())).toEqual([]);
    expect(
      findOrganizationEmployeeCountViolations([{ id: sandbox.id, employeeCount: 1 }], new Map()),
    ).toEqual([sandbox.id]);
  });
});

describe("SEED-R1 exact membership set", () => {
  it("passes on the exact expected set", () => {
    const expected = expectedMemberships(organizations);
    const actual = expected.map((row) => ({ ...row }));

    const { missingExpectedMemberships, unexpectedMemberships } = diffMembershipSets(
      expected,
      actual,
    );

    expect(missingExpectedMemberships).toEqual([]);
    expect(unexpectedMemberships).toEqual([]);
  });

  it("fails when one expected membership is missing", () => {
    const expected = expectedMemberships(organizations);
    const actual = expected.slice(1).map((row) => ({ ...row }));

    const { missingExpectedMemberships, unexpectedMemberships } = diffMembershipSets(
      expected,
      actual,
    );

    expect(missingExpectedMemberships).toHaveLength(1);
    expect(unexpectedMemberships).toEqual([]);
  });

  it("fails on a same-count replacement (count-only checks would stay green)", () => {
    const expected = expectedMemberships(organizations);
    const actual = expected.map((row) => ({ ...row }));

    // Remove one expected row, add one wrong row: total count unchanged.
    actual.shift();
    expect(actual).toHaveLength(expected.length - 1);
    actual.push({
      organizationId: organizations[0].id,
      userId: "seed-user-intruder",
      role: expected[0].role,
    });
    expect(actual).toHaveLength(expected.length);

    const { missingExpectedMemberships, unexpectedMemberships } = diffMembershipSets(
      expected,
      actual,
    );

    expect(missingExpectedMemberships).toHaveLength(1);
    expect(unexpectedMemberships).toHaveLength(1);
  });

  it("detects a role change on the same user+org pair", () => {
    const expected = expectedMemberships(organizations);
    const actual = expected.map((row) => ({ ...row }));

    actual[0] = { ...actual[0], role: MembershipRole.VIEWER_AUDITOR };

    const { missingExpectedMemberships, unexpectedMemberships } = diffMembershipSets(
      expected,
      actual,
    );

    expect(missingExpectedMemberships).toHaveLength(1);
    expect(unexpectedMemberships).toHaveLength(1);
  });
});
