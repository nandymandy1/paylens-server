import { Readable } from "node:stream";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import type { Job } from "bullmq";
import { EmployeeStatus, EmploymentType } from "@prisma/client";
import { isPrismaUniqueViolationOn } from "@/common/utils/prisma.js";
import { PrismaService } from "@/database/prisma.service.js";
import { normalizeDepartmentName } from "@/modules/employee-transfer/employee-interchange.js";
import { FileStorageService } from "@/storage/file-storage.service.js";
import {
  EMPLOYEE_IMPORT_APPLY_BATCH_SIZE,
  EMPLOYEE_IMPORT_APPLY_JOB,
  EMPLOYEE_IMPORT_MAX_ROWS,
  EMPLOYEE_IMPORT_NORMALIZED_CHUNK_SIZE,
  EMPLOYEE_IMPORT_QUEUE,
} from "./employee-imports.constants.js";

type ImportJob = { importId: string; organizationId: string; requestedByUserId: string };

type NormalizedRow = {
  rowNumber: number;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string | null;
  jobTitle: string;
  department: string;
  countryCode: string;
  employmentType: EmploymentType;
  status: EmployeeStatus;
  level: string | null;
  hireDate: string;
  terminationDate: string | null;
  kind: "CREATE" | "UPDATE" | "UNCHANGED";
};

type RowError = {
  row: number;
  employeeNumber: string;
  column: string;
  errorCode: string;
  message: string;
};

const REQUIRED_HEADERS = [
  "Employee Number",
  "First Name",
  "Last Name",
  "Job Title",
  "Department",
  "Country",
  "Employment Type",
  "Start Date",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeHeader = (value: string): string =>
  // Strip a leading BOM: Excel-saved CSVs start the first header with U+FEFF,
  // which otherwise breaks the "Employee Number" required-header match.
  value.replace(/^\uFEFF/, "").trim().toLocaleLowerCase();

const canonicalHeader = (value: string): string | null => {
  const normalized = normalizeHeader(value);
  const match: Record<string, string> = {
    "employee number": "Employee Number",
    "first name": "First Name",
    "last name": "Last Name",
    "work email": "Work Email",
    "job title": "Job Title",
    department: "Department",
    country: "Country",
    "employment type": "Employment Type",
    "employment status": "Employment Status",
    level: "Level",
    "start date": "Start Date",
    "termination date": "Termination Date",
  };

  return match[normalized] ?? null;
};

const toEmploymentType = (value: string): EmploymentType | null => {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (normalized === "FULLTIME") return "FULL_TIME";
  if (normalized === "PARTTIME") return "PART_TIME";
  if ((Object.values(EmploymentType) as string[]).includes(normalized))
    return normalized as EmploymentType;

  return null;
};

const toEmployeeStatus = (value: string): EmployeeStatus | null => {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (!normalized) return "ACTIVE";
  if ((Object.values(EmployeeStatus) as string[]).includes(normalized))
    return normalized as EmployeeStatus;

  return null;
};

const isRealDate = (value: string): boolean => {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

const departmentCodeFor = (name: string): string => {
  const base =
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 20) || "DEPT";

  return /^[A-Z0-9][A-Z0-9-]{1,19}$/.test(base) ? base : `${base.slice(0, 18)}-X`;
};

async function readCsvTable(stream: Readable): Promise<{ headers: string[]; rows: string[][] }> {
  const parser = stream.pipe(
    parse({ columns: false, trim: true, skip_empty_lines: true, relax_column_count: true }),
  );
  const records: string[][] = [];

  for await (const record of parser as AsyncIterable<string[]>) {
    records.push(record);
    if (records.length > EMPLOYEE_IMPORT_MAX_ROWS + 1)
      throw Object.assign(new Error("Row limit exceeded"), { code: "ROW_LIMIT" });
  }

  if (!records.length) return { headers: [], rows: [] };

  return { headers: records[0], rows: records.slice(1) };
}

async function readXlsxTable(buffer: Buffer): Promise<{ headers: string[]; rows: string[][] }> {
  const workbook = new ExcelJS.Workbook();

  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  if (!workbook.worksheets.length)
    throw Object.assign(new Error("No worksheet"), { code: "NO_SHEET" });

  const named = workbook.worksheets.find(
    (sheet) => sheet.name.trim().toLocaleLowerCase() === "employees",
  );
  const sheet = named ?? (workbook.worksheets.length === 1 ? workbook.worksheets[0] : null);

  if (!sheet) throw Object.assign(new Error("Ambiguous worksheet"), { code: "MULTIPLE_SHEETS" });

  const table: string[][] = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || table.length < EMPLOYEE_IMPORT_MAX_ROWS + 1) {
      const values: string[] = [];
      const count = typeof row.cellCount === "number" && row.cellCount > 0 ? row.cellCount : 12;

      for (let index = 1; index <= count; index += 1) {
        const cell = row.getCell(index);
        const value = cell.value as unknown;

        if (
          value !== null &&
          typeof value === "object" &&
          "formula" in (value as Record<string, unknown>)
        )
          throw Object.assign(new Error(`Formula cell at row ${rowNumber}`), {
            code: "FORMULA_CELL",
          });

        values.push(value === null || value === undefined ? "" : String(value).trim());
      }

      table.push(values);
    }
  });

  if (!table.length) return { headers: [], rows: [] };

  return { headers: table[0], rows: table.slice(1) };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const piece of stream)
    chunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));

  return Buffer.concat(chunks);
}

