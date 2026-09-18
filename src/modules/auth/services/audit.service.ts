import { Injectable } from "@nestjs/common";
import type { AuthAuditAction } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { TraceBusinessService } from "@/common/tracing/trace-method.decorator.js";

@Injectable()
@TraceBusinessService(["record"])
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    readonly executionTrace: ExecutionTraceService,
  ) {}

  async record(
    action: AuthAuditAction,
    options: {
      actorUserId?: string | null;
      targetUserId?: string | null;
      organizationId?: string | null;
      requestId?: string | null;
      metadata?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.prisma.authAuditEvent.create({
      data: {
        action,
        actorUserId: options.actorUserId ?? null,
        targetUserId: options.targetUserId ?? null,
        organizationId: options.organizationId ?? null,
        requestId: options.requestId ?? null,
        metadata: (options.metadata ?? {}) as object,
      },
    });
  }
}
