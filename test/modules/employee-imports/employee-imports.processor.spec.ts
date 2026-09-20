import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPLOYEE_IMPORT_VALIDATE_JOB } from "@/modules/employee-imports/employee-imports.constants.js";
import { EmployeeImportsProcessor } from "@/modules/employee-imports/employee-imports.processor.js";

// Excel-saved CSVs start the first header cell with a BOM (U+FEFF). The real
// user file "novastack-tech-300-employees.csv" carries it, and validation must
// still recognize "Employee Number" instead of failing with MISSING_HEADER.
const BOM_CSV = [
  "\uFEFF" + "Employee Number,First Name,Last Name,Work Email,Job Title,Department,Country,Employment Type,Employment Status,Level,Start Date,Termination Date",
  "NST-0001,Ananya,Agarwal,ananya.agarwal.001@novastack.example,Staff Engineer,Engineering,IN,FULL_TIME,ACTIVE,L4,2022-08-07,",
].join("\n");

const createHarness = () => {
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    employeeImport: {
      findFirst: vi.fn(async () => ({
        id: "imp-1",
        organizationId: "org-1",
        requestedByUserId: "user-1",
        format: "CSV",
        status: "QUEUED",
        sourceObjectKey: "employee-imports/org-1/imp-1/source/original.csv",
      })),
      findUniqueOrThrow: vi.fn(async () => ({
        id: "imp-1",
        organizationId: "org-1",
      })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);

        return args.data;
      }),
    },
    employee: { findMany: vi.fn(async () => []) },
    department: { findMany: vi.fn(async () => [{ name: "Engineering" }]) },
  };
  const storage = {
    downloadStream: vi.fn(async () => Readable.from([BOM_CSV])),
    upload: vi.fn(async () => ({ key: "k" })),
  };
  const processor = new EmployeeImportsProcessor(prisma as never, storage as never);

  return { prisma, storage, processor, updates };
};

describe("EmployeeImportsProcessor", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("validates a BOM-prefixed CSV without a header failure", async () => {
    const { processor, updates } = createHarness();

    await processor.process({
      name: EMPLOYEE_IMPORT_VALIDATE_JOB,
      data: { importId: "imp-1", organizationId: "org-1", requestedByUserId: "user-1" },
      updateProgress: vi.fn(async () => undefined),
    } as never);

    const final = updates.at(-1) as { status: string; invalidRows: number; validRows: number };
    expect(final.status).toBe("READY_FOR_REVIEW");
    expect(final.invalidRows).toBe(0);
    expect(final.validRows).toBe(1);
  });
});
