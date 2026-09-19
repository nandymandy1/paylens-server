/**
 * HTTP route resolution utilities.
 * Separates log-safe route resolution from low-cardinality metric route resolution.
 */

import type { Request } from "express";

/**
 * Resolve a route string for structured logs.
 * Uses the Express route template when available, falls back to raw path.
 * Logs may include more descriptive path info if security policy permits.
 */
export function resolveRequestRouteForLog(request: Request): string {
  return request.route?.path ?? request.path;
}

/**
 * Resolve a low-cardinality route string for metric labels.
 * Uses the Express route template when available.
 * Falls back to "__unmatched__" for unknown/dynamic paths to prevent
 * high-cardinality labels like "/api/v1/employees/cmu84ab...".
 */
export function resolveRequestRouteForMetric(request: Request): string {
  return request.route?.path ?? "__unmatched__";
}
