/**
 * Generic environment variable parsing utilities.
 * These are domain-agnostic — no knowledge of OTEL, DATABASE_URL, etc.
 */

/**
 * Parse a boolean environment variable.
 * Recognizes "true"/"false" case-insensitively after trim.
 * Throws on invalid values when used in validation contexts.
 */
export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const lower = value.trim().toLowerCase();

  if (lower === "true") return true;
  if (lower === "false") return false;

  return fallback;
}

/**
 * Parse a boolean env var, throwing on unrecognized values.
 * Only "true" and "false" (exact, trimmed) are accepted.
 * "1", "0", "yes", "TRUE", etc. all throw.
 */
export function parseBooleanEnvStrict(
  value: unknown,
  defaultValue: boolean,
  name: string,
): boolean {
  if (value === undefined) return defaultValue;

  if (typeof value !== "string") {
    throw new Error(`${name} must be "true" or "false"`);
  }

  const trimmed = value.trim();

  if (trimmed === "") return defaultValue;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  throw new Error(`${name} must be "true" or "false"`);
}

/**
 * Parse an optional string env var, trimming whitespace.
 * Returns undefined for undefined/empty values.
 */
export function parseOptionalStringEnv(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const trimmed = value.trim();

  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse a number env var with optional range constraints.
 */
export function parseNumberEnv(
  value: string | undefined,
  options: { fallback: number; min?: number; max?: number; name?: string },
): number {
  if (value === undefined || value === "") return options.fallback;
  const num = Number(value);

  if (!Number.isFinite(num)) {
    if (options.name) throw new Error(`${options.name} must be a finite number`);

    return options.fallback;
  }

  if (options.min !== undefined && num < options.min) {
    if (options.name) throw new Error(`${options.name} must be >= ${options.min}`);

    return options.fallback;
  }

  if (options.max !== undefined && num > options.max) {
    if (options.name) throw new Error(`${options.name} must be <= ${options.max}`);

    return options.fallback;
  }

  return num;
}

/**
 * Parse an integer env var with range constraints.
 */
export function parseIntegerInRange(
  value: unknown,
  defaultValue: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const numberValue = Number(value ?? defaultValue);

  if (!Number.isInteger(numberValue) || numberValue < minimum || numberValue > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return numberValue;
}
