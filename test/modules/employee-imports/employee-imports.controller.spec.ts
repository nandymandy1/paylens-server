import { describe, expect, it, vi } from "vitest";
import { EmployeeImportsController } from "@/modules/employee-imports/employee-imports.controller.js";

const principal = {
  userId: "user-1",
  sessionId: "session-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  role: "HR_MANAGER",
} as never;

describe("EmployeeImportsController", () => {
  it("delegates import lifecycle to the service with the principal first", async () => {
    const imports = {
      create: vi.fn(async () => ({ id: "imp-1" })),
      list: vi.fn(async () => []),
      detail: vi.fn(async () => ({ id: "imp-1" })),
      uploadComplete: vi.fn(async () => ({ id: "imp-1" })),
      confirm: vi.fn(async () => ({ id: "imp-1" })),
      pause: vi.fn(async () => ({ id: "imp-1" })),
      resume: vi.fn(async () => ({ id: "imp-1" })),
      cancel: vi.fn(async () => ({ id: "imp-1" })),
      downloadReport: vi.fn(async () => ({ url: "https://signed.example/r" })),
    };
    const controller = new EmployeeImportsController(imports as never);
    const body = { fileName: "employees.csv" } as never;

    await controller.create(principal, body);
    await controller.list(principal);
    await controller.detail(principal, "imp-1");
    await controller.uploadComplete(principal, "imp-1");
    await controller.confirm(principal, "imp-1", { createMissingDepartments: true } as never);
    await controller.pause(principal, "imp-1");
    await controller.resume(principal, "imp-1");
    await controller.cancel(principal, "imp-1");
    await controller.report(principal, "imp-1", { type: "validation" } as never);

    expect(imports.create).toHaveBeenCalledWith(principal, body);
    expect(imports.list).toHaveBeenCalledWith(principal);
    expect(imports.detail).toHaveBeenCalledWith(principal, "imp-1");
    expect(imports.uploadComplete).toHaveBeenCalledWith(principal, "imp-1");
    expect(imports.confirm).toHaveBeenCalledWith(principal, "imp-1", true);
    expect(imports.pause).toHaveBeenCalledWith(principal, "imp-1");
    expect(imports.resume).toHaveBeenCalledWith(principal, "imp-1");
    expect(imports.cancel).toHaveBeenCalledWith(principal, "imp-1");
    expect(imports.downloadReport).toHaveBeenCalledWith(principal, "imp-1", "validation");
  });
});
