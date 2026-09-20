import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { stringify } from "csv-stringify";
import ExcelJS from "exceljs";
import type { Job } from "bullmq";
import { PrismaService } from "@/database/prisma.service.js";
import { FileStorageService } from "@/storage/file-storage.service.js";
import {
  escapeSpreadsheetCell,
  EMPLOYEE_INTERCHANGE_COLUMNS,
  toEmployeeInterchangeRow,
  type EmployeeInterchangeRow,
} from "@/modules/employee-transfer/employee-interchange.js";
import {
  EMPLOYEE_EXPORT_BATCH_SIZE,
  EMPLOYEE_EXPORT_CLEANUP_BATCH,
  EMPLOYEE_EXPORT_CLEANUP_JOB,
  EMPLOYEE_EXPORT_ERROR_CODES,
  EMPLOYEE_EXPORT_MAX_ATTEMPTS,
  EMPLOYEE_EXPORT_QUEUE,
} from "./employee-exports.constants.js";

type ExportJob = { exportId: string; organizationId: string; requestedByUserId: string };

type ExportRecord = {
  id: string;
  organizationId: string;
  format: "CSV" | "XLSX";
  status: string;
  totalRows: number;
  processedRows: number;
  lastProcessedEmployeeId: string | null;
  nextBatchNumber: number;
  startedAt: Date | null;
};

const TERMINAL = ["CANCELLED", "COMPLETED", "EXPIRED", "FAILED"] as const;

const stagingPrefix = (organizationId: string, exportId: string): string =>
  `employee-exports/${organizationId}/${exportId}/staging/`;

const stagingKey = (organizationId: string, exportId: string, batch: number): string =>
  `${stagingPrefix(organizationId, exportId)}part-${String(batch).padStart(6, "0")}.ndjson`;

@Processor(EMPLOYEE_EXPORT_QUEUE)
export class EmployeeExportsProcessor extends WorkerHost {
  private readonly logger = new Logger(EmployeeExportsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === EMPLOYEE_EXPORT_CLEANUP_JOB) {
      await this.runCleanup();

      return;
    }

