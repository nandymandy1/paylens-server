import { describe, expect, it, vi } from "vitest";
import { EmployeesController } from "@/modules/employees/employees.controller.js";

describe("EmployeesController", () => {
  it("delegates list and detail to the service with the principal first", async () => {
    const employees = {
      list: vi.fn(async () => ({ items: [], pageInfo: { hasNextPage: false, nextCursor: null } })),
      detail: vi.fn(async () => ({ id: "emp-1" })),
    };
    const controller = new EmployeesController(employees as never);
    const principal = {
      userId: "user-1",
      sessionId: "session-1",
      organizationId: "org-1",
      membershipId: "membership-1",
      role: "HR_MANAGER",
    } as never;
    const query = { search: "oli" } as never;

    await controller.list(principal, query);
    await controller.detail(principal, "emp-1");

    expect(employees.list).toHaveBeenCalledWith(principal, query);
    expect(employees.detail).toHaveBeenCalledWith(principal, "emp-1");
  });

  it("delegates employee creation to the service with the principal first", async () => {
    const employees = { createEmployee: vi.fn(async () => ({ id: "emp-new" })) };
    const controller = new EmployeesController(employees as never);
    const principal = {
      userId: "user-1",
      sessionId: "session-1",
      organizationId: "org-1",
      membershipId: "membership-1",
      role: "HR_MANAGER",
    } as never;
    const body = { employeeNumber: "EMP-1" } as never;

    await controller.create(principal, body);

    expect(employees.createEmployee).toHaveBeenCalledWith(principal, body);
  });
});
