import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { EmployeeExportsProcessor } from "@/modules/employee-exports/employee-exports.processor.js";
import { EMPLOYEE_INTERCHANGE_COLUMNS } from "@/modules/employee-transfer/employee-interchange.js";

type FakeEmployee = {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string | null;
  jobTitle: string;
  level: string | null;
  countryCode: string;
  employmentType: "FULL_TIME";
  status: "ACTIVE";
  hireDate: Date;
  terminationDate: Date | null;
  department: { name: string };
};

const makeEmployees = (count: number): FakeEmployee[] =>
  Array.from({ length: count }, (_, index) => {
    const n = index + 1;

    return {
      id: `emp-${String(n).padStart(6, "0")}`,
      employeeNumber: `EMP-${String(n).padStart(6, "0")}`,
      firstName: n === 1 ? "=CMD|'/malicious" : `First${n}`,
      lastName: n === 2 ? 'O"Brien, Jr.\nÜnïcodé' : `Last${n}`,
      workEmail: n % 3 === 0 ? null : `user${n}@acme.example`,
      jobTitle: n === 3 ? "+Engineering @R&D" : `Engineer L${n % 5}`,
      level: n % 2 === 0 ? null : `L${n % 5}`,
      countryCode: "IN",
      employmentType: "FULL_TIME",
      status: "ACTIVE",
      hireDate: new Date("2022-03-01T00:00:00.000Z"),
      terminationDate: null,
      department: { name: n % 4 === 0 ? "Marketing" : "Engineering" },
    };
  });

const exportRow = (overrides: Record<string, unknown> = {}) => ({
  id: "exp-1",
  organizationId: "org-1",
  requestedByUserId: "user-1",
  format: "CSV",
  status: "QUEUED",
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
  ...overrides,
});

const matchesStatus = (wanted: unknown, actual: string): boolean => {
  if (wanted === undefined) return true;
  if (typeof wanted === "string") return wanted === actual;
  if (typeof wanted === "object" && wanted !== null && "in" in wanted)
    return (wanted as { in: string[] }).in.includes(actual);

  return false;
};

const createHarness = (employees: FakeEmployee[], rowOverrides: Record<string, unknown> = {}) => {
  let current = exportRow(rowOverrides) as Record<string, unknown>;
  const objects = new Map<string, Buffer>();
  const failUploadKeys = new Set<string>();
  let uploadCalls = 0;

  const consume = async (body: unknown): Promise<Buffer> => {
    if (Buffer.isBuffer(body)) return body;
    const chunks: Buffer[] = [];

    for await (const piece of body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));
    }

    return Buffer.concat(chunks);
  };

  const prisma = {
    employeeExport: {
      findFirst: vi.fn(async () => ({ ...current })),
      findUniqueOrThrow: vi.fn(async () => ({ ...current })),
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        current = { ...current, ...args.data };

        return { ...current };
      }),
      updateMany: vi.fn(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const where = args.where as { id: string; status?: unknown };

          if (where.id !== current.id) return { count: 0 };
          if (!matchesStatus(where.status, current.status as string)) return { count: 0 };

          current = { ...current, ...args.data };

          return { count: 1 };
        },
      ),
    },
    employee: {
      findMany: vi.fn(async (args: { where: Record<string, unknown>; take: number }) => {
        const where = args.where as { id?: { gt: string } };
        const after = where.id?.gt;
        const start = after ? employees.findIndex((employee) => employee.id === after) + 1 : 0;

        return employees.slice(start, start + args.take);
      }),
      count: vi.fn(async () => employees.length),
    },
  };
  const storage = {
    upload: vi.fn(async (input: { key: string; body: unknown }) => {
      uploadCalls += 1;

      if (failUploadKeys.has(input.key)) throw new Error("r2 unavailable");

      objects.set(input.key, await consume(input.body));

      return { key: input.key };
    }),
    downloadStream: vi.fn(async (key: string) => {
      const object = objects.get(key);

      if (!object) throw new Error(`missing object ${key}`);

      return Readable.from([object]);
    }),
    head: vi.fn(async (key: string) => ({ size: objects.get(key)?.length ?? 0 })),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
    deletePrefix: vi.fn(async (prefix: string) => {
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) objects.delete(key);
      }
    }),
    createSignedUploadUrl: vi.fn(async () => ({
      url: "https://signed.example/put",
      expiresAt: new Date(),
    })),
    createSignedDownloadUrl: vi.fn(async (key: string) => ({
      url: `https://signed.example/${key}`,
      expiresAt: new Date(),
    })),
  };
  const processor = new EmployeeExportsProcessor(prisma as never, storage as never);
  const job = (overrides: Record<string, unknown> = {}) => ({
    name: "employee-export-run",
    data: { exportId: "exp-1", organizationId: "org-1", requestedByUserId: "user-1" },
    attemptsMade: 0,
    updateProgress: vi.fn(async () => undefined),
    ...overrides,
  });
  const state = () => ({ ...current });
  const setState = (patch: Record<string, unknown>) => {
    current = { ...current, ...patch };
  };

  return {
    prisma,
    storage,
    processor,
    job,
    state,
    setState,
    objects,
    failUploadKeys,
    uploads: () => uploadCalls,
  };
};

