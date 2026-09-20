export type AiJsonPrompt = {
  system: string;
  /** JSON-serializable payload. Callers must only pass non-sensitive data. */
  user: unknown;
  model?: string;
};
