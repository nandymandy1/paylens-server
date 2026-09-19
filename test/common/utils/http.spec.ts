import { describe, expect, it } from "vitest";
import { resolveRequestRouteForLog, resolveRequestRouteForMetric } from "@/common/utils/http.js";

function createMockRequest(routePath?: string, path?: string) {
  return {
    route: routePath !== undefined ? { path: routePath } : undefined,
    path: path ?? "/unknown",
  } as never;
}

describe("resolveRequestRouteForLog", () => {
  it("uses Express route template when available", () => {
    const req = createMockRequest("/api/v1/employees/:id", "/api/v1/employees/abc123");

    expect(resolveRequestRouteForLog(req)).toBe("/api/v1/employees/:id");
  });

  it("falls back to raw path when no route template", () => {
    const req = createMockRequest(undefined, "/api/v1/employees/abc123");

    expect(resolveRequestRouteForLog(req)).toBe("/api/v1/employees/abc123");
  });

  it("uses route template for health endpoint", () => {
    const req = createMockRequest("/health", "/health");

    expect(resolveRequestRouteForLog(req)).toBe("/health");
  });
});

describe("resolveRequestRouteForMetric", () => {
  it("uses Express route template when available", () => {
    const req = createMockRequest("/api/v1/employees/:id", "/api/v1/employees/abc123");

    expect(resolveRequestRouteForMetric(req)).toBe("/api/v1/employees/:id");
  });

  it("returns __unmatched__ for unknown paths", () => {
    const req = createMockRequest(undefined, "/api/v1/employees/abc123");

    expect(resolveRequestRouteForMetric(req)).toBe("__unmatched__");
  });

  it("returns __unmatched__ for unmatched dynamic paths", () => {
    const req = createMockRequest(undefined, "/some/random/path/cmu84ab123");

    expect(resolveRequestRouteForMetric(req)).toBe("__unmatched__");
  });

  it("never returns raw user IDs in metric route", () => {
    const req = createMockRequest(undefined, "/api/v1/employees/usr_abc123def456");

    const metricRoute = resolveRequestRouteForMetric(req);

    expect(metricRoute).not.toContain("usr_abc123def456");
    expect(metricRoute).toBe("__unmatched__");
  });

  it("uses template for nested routes with multiple params", () => {
    const req = createMockRequest(
      "/api/v1/organizations/:orgId/departments/:deptId",
      "/api/v1/organizations/org_123/departments/dept_456",
    );

    expect(resolveRequestRouteForMetric(req)).toBe(
      "/api/v1/organizations/:orgId/departments/:deptId",
    );
  });
});
