import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmployeeExportsService } from "@/modules/employee-exports/employee-exports.service.js";
import { EMPLOYEE_EXPORT_ERROR_CODES } from "@/modules/employee-exports/employee-exports.constants.js";

const principalFor = (role: string, org = "org-1", user = "user-1") => ({
  userId: user,
  sessionId: "session-1",
  organizationId: org,
  membershipId: `membership-${user}`,
  role,
});

const exportRow = (overrides: Record<string, unknown> = {}) => ({
  id: "exp-1",
  organizationId: "org-1",
  requestedByUserId: "user-1",
  format: "CSV",
  status: "PROCESSING",
  totalRows: 0,
  processedRows: 0,
  progressPercent: 0,
  lastProcessedEmployeeId: null,
  nextBatchNumber: 1,
  finalObjectKey: null,
  fileName: null,
  fileSizeBytes: null,
  errorCode: null,
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
  startedAt: null,
  completedAt: null,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
  updatedAt: new Date("2026-09-20T00:00:00.000Z"),
  ...overrides,
});

const createHarness = (rowOverrides: Record<string, unknown> = {}) => {
  let current = exportRow(rowOverrides);
  const prisma = {
    organizationMembership: {
      findFirst: vi.fn(async (args: { where: Record<string, string> }) => ({
        organizationId: args.where.organizationId,
        role: "HR_MANAGER",
      })),
    },
    employeeExport: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        current = exportRow({ ...args.data, id: "exp-1", status: "QUEUED" });

        return current;
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        current = { ...current, ...args.data };

        return current;
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const where = args.where as { id: string; status?: unknown };

          if (where.id !== current.id) return { count: 0 };
          if (where.status !== undefined) {
            const allowed = Array.isArray(where.status) ? where.status : [where.status];

            if (!allowed.includes(current.status)) return { count: 0 };
          }

          current = { ...current, ...args.data };

          return { count: 1 };
        },
      ),
      findFirst: vi.fn(async (args?: { where?: Record<string, string> }) => {
        const where = args?.where ?? {};

        if (where.organizationId && where.organizationId !== current.organizationId) return null;
        if (where.requestedByUserId && where.requestedByUserId !== current.requestedByUserId)
          return null;

        return current;
      }),
      findMany: vi.fn(async () => [current]),
    },
  };
  const storage = {
    createSignedDownloadUrl: vi.fn(async () => ({
      url: "https://signed.example/get",
      expiresAt: new Date(),
    })),
    deletePrefix: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const queue = { add: vi.fn(async () => undefined) };
  const service = new EmployeeExportsService(prisma as never, storage as never, queue as never);
  const state = () => current;

  return { prisma, storage, queue, service, state };
};

