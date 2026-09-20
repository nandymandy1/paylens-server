import { Readable } from "node:stream";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { parse } from "csv-parse";
import { stringify } from "csv-stringify/sync";
import ExcelJS from "exceljs";
import type { Job } from "bullmq";
import { EmployeeStatus, EmploymentType } from "@prisma/client";
import { isPrismaUniqueViolationOn } from "@/common/utils/prisma.js";
import { PrismaService } from "@/database/prisma.service.js";
import { AiService } from "@/modules/ai/ai.service.js";
import { normalizeDepartmentName } from "@/modules/employee-transfer/employee-interchange.js";
import {
  DEPARTMENT_CODE_HEADER,
  buildDepartmentPrompt,
  buildHeaderMappingPrompt,
  isValidDepartmentCode,
  parseDepartmentResponse,
  parseHeaderMappingResponse,
  readDepartmentPlan,
  resolveDeterministicHeader,
  type DepartmentPlanEntry,
  type HeaderTarget,
} from "./employee-imports.header-mapping.js";
import { FileStorageService } from "@/storage/file-storage.service.js";
import {
  EMPLOYEE_IMPORT_APPLY_BATCH_SIZE,
  EMPLOYEE_IMPORT_APPLY_JOB,
  EMPLOYEE_IMPORT_CLEANUP_BATCH,
  EMPLOYEE_IMPORT_CLEANUP_JOB,
  EMPLOYEE_IMPORT_ERROR_CODES,
  EMPLOYEE_IMPORT_MAX_ATTEMPTS,
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
  departmentCode: string | null;
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

class ValidationCancelledError extends Error {
  constructor() {
    super("Employee import validation cancelled");
  }
}

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

const xlsxDate = (value: Date): string =>
  `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(
    value.getUTCDate(),
  ).padStart(2, "0")}`;

const xlsxCellValue = (value: unknown): string => {
  if (value instanceof Date) return xlsxDate(value);

  return value === null || value === undefined ? "" : String(value).trim();
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

        values.push(xlsxCellValue(value));
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
    private readonly ai: AiService,
  ) {
    super();
  }

  /**
   * Resolve every header to its canonical target. Deterministic rules first;
   * only the leftover unknown header strings go to the standalone AiService
   * (never row data), and only when a key is configured. Unmapped headers
   * stay null and flow into the existing required-header validation errors.
   */
  private async resolveHeaders(headers: string[]): Promise<(HeaderTarget | null)[]> {
    const resolved = headers.map((header) => resolveDeterministicHeader(header));
    const unknown = [
      ...new Set(headers.filter((header, index) => !resolved[index] && header.trim())),
    ];

    if (!unknown.length || !this.ai.isConfigured) return resolved;

    const prompt = buildHeaderMappingPrompt(unknown, [DEPARTMENT_CODE_HEADER]);
    const ai = await this.ai.completeJson(prompt, (raw) =>
      parseHeaderMappingResponse(raw, unknown, [DEPARTMENT_CODE_HEADER]),
    );

    if (!ai) return resolved;

    return headers.map((header, index) => resolved[index] ?? ai[header] ?? null);
  }

  /**
   * Plan names/codes for missing departments. Sheet-provided codes win when
   * valid; otherwise AI proposes from distinct names only (never rows);
   * otherwise the deterministic generator. The plan is persisted in the
   * preview so apply reuses it instead of re-deciding.
   */
  private async planDepartments(
    missing: string[],
    sheetCodes: Map<string, string>,
  ): Promise<DepartmentPlanEntry[]> {
    const prompt = this.ai.isConfigured ? buildDepartmentPrompt(missing) : null;
    const ai = prompt
      ? ((await this.ai.completeJson(prompt, (raw) => parseDepartmentResponse(raw, missing))) ?? {})
      : {};

    return missing.map((from) => {
      const key = normalizeDepartmentName(from);
      const sheetCode = sheetCodes.get(key);

      if (sheetCode) return { from, name: from.trim(), code: sheetCode, source: "sheet" as const };

      const suggestion = ai[from];

      if (suggestion)
        return { from, name: suggestion.name, code: suggestion.code, source: "ai" as const };

      return {
        from,
        name: from.trim(),
        code: departmentCodeFor(from),
        source: "generated" as const,
      };
    });
  }

  async process(job: Job<ImportJob>): Promise<void> {
    if (job.name === EMPLOYEE_IMPORT_CLEANUP_JOB) {
      await this.runCleanup();

      return;
    }

    try {
      if (job.name === EMPLOYEE_IMPORT_APPLY_JOB) await this.applyImport(job);
      else await this.validateImport(job);
    } catch (error) {
      // A non-deterministic storage/DB failure must remain retryable. Once
      // BullMQ has exhausted retries, DB state must not strand in progress.
      if (job.attemptsMade < EMPLOYEE_IMPORT_MAX_ATTEMPTS - 1) throw error;

      await this.prisma.employeeImport.updateMany({
        where: {
          id: job.data.importId,
          status: {
            in: ["QUEUED", "VALIDATING", "APPLY_QUEUED", "APPLYING", "PAUSING", "CANCELLING"],
          },
        },
        data: { status: "FAILED", errorCode: EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_WORKER_FAILED },
      });
    }
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

    const claimed = await this.prisma.employeeImport.updateMany({
      where: { id: row.id, status: { in: ["QUEUED", "VALIDATING"] } },
      data: { status: "VALIDATING" },
    });

    if (!claimed.count) return;

    try {
      const stream = await this.storage.downloadStream(row.sourceObjectKey);
      const table =
        row.format === "CSV"
          ? await readCsvTable(stream)
          : await readXlsxTable(await streamToBuffer(stream));

      await this.prisma.employeeImport.updateMany({
        where: { id: row.id, status: "VALIDATING" },
        data: { totalRows: table.rows.length, validatedRows: 0, progressPercent: 0 },
      });

      const resolvedHeaders = await this.resolveHeaders(table.headers);
      const fatal = await this.failIfBadHeaders(row.id, resolvedHeaders);

      if (fatal) return;

      const {
        normalized,
        errors,
        warnings,
        missingDepartments,
        matchedDepartments,
        departmentCodes,
      } = await this.classifyRows(
        row.organizationId,
        table,
        resolvedHeaders,
        async (validatedRows) => {
          const progressPercent = table.rows.length
            ? Math.min(49, Math.floor((validatedRows / table.rows.length) * 49))
            : 49;
          const updated = await this.prisma.employeeImport.updateMany({
            where: { id: row.id, status: "VALIDATING" },
            data: { validatedRows, totalRows: table.rows.length, progressPercent },
          });

          if (!updated.count) throw new ValidationCancelledError();
          await job.updateProgress({
            validatedRows,
            totalRows: table.rows.length,
            progressPercent,
          });
        },
      );

      const invalidRowNumbers = new Set(errors.map((error) => error.row));
      const good = normalized.filter((item) => !invalidRowNumbers.has(item.rowNumber));
      const departmentPlan = await this.planDepartments(missingDepartments, departmentCodes);
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
        departmentPlan,
        warnings,
        firstErrors: errors.slice(0, 25),
      };

      // A validation cancel must win over its final write. It is intentionally
      // conditional because no resume checkpoint exists during validation.
      const ready = await this.prisma.employeeImport.updateMany({
        where: { id: row.id, status: "VALIDATING" },
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
          progressPercent: 50,
        },
      });

      if (ready.count === 0) {
        const cancelled = await this.prisma.employeeImport.updateMany({
          where: { id: row.id, status: "CANCELLING" },
          data: { status: "CANCELLED" },
        });

        if (cancelled.count)
          await this.storage.deletePrefix(`employee-imports/${row.organizationId}/${row.id}/`);

        return;
      }

      await job.updateProgress({ validatedRows: table.rows.length, totalRows: table.rows.length });
    } catch (error) {
      if (error instanceof ValidationCancelledError) {
        const cancelled = await this.prisma.employeeImport.updateMany({
          where: { id: row.id, status: "CANCELLING" },
          data: { status: "CANCELLED" },
        });

        if (cancelled.count)
          await this.storage.deletePrefix(`employee-imports/${row.organizationId}/${row.id}/`);

        return;
      }

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

      // Let BullMQ retry unexpected infrastructure failures. The outer
      // processor marks final exhaustion FAILED with a safe, stable code.
      throw error;
    }
  }

  private async failIfBadHeaders(
    importId: string,
    resolved: (HeaderTarget | null)[],
  ): Promise<boolean> {
    const seen = new Map<string, number>();
    const errors: RowError[] = [];

    resolved.forEach((mapped) => {
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

    if (!resolved.length)
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
    resolved: (HeaderTarget | null)[],
    onBatchValidated?: (validatedRows: number) => Promise<void>,
  ): Promise<{
    normalized: NormalizedRow[];
    errors: RowError[];
    warnings: string[];
    missingDepartments: string[];
    matchedDepartments: string[];
    departmentCodes: Map<string, string>;
  }> {
    const headerIndex = new Map<string, number>();

    resolved.forEach((mapped, index) => {
      if (mapped && !headerIndex.has(mapped)) headerIndex.set(mapped, index);
    });

    const cell = (row: string[], column: string): string =>
      (row[headerIndex.get(column) ?? -1] ?? "").trim();

    let byNumber = new Map<
      string,
      {
        employeeNumber: string;
        firstName: string;
        lastName: string;
        workEmail: string | null;
        jobTitle: string;
        level: string | null;
        countryCode: string;
        employmentType: EmploymentType;
        status: EmployeeStatus;
        hireDate: Date;
        terminationDate: Date | null;
        department: { name: string };
      }
    >();
    let emailOwner = new Map<string, string>();
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
    const deptCodeByDept = new Map<string, { code: string; row: number }>();

    if (resolved.includes(null)) warnings.push("Unknown columns are ignored.");

    for (
      let batchStart = 0;
      batchStart < table.rows.length;
      batchStart += EMPLOYEE_IMPORT_APPLY_BATCH_SIZE
    ) {
      const batch = table.rows.slice(batchStart, batchStart + EMPLOYEE_IMPORT_APPLY_BATCH_SIZE);
      const numbers = [
        ...new Set(batch.map((record) => cell(record, "Employee Number")).filter(Boolean)),
      ];
      const emails = [
        ...new Set(batch.map((record) => cell(record, "Work Email").toLowerCase()).filter(Boolean)),
      ];
      const existing = await this.prisma.employee.findMany({
        where: {
          organizationId,
          OR: [
            ...(numbers.length ? [{ employeeNumber: { in: numbers } }] : []),
            ...(emails.length ? [{ workEmail: { in: emails } }] : []),
          ],
        },
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

      byNumber = new Map(existing.map((employee) => [employee.employeeNumber, employee]));
      emailOwner = new Map(
        existing.flatMap((employee) =>
          employee.workEmail ? [[employee.workEmail.toLowerCase(), employee.employeeNumber]] : [],
        ),
      );

      batch.forEach((record, relativeIndex) => {
        const index = batchStart + relativeIndex;
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
        const deptCodeRaw = cell(record, DEPARTMENT_CODE_HEADER);

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

        // Advisory sheet code: strict format check, never a guess. Conflicting
        // codes for one logical department are a row error, not a silent pick.
        let departmentCode: string | null = null;

        if (deptCodeRaw) {
          const candidate = deptCodeRaw.trim().toUpperCase();

          if (!isValidDepartmentCode(candidate))
            fail(
              DEPARTMENT_CODE_HEADER,
              "INVALID_DEPT_CODE",
              "Department Code must be 2-20 chars: A-Z, 0-9, dashes.",
            );
          else departmentCode = candidate;
        }

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

        if (workEmail && emailOwner.has(workEmail) && emailOwner.get(workEmail) !== employeeNumber)
          fail("Work Email", "EMAIL_CONFLICT", "Work Email belongs to a different employee.");

        if (invalid) return;

        if (departmentCode && department) {
          const key = normalizeDepartmentName(department);
          const seen = deptCodeByDept.get(key);

          if (seen && seen.code !== departmentCode)
            fail(
              DEPARTMENT_CODE_HEADER,
              "CONFLICTING_DEPT_CODE",
              `Department "${department.trim()}" uses conflicting codes (rows ${seen.row} and ${rowNumber}).`,
            );
          else if (!seen) deptCodeByDept.set(key, { code: departmentCode, row: rowNumber });
        }

        if (invalid) return;

        if (knownDepartments.has(normalizeDepartmentName(department)))
          matched.add(department.trim());
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
          departmentCode,
          countryCode,
          employmentType: employmentType as EmploymentType,
          status: status as EmployeeStatus,
          level,
          hireDate,
          terminationDate,
          kind,
        });
      });

      await onBatchValidated?.(Math.min(table.rows.length, batchStart + batch.length));
    }

    return {
      normalized,
      errors,
      warnings,
      missingDepartments: [...missing],
      matchedDepartments: [...matched],
      departmentCodes: new Map(
        [...deptCodeByDept].map(([name, entry]) => [name, entry.code] as [string, string]),
      ),
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

    const claimed = await this.prisma.employeeImport.updateMany({
      where: { id: row.id, status: "APPLY_QUEUED" },
      data: { status: "APPLYING" },
    });

    if (!claimed.count && row.status !== "APPLYING") return;

    const loadDepartments = async (): Promise<Map<string, string>> =>
      new Map(
        (
          await this.prisma.department.findMany({
            where: { organizationId: row.organizationId },
            select: { id: true, name: true },
          })
        ).map((department) => [normalizeDepartmentName(department.name), department.id]),
      );

    let departmentByName = await loadDepartments();
    const plan = readDepartmentPlan(row.previewSummary);
    const summary = row.previewSummary as { missingDepartments?: unknown } | null;
    const missingSources = Array.isArray(summary?.missingDepartments)
      ? summary.missingDepartments.filter((value): value is string => typeof value === "string")
      : [];
    const departmentBySource = new Map<string, string>();

    for (const source of missingSources) {
      const sourceKey = normalizeDepartmentName(source);
      const planned = plan.get(sourceKey);
      const targetName = planned?.name ?? source;
      const targetKey = normalizeDepartmentName(targetName);
      const existingId = departmentByName.get(targetKey);

      if (existingId) {
        // AI may rename "Engg" to an already-existing "Engineering".
        // Keep the source alias so apply never attempts a duplicate create.
        departmentBySource.set(sourceKey, existingId);
        continue;
      }

      if (!row.createMissingDepartments) {
        await this.prisma.employeeImport.updateMany({
          where: { id: row.id, status: "APPLYING" },
          data: { status: "FAILED" },
        });

        return;
      }

      const preferred = planned?.code ?? departmentCodeFor(targetName);
      let attempt = 0;

      for (;;) {
        try {
          const created = await this.prisma.department.create({
            data: {
              organizationId: row.organizationId,
              code: attempt ? `${preferred.slice(0, 18)}-${attempt + 1}` : preferred,
              name: targetName.trim(),
            },
            select: { id: true },
          });

          departmentByName.set(targetKey, created.id);
          departmentBySource.set(sourceKey, created.id);
          break;
        } catch (error) {
          if (
            !isPrismaUniqueViolationOn(error, "code") &&
            !isPrismaUniqueViolationOn(error, "normalizedName")
          )
            throw error;
          departmentByName = await loadDepartments();
          const resolved = departmentByName.get(targetKey);

          if (resolved) {
            departmentBySource.set(sourceKey, resolved);
            break;
          }

          attempt += 1;
          if (attempt > 5) throw error;
        }
      }
    }

    for (const [name, id] of departmentByName) departmentBySource.set(name, id);

    const applyErrors: RowError[] = [];
    let createdRows = row.createdRows;
    let updatedRows = row.updatedRows;
    let failedRows = row.failedRows;
    let processedRows = row.processedRows;
    let sawPendingRows = false;

    const applyBatch = async (batch: NormalizedRow[]): Promise<"continue" | "stop"> => {
      const state = await this.prisma.employeeImport.findUniqueOrThrow({ where: { id: row.id } });

      if (state.status === "CANCELLING") {
        await this.prisma.employeeImport.updateMany({
          where: { id: row.id, status: "CANCELLING" },
          data: { status: processedRows > 0 ? "CANCELLED_PARTIAL" : "CANCELLED" },
        });

        return "stop";
      }

      if (state.status === "PAUSING") {
        await this.prisma.employeeImport.updateMany({
          where: { id: row.id, status: "PAUSING" },
          data: { status: "PAUSED" },
        });

        return "stop";
      }

      const employeeNumbers = [...new Set(batch.map((item) => item.employeeNumber))];
      const workEmails = [
        ...new Set(batch.flatMap((item) => (item.workEmail ? [item.workEmail] : []))),
      ];
      const existing = await this.prisma.employee.findMany({
        where: {
          organizationId: row.organizationId,
          OR: [
            { employeeNumber: { in: employeeNumbers } },
            ...(workEmails.length ? [{ workEmail: { in: workEmails } }] : []),
          ],
        },
        select: { id: true, employeeNumber: true, workEmail: true },
      });
      const employeeByNumber = new Map(
        existing.map((employee) => [employee.employeeNumber, employee]),
      );
      const employeeByEmail = new Map(
        existing.flatMap((employee) =>
          employee.workEmail ? [[employee.workEmail.toLowerCase(), employee]] : [],
        ),
      );

      await this.prisma.$transaction(async (transaction) => {
        for (const item of batch) {
          try {
            if (item.kind === "UNCHANGED") {
              processedRows += 1;
              continue;
            }

            const departmentId = departmentBySource.get(normalizeDepartmentName(item.department));

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
              continue;
            }

            const current = employeeByNumber.get(item.employeeNumber);

            if (item.workEmail) {
              const owner = employeeByEmail.get(item.workEmail);

              if (owner && owner.employeeNumber !== item.employeeNumber) {
                failedRows += 1;
                processedRows += 1;
                applyErrors.push({
                  row: item.rowNumber,
                  employeeNumber: item.employeeNumber,
                  column: "Work Email",
                  errorCode: "EMAIL_CONFLICT",
                  message: "Work Email is owned by another employee.",
                });
                continue;
              }
            }

            const data = {
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
            };

            if (current) {
              await transaction.employee.update({ where: { id: current.id }, data });
              updatedRows += 1;
            } else {
              await transaction.employee.create({
                data: {
                  organizationId: row.organizationId,
                  employeeNumber: item.employeeNumber,
                  ...data,
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
            50 + Math.floor((processedRows / Math.max(1, row.totalRows)) * 49),
          ),
        },
      });
      await job.updateProgress({ processedRows, totalRows: row.totalRows });

      return "continue";
    };

    // Consume one deterministic R2 part at a time and discard it once its
    // bounded apply batches checkpoint. Resume is owned solely by row number.
    let batch: NormalizedRow[] = [];
    let stopped = false;

    for (let part = 1; !stopped; part += 1) {
      const key = `${row.normalizedPrefix}part-${String(part).padStart(6, "0")}.ndjson`;

      if (!(await this.storage.exists(key))) break;

      const buffer = await streamToBuffer(await this.storage.downloadStream(key));

      for (const line of buffer.toString("utf8").split("\n")) {
        if (!line) continue;
        const item = JSON.parse(line) as NormalizedRow;

        if (item.rowNumber <= row.lastProcessedRow) continue;

        sawPendingRows = true;
        batch.push(item);
        if (batch.length < EMPLOYEE_IMPORT_APPLY_BATCH_SIZE) continue;

        if ((await applyBatch(batch)) === "stop") {
          stopped = true;
          break;
        }

        batch = [];
      }
    }

    if (stopped) return;
    if (batch.length && (await applyBatch(batch)) === "stop") return;

    if (!sawPendingRows) {
      await this.finishImport(row.id, row, [], row.createdRows, row.updatedRows, row.failedRows);

      return;
    }

    await this.finishImport(row.id, row, applyErrors, createdRows, updatedRows, failedRows);
  }

  private async finishImport(
    importId: string,
    row: { organizationId: string; id: string },
    applyErrors: RowError[],
    createdRows: number,
    updatedRows: number,
    failedRows: number,
  ): Promise<void> {
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
    const completed = await this.prisma.employeeImport.updateMany({
      where: { id: importId, status: "APPLYING" },
      data: {
        status: failedRows > 0 ? "COMPLETED_WITH_ERRORS" : "COMPLETED",
        applyReportObjectKey: reportKey,
        completedAt: new Date(),
        progressPercent: 100,
        createdRows,
        updatedRows,
        failedRows,
      },
    });

    if (completed.count === 0) {
      const current = await this.prisma.employeeImport.findUniqueOrThrow({
        where: { id: importId },
      });

      if (current.status === "CANCELLING") {
        const cancelled = await this.prisma.employeeImport.updateMany({
          where: { id: importId, status: "CANCELLING" },
          data: { status: current.processedRows > 0 ? "CANCELLED_PARTIAL" : "CANCELLED" },
        });

        if (cancelled.count)
          await this.storage.deletePrefix(`employee-imports/${row.organizationId}/${row.id}/`);
      }
    }
  }

  private async runCleanup(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.employeeImport.findMany({
      where: { expiresAt: { lte: now }, status: { not: "EXPIRED" } },
      select: { id: true, organizationId: true, status: true },
      orderBy: { expiresAt: "asc" },
      take: EMPLOYEE_IMPORT_CLEANUP_BATCH,
    });

    for (const item of expired) {
      try {
        await this.storage.deletePrefix(`employee-imports/${item.organizationId}/${item.id}/`);
      } catch {
        continue;
      }

      await this.prisma.employeeImport.updateMany({
        where: { id: item.id, status: item.status },
        data: { status: "EXPIRED" },
      });
    }

    const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    const stale = await this.prisma.employeeImport.findMany({
      where: {
        status: { in: ["FAILED", "CANCELLED", "CANCELLED_PARTIAL"] },
        updatedAt: { lt: staleCutoff },
      },
      select: { id: true, organizationId: true },
      orderBy: { updatedAt: "asc" },
      take: EMPLOYEE_IMPORT_CLEANUP_BATCH,
    });

    for (const item of stale) {
      try {
        await this.storage.deletePrefix(`employee-imports/${item.organizationId}/${item.id}/`);
      } catch {
        // A later scheduled run retries storage cleanup; lifecycle remains terminal.
      }
    }
  }
}