    await this.runExport(job as Job<ExportJob>);
  }

  private async runExport(job: Job<ExportJob>): Promise<void> {
    const row = await this.prisma.employeeExport.findFirst({
      where: {
        id: job.data.exportId,
        organizationId: job.data.organizationId,
        requestedByUserId: job.data.requestedByUserId,
      },
    });

    // DB state is authoritative: stale redeliveries of terminal work exit.
    if (!row || (TERMINAL as readonly string[]).includes(row.status)) return;

    try {
      if (row.status === "PAUSED") return;

      if (row.status === "CANCELLING") {
        await this.cancelCleanup(row);

        return;
      }

      if (row.status === "PAUSING") {
        await this.prisma.employeeExport.updateMany({
          where: { id: row.id, status: "PAUSING" },
          data: { status: "PAUSED" },
        });

        return;
      }

      if (row.status === "FINALIZING") {
        await this.finalize(row);

        return;
      }

      if (row.status === "QUEUED") {
        const totalRows =
          row.totalRows ||
          (await this.prisma.employee.count({ where: { organizationId: row.organizationId } }));
        const claimed = await this.prisma.employeeExport.updateMany({
          where: { id: row.id, status: "QUEUED" },
          data: { status: "PROCESSING", totalRows, startedAt: row.startedAt ?? new Date() },
        });

        if (claimed.count === 0) return;
      }

      await this.extract(job, { ...row, status: "PROCESSING" });
    } catch (error) {
      // Transient attempt: rethrow for BullMQ retry. Final attempt: park
      // the export in FAILED with a safe code instead of PROCESSING limbo.
      const finalAttempt = job.attemptsMade >= EMPLOYEE_EXPORT_MAX_ATTEMPTS - 1;

      if (!finalAttempt) throw error;

      this.logger.warn(
        `employee export ${job.data.exportId} failed terminally (safe metadata only)`,
      );
      await this.prisma.employeeExport.updateMany({
        where: {
          id: job.data.exportId,
          status: { in: ["QUEUED", "PROCESSING", "PAUSING", "FINALIZING", "CANCELLING"] },
        },
        data: { status: "FAILED", errorCode: EMPLOYEE_EXPORT_ERROR_CODES.EXPORT_WORKER_FAILED },
      });
    }
  }

  private async extract(job: Job<ExportJob>, record: ExportRecord): Promise<void> {
    const { organizationId, id } = record;
    const totalRows =
      record.totalRows || (await this.prisma.employee.count({ where: { organizationId } }));
    let cursor = record.lastProcessedEmployeeId;
    let batch = record.nextBatchNumber;

    for (;;) {
      const state = await this.prisma.employeeExport.findUniqueOrThrow({ where: { id } });

      if (state.status === "CANCELLING") {
        await this.cancelCleanup({ id, organizationId });

        return;
      }

      if (state.status === "PAUSING") {
        await this.prisma.employeeExport.updateMany({
          where: { id, status: "PAUSING" },
          data: { status: "PAUSED" },
        });

        return;
      }

      const employees = await this.prisma.employee.findMany({
        where: { organizationId, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: "asc" },
        take: EMPLOYEE_EXPORT_BATCH_SIZE,
        select: {
          id: true,
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

      if (!employees.length) break;

      // Deterministic chunk key: a retry after upload-but-before-checkpoint
      // rewrites the same object instead of duplicating output.
      await this.storage.upload({
        key: stagingKey(organizationId, id, batch),
        body: Buffer.from(
          `${employees.map((employee) => JSON.stringify(toEmployeeInterchangeRow(employee))).join("\n")}\n`,
        ),
        contentType: "application/x-ndjson",
      });
      cursor = employees.at(-1)?.id ?? cursor;
      const processedRows = state.processedRows + employees.length;

      // Checkpoint only after the chunk is durable in storage.
      await this.prisma.employeeExport.update({
        where: { id },
        data: {
          lastProcessedEmployeeId: cursor,
          processedRows,
          nextBatchNumber: batch + 1,
          progressPercent: totalRows
            ? Math.min(90, Math.floor((processedRows / totalRows) * 85) + 5)
            : 90,
        },
      });
      await job.updateProgress({ processedRows, totalRows });
      batch += 1;
    }

    // A Pause/Cancel arriving after the last batch must not be overwritten:
    // only PROCESSING may enter FINALIZING.
    const claimed = await this.prisma.employeeExport.updateMany({
      where: { id, status: "PROCESSING" },
      data: { status: "FINALIZING", progressPercent: 95 },
    });

    if (claimed.count === 0) {
      const state = await this.prisma.employeeExport.findUniqueOrThrow({ where: { id } });

      if (state.status === "CANCELLING") await this.cancelCleanup({ id, organizationId });
      else if (state.status === "PAUSING")
        await this.prisma.employeeExport.updateMany({
          where: { id, status: "PAUSING" },
          data: { status: "PAUSED" },
        });

      return;
    }

    await this.finalize(record);
  }

  /**
   * Bounded-memory row iterator: one NDJSON line is in memory at a time.
   * `parts` is re-read from the DB so FINALIZING retries see every chunk.
   */
  private async *iterateStagedRows(
    organizationId: string,
    exportId: string,
    parts: number,
  ): AsyncGenerator<EmployeeInterchangeRow> {
    for (let part = 1; part <= parts; part += 1) {
      const stream = await this.storage.downloadStream(stagingKey(organizationId, exportId, part));
      const lines = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of lines) {
        if (!line.trim()) continue;
        yield JSON.parse(line) as EmployeeInterchangeRow;
      }
    }
  }

  private async finalize(record: ExportRecord): Promise<void> {
    const { organizationId, id } = record;
    const current = await this.prisma.employeeExport.findUniqueOrThrow({ where: { id } });

    if ((TERMINAL as readonly string[]).includes(current.status)) return;

    const parts = Math.max(0, current.nextBatchNumber - 1);
    const fileName = `paylens-employees-${new Date().toISOString().slice(0, 10)}.${current.format.toLowerCase()}`;
    const finalObjectKey = `employee-exports/${organizationId}/${id}/final/${fileName}`;

    if (current.format === "CSV") await this.finalizeCsv(record, parts, finalObjectKey);
    else await this.finalizeXlsx(record, parts, finalObjectKey);

    const head = await this.storage.head(finalObjectKey);
    const completed = await this.prisma.employeeExport.updateMany({
      where: { id, status: "FINALIZING" },
      data: {
        status: "COMPLETED",
        finalObjectKey,
        fileName,
        fileSizeBytes: head.size,
        completedAt: new Date(),
        progressPercent: 100,
      },
    });

    if (completed.count === 0) return;

    // Staging is redundant once the final artifact is verified. A cleanup
    // failure must never corrupt the completed download: log safely and
    // leave leftovers for the scheduled sweeper.
    try {
      await this.storage.deletePrefix(stagingPrefix(organizationId, id));
    } catch {
      this.logger.warn(`employee export ${id} staging cleanup deferred to sweeper`);
    }
  }

  private async finalizeCsv(
    record: ExportRecord,
    parts: number,
    finalObjectKey: string,
  ): Promise<void> {
    const stringifier = stringify({ header: true, columns: [...EMPLOYEE_INTERCHANGE_COLUMNS] });
    const pump = (async (): Promise<void> => {
      for await (const row of this.iterateStagedRows(record.organizationId, record.id, parts)) {
        const cells = EMPLOYEE_INTERCHANGE_COLUMNS.map((column) =>
          escapeSpreadsheetCell(row[column] ?? ""),
        );

        if (!stringifier.write(cells)) await once(stringifier, "drain");
      }

      stringifier.end();
    })();

    pump.catch((error: unknown) => stringifier.destroy(error as Error));
    await this.storage.upload({
      key: finalObjectKey,
      body: stringifier,
      contentType: "text/csv; charset=utf-8",
    });
    await pump;
  }

  private async finalizeXlsx(
    record: ExportRecord,
    parts: number,
    finalObjectKey: string,
  ): Promise<void> {
    const output = new PassThrough();
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: output,
      useStyles: true,
      useSharedStrings: true,
    });
    const sheet = workbook.addWorksheet("Employees", { views: [{ state: "frozen", ySplit: 1 }] });

    sheet.columns = EMPLOYEE_INTERCHANGE_COLUMNS.map((header) => ({
      header,
      key: header,
      width: Math.max(14, header.length + 4),
    }));
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = {
      from: "A1",
      to: `${String.fromCharCode(64 + EMPLOYEE_INTERCHANGE_COLUMNS.length)}1`,
    };

    const upload = this.storage.upload({
      key: finalObjectKey,
      body: output,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    try {
      for await (const row of this.iterateStagedRows(record.organizationId, record.id, parts)) {
        const values = EMPLOYEE_INTERCHANGE_COLUMNS.map((column) => {
          if (column === "Start Date" || column === "Termination Date") {
            const raw = row[column] ?? "";

            return raw ? new Date(`${raw}T00:00:00.000Z`) : "";
          }

          return escapeSpreadsheetCell(row[column] ?? "");
        });
        const excelRow = sheet.addRow(values);

        excelRow.eachCell((cell) => {
          if (cell.value instanceof Date) cell.numFmt = "yyyy-mm-dd";
        });
        excelRow.commit();
      }

      await sheet.commit();
      await workbook.commit();
      await upload;
    } catch (error) {
      output.destroy(error as Error);
      await upload.catch(() => undefined);

      throw error;
    }
  }

  private async cancelCleanup(row: { id: string; organizationId: string }): Promise<void> {
    await this.storage.deletePrefix(`employee-exports/${row.organizationId}/${row.id}/`);
    await this.prisma.employeeExport.updateMany({
      where: { id: row.id, status: "CANCELLING" },
      data: { status: "CANCELLED" },
    });
  }

  private async runCleanup(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.employeeExport.findMany({
      where: { status: "COMPLETED", expiresAt: { lte: now } },
      select: { id: true, organizationId: true, finalObjectKey: true },
      orderBy: { expiresAt: "asc" },
      take: EMPLOYEE_EXPORT_CLEANUP_BATCH,
    });

    for (const row of expired) {
      try {
        await this.storage.deletePrefix(stagingPrefix(row.organizationId, row.id));
        if (row.finalObjectKey) await this.storage.delete(row.finalObjectKey);
      } catch {
        this.logger.warn(`employee export ${row.id} expiry cleanup deferred`);
        continue;
      }

      await this.prisma.employeeExport.updateMany({
        where: { id: row.id, status: "COMPLETED" },
        data: { status: "EXPIRED" },
      });
    }

    const staleCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
    const stale = await this.prisma.employeeExport.findMany({
      where: { status: { in: ["FAILED", "CANCELLED"] }, updatedAt: { lt: staleCutoff } },
      select: { id: true, organizationId: true, finalObjectKey: true },
      orderBy: { updatedAt: "asc" },
      take: EMPLOYEE_EXPORT_CLEANUP_BATCH,
    });

    for (const row of stale) {
      try {
        await this.storage.deletePrefix(stagingPrefix(row.organizationId, row.id));
        if (row.finalObjectKey) await this.storage.delete(row.finalObjectKey);
      } catch {
        this.logger.warn(`employee export ${row.id} stale cleanup deferred`);
      }
    }
  }
}