describe("EmployeeExportsService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects unauthorized roles and cross-tenant access (backend authoritative)", async () => {
    const { service } = createHarness();

    // EMPLOYEE has no directory read grant, so export is forbidden.
    await expect(
      service.create(principalFor("EMPLOYEE") as never, "CSV" as never),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.detail(principalFor("HR_MANAGER", "org-2") as never, "exp-1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("marks FAILED instead of orphaning QUEUED when enqueue throws", async () => {
    const { service, queue, state } = createHarness();

    queue.add.mockRejectedValueOnce(new Error("redis down"));

    await expect(
      service.create(principalFor("HR_MANAGER") as never, "CSV" as never),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(state().status).toBe("FAILED");
    expect(state().errorCode).toBe(EMPLOYEE_EXPORT_ERROR_CODES.EXPORT_QUEUE_UNAVAILABLE);
  });

  it("pauses atomically from PROCESSING and ignores FINALIZING", async () => {
    const processing = createHarness({ status: "PROCESSING" });

    await processing.service.pause(principalFor("HR_MANAGER") as never, "exp-1");
    expect(processing.state().status).toBe("PAUSING");

    const finalizing = createHarness({ status: "FINALIZING" });

    await finalizing.service.pause(principalFor("HR_MANAGER") as never, "exp-1");
    expect(finalizing.state().status).toBe("FINALIZING");
  });

  it("resume claims PAUSED once and never enqueues twice", async () => {
    const { service, queue, prisma, state } = createHarness({
      status: "PAUSED",
      nextBatchNumber: 2,
    });

    await service.resume(principalFor("HR_MANAGER") as never, "exp-1");
    expect(state().status).toBe("QUEUED");
    expect(queue.add).toHaveBeenCalledTimes(1);

    const firstJobId = (queue.add.mock.calls[0] as { jobId?: string }[])[2]?.jobId;

    expect(firstJobId).toContain("exp-1:resume:2");

    // A concurrent second resume finds QUEUED, not PAUSED: no duplicate job.
    await service.resume(principalFor("HR_MANAGER") as never, "exp-1");
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(prisma.employeeExport.updateMany).toHaveBeenCalled();
  });

  it("immediate pause→resume race ends in exactly one continuation", async () => {
    const { service, queue, state } = createHarness({ status: "PROCESSING" });

    await service.pause(principalFor("HR_MANAGER") as never, "exp-1");
    expect(state().status).toBe("PAUSING");

    // Resume while PAUSING (not PAUSED) is a no-op: no duplicate worker.
    await service.resume(principalFor("HR_MANAGER") as never, "exp-1");
    expect(queue.add).not.toHaveBeenCalled();
    expect(state().status).toBe("PAUSING");
  });

  it("cancels QUEUED/PAUSED with cleanup but never FINALIZING", async () => {
    const queued = createHarness({ status: "QUEUED" });

    await queued.service.cancel(principalFor("HR_MANAGER") as never, "exp-1");
    expect(queued.state().status).toBe("CANCELLED");
    expect(queued.storage.deletePrefix).toHaveBeenCalled();

    const processing = createHarness({ status: "PROCESSING" });

    await processing.service.cancel(principalFor("HR_MANAGER") as never, "exp-1");
    expect(processing.state().status).toBe("CANCELLING");

    const finalizing = createHarness({ status: "FINALIZING" });

    await finalizing.service.cancel(principalFor("HR_MANAGER") as never, "exp-1");
    expect(finalizing.state().status).toBe("FINALIZING");
    expect(finalizing.storage.deletePrefix).not.toHaveBeenCalled();
  });

  it("denies expired, cross-tenant, and other-requester downloads", async () => {
    const expired = createHarness({
      status: "COMPLETED",
      finalObjectKey: "employee-exports/org-1/exp-1/final/f.csv",
      fileName: "f.csv",
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(
      expired.service.download(principalFor("HR_MANAGER") as never, "exp-1"),
    ).rejects.toMatchObject({
      status: 404,
    });

    const crossTenant = createHarness({
      status: "COMPLETED",
      finalObjectKey: "employee-exports/org-1/exp-1/final/f.csv",
      fileName: "f.csv",
    });

    await expect(
      crossTenant.service.download(principalFor("HR_MANAGER", "org-2") as never, "exp-1"),
    ).rejects.toMatchObject({ status: 404 });

    const otherRequester = createHarness({
      status: "COMPLETED",
      finalObjectKey: "employee-exports/org-1/exp-1/final/f.csv",
      fileName: "f.csv",
    });

    await expect(
      otherRequester.service.download(
        principalFor("HR_MANAGER", "org-1", "user-9") as never,
        "exp-1",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("signs downloads with a safe attachment filename", async () => {
    const { service, storage } = createHarness({
      status: "COMPLETED",
      finalObjectKey: "employee-exports/org-1/exp-1/final/paylens-employees-2026-09-20.csv",
      fileName: 'paylens-employees-2026-09-20.csv"\r\n',
    });

    const result = await service.download(principalFor("HR_MANAGER") as never, "exp-1");

    expect(result.fileName).not.toContain('"');
    expect(storage.createSignedDownloadUrl).toHaveBeenCalledWith({
      key: "employee-exports/org-1/exp-1/final/paylens-employees-2026-09-20.csv",
      contentDisposition: expect.stringContaining("attachment;"),
    });
  });
});
