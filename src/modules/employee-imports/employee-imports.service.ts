import { HttpStatus, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import {
  EmployeeImportStatus,
  type EmployeeImport,
  type EmployeeTransferFormat,
} from "@prisma/client";
import type { Queue } from "bullmq";
import { PrismaService } from "@/database/prisma.service.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import { AUTH_ERROR_CODES } from "@/modules/auth/constants/auth.constants.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { activeTenantMembershipWhere } from "@/modules/auth/utils/tenant-access.utils.js";
import { EMPLOYEE_WRITE_ROLES } from "@/modules/employees/constants/employees.constants.js";
import { FileStorageService } from "@/storage/file-storage.service.js";
import type { CreateEmployeeImportDto } from "@/modules/employee-imports/dto/employee-imports.dto.js";
import {
  EMPLOYEE_IMPORT_APPLY_JOB,
  EMPLOYEE_IMPORT_ERROR_CODES,
  EMPLOYEE_IMPORT_MAX_FILE_BYTES,
  EMPLOYEE_IMPORT_QUEUE,
  EMPLOYEE_IMPORT_TTL_MS,
  EMPLOYEE_IMPORT_VALIDATE_JOB,
} from "./employee-imports.constants.js";
import type { EmployeeImportSummary } from "./employee-imports.types.js";

type ImportJob = { importId: string; organizationId: string; requestedByUserId: string };

const CSV_CONTENT_TYPES = new Set(["text/csv", "text/x-csv", "application/vnd.ms-excel"]);

const XLSX_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const terminal = new Set<EmployeeImportStatus>([
  "CANCELLED",
  "CANCELLED_PARTIAL",
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "EXPIRED",
]);

const extensionFor = (format: EmployeeTransferFormat): string =>
  format === "CSV" ? "csv" : "xlsx";

export const buildImportSourceKey = (
  organizationId: string,
  importId: string,
  format: EmployeeTransferFormat,
): string =>
  `employee-imports/${organizationId}/${importId}/source/original.${extensionFor(format).toLowerCase()}`;

@Injectable()
export class EmployeeImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
    @InjectQueue(EMPLOYEE_IMPORT_QUEUE) private readonly queue: Queue<ImportJob>,
  ) {}

  private async scope(principal: RequestPrincipal) {
    if (!principal.organizationId || !principal.membershipId || !principal.role)
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "Select an organization first.",
        HttpStatus.FORBIDDEN,
      );
    if (!(EMPLOYEE_WRITE_ROLES as readonly string[]).includes(principal.role))
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot manage employee imports.",
        HttpStatus.FORBIDDEN,
      );
    const membership = await this.prisma.organizationMembership.findFirst({
      where: activeTenantMembershipWhere({
        id: principal.membershipId,
        userId: principal.userId,
        organizationId: principal.organizationId,
      }),
    });

    if (!membership)
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "Your membership is no longer active.",
        HttpStatus.FORBIDDEN,
      );

    return { organizationId: membership.organizationId, userId: principal.userId };
  }

  private async owned(principal: RequestPrincipal, id: string): Promise<EmployeeImport> {
    const scope = await this.scope(principal);
    const row = await this.prisma.employeeImport.findFirst({
      where: { id, organizationId: scope.organizationId, requestedByUserId: scope.userId },
    });

    if (!row)
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_NOT_FOUND,
        "Employee import was not found.",
        HttpStatus.NOT_FOUND,
      );

    return row;
  }

  async create(principal: RequestPrincipal, dto: CreateEmployeeImportDto) {
    const scope = await this.scope(principal);

    if (dto.sizeBytes > EMPLOYEE_IMPORT_MAX_FILE_BYTES)
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_FILE_TOO_LARGE,
        "File exceeds the 25 MB import limit.",
        HttpStatus.BAD_REQUEST,
      );

    const baseContentType = dto.contentType.split(";")[0].trim().toLowerCase();
    const allowed =
      dto.format === "CSV"
        ? CSV_CONTENT_TYPES.has(baseContentType)
        : XLSX_CONTENT_TYPES.has(baseContentType);

    if (!allowed)
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_UNSUPPORTED_TYPE,
        "Only CSV (.csv) and XLSX (.xlsx) imports are supported.",
        HttpStatus.BAD_REQUEST,
      );

    const lowered = dto.fileName.toLowerCase();
    const forbidden = [".xlsm", ".xls;", ".zip", ".pdf", ".html"];
    const hasForbidden = forbidden.some((fragment) => lowered.includes(fragment));
    const extensionOk = dto.format === "CSV" ? lowered.endsWith(".csv") : lowered.endsWith(".xlsx");

    if (hasForbidden || !extensionOk)
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_UNSUPPORTED_TYPE,
        "Only .csv and .xlsx files are accepted.",
        HttpStatus.BAD_REQUEST,
      );

    // Server owns the object key; the client never supplies storage authority.
    const record = await this.prisma.employeeImport.create({
      data: {
        organizationId: scope.organizationId,
        requestedByUserId: scope.userId,
        format: dto.format,
        originalFileName: dto.fileName.slice(0, 255),
        sourceObjectKey: "pending",
        expiresAt: new Date(Date.now() + EMPLOYEE_IMPORT_TTL_MS),
      },
    });
    const sourceObjectKey = buildImportSourceKey(scope.organizationId, record.id, dto.format);

    await this.prisma.employeeImport.update({
      where: { id: record.id },
      data: { sourceObjectKey },
    });
    const signed = await this.storage.createSignedUploadUrl({
      key: sourceObjectKey,
      contentType:
        dto.format === "CSV"
          ? "text/csv; charset=utf-8"
          : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      contentLength: dto.sizeBytes,
    });

    return {
      import: this.summary({ ...record, sourceObjectKey }),
      uploadUrl: signed.url,
      expiresAt: signed.expiresAt,
    };
  }

  async uploadComplete(principal: RequestPrincipal, id: string) {
    const row = await this.owned(principal, id);

    if (row.status !== "AWAITING_UPLOAD")
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_INVALID_STATE,
        "This import is not awaiting upload.",
        HttpStatus.CONFLICT,
      );

    const exists = await this.storage.exists(row.sourceObjectKey);

    if (!exists)
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_NOT_FOUND,
        "Uploaded file was not found in storage.",
        HttpStatus.NOT_FOUND,
      );

    const head = await this.storage.head(row.sourceObjectKey);

    if (head.size <= 0 || head.size > EMPLOYEE_IMPORT_MAX_FILE_BYTES)
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_FILE_TOO_LARGE,
        "Uploaded file failed size verification.",
        HttpStatus.BAD_REQUEST,
      );

    const updated = await this.prisma.employeeImport.update({
      where: { id: row.id },
      data: { status: "QUEUED", uploadedAt: new Date() },
    });

    // BullMQ v6 rejects ":" in custom job IDs ("Custom Id cannot contain :"),
    // so the separator is "-" (still deterministic per import + phase).
    try {
      await this.queue.add(
        EMPLOYEE_IMPORT_VALIDATE_JOB,
        {
          importId: row.id,
          organizationId: row.organizationId,
          requestedByUserId: row.requestedByUserId,
        },
        {
          jobId: `${row.id}-validate`,
          removeOnComplete: true,
          removeOnFail: 100,
          attempts: 3,
          backoff: { type: "exponential", delay: 1_000 },
        },
      );
    } catch (error) {
      // Status already flipped above; restore so the client can retry instead
      // of being stuck on IMPORT_INVALID_STATE with no job enqueued.
      await this.prisma.employeeImport.update({
        where: { id: row.id },
        data: { status: "AWAITING_UPLOAD", uploadedAt: null },
      });
      throw error;
    }

    return this.summary(updated);
  }

  async list(principal: RequestPrincipal): Promise<EmployeeImportSummary[]> {
    const scope = await this.scope(principal);
    const rows = await this.prisma.employeeImport.findMany({
      where: { organizationId: scope.organizationId, requestedByUserId: scope.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return rows.map((row) => this.summary(row));
  }

  async detail(principal: RequestPrincipal, id: string): Promise<EmployeeImportSummary> {
    return this.summary(await this.owned(principal, id));
  }

  async confirm(principal: RequestPrincipal, id: string, createMissingDepartments: boolean) {
    const row = await this.owned(principal, id);

    // Idempotent: a repeated confirm with the same flag returns current state
    // without enqueueing a duplicate apply job.
    if (row.status === "APPLY_QUEUED" || row.status === "APPLYING") return this.summary(row);

    if (row.status !== "READY_FOR_REVIEW" || (row.invalidRows ?? 0) > 0)
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_INVALID_STATE,
        "Resolve validation errors before confirming this import.",
        HttpStatus.CONFLICT,
      );

    if (!createMissingDepartments && (await this.hasUnresolvedDepartments(row)))
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_CONFLICT,
        "Missing departments must be created or resolved before confirming this import.",
        HttpStatus.CONFLICT,
      );

    const transitioned = await this.prisma.employeeImport.updateMany({
      where: { id: row.id, status: "READY_FOR_REVIEW" },
      data: {
        status: "APPLY_QUEUED",
        createMissingDepartments,
        startedAt: row.startedAt ?? new Date(),
      },
    });

    if (transitioned.count === 0) return this.detail(principal, id);

    try {
      await this.queue.add(
        EMPLOYEE_IMPORT_APPLY_JOB,
        {
          importId: row.id,
          organizationId: row.organizationId,
          requestedByUserId: row.requestedByUserId,
        },
        {
          jobId: `${row.id}-apply`,
          removeOnComplete: true,
          removeOnFail: 100,
          attempts: 3,
          backoff: { type: "exponential", delay: 1_000 },
        },
      );
    } catch (error) {
      await this.prisma.employeeImport.update({
        where: { id: row.id },
        data: {
          status: "READY_FOR_REVIEW",
          createMissingDepartments: row.createMissingDepartments,
        },
      });
      throw error;
    }

    return this.detail(principal, id);
  }

  async pause(principal: RequestPrincipal, id: string) {
    const row = await this.owned(principal, id);

    // Validation owns no resumable, durable checkpoint. Pause is therefore
    // deliberately limited to the apply phase.
    if (row.status === "APPLYING")
      await this.prisma.employeeImport.updateMany({
        where: { id, status: "APPLYING" },
        data: { status: "PAUSING" },
      });

    return this.detail(principal, id);
  }

  async resume(principal: RequestPrincipal, id: string) {
    const row = await this.owned(principal, id);

    if (row.status !== "PAUSED") return this.summary(row);

    const claimed = await this.prisma.employeeImport.updateMany({
      where: { id, status: "PAUSED" },
      data: { status: "APPLY_QUEUED" },
    });

    if (claimed.count === 0) return this.detail(principal, id);

    try {
      await this.queue.add(
        EMPLOYEE_IMPORT_APPLY_JOB,
        {
          importId: row.id,
          organizationId: row.organizationId,
          requestedByUserId: row.requestedByUserId,
        },
        {
          jobId: `${row.id}-apply-resume-${row.lastProcessedRow}`,
          removeOnComplete: true,
          removeOnFail: 100,
          attempts: 3,
          backoff: { type: "exponential", delay: 1_000 },
        },
      );
    } catch (error) {
      await this.prisma.employeeImport.updateMany({
        where: { id, status: "APPLY_QUEUED" },
        data: { status: "PAUSED" },
      });
      throw error;
    }

    return this.detail(principal, id);
  }

  async cancel(principal: RequestPrincipal, id: string) {
    const row = await this.owned(principal, id);

    if (terminal.has(row.status)) return this.summary(row);

    if (
      ["AWAITING_UPLOAD", "QUEUED", "PAUSED", "READY_FOR_REVIEW", "APPLY_QUEUED"].includes(
        row.status,
      )
    ) {
      // Claim the terminal transition before deleting anything. A worker may
      // otherwise have claimed APPLYING after our read but before cleanup.
      const claimed = await this.prisma.employeeImport.updateMany({
        where: {
          id,
          status: {
            in: ["AWAITING_UPLOAD", "QUEUED", "PAUSED", "READY_FOR_REVIEW", "APPLY_QUEUED"],
          },
        },
        data: { status: "CANCELLED" },
      });

      if (claimed.count > 0) await this.cleanupArtifacts(row);

      return this.detail(principal, id);
    }

    await this.prisma.employeeImport.updateMany({
      where: { id, status: { in: ["VALIDATING", "APPLYING", "PAUSING"] } },
      data: { status: "CANCELLING" },
    });

    return this.detail(principal, id);
  }
  async downloadReport(principal: RequestPrincipal, id: string, type: string) {
    const row = await this.owned(principal, id);

    if (row.expiresAt && row.expiresAt <= new Date())
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_NOT_FOUND,
        "This import has expired.",
        HttpStatus.NOT_FOUND,
      );

    const key = type === "apply" ? row.applyReportObjectKey : row.validationReportObjectKey;

    if (!key)
      throw new AuthException(
        EMPLOYEE_IMPORT_ERROR_CODES.IMPORT_NOT_FOUND,
        "No report is available for this import yet.",
        HttpStatus.NOT_FOUND,
      );

    return this.storage.createSignedDownloadUrl(key);
  }

  async cleanupArtifacts(row: { organizationId: string; id: string }) {
    await this.storage.deletePrefix(`employee-imports/${row.organizationId}/${row.id}/`);
  }

  summary(row: EmployeeImport): EmployeeImportSummary {
    return {
      id: row.id,
      format: row.format,
      status: row.status,
      originalFileName: row.originalFileName,
      totalRows: row.totalRows,
      validatedRows: row.validatedRows,
      validRows: row.validRows,
      invalidRows: row.invalidRows,
      createRows: row.createRows,
      updateRows: row.updateRows,
      unchangedRows: row.unchangedRows,
      processedRows: row.processedRows,
      progressPercent: row.progressPercent,
      createdRows: row.createdRows,
      updatedRows: row.updatedRows,
      failedRows: row.failedRows,
      createMissingDepartments: row.createMissingDepartments,
      previewSummary: row.previewSummary,
      createdAt: row.createdAt,
      validatedAt: row.validatedAt,
      completedAt: row.completedAt,
      errorCode: null,
    };
  }

  private async hasUnresolvedDepartments(row: EmployeeImport): Promise<boolean> {
    const preview = row.previewSummary as {
      missingDepartments?: unknown;
      departmentPlan?: unknown;
    } | null;
    const sources = Array.isArray(preview?.missingDepartments)
      ? preview.missingDepartments.filter((value): value is string => typeof value === "string")
      : [];

    if (!sources.length) return false;

    const plans = new Map<string, string>();

    if (Array.isArray(preview?.departmentPlan)) {
      for (const entry of preview.departmentPlan) {
        if (
          entry &&
          typeof entry === "object" &&
          "from" in entry &&
          "name" in entry &&
          typeof entry.from === "string" &&
          typeof entry.name === "string"
        )
          plans.set(entry.from.trim().toLocaleLowerCase(), entry.name.trim().toLocaleLowerCase());
      }
    }

    const existing = new Set(
      (
        await this.prisma.department.findMany({
          where: { organizationId: row.organizationId },
          select: { name: true },
        })
      ).map((department) => department.name.trim().toLocaleLowerCase()),
    );

    return sources.some(
      (source) =>
        !existing.has(
          plans.get(source.trim().toLocaleLowerCase()) ?? source.trim().toLocaleLowerCase(),
        ),
    );
  }
}
