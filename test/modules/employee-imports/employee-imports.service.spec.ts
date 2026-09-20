import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeeImportsService } from "@/modules/employee-imports/employee-imports.service.js";

const principalFor = (role: string) => ({
  userId: "user-1",
  sessionId: "session-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  role,
});

const importRow = (overrides: Record<string, unknown> = {}) => ({
  id: "imp-1",
  organizationId: "org-1",
  requestedByUserId: "user-1",
  format: "CSV",
  status: "READY_FOR_REVIEW",
  originalFileName: "employees.csv",
  sourceObjectKey: "employee-imports/org-1/imp-1/source/original.csv",
  normalizedPrefix: "employee-imports/org-1/imp-1/normalized/",
  validationReportObjectKey: "employee-imports/org-1/imp-1/reports/validation-errors.csv",
  applyReportObjectKey: null,
  totalRows: 10,
  validatedRows: 10,
  validRows: 10,
  invalidRows: 0,
  createRows: 4,
  updateRows: 6,
  unchangedRows: 0,
  processedRows: 0,
  createdRows: 0,
  updatedRows: 0,
  failedRows: 0,
  lastProcessedRow: 0,
  nextBatchNumber: 1,
  createMissingDepartments: false,
  previewSummary: {},
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
  validatedAt: new Date("2026-09-20T00:01:00.000Z"),
  completedAt: null,
  ...overrides,
});

const createHarness = (rowOverrides: Record<string, unknown> = {}) => {
  const prisma = {
    organizationMembership: {
      findFirst: vi.fn(async () => ({ organizationId: "org-1", role: "HR_MANAGER" })),
    },
    employeeImport: {
      create: vi.fn(async () => importRow({ status: "AWAITING_UPLOAD" })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => importRow(args.data)),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => importRow(rowOverrides)),
      findMany: vi.fn(async () => [importRow(rowOverrides)]),
    },
    department: { findMany: vi.fn(async () => []) },
  };
  const storage = {
    createSignedUploadUrl: vi.fn(async () => ({
      url: "https://signed.example/put",
      expiresAt: new Date(),
    })),
    createSignedDownloadUrl: vi.fn(async () => ({
      url: "https://signed.example/get",
      expiresAt: new Date(),
    })),
    exists: vi.fn(async () => true),
    head: vi.fn(async () => ({ size: 1024 })),
    deletePrefix: vi.fn(async () => undefined),
  };
  const queue = { add: vi.fn(async () => undefined) };
  const service = new EmployeeImportsService(prisma as never, storage as never, queue as never);

  return { prisma, storage, queue, service };
};

describe("EmployeeImportsService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects viewers from creating imports (backend authoritative)", async () => {
    const { service } = createHarness();

    await expect(
      service.create(
        principalFor("VIEWER_AUDITOR") as never,
        {
          fileName: "employees.csv",
          format: "CSV",
          sizeBytes: 100,
          contentType: "text/csv",
        } as never,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects oversized files before touching storage", async () => {
    const { service, storage } = createHarness();

    await expect(
      service.create(
        principalFor("HR_MANAGER") as never,
        {
          fileName: "employees.csv",
          format: "CSV",
          sizeBytes: 26 * 1024 * 1024,
          contentType: "text/csv",
        } as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects zip content disguised as an import", async () => {
    const { service } = createHarness();

    await expect(
      service.create(
        principalFor("HR_MANAGER") as never,
        {
          fileName: "employees.zip",
          format: "CSV",
          sizeBytes: 100,
          contentType: "application/zip",
        } as never,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("blocks confirm when validation errors exist", async () => {
    const { service, queue } = createHarness({ invalidRows: 3 });

    await expect(
      service.confirm(principalFor("HR_MANAGER") as never, "imp-1", true),
    ).rejects.toMatchObject({ status: 409 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("rejects confirmation without creation when a planned department remains unresolved", async () => {
    const { service, queue } = createHarness({
      previewSummary: {
        missingDepartments: ["Engg"],
        departmentPlan: [{ from: "Engg", name: "Engineering", code: "ENG", source: "ai" }],
      },
    });

    await expect(
      service.confirm(principalFor("HR_MANAGER") as never, "imp-1", false),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("allows confirmation without creation when an AI alias resolves to an existing department", async () => {
    const { service, prisma, queue } = createHarness({
      previewSummary: {
        missingDepartments: ["Engg"],
        departmentPlan: [{ from: "Engg", name: "Engineering", code: "ENG", source: "ai" }],
      },
    });

    prisma.department.findMany.mockResolvedValueOnce([{ name: "Engineering" }] as never);

    await service.confirm(principalFor("HR_MANAGER") as never, "imp-1", false);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("confirm is idempotent while apply is already queued", async () => {
    const { service, queue } = createHarness({ status: "APPLY_QUEUED", invalidRows: 0 });

    const result = await service.confirm(principalFor("HR_MANAGER") as never, "imp-1", true);

    expect(result.status).toBe("APPLY_QUEUED");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("uploadComplete enqueues with a BullMQ-safe job id (no colons)", async () => {
    const { service, queue } = createHarness({ status: "AWAITING_UPLOAD" });

    await service.uploadComplete(principalFor("HR_MANAGER") as never, "imp-1");

    expect(queue.add).toHaveBeenCalledTimes(1);
    const options = (queue.add.mock.calls[0] as { jobId?: string }[])[2];

    expect(options?.jobId).toBe("imp-1-validate");
  });

  it("uploadComplete restores AWAITING_UPLOAD when enqueue fails", async () => {
    const { service, prisma, queue } = createHarness({ status: "AWAITING_UPLOAD" });

    queue.add.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      service.uploadComplete(principalFor("HR_MANAGER") as never, "imp-1"),
    ).rejects.toThrow("redis down");
    const statuses = prisma.employeeImport.update.mock.calls.map(
      (call) => (call[0] as { data: { status: string } }).data.status,
    );

    expect(statuses).toEqual(["QUEUED", "AWAITING_UPLOAD"]);
  });

  it("confirm restores READY_FOR_REVIEW when enqueue fails", async () => {
    const { service, prisma, queue } = createHarness({
      status: "READY_FOR_REVIEW",
      invalidRows: 0,
    });

    queue.add.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      service.confirm(principalFor("HR_MANAGER") as never, "imp-1", true),
    ).rejects.toThrow("redis down");
    expect(prisma.employeeImport.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "READY_FOR_REVIEW" }),
      }),
    );
  });

  it("cancel on a terminal import returns current state without side effects", async () => {
    const { service, storage } = createHarness({ status: "COMPLETED" });

    const result = await service.cancel(principalFor("HR_MANAGER") as never, "imp-1");

    expect(result.status).toBe("COMPLETED");
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });
});
