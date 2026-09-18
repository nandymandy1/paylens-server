import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_SAFE_REDIRECT } from "@/modules/auth/constants/auth.constants.js";
import { normalizeEmail } from "@/common/utils/string.js";

export { normalizeEmail };

/** High-entropy opaque token for emails/invitations/refresh secrets. */
export const generateOpaqueToken = (bytes = 32): string => randomBytes(bytes).toString("hex");

/** SHA-256 hash-at-rest for opaque tokens. Never store raw tokens. */
export const hashOpaqueToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

const SLUG_UNSAFE = /[^a-z0-9]+/g;

export const slugifyOrganization = (name: string): string => {
  const base = name
    .trim()
    .toLowerCase()
    .replace(SLUG_UNSAFE, "-")
    .replace(/^-+|-+$/g, "");

  return base.slice(0, 60) || "organization";
};

/** Only internal application paths may be used as redirect targets. */
export const getSafeRedirectPath = (candidate: unknown): string => {
  if (typeof candidate !== "string" || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return DEFAULT_SAFE_REDIRECT;
  }

  try {
    const parsed = new URL(candidate, "https://paylens.local");

    if (parsed.host !== "paylens.local") {
      return DEFAULT_SAFE_REDIRECT;
    }

    const path = `${parsed.pathname}${parsed.search}`;

    if (/^(javascript|data|vbscript):/i.test(path)) {
      return DEFAULT_SAFE_REDIRECT;
    }

    return path;
  } catch {
    return DEFAULT_SAFE_REDIRECT;
  }
};

export const sessionKey = (sessionId: string): string => `auth:session:${sessionId}`;

export const userSessionsKey = (userId: string): string => `auth:user-sessions:${userId}`;

export const oauthStateKey = (state: string): string => `auth:oauth-state:${state}`;
