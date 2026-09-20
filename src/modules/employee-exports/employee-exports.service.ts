import { HttpStatus, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { EmployeeExportStatus, type EmployeeTransferFormat } from "@prisma/client";
import type { Queue } from "bullmq";
import { AuthException } from "@/modules/auth/auth.exception.js";
import { AUTH_ERROR_CODES } from "@/modules/auth/constants/auth.constants.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { activeTenantMembershipWhere } from "@/modules/auth/utils/tenant-access.utils.js";
import { PrismaService } from "@/database/prisma.service.js";
import { FileStorageService } from "@/storage/file-storage.service.js";
import { EMPLOYEE_DIRECTORY_ROLES } from "@/modules/employees/constants/employees.constants.js";
import {
  EMPLOYEE_EXPORT_ERROR_CODES,
  EMPLOYEE_EXPORT_JOB,
  EMPLOYEE_EXPORT_MAX_ATTEMPTS,
  EMPLOYEE_EXPORT_QUEUE,
  EMPLOYEE_EXPORT_TTL_MS,
} from "./employee-exports.constants.js";

type ExportJob = { exportId: string; organizationId: string; requestedByUserId: string };

const sanitizedFileName = (fileName: string): string =>
  fileName.replace(/["\\\r\n]/g, "").slice(0, 128) || "paylens-employees.csv";

@Injectable()
export class EmployeeExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorageService,
    @InjectQueue(EMPLOYEE_EXPORT_QUEUE) private readonly queue: Queue<ExportJob>,
  ) {}

  private async scope(principal: RequestPrincipal) {
    if (!principal.organizationId || !principal.membershipId || !principal.role)
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "Select an organization first.",
        HttpStatus.FORBIDDEN,
      );
    if (!(EMPLOYEE_DIRECTORY_ROLES as readonly string[]).includes(principal.role))
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot export employees.",
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

  async create(principal: RequestPrincipal, format: EmployeeTransferFormat) {
    const scope = await this.scope(principal);
    const record = await this.prisma.employeeExport.create({
      data: {
        organizationId: scope.organizationId,
        requestedByUserId: scope.userId,
        format,
        expiresAt: new Date(Date.now() + EMPLOYEE_EXPORT_TTL_MS),
      },
    });

    try {
      await this.enqueue(
        {
          exportId: record.id,
          organizationId: scope.organizationId,
          requestedByUserId: scope.userId,
        },
        record.id,
      );
    } catch {
      // Never leave a forever-QUEUED orphan when Redis/BullMQ is down.
      await this.prisma.employeeExport.update({
        where: { id: record.id },
        data: { status: "FAILED", errorCode: EMPLOYEE_EXPORT_ERROR_CODES.EXPORT_QUEUE_UNAVAILABLE },
      });

      throw new AuthException(
        EMPLOYEE_EXPORT_ERROR_CODES.EXPORT_QUEUE_UNAVAILABLE,
        "Export could not be queued. Try again.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return this.summary(record);
  }

  async list(principal: RequestPrincipal) {
    const scope = await this.scope(principal);

    return (
      await this.prisma.employeeExport.findMany({
        where: { organizationId: scope.organizationId, requestedByUserId: scope.userId },
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    ).map((row) => this.summary(row));
  }
  async detail(principal: RequestPrincipal, id: string) {
    return this.summary(await this.owned(principal, id));
  }
  async pause(principal: RequestPrincipal, id: string) {
    const row = await this.owned(principal, id);

    // Atomic: only the request that flips PROCESSING wins; concurrent
    // pauses and a FINALIZING transition cannot both succeed.
    await this.prisma.employeeExport.updateMany({
      where: { id: row.id, status: "PROCESSING" },
      data: { status: "PAUSING" },
    });

    return this.detail(principal, id);
  }
  async cancel(principal: RequestPrincipal, id: string) {
    const row = await this.owned(principal, id);

    if (row.status === "QUEUED" || row.status === "PAUSED") {
      const claimed = await this.prisma.employeeExport.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: "CANCELLED" },
      });

      if (claimed.count > 0) await this.cleanup(row);
    } else if (
      row.status === "PROCESSING" ||
      row.status === "PAUSING" ||
      row.status === "CANCELLING"
    ) {
      await this.prisma.employeeExport.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: "CANCELLING" },
      });
    }
    // FINALIZING and every terminal state: cancel is disabled by design.

    return this.detail(principal, id);
  }
  async resume(principal: RequestPrincipal, id: string) {
    const row = await this.owned(principal, id);

    // Atomic PAUSED → QUEUED: only one resumed worker can ever exist.
    const claimed = await this.prisma.employeeExport.updateMany({
      where: { id: row.id, status: "PAUSED" },
      data: { status: "QUEUED" },
    });

    if (claimed.count > 0) {
      try {
        // Unique continuation id: never collides with the original run job.
        await this.enqueue(
          {
            exportId: row.id,
            organizationId: row.organizationId,
            requestedByUserId: row.requestedByUserId,
          },
          `${row.id}:resume:${row.nextBatchNumber}`,
        );
      } catch {
        await this.prisma.employeeExport.updateMany({
          where: { id: row.id, status: "QUEUED" },
          data: { status: "PAUSED" },
        });

        throw new AuthException(
          EMPLOYEE_EXPORT_ERROR_CODES.EXPORT_QUEUE_UNAVAILABLE,
          "Export could not be resumed. Try again.",
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }

    return this.detail(principal, id);
  }
  async download(principal: RequestPrincipal, id: string) {
    const row = await this.owned(principal, id);

    if (
      row.status !== "COMPLETED" ||
      !row.finalObjectKey ||
      !row.fileName ||
      (row.expiresAt && row.expiresAt <= new Date())
    )
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "This export is not available for download.",
        HttpStatus.NOT_FOUND,
      );

    const fileName = sanitizedFileName(row.fileName);
    const signed = await this.storage.createSignedDownloadUrl({
      key: row.finalObjectKey,
      contentDisposition: `attachment; filename="${fileName}"`,
    });

    return { url: signed.url, fileName, expiresAt: signed.expiresAt };
  }
  async enqueue(data: ExportJob, jobId?: string) {
    await this.queue.add(EMPLOYEE_EXPORT_JOB, data, {
      ...(jobId ? { jobId } : {}),
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: EMPLOYEE_EXPORT_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 1_000 },
    });
  }
  async cleanup(row: { id: string; organizationId: string; finalObjectKey: string | null }) {
    await this.storage.deletePrefix(`employee-exports/${row.organizationId}/${row.id}/staging/`);
    if (row.finalObjectKey) await this.storage.delete(row.finalObjectKey);
  }
  private async owned(principal: RequestPrincipal, id: string) {
    const scope = await this.scope(principal);
    const row = await this.prisma.employeeExport.findFirst({
      where: { id, organizationId: scope.organizationId, requestedByUserId: scope.userId },
    });

    if (!row)
      throw new AuthException(
        EMPLOYEE_EXPORT_ERROR_CODES.EXPORT_NOT_FOUND,
        "Employee export was not found.",
        HttpStatus.NOT_FOUND,
      );

    return row;
  }
  private summary(row: {
    id: string;
    format: EmployeeTransferFormat;
    status: EmployeeExportStatus;
    totalRows: number;
    processedRows: number;
    progressPercent: number;
    fileName: string | null;
    createdAt: Date;
    completedAt: Date | null;
    errorCode: string | null;
  }) {
    return {
      id: row.id,
      format: row.format,
      status: row.status,
      totalRows: row.totalRows,
      processedRows: row.processedRows,
      progressPercent: row.progressPercent,
      fileName: row.fileName,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      errorCode: row.errorCode,
    };
  }
}
