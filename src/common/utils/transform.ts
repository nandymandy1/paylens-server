import { normalizeEmail } from "@/common/utils/string.js";

type TransformArgs = {
  value: unknown;
};

/** Trim strings, pass through anything else (class-transformer compatible). */
export const trimTransform = ({ value }: TransformArgs): unknown =>
  typeof value === "string" ? value.trim() : value;

/** Trim strings; empty becomes undefined (optional fields). */
export const trimOptionalTransform = ({ value }: TransformArgs): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? undefined : trimmed;
};

/** Trim + uppercase (tenant codes, country codes). */
export const trimUppercaseTransform = ({ value }: TransformArgs): unknown =>
  typeof value === "string" ? value.trim().toUpperCase() : value;

/** Optional email boundary: trim + lowercase, empty becomes undefined. */
export const optionalEmailTransform = ({ value }: TransformArgs): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = normalizeEmail(value);

  return normalized.length === 0 ? undefined : normalized;
};
