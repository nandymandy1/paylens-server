import { describe, expect, it } from "vitest";
import { createValidationException } from "@/common/pipes/validation-exception.js";

describe("validation exception translation", () => {
  it("preserves only field-safe class-validator constraints", () => {
    const exception = createValidationException([
      {
        property: "email",
        constraints: { isEmail: "email must be an email" },
        children: [],
      } as never,
    ]);

    expect(exception.getResponse()).toEqual({
      message: "Request validation failed.",
      details: { fields: { email: ["email must be an email"] } },
    });
  });
});
