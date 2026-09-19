import { HttpStatus, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { CompensationChangeReason, Prisma } from "@prisma/client";
import {
  buildCursorPage,
  decodeCursor,
  encodeCursor,
  normalizeCursorLimit,
} from "@/common/pagination/cursor-pagination.util.js";
import type { CursorPage } from "@/common/pagination/cursor-pagination.type.js";
import {
  IdempotencyService,
  isValidIdempotencyKey,
} from "@/common/idempotency/idempotency.service.js";
import { dayjs, toDateOnly } from "@/common/utils/date.js";
import { BigNumber, toMoneyString } from "@/common/utils/number.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { TraceBusinessService } from "@/common/tracing/trace-method.decorator.js";
import { PrismaService } from "@/database/prisma.service.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import { AUTH_ERROR_CODES } from "@/modules/auth/constants/auth.constants.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { activeTenantMembershipWhere } from "@/modules/auth/utils/tenant-access.utils.js";
import {
  COMPENSATION_ERROR_CODES,
  COMPENSATION_READ_ROLES,
  COMPENSATION_WRITE_ROLES,
} from "@/modules/compensation/constants/compensation.constants.js";
import type {
  ChangeCompensationDto,
  ListCompensationHistoryDto,
} from "@/modules/compensation/dto/compensation.dto.js";

type CurrentCompensation = {
  employeeId: string;
  annualBaseSalary: string;
  currency: string;
  effectiveFrom: string;
  version: number;
};

type HistoryItem = {
  id: string;
  version: number;
  previousAnnualBaseSalary: string | null;
  newAnnualBaseSalary: string;
  previousCurrency: string | null;
  newCurrency: string;
  previousEffectiveFrom: string | null;
  effectiveFrom: string;
  reason: CompensationChangeReason;
  note: string | null;
  changedBy: { id: string; firstName: string; lastName: string } | null;
  createdAt: string;
};

type HistoryCursor = { version: number };

const isHistoryCursor = (value: unknown): value is HistoryCursor =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as HistoryCursor).version === "number" &&
  Number.isInteger((value as HistoryCursor).version) &&
  (value as HistoryCursor).version > 0;

const isDateOnly = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && dayjs(value, "YYYY-MM-DD", true).isValid();

