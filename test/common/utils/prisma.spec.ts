import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { isPrismaRelationViolation, isPrismaUniqueViolationOn } from "@/common/utils/prisma.js";

const uniqueError = (target: unknown) =>
  new Prisma.PrismaClientKnownRequestError("unique", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });

const relationError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError("relation", {
    code,
    clientVersion: "test",
  });

describe("prisma predicates", () => {
  it("identifies unique violations on the expected field", () => {
    expect(isPrismaUniqueViolationOn(uniqueError(["organizationId", "code"]), "code")).toBe(true);
    expect(isPrismaUniqueViolationOn(uniqueError(["organizationId", "code"]), "name")).toBe(false);
    expect(isPrismaUniqueViolationOn(new Error("other"), "code")).toBe(false);
  });

  it("identifies relation-restriction violations", () => {
    expect(isPrismaRelationViolation(relationError("P2003"))).toBe(true);
    expect(isPrismaRelationViolation(relationError("P2014"))).toBe(true);
    expect(isPrismaRelationViolation(relationError("P2002"))).toBe(false);
    expect(isPrismaRelationViolation(new Error("other"))).toBe(false);
  });
});
