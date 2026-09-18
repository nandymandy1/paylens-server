/** Shared data-boundary string normalization (not auth-specific). */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