describe("EmployeeExportsProcessor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts 1201 employees in 500/500/201 deterministic chunks", async () => {
    const { processor, job, state, objects, storage } = createHarness(makeEmployees(1201));

    await processor.process(job() as never);

    expect(state().status).toBe("COMPLETED");
    expect(state().processedRows).toBe(1201);
    expect(state().progressPercent).toBe(100);

    // Deterministic chunk keys were uploaded (§13 deletes staging after success).
    const uploaded = (storage.upload.mock.calls as { key: string }[][]).map((call) => call[0].key);

    expect(uploaded).toContain("employee-exports/org-1/exp-1/staging/part-000001.ndjson");
    expect(uploaded).toContain("employee-exports/org-1/exp-1/staging/part-000002.ndjson");
    expect(uploaded).toContain("employee-exports/org-1/exp-1/staging/part-000003.ndjson");
    expect(uploaded).not.toContain("employee-exports/org-1/exp-1/staging/part-000004.ndjson");
    expect([...objects.keys()].filter((key) => key.includes("/staging/"))).toHaveLength(0);
  });

  it("checkpoints only after durable upload and retries without duplicates", async () => {
    const harness = createHarness(makeEmployees(1201));
    const { processor, job, state, objects, failUploadKeys } = harness;

    failUploadKeys.add("employee-exports/org-1/exp-1/staging/part-000002.ndjson");

    await expect(processor.process(job() as never)).rejects.toThrow("r2 unavailable");
    expect(state().processedRows).toBe(500);
    expect(state().nextBatchNumber).toBe(2);

    failUploadKeys.clear();
    await processor.process(job() as never);

    expect(state().status).toBe("COMPLETED");
    expect(state().processedRows).toBe(1201);

    const final = objects.get(state().finalObjectKey as string) as Buffer;
    const records = parse(final, { columns: true }) as Record<string, string>[];
    const numbers = records.map((record) => record["Employee Number"]);

    expect(records).toHaveLength(1201);
    expect(new Set(numbers).size).toBe(1201);
    expect(numbers).toContain("EMP-001201");
  });

  it("pauses after the first batch and resumes from the exact checkpoint", async () => {
    const harness = createHarness(makeEmployees(600));
    const { processor, job, state, prisma } = harness;
    let updates = 0;
    const original = prisma.employeeExport.update;

    prisma.employeeExport.update = vi.fn(async (args: { data: Record<string, unknown> }) => {
      updates += 1;

      if (updates === 1) {
        const result = await original(args);

        harness.setState({ status: "PAUSING" });

        return result;
      }

      return original(args);
    });

    await processor.process(job() as never);
    expect(state().status).toBe("PAUSED");
    expect(state().processedRows).toBe(500);
    expect(state().finalObjectKey).toBeNull();

    // Resume continuation: service flips PAUSED → QUEUED; the worker must
    // continue from row 501 instead of restarting.
    harness.setState({ status: "QUEUED" });
    await processor.process(job() as never);

    expect(state().status).toBe("COMPLETED");
    expect(state().processedRows).toBe(600);
  });

  it("cancels processing with full artifact cleanup", async () => {
    const harness = createHarness(makeEmployees(600));
    const { processor, job, state, objects } = harness;

    harness.setState({ status: "CANCELLING" });
    await processor.process(job() as never);

    expect(state().status).toBe("CANCELLED");
    expect(
      [...objects.keys()].filter((key) => key.includes("employee-exports/org-1/exp-1")),
    ).toHaveLength(0);
  });

  it("resumes FINALIZING retries from finalization instead of re-extracting", async () => {
    const harness = createHarness(makeEmployees(10));
    const { processor, job, state, prisma } = harness;

    await processor.process(job() as never);
    expect(state().status).toBe("COMPLETED");

    const countBefore = (prisma.employee.count as ReturnType<typeof vi.fn>).mock.calls.length;

    harness.setState({ status: "FINALIZING" });
    await expect(processor.process(job() as never)).rejects.toThrow();

    // Staging was deleted after success, so re-finalize fails; the export
    // must not silently restart extraction (employee reads unchanged).
    expect((prisma.employee.count as ReturnType<typeof vi.fn>).mock.calls.length).toBe(countBefore);
  });

  it("parks FAILED on the final attempt and rethrows transient failures", async () => {
    const transient = createHarness(makeEmployees(600));

    transient.failUploadKeys.add("employee-exports/org-1/exp-1/staging/part-000001.ndjson");
    await expect(transient.processor.process(transient.job() as never)).rejects.toThrow();
    expect(transient.state().status).not.toBe("FAILED");

    const terminal = createHarness(makeEmployees(600));

    terminal.failUploadKeys.add("employee-exports/org-1/exp-1/staging/part-000001.ndjson");
    await terminal.processor.process(terminal.job({ attemptsMade: 2 }) as never);
    expect(terminal.state().status).toBe("FAILED");
    expect(terminal.state().errorCode).toBe("EMPLOYEE_EXPORT_WORKER_FAILED");
  });

  it("produces valid CSV: injection-safe with quotes, commas, newlines, unicode", async () => {
    const { processor, job, state, objects } = createHarness(makeEmployees(10));

    await processor.process(job() as never);

    const final = objects.get(state().finalObjectKey as string) as Buffer;
    const text = final.toString("utf8");
    const records = parse(final, { columns: true }) as Record<string, string>[];

    expect(Object.keys(records[0])).toEqual([...EMPLOYEE_INTERCHANGE_COLUMNS]);
    expect(records).toHaveLength(10);
    // Formula prefixes are neutralized at the data level.
    expect(text).toContain("'=CMD");
    expect(records[0]["First Name"]).toBe("'=CMD|'/malicious");
    // Quotes, commas, embedded newlines, and unicode survive the round trip.
    expect(records[1]["Last Name"]).toBe('O"Brien, Jr.\nÜnïcodé');
    expect(records[2]["Job Title"]).toBe("'+Engineering @R&D");
    // Human-readable departments, never UUIDs or compensation columns.
    expect(records[0].Department).toBe("Engineering");
    expect("departmentId" in records[0]).toBe(false);
    expect("organizationId" in records[0]).toBe(false);
    expect(Object.keys(records[0]).some((key) => key.toLowerCase().includes("salar"))).toBe(false);
    // Size comes from storage HEAD, not an in-memory buffer guess.
    expect(state().fileSizeBytes).toBe(final.length);
  });

  it("produces a real XLSX workbook with dates and exact rows", async () => {
    const { processor, job, state, objects } = createHarness(makeEmployees(25), { format: "XLSX" });

    await processor.process(job() as never);

    const final = objects.get(state().finalObjectKey as string) as Buffer;
    const workbook = new ExcelJS.Workbook();

    await workbook.xlsx.load(final as unknown as ArrayBuffer);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["Employees"]);

    const sheet = workbook.getWorksheet("Employees") as ExcelJS.Worksheet;
    const header = sheet.getRow(1).values as unknown[];

    expect(header.slice(1)).toEqual([...EMPLOYEE_INTERCHANGE_COLUMNS]);
    expect(sheet.rowCount).toBe(26);
    expect(sheet.getRow(1).font?.bold).toBe(true);

    const firstData = sheet.getRow(2);
    const startDate = firstData.getCell(11).value;

    expect(startDate instanceof Date).toBe(true);
    expect((startDate as Date).toISOString().slice(0, 10)).toBe("2022-03-01");
    expect(firstData.getCell(11).numFmt).toBe("yyyy-mm-dd");
  });

  it("deletes staging after success and completes zero-employee exports", async () => {
    const { processor, job, state, objects } = createHarness(makeEmployees(3));

    await processor.process(job() as never);

    const stagingLeft = [...objects.keys()].filter((key) => key.includes("/staging/"));

    expect(stagingLeft).toHaveLength(0);
    expect(state().finalObjectKey).toContain("/final/");

    const empty = createHarness([]);

    await empty.processor.process(empty.job() as never);
    expect(empty.state().status).toBe("COMPLETED");
    expect(empty.state().processedRows).toBe(0);
  });

  it("sweeps expired completions and stale debris on the cleanup job", async () => {
    const harness = createHarness([]);
    const { processor, prisma, objects, state } = harness;

    (prisma.employeeExport.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        {
          id: "exp-old",
          organizationId: "org-1",
          finalObjectKey: "employee-exports/org-1/exp-old/final/f.csv",
        },
      ])
      .mockResolvedValueOnce([{ id: "exp-dead", organizationId: "org-1", finalObjectKey: null }]);

    objects.set("employee-exports/org-1/exp-old/final/f.csv", Buffer.from("x"));
    objects.set("employee-exports/org-1/exp-old/staging/part-000001.ndjson", Buffer.from("x"));
    objects.set("employee-exports/org-1/exp-dead/staging/part-000001.ndjson", Buffer.from("x"));

    await processor.process({ name: "employee-export-cleanup", data: {} } as never);

    expect(objects.has("employee-exports/org-1/exp-old/final/f.csv")).toBe(false);
    expect(objects.has("employee-exports/org-1/exp-old/staging/part-000001.ndjson")).toBe(false);
    expect(objects.has("employee-exports/org-1/exp-dead/staging/part-000001.ndjson")).toBe(false);
    expect(state().status).toBe("QUEUED");
  });
});
