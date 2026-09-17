import { BadRequestException } from "@nestjs/common";
import type { ValidationError } from "class-validator";

export type ValidationDetails = {
  fields: Record<string, string[]>;
};

function collectFieldErrors(errors: ValidationError[], parentPath = ""): Record<string, string[]> {
  return errors.reduce<Record<string, string[]>>((fields, error) => {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;
    const constraints = error.constraints ? Object.values(error.constraints) : [];

    if (constraints.length) {
      fields[path] = constraints;
    }

    return {
      ...fields,
      ...collectFieldErrors(error.children ?? [], path),
    };
  }, {});
}

export class ValidationException extends BadRequestException {
  constructor(errors: ValidationError[]) {
    super({
      message: "Request validation failed.",
      details: { fields: collectFieldErrors(errors) } satisfies ValidationDetails,
    });
  }
}

export function createValidationException(errors: ValidationError[]): ValidationException {
  return new ValidationException(errors);
}
