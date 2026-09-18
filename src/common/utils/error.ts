/** Canonical error metadata extraction for tracing (name only, no secrets). */
export const getErrorMetadata = (error: unknown): Record<string, string> => ({
  name: error instanceof Error ? error.name : "UnknownError",
});