@Injectable()
@TraceBusinessService(["current", "history", "change"])
export class CompensationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    readonly executionTrace: ExecutionTraceService,
  ) {}

  private async membership(principal: RequestPrincipal) {
    if (!principal.organizationId || !principal.membershipId || !principal.role) {
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "Select an organization first.",
        HttpStatus.FORBIDDEN,
      );
    }

    const membership = await this.prisma.organizationMembership.findFirst({
      where: activeTenantMembershipWhere({
        id: principal.membershipId,
        userId: principal.userId,
        organizationId: principal.organizationId,
      }),
    });

    if (!membership) {
      throw new AuthException(
        AUTH_ERROR_CODES.MEMBERSHIP_REQUIRED,
        "Your membership is no longer active.",
        HttpStatus.FORBIDDEN,
      );
    }

    return membership;
  }

  private assertRole(role: string, allowed: readonly string[]) {
    if (!allowed.includes(role)) {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot access compensation.",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private notFound(): never {
    throw new AuthException(
      COMPENSATION_ERROR_CODES.EMPLOYEE_NOT_FOUND,
      "Employee was not found.",
      HttpStatus.NOT_FOUND,
    );
  }

  private idempotencyRequired(): never {
    throw new AuthException(
      COMPENSATION_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      "A valid Idempotency-Key header is required.",
      HttpStatus.BAD_REQUEST,
    );
  }

  private idempotencyConflict(): never {
    throw new AuthException(
      COMPENSATION_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
      "This idempotency key was already used for a different request.",
      HttpStatus.CONFLICT,
    );
  }

  private versionConflict(): never {
    throw new AuthException(
      COMPENSATION_ERROR_CODES.COMPENSATION_VERSION_CONFLICT,
      "Compensation changed while you were editing.",
      HttpStatus.CONFLICT,
    );
  }

  private async employeeOrThrow(organizationId: string, employeeId: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId },
      select: { id: true },
    });

    if (!employee) this.notFound();

    return employee;
  }

  private currentResponse(row: {
    employeeId: string;
    annualBaseSalary: Prisma.Decimal;
    currency: string;
    effectiveFrom: Date;
    version: number;
  }): CurrentCompensation {
    return {
      employeeId: row.employeeId,
      annualBaseSalary: toMoneyString(row.annualBaseSalary),
      currency: row.currency,
      effectiveFrom: toDateOnly(row.effectiveFrom),
      version: row.version,
    };
  }

  async current(
    principal: RequestPrincipal,
    employeeId: string,
  ): Promise<CurrentCompensation | null> {
    const membership = await this.membership(principal);

    this.assertRole(membership.role, COMPENSATION_READ_ROLES);
    await this.employeeOrThrow(membership.organizationId, employeeId);
    const current = await this.prisma.employeeCompensation.findFirst({
      where: { employeeId, employee: { organizationId: membership.organizationId } },
      select: {
        employeeId: true,
        annualBaseSalary: true,
        currency: true,
        effectiveFrom: true,
        version: true,
      },
    });

    return current ? this.currentResponse(current) : null;
  }

  async history(
    principal: RequestPrincipal,
    employeeId: string,
    dto: ListCompensationHistoryDto,
  ): Promise<CursorPage<HistoryItem>> {
    const membership = await this.membership(principal);

    this.assertRole(membership.role, COMPENSATION_READ_ROLES);
    await this.employeeOrThrow(membership.organizationId, employeeId);
    const limit = normalizeCursorLimit(dto.limit ?? 20);
    let cursor: HistoryCursor | null = null;

    try {
      cursor = dto.cursor ? decodeCursor(dto.cursor, isHistoryCursor) : null;
    } catch {
      throw new AuthException("INVALID_CURSOR", "Invalid cursor.", HttpStatus.BAD_REQUEST);
    }

    const rows = await this.prisma.compensationHistory.findMany({
      where: {
        employeeId,
        employee: { organizationId: membership.organizationId },
        ...(cursor ? { version: { lt: cursor.version } } : {}),
      },
      // The tenant-scoped employee proof above makes this use the existing
      // unique (employeeId, version) sequence: deterministic, append-only,
      // and index-aligned without a redundant createdAt index.
      orderBy: { version: "desc" },
      take: limit + 1,
      select: {
        id: true,
        version: true,
        previousAnnualBaseSalary: true,
        newAnnualBaseSalary: true,
        previousCurrency: true,
        newCurrency: true,
        previousEffectiveFrom: true,
        effectiveFrom: true,
        reason: true,
        note: true,
        createdAt: true,
        changedByUser: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const items = rows.map((row) => ({
      id: row.id,
      version: row.version,
      previousAnnualBaseSalary: row.previousAnnualBaseSalary
        ? toMoneyString(row.previousAnnualBaseSalary)
        : null,
      newAnnualBaseSalary: toMoneyString(row.newAnnualBaseSalary),
      previousCurrency: row.previousCurrency,
      newCurrency: row.newCurrency,
      previousEffectiveFrom: row.previousEffectiveFrom
        ? toDateOnly(row.previousEffectiveFrom)
        : null,
      effectiveFrom: toDateOnly(row.effectiveFrom),
      reason: row.reason,
      note: row.note,
      changedBy: row.changedByUser,
      createdAt: row.createdAt.toISOString(),
    }));

    return buildCursorPage({
      limit,
      rows: items,
      cursorFromItem: (item) => encodeCursor({ version: item.version }),
    });
  }

  async change(
    principal: RequestPrincipal,
    employeeId: string,
    dto: ChangeCompensationDto,
    idempotencyKey: string | undefined,
  ): Promise<CurrentCompensation> {
    const membership = await this.membership(principal);

    this.assertRole(membership.role, COMPENSATION_WRITE_ROLES);
    if (!isValidIdempotencyKey(idempotencyKey)) this.idempotencyRequired();
    if (!isDateOnly(dto.effectiveFrom)) {
      throw new AuthException(
        "INVALID_EFFECTIVE_DATE",
        "Effective date must be a calendar date (YYYY-MM-DD).",
        HttpStatus.BAD_REQUEST,
      );
    }

    const amount = new BigNumber(dto.annualBaseSalary);

    if (!amount.isFinite() || !amount.isPositive() || (amount.decimalPlaces() ?? 0) > 2) {
      throw new AuthException(
        "INVALID_COMPENSATION_AMOUNT",
        "Annual base salary must be a positive decimal with at most 2 places.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const organizationId = membership.organizationId;
    const canonicalReason = dto.expectedVersion === 0 ? "INITIAL" : dto.reason;

    if (dto.expectedVersion !== 0 && (!canonicalReason || canonicalReason === "INITIAL")) {
      throw new AuthException(
        COMPENSATION_ERROR_CODES.INVALID_COMPENSATION_REASON,
        "Select a valid compensation change reason.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const normalized = {
      annualBaseSalary: amount.toFixed(2),
      currency: dto.currency,
      effectiveFrom: dto.effectiveFrom,
      expectedVersion: dto.expectedVersion,
      reason: canonicalReason,
      note: dto.note?.trim() || null,
    };
    const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const idempotencyInput = {
      organizationId,
      operation: `compensation.change:${employeeId}`,
      idempotencyKey,
    };
    const startedAt = this.executionTrace.now();

    try {
      const current = await this.prisma.$transaction(async (transaction) => {
        const employee = await transaction.employee.findFirst({
          where: { id: employeeId, organizationId },
          select: { id: true },
        });

        if (!employee) this.notFound();
        const previousReplay = await this.idempotency.find(transaction, idempotencyInput);

        if (previousReplay) {
          if (previousReplay.requestHash !== requestHash || !previousReplay.responsePayload)
            this.idempotencyConflict();

          return previousReplay.responsePayload as unknown as CurrentCompensation;
        }

        const reservation = await this.idempotency.reserve(transaction, {
          ...idempotencyInput,
          requestHash,
        });
        const previous = await transaction.employeeCompensation.findUnique({
          where: { employeeId },
        });
        const effectiveFrom = new Date(`${dto.effectiveFrom}T00:00:00.000Z`);
        let result;
        let historyId: string;

        if (!previous) {
          if (dto.expectedVersion !== 0) this.versionConflict();
          result = await transaction.employeeCompensation.create({
            data: {
              employeeId,
              annualBaseSalary: normalized.annualBaseSalary,
              currency: dto.currency,
              effectiveFrom,
              version: 1,
            },
            select: {
              id: true,
              employeeId: true,
              annualBaseSalary: true,
              currency: true,
              effectiveFrom: true,
              version: true,
            },
          });
          const history = await transaction.compensationHistory.create({
            data: {
              employeeId,
              version: 1,
              newAnnualBaseSalary: normalized.annualBaseSalary,
              newCurrency: dto.currency,
              effectiveFrom,
              reason: "INITIAL",
              note: normalized.note,
              changedByUserId: principal.userId,
            },
          });

          historyId = history.id;
        } else {
          if (dto.expectedVersion !== previous.version) this.versionConflict();
          const updated = await transaction.employeeCompensation.updateMany({
            where: { employeeId, version: dto.expectedVersion },
            data: {
              annualBaseSalary: normalized.annualBaseSalary,
              currency: dto.currency,
              effectiveFrom,
              version: { increment: 1 },
            },
          });

          if (updated.count !== 1) this.versionConflict();
          result = await transaction.employeeCompensation.findUniqueOrThrow({
            where: { employeeId },
            select: {
              id: true,
              employeeId: true,
              annualBaseSalary: true,
              currency: true,
              effectiveFrom: true,
              version: true,
            },
          });
          const history = await transaction.compensationHistory.create({
            data: {
              employeeId,
              version: result.version,
              previousAnnualBaseSalary: previous.annualBaseSalary,
              newAnnualBaseSalary: normalized.annualBaseSalary,
              previousCurrency: previous.currency,
              newCurrency: dto.currency,
              previousEffectiveFrom: previous.effectiveFrom,
              effectiveFrom,
              reason: canonicalReason as CompensationChangeReason,
              note: normalized.note,
              changedByUserId: principal.userId,
            },
          });

          historyId = history.id;
        }

        const response = this.currentResponse(result);

        await this.idempotency.complete(transaction, reservation.id, historyId, response);

        return response;
      });

      this.executionTrace.debug({
        event: "compensation.change.complete",
        organizationId,
        employeeId,
        version: current.version,
        durationMs: this.executionTrace.durationSince(startedAt),
      });

      return current;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        Array.isArray(error.meta?.target) &&
        (error.meta.target as unknown[]).includes("idempotencyKey")
      ) {
        const replay = await this.idempotency.findCommitted(idempotencyInput);

        if (!replay || replay.requestHash !== requestHash || !replay.responsePayload)
          this.idempotencyConflict();

        return replay.responsePayload as unknown as CurrentCompensation;
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        Array.isArray(error.meta?.target) &&
        (error.meta.target as unknown[]).includes("employeeId")
      ) {
        this.versionConflict();
      }

      throw error;
    }
  }
}
