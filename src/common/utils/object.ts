/** Canonical unknown-object guard for cursor payloads and decoded JSON. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
