const SENSITIVE_KEY =
  /^(?:(?:password|pass|passwd)|(?:access|refresh|id|verification|reset|invite|invitation|session|oauth)?token|authorization|cookie|set-cookie|session|sessionId|sessionToken|(?:client)?secret|apiKey|apikey|privateKey|oauthCode|verificationCode|resetCode|credential|credentials)$/i;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;

export const REDACTED_LOG_VALUE = "***";

/** Sanitizes structured diagnostics without mutating application data. */
export function sanitizeForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";

  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeForLog(item, depth + 1, seen));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED_LOG_VALUE : sanitizeForLog(entry, depth + 1, seen),
    ]),
  );
}

export function safeRequestMetadata(request: {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): Record<string, unknown> {
  const query = sanitizeForLog(request.query ?? {}) as Record<string, unknown>;
  const params = sanitizeForLog(request.params ?? {}) as Record<string, unknown>;
  const search = query.search;

  if (typeof search === "string") {
    delete query.search;
    query.searchPresent = true;
    query.searchLength = search.length;
  }

  return {
    ...(Object.keys(params).length === 0 ? {} : { params }),
    ...(Object.keys(query).length === 0 ? {} : { query }),
  };
}