@Processor(EMPLOYEE_IMPORT_QUEUE)
export class EmployeeImportsProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
  ) {
    super();
  }

  async process(job: Job<ImportJob>): Promise<void> {
    if (job.name === EMPLOYEE_IMPORT_APPLY_JOB) await this.applyImport(job);
    else await this.validateImport(job);
  }

  private async validateImport(job: Job<ImportJob>): Promise<void> {
    const row = await this.prisma.employeeImport.findFirst({
      where: {
        id: job.data.importId,
        organizationId: job.data.organizationId,
        requestedByUserId: job.data.requestedByUserId,
      },
    });

    if (
      !row ||
      ["CANCELLED", "CANCELLED_PARTIAL", "COMPLETED", "COMPLETED_WITH_ERRORS", "EXPIRED"].includes(
        row.status,
      )
    )
      return;

    await this.prisma.employeeImport.update({
      where: { id: row.id },
      data: { status: "VALIDATING" },
    });

    try {
      const stream = await this.storage.downloadStream(row.sourceObjectKey);
      const table =
        row.format === "CSV"
          ? await readCsvTable(stream)
          : await readXlsxTable(await streamToBuffer(stream));

      const fatal = await this.failIfBadHeaders(row.id, table.headers);

      if (fatal) return;

      const { normalized, errors, warnings, missingDepartments, matchedDepartments } =
        await this.classifyRows(row.organizationId, table);

      const invalidRowNumbers = new Set(errors.map((error) => error.row));
      const good = normalized.filter((item) => !invalidRowNumbers.has(item.rowNumber));
      const createRows = good.filter((item) => item.kind === "CREATE").length;
      const updateRows = good.filter((item) => item.kind === "UPDATE").length;
      const unchangedRows = good.filter((item) => item.kind === "UNCHANGED").length;

      // Stage normalized rows for pause/resume/apply without reparsing source.
      const prefix = `employee-imports/${row.organizationId}/${row.id}/normalized/`;
      let chunk: NormalizedRow[] = [];
      let chunkIndex = 1;

      for (const item of good) {
        chunk.push(item);
        if (chunk.length >= EMPLOYEE_IMPORT_NORMALIZED_CHUNK_SIZE) {
          await this.storage.upload({
            key: `${prefix}part-${String(chunkIndex).padStart(6, "0")}.ndjson`,
            body: Buffer.from(`${chunk.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
            contentType: "application/x-ndjson",
          });
          chunk = [];
          chunkIndex += 1;
        }
      }

      if (chunk.length) {
        await this.storage.upload({
          key: `${prefix}part-${String(chunkIndex).padStart(6, "0")}.ndjson`,
          body: Buffer.from(`${chunk.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
          contentType: "application/x-ndjson",
        });
      }

      const reportKey = `employee-imports/${row.organizationId}/${row.id}/reports/validation-errors.csv`;
      const reportBody = stringify(
        errors.map((error) => [
          error.row,
          error.employeeNumber,
          error.column,
          error.errorCode,
          error.message,
        ]),
        { header: true, columns: ["Row", "Employee Number", "Column", "Error Code", "Message"] },
      );

      await this.storage.upload({
        key: reportKey,
        body: Buffer.from(
          errors.length ? reportBody : "Row,Employee Number,Column,Error Code,Message\n",
        ),
        contentType: "text/csv; charset=utf-8",
      });

      const previewSummary = {
        totalRows: good.length + invalidRowNumbers.size,
        createRows,
        updateRows,
        unchangedRows,
        invalidRows: invalidRowNumbers.size,
        matchedDepartments,
        missingDepartments,
        warnings,
        firstErrors: errors.slice(0, 25),
      };

      await this.prisma.employeeImport.update({
        where: { id: row.id },
        data: {
          status: "READY_FOR_REVIEW",
          totalRows: table.rows.length,
          validatedRows: table.rows.length,
          validRows: good.length,
          invalidRows: previewSummary.invalidRows,
          createRows,
          updateRows,
          unchangedRows,
          normalizedPrefix: prefix,
          validationReportObjectKey: reportKey,
          previewSummary,
          validatedAt: new Date(),
        },
      });
      await job.updateProgress({ validatedRows: table.rows.length, totalRows: table.rows.length });
    } catch (error) {
      const code =
        error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : null;
      const message = error instanceof Error ? error.message : "Validation failed";

      if (
        code === "ROW_LIMIT" ||
        code === "FORMULA_CELL" ||
        code === "MULTIPLE_SHEETS" ||
        code === "NO_SHEET"
      ) {
        await this.prisma.employeeImport.update({
          where: { id: row.id },
          data: { status: "FAILED", previewSummary: { fatal: message, code } },
        });

        return;
      }

      await this.prisma.employeeImport.update({
        where: { id: row.id },
        data: { status: "FAILED", previewSummary: { fatal: "Validation failed unexpectedly" } },
      });
    }
  }

  private async failIfBadHeaders(importId: string, headers: string[]): Promise<boolean> {
    const canonical = headers.map((header) => canonicalHeader(header));
    const seen = new Map<string, number>();
    const errors: RowError[] = [];

    headers.forEach((header, index) => {
      const mapped = canonical[index];

      if (!mapped) return;
      seen.set(mapped, (seen.get(mapped) ?? 0) + 1);
    });

    for (const [name, count] of seen) {
      if (count > 1)
        errors.push({
          row: 0,
          employeeNumber: "",
          column: name,
          errorCode: "DUPLICATE_HEADER",
          message: `Duplicate column: ${name}`,
        });
    }

    for (const required of REQUIRED_HEADERS) {
      if (!seen.has(required))
        errors.push({
          row: 0,
          employeeNumber: "",
          column: required,
          errorCode: "MISSING_HEADER",
          message: `Missing required column: ${required}`,
        });
    }

    if (!headers.length)
      errors.push({
        row: 0,
        employeeNumber: "",
        column: "__file__",
        errorCode: "EMPTY_FILE",
        message: "File contains no rows.",
      });

    if (!errors.length) return false;

    const row = await this.prisma.employeeImport.findUniqueOrThrow({ where: { id: importId } });
    const reportKey = `employee-imports/${row.organizationId}/${row.id}/reports/validation-errors.csv`;

    await this.storage.upload({
      key: reportKey,
      body: Buffer.from(
        stringify(
          errors.map((error) => [
            error.row,
            error.employeeNumber,
            error.column,
            error.errorCode,
            error.message,
          ]),
          { header: true, columns: ["Row", "Employee Number", "Column", "Error Code", "Message"] },
        ),
      ),
      contentType: "text/csv; charset=utf-8",
    });
    await this.prisma.employeeImport.update({
      where: { id: importId },
      data: {
        status: "FAILED",
        totalRows: 0,
        validatedRows: 0,
        validRows: 0,
        invalidRows: errors.length,
        validationReportObjectKey: reportKey,
        previewSummary: { fatal: errors[0].message, firstErrors: errors.slice(0, 25) },
      },
    });

    return true;
  }

  private async classifyRows(
    organizationId: string,
    table: { headers: string[]; rows: string[][] },
  ): Promise<{
    normalized: NormalizedRow[];
    errors: RowError[];
    warnings: string[];
    missingDepartments: string[];
    matchedDepartments: string[];
  }> {
    const headerIndex = new Map<string, number>();

    table.headers.forEach((header, index) => {
      const mapped = canonicalHeader(header);

      if (mapped && !headerIndex.has(mapped)) headerIndex.set(mapped, index);
    });

    const cell = (row: string[], column: string): string =>
      (row[headerIndex.get(column) ?? -1] ?? "").trim();

    const existing = await this.prisma.employee.findMany({
      where: { organizationId },
      select: {
        employeeNumber: true,
        firstName: true,
        lastName: true,
        workEmail: true,
        jobTitle: true,
        level: true,
        countryCode: true,
        employmentType: true,
        status: true,
        hireDate: true,
        terminationDate: true,
        department: { select: { name: true } },
      },
    });
    const byNumber = new Map(existing.map((employee) => [employee.employeeNumber, employee]));
    const emailOwner = new Map(
      existing.flatMap((employee) =>
        employee.workEmail ? [[employee.workEmail.toLowerCase(), employee.employeeNumber]] : [],
      ),
    );
    const departments = await this.prisma.department.findMany({
      where: { organizationId },
      select: { name: true },
    });
    const knownDepartments = new Set(
      departments.map((department) => normalizeDepartmentName(department.name)),
    );

    const normalized: NormalizedRow[] = [];
    const errors: RowError[] = [];
    const warnings: string[] = [];
    const seenNumbers = new Map<string, number>();
    const seenEmails = new Map<string, number>();
    const missing = new Set<string>();
    const matched = new Set<string>();

    if (table.headers.some((header) => canonicalHeader(header) === null))
      warnings.push("Unknown columns are ignored.");

    table.rows.forEach((record, index) => {
      const rowNumber = index + 2;
      const push = (
        column: string,
        errorCode: string,
        message: string,
        employeeNumber = "",
      ): void => {
        errors.push({ row: rowNumber, employeeNumber, column, errorCode, message });
      };

      const employeeNumber = cell(record, "Employee Number");
      const firstName = cell(record, "First Name");
      const lastName = cell(record, "Last Name");
      const workEmailRaw = cell(record, "Work Email");
      const jobTitle = cell(record, "Job Title");
      const department = cell(record, "Department");
      const countryCode = cell(record, "Country").toUpperCase();
      const employmentTypeRaw = cell(record, "Employment Type");
      const statusRaw = cell(record, "Employment Status");
      const levelRaw = cell(record, "Level");
      const hireDate = cell(record, "Start Date");
      const terminationRaw = cell(record, "Termination Date");

      let invalid = false;
      const fail = (column: string, errorCode: string, message: string): void => {
        invalid = true;
        push(column, errorCode, message, employeeNumber);
      };

      if (!employeeNumber || employeeNumber.length > 64)
        fail("Employee Number", "REQUIRED", "Employee Number is required (1-64 chars).");
      if (!firstName || firstName.length > 100)
        fail("First Name", "REQUIRED", "First Name is required (1-100 chars).");
      if (!lastName || lastName.length > 100)
        fail("Last Name", "REQUIRED", "Last Name is required (1-100 chars).");
      if (!jobTitle || jobTitle.length > 120)
        fail("Job Title", "REQUIRED", "Job Title is required (1-120 chars).");
      if (!department || department.length > 100)
        fail("Department", "REQUIRED", "Department is required (1-100 chars).");
      if (!/^[A-Z]{2}$/.test(countryCode))
        fail("Country", "INVALID_COUNTRY", "Country must be a 2-letter code.");

      const employmentType = toEmploymentType(employmentTypeRaw);

      if (!employmentType)
        fail(
          "Employment Type",
          "INVALID_ENUM",
          "Employment Type must be FULL_TIME, PART_TIME, CONTRACTOR, or INTERN.",
        );

      const status = toEmployeeStatus(statusRaw);

      if (!status)
        fail(
          "Employment Status",
          "INVALID_ENUM",
          "Employment Status must be ACTIVE, ON_LEAVE, or TERMINATED.",
        );

      if (!hireDate || !isRealDate(hireDate))
        fail("Start Date", "INVALID_DATE", "Start Date must be YYYY-MM-DD.");
      if (terminationRaw && !isRealDate(terminationRaw))
        fail("Termination Date", "INVALID_DATE", "Termination Date must be YYYY-MM-DD.");
      if (
        hireDate &&
        terminationRaw &&
        isRealDate(hireDate) &&
        isRealDate(terminationRaw) &&
        terminationRaw < hireDate
      )
        fail("Termination Date", "INVALID_RANGE", "Termination Date cannot precede Start Date.");

      const workEmail = workEmailRaw ? workEmailRaw.toLowerCase() : null;

      if (workEmail && (!EMAIL_RE.test(workEmail) || workEmail.length > 254))
        fail("Work Email", "INVALID_EMAIL", "Work Email is invalid.");
      if (levelRaw && levelRaw.length > 32) fail("Level", "TOO_LONG", "Level exceeds 32 chars.");

      if (employeeNumber) {
        if (seenNumbers.has(employeeNumber))
          fail(
            "Employee Number",
            "DUPLICATE_IN_FILE",
            `Duplicate Employee Number in file (rows ${seenNumbers.get(employeeNumber)} and ${rowNumber}).`,
          );
        else seenNumbers.set(employeeNumber, rowNumber);
      }

      if (workEmail) {
        if (seenEmails.has(workEmail))
          fail(
            "Work Email",
            "DUPLICATE_IN_FILE",
            `Duplicate Work Email in file (rows ${seenEmails.get(workEmail)} and ${rowNumber}).`,
          );
        else seenEmails.set(workEmail, rowNumber);
      }

      // Tenant conflict: same number but email belongs to a different employee.
      const current = byNumber.get(employeeNumber);

      if (
        current &&
        workEmail &&
        emailOwner.has(workEmail) &&
        emailOwner.get(workEmail) !== employeeNumber
      )
        fail("Work Email", "EMAIL_CONFLICT", "Work Email belongs to a different employee.");

      if (invalid) return;

      if (knownDepartments.has(normalizeDepartmentName(department))) matched.add(department.trim());
      else missing.add(department.trim());

      const level = levelRaw ? levelRaw : null;
      const terminationDate = terminationRaw ? terminationRaw : null;
      let kind: NormalizedRow["kind"] = "CREATE";

      if (current) {
        const same =
          current.firstName === firstName &&
          current.lastName === lastName &&
          (current.workEmail?.toLowerCase() ?? null) === workEmail &&
          current.jobTitle === jobTitle &&
          current.department.name === department.trim() &&
          current.countryCode === countryCode &&
          current.employmentType === employmentType &&
          current.status === status &&
          (current.level ?? null) === level &&
          current.hireDate.toISOString().slice(0, 10) === hireDate &&
          (current.terminationDate?.toISOString().slice(0, 10) ?? null) === terminationDate;

        kind = same ? "UNCHANGED" : "UPDATE";
      }

      normalized.push({
        rowNumber,
        employeeNumber,
        firstName,
        lastName,
        workEmail,
        jobTitle,
        department: department.trim(),
        countryCode,
        employmentType: employmentType as EmploymentType,
        status: status as EmployeeStatus,
        level,
        hireDate,
        terminationDate,
        kind,
      });
    });

    return {
      normalized,
      errors,
      warnings,
      missingDepartments: [...missing],
      matchedDepartments: [...matched],
    };
  }

  private async applyImport(job: Job<ImportJob>): Promise<void> {
    const row = await this.prisma.employeeImport.findFirst({
      where: {
        id: job.data.importId,
        organizationId: job.data.organizationId,
        requestedByUserId: job.data.requestedByUserId,
      },
    });

    if (
      !row ||
      ["CANCELLED", "CANCELLED_PARTIAL", "COMPLETED", "COMPLETED_WITH_ERRORS", "EXPIRED"].includes(
        row.status,
      )
    )
      return;
    if (!row.normalizedPrefix) {
      await this.prisma.employeeImport.update({
        where: { id: row.id },
        data: { status: "FAILED" },
      });

      return;
    }

    await this.prisma.employeeImport.update({
      where: { id: row.id },
      data: { status: "APPLYING" },
    });

    // Resolve departments once; create missing exactly once per logical name.
    const loadDepartments = async (): Promise<Map<string, string>> => {
      const departments = await this.prisma.department.findMany({
        where: { organizationId: row.organizationId },
        select: { id: true, name: true },
      });

      return new Map(
        departments.map((department) => [normalizeDepartmentName(department.name), department.id]),
      );
    };

    let departmentByNormalized = await loadDepartments();
    const desired = new Set<string>();
    const chunkIndex = Math.max(1, row.nextBatchNumber);

    // Discover desired departments from staged chunks (bounded: chunk keys listed via prefix scan is avoided;
    // normalized chunks are deterministic part-000001.. so probe sequentially until a miss).
    const staged: NormalizedRow[] = [];

    for (;;) {
      const key = `${row.normalizedPrefix}part-${String(chunkIndex + staged.length).padStart(6, "0")}.ndjson`;
      const exists = await this.storage.exists(key);

      if (!exists) break;

      const buffer = await streamToBuffer(await this.storage.downloadStream(key));
      const lines = buffer.toString("utf8").split("\n").filter(Boolean);

      for (const line of lines) staged.push(JSON.parse(line) as NormalizedRow);
      if (staged.length > EMPLOYEE_IMPORT_MAX_ROWS) break;
    }

    for (const item of staged) desired.add(normalizeDepartmentName(item.department));

    const missing = [...desired].filter((name) => !departmentByNormalized.has(name));

    if (missing.length && !row.createMissingDepartments) {
      await this.prisma.employeeImport.update({
        where: { id: row.id },
        data: { status: "FAILED" },
      });

      return;
    }

    for (const normalizedName of missing) {
      const original =
        staged.find((item) => normalizeDepartmentName(item.department) === normalizedName)
          ?.department ?? normalizedName;
      const code = departmentCodeFor(original);
      let attempt = 0;

      for (;;) {
        try {
          const created = await this.prisma.department.create({
            data: {
              organizationId: row.organizationId,
              code: attempt ? `${code.slice(0, 18)}-${attempt + 1}` : code,
              name: original.trim(),
            },
            select: { id: true },
          });

          departmentByNormalized.set(normalizedName, created.id);
          break;
        } catch (error) {
          const unique =
            isPrismaUniqueViolationOn(error, "code") ||
            isPrismaUniqueViolationOn(error, "normalizedName");

          if (!unique) throw error;
          // Another job created the same logical department concurrently: reuse it.
          departmentByNormalized = await loadDepartments();
          if (departmentByNormalized.has(normalizedName)) break;
          attempt += 1;
          if (attempt > 5) throw error;
        }
      }
    }

    departmentByNormalized = await loadDepartments();

    const pending = staged.filter((item) => item.rowNumber > row.lastProcessedRow);
    const applyErrors: RowError[] = [];
    let createdRows = row.createdRows;
    let updatedRows = row.updatedRows;
    let failedRows = row.failedRows;
    let processedRows = row.processedRows;

    for (let start = 0; start < pending.length; start += EMPLOYEE_IMPORT_APPLY_BATCH_SIZE) {
      const state = await this.prisma.employeeImport.findUniqueOrThrow({ where: { id: row.id } });

      if (state.status === "CANCELLING") {
        const status =
          processedRows > row.processedRows && row.processedRows >= 0 && processedRows > 0
            ? "CANCELLED_PARTIAL"
            : "CANCELLED";

        await this.prisma.employeeImport.update({ where: { id: row.id }, data: { status } });

        return;
      }

      if (state.status === "PAUSING") {
        await this.prisma.employeeImport.update({
          where: { id: row.id },
          data: { status: "PAUSED" },
        });

        return;
      }

      const batch = pending.slice(start, start + EMPLOYEE_IMPORT_APPLY_BATCH_SIZE);

      await this.prisma.$transaction(async (transaction) => {
        for (const item of batch) {
          try {
            if (item.kind === "UNCHANGED") {
              processedRows += 1;

              return;
            }

            const departmentId = departmentByNormalized.get(
              normalizeDepartmentName(item.department),
            );

            if (!departmentId) {
              failedRows += 1;
              processedRows += 1;
              applyErrors.push({
                row: item.rowNumber,
                employeeNumber: item.employeeNumber,
                column: "Department",
                errorCode: "DEPARTMENT_RESOLUTION_ERROR",
                message: "Department could not be resolved.",
              });

              return;
            }

            const current = await transaction.employee.findFirst({
              where: { organizationId: row.organizationId, employeeNumber: item.employeeNumber },
              select: { id: true, workEmail: true },
            });

            if (item.workEmail && current) {
              const owner = await transaction.employee.findFirst({
                where: { organizationId: row.organizationId, workEmail: item.workEmail },
                select: { id: true },
              });

              if (owner && owner.id !== current.id) {
                failedRows += 1;
                processedRows += 1;
                applyErrors.push({
                  row: item.rowNumber,
                  employeeNumber: item.employeeNumber,
                  column: "Work Email",
                  errorCode: "EMAIL_CONFLICT",
                  message: "Work Email is owned by another employee.",
                });

                return;
              }
            }

            if (current) {
              await transaction.employee.update({
                where: { id: current.id },
                data: {
                  firstName: item.firstName,
                  lastName: item.lastName,
                  workEmail: item.workEmail,
                  jobTitle: item.jobTitle,
                  departmentId,
                  countryCode: item.countryCode,
                  employmentType: item.employmentType,
                  status: item.status,
                  level: item.level,
                  hireDate: new Date(`${item.hireDate}T00:00:00.000Z`),
                  terminationDate: item.terminationDate
                    ? new Date(`${item.terminationDate}T00:00:00.000Z`)
                    : null,
                },
              });
              updatedRows += 1;
            } else {
              await transaction.employee.create({
                data: {
                  organizationId: row.organizationId,
                  departmentId,
                  employeeNumber: item.employeeNumber,
                  firstName: item.firstName,
                  lastName: item.lastName,
                  workEmail: item.workEmail,
                  jobTitle: item.jobTitle,
                  level: item.level,
                  countryCode: item.countryCode,
                  employmentType: item.employmentType,
                  status: item.status,
                  hireDate: new Date(`${item.hireDate}T00:00:00.000Z`),
                  terminationDate: item.terminationDate
                    ? new Date(`${item.terminationDate}T00:00:00.000Z`)
                    : null,
                },
              });
              createdRows += 1;
            }

            processedRows += 1;
          } catch {
            failedRows += 1;
            processedRows += 1;
            applyErrors.push({
              row: item.rowNumber,
              employeeNumber: item.employeeNumber,
              column: "__row__",
              errorCode: "UNIQUE_CONFLICT",
              message: "Row could not be applied due to a conflict.",
            });
          }
        }
      });

      const lastRow = batch.at(-1)?.rowNumber ?? row.lastProcessedRow;

      await this.prisma.employeeImport.update({
        where: { id: row.id },
        data: {
          processedRows,
          createdRows,
          updatedRows,
          failedRows,
          lastProcessedRow: lastRow,
          progressPercent: Math.min(
            99,
            50 + Math.floor((processedRows / Math.max(1, row.totalRows || staged.length)) * 45),
          ),
        },
      });
      await job.updateProgress({ processedRows, totalRows: row.totalRows || staged.length });
    }

    const reportKey = `employee-imports/${row.organizationId}/${row.id}/reports/apply-errors.csv`;

    await this.storage.upload({
      key: reportKey,
      body: Buffer.from(
        applyErrors.length
          ? stringify(
              applyErrors.map((error) => [
                error.row,
                error.employeeNumber,
                error.column,
                error.errorCode,
                error.message,
              ]),
              {
                header: true,
                columns: ["Row", "Employee Number", "Column", "Error Code", "Message"],
              },
            )
          : "Row,Employee Number,Column,Error Code,Message\n",
      ),
      contentType: "text/csv; charset=utf-8",
    });

    await this.prisma.employeeImport.update({
      where: { id: row.id },
      data: {
        status: failedRows > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        applyReportObjectKey: reportKey,
        completedAt: new Date(),
        progressPercent: 100,
      },
    });
  }
}
