import { describe, expect, it, vi } from "vitest";
import { EmployeeExportsController } from "@/modules/employee-exports/employee-exports.controller.js";

const principal = {
  userId: "user-1",
  sessionId: "session-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  role: "HR_MANAGER",
} as never;

describe("EmployeeExportsController", () => {
  it("delegates the export lifecycle to the service with the principal first", async () => {
    const exports = {
      create: vi.fn(async () => ({ id: "exp-1" })),
      list: vi.fn(async () => []),
      detail: vi.fn(async () => ({ id: "exp-1" })),
      pause: vi.fn(async () => ({ id: "exp-1" })),
      resume: vi.fn(async () => ({ id: "exp-1" })),
      cancel: vi.fn(async () => ({ id: "exp-1" })),
      download: vi.fn(async () => ({ url: "https://signed.example/f.csv", fileName: "f.csv" })),
    };
    const controller = new EmployeeExportsController(exports as never);
    const body = { format: "CSV" } as never;

    await controller.create(principal, body);
    await controller.list(principal);
    await controller.detail(principal, "exp-1");
    await controller.pause(principal, "exp-1");
    await controller.resume(principal, "exp-1");
    await controller.cancel(principal, "exp-1");
    await controller.download(principal, "exp-1");

    expect(exports.create).toHaveBeenCalledWith(principal, "CSV");
    expect(exports.list).toHaveBeenCalledWith(principal);
    expect(exports.detail).toHaveBeenCalledWith(principal, "exp-1");
    expect(exports.pause).toHaveBeenCalledWith(principal, "exp-1");
    expect(exports.resume).toHaveBeenCalledWith(principal, "exp-1");
    expect(exports.cancel).toHaveBeenCalledWith(principal, "exp-1");
    expect(exports.download).toHaveBeenCalledWith(principal, "exp-1");
  });
});
