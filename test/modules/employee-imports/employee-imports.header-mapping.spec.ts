import { describe, expect, it } from "vitest";
import {
  DEPARTMENT_CODE_HEADER,
  buildDepartmentPrompt,
  buildHeaderMappingPrompt,
  isValidDepartmentCode,
  parseDepartmentResponse,
  parseHeaderMappingResponse,
  readDepartmentPlan,
  resolveDeterministicHeader,
} from "@/modules/employee-imports/employee-imports.header-mapping.js";

describe("import header mapping", () => {
  it("resolves canonical headers with BOM and aliases, rejects unknowns", () => {
    expect(resolveDeterministicHeader("\uFEFFEmployee Number")).toBe("Employee Number");
    expect(resolveDeterministicHeader("Emp No")).toBe("Employee Number");
    expect(resolveDeterministicHeader("Dept")).toBe("Department");
    expect(resolveDeterministicHeader("DOJ")).toBe("Start Date");
    expect(resolveDeterministicHeader("Random Column")).toBeNull();
  });

  it("sends only header strings in the mapping prompt", () => {
    const prompt = buildHeaderMappingPrompt(["Emp No"], [DEPARTMENT_CODE_HEADER]);

    expect(JSON.stringify(prompt)).toContain("Emp No");
    expect(JSON.stringify(prompt)).not.toContain("Ananya");
    expect(prompt.user).toEqual({ headers: ["Emp No"] });
  });

  it("validates the model answer against the allowlist", () => {
    const parsed = parseHeaderMappingResponse(
      { mapping: { "Emp No": "Employee Number", Foo: "Not A Column", Code: "Department Code" } },
      ["Emp No", "Foo", "Code"],
      [DEPARTMENT_CODE_HEADER],
    );

    expect(parsed).toEqual({
      "Emp No": "Employee Number",
      Foo: null,
      Code: "Department Code",
    });
  });

  it("bounds and validates department proposals", () => {
    expect(isValidDepartmentCode("ENG")).toBe(true);
    expect(isValidDepartmentCode("bad code!")).toBe(false);

    const prompt = buildDepartmentPrompt(["  Engg  ", ""]);

    expect(prompt.user).toEqual({ departments: ["Engg"] });

    const parsed = parseDepartmentResponse(
      {
        departments: {
          Engg: { name: "Engineering", code: "ENG" },
          Bad: { name: "Bad", code: "nope!" },
        },
      },
      ["Engg", "Bad"],
    );

    expect(parsed).toEqual({ Engg: { name: "Engineering", code: "ENG" } });
  });

  it("re-validates a persisted department plan before apply trusts it", () => {
    const plan = readDepartmentPlan({
      departmentPlan: [
        { from: "Engg", name: "Engineering", code: "ENG", source: "ai" },
        { from: "Bad", name: "Bad", code: "nope!", source: "ai" },
      ],
    });

    expect(plan.get("engg")).toMatchObject({ name: "Engineering", code: "ENG" });
    expect(plan.has("bad")).toBe(false);
    expect(readDepartmentPlan(null).size).toBe(0);
  });
});
