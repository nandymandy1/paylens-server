const SENSITIVE_KEY =
  /^(?:(?:password|pass|passwd)|(?:access|refresh|id|verification|reset|invite|invitation|session|oauth)?token|authorization|cookie|set-cookie|session|sessionId|sessionToken|(?:client)?secret|apiKey|apikey|privateKey|oauthCode|verificationCode|resetCode|credential|credentials|state)$/i;

/**
 * OAuth-specific query/param keys that carry credentials in callback routes.
 * `code` is NOT in SENSITIVE_KEY because it is a legitimate business field
 * (error code, department code, etc.) in non-OAuth contexts.
 */
const OAUTH_CREDENTIAL_KEYS = new Set(["code", "state"]);
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;

export const REDACTED_LOG_VALUE = "***";

/**
 * Query parameter names that may carry secrets inside URL strings.
 * Applied to URL-like string values during sanitization.
 */
const SENSITIVE_URL_PARAMS = new Set([
  "token",
  "code",
  "state",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "password",
  "reset_token",
  "invite_token",
  "authorization",
]);

/**
 * Redacts sensitive query parameters inside URL-like strings.
 * Also handles nested URLs (e.g., redirect_to containing token=...).
 * Safe: malformed URLs return unchanged; never throws.
 */
export function sanitizeUrlString(value: string): string {
  try {
    const url = new URL(value, "http://localhost");
    let changed = false;

    for (const [key] of url.searchParams) {
      if (SENSITIVE_URL_PARAMS.has(key)) {
        url.searchParams.set(key, REDACTED_LOG_VALUE);
        changed = true;
      }
    }

    // Reconstruct and also scan for nested sensitive key=value patterns
    let result =
      !value.startsWith("http://") && !value.startsWith("https://")
        ? url.pathname + url.search
        : url.toString();

    // Scan for nested sensitive params (e.g., redirect_to=/invite?token=xxx)
    const nestedPattern =
      /([?&])(token|code|state|access_token|refresh_token|id_token|client_secret|password|reset_token|invite_token|authorization)=([^&]*)/gi;
    const sanitized = result.replace(
      nestedPattern,
      (match, sep, key) => `${sep}${key}=${REDACTED_LOG_VALUE}`,
    );

    if (sanitized !== result) {
      result = sanitized;
      changed = true;
    }

    if (!changed) return value;

    return result;
  } catch {
    return value;
  }
}

/** Sanitizes structured diagnostics without mutating application data. */
export function sanitizeForLog(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value !== "object") {
    // Redact sensitive query params inside URL-like strings
    if (typeof value === "string" && (value.includes("?") || /^\//.test(value))) {
      return sanitizeUrlString(value);
    }

    return value;
  }

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

export function safeRequestMetadata(
  request: {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    path?: string;
  },
  options?: { oauthCallbackRoute?: boolean },
): Record<string, unknown> {
  const query = sanitizeForLog(request.query ?? {}) as Record<string, unknown>;
  const params = sanitizeForLog(request.params ?? {}) as Record<string, unknown>;
  const search = query.search;

  if (typeof search === "string") {
    delete query.search;
    query.searchPresent = true;
    query.searchLength = search.length;
  }

  // OAuth callback routes: redact credential-bearing fields (code, state)
  // that are NOT in the generic SENSITIVE_KEY list because they are
  // legitimate business fields in non-OAuth contexts.
  const isOAuthRoute =
    options?.oauthCallbackRoute ??
    (typeof request.path === "string" && /google\/callback/i.test(request.path));

  if (isOAuthRoute) {
    for (const key of OAUTH_CREDENTIAL_KEYS) {
      if (key in query) query[key] = REDACTED_LOG_VALUE;
      if (key in params) params[key] = REDACTED_LOG_VALUE;
    }
  }

  return {
    ...(Object.keys(params).length === 0 ? {} : { params }),
    ...(Object.keys(query).length === 0 ? {} : { query }),
  };
}
