import { HttpStatus, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { EmployeeStatus, EmploymentType, Prisma } from "@prisma/client";
import { dayjs, toDateOnly } from "@/common/utils/date.js";
import { isRecord } from "@/common/utils/object.js";
import { isPrismaRelationViolation, isPrismaUniqueViolationOn } from "@/common/utils/prisma.js";
import { normalizeEmail } from "@/common/utils/string.js";
import {
  buildCursorPage,
  decodeCursor,
  encodeCursor,
  normalizeCursorLimit,
} from "@/common/pagination/cursor-pagination.util.js";
import type { CursorPage } from "@/common/pagination/cursor-pagination.type.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { TraceBusinessService } from "@/common/tracing/trace-method.decorator.js";
import {
  IdempotencyService,
  isValidIdempotencyKey,
} from "@/common/idempotency/idempotency.service.js";
import { PrismaService } from "@/database/prisma.service.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import { AUTH_ERROR_CODES } from "@/modules/auth/constants/auth.constants.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { activeTenantMembershipWhere } from "@/modules/auth/utils/tenant-access.utils.js";
import { DepartmentsService } from "@/modules/departments/departments.service.js";
import { DEPARTMENT_ERROR_CODES } from "@/modules/departments/constants/departments.constants.js";
import {
  EMPLOYEE_DIRECTIONS,
  EMPLOYEE_DIRECTORY_ROLES,
  EMPLOYEE_SORTS,
  EMPLOYEE_ERROR_CODES,
  EMPLOYEE_WRITE_ROLES,
  type EmployeeDirection,
  type EmployeeSort,
} from "@/modules/employees/constants/employees.constants.js";
import type {
  CreateEmployeeDto,
  ListEmployeesDto,
  UpdateEmployeeDto,
} from "@/modules/employees/dto/employees.dto.js";
import type {
  EmployeeCursorPayload,
  EmployeeDetail,
  EmployeeHireDateCursor,
  EmployeeListItem,
  EmployeeNameCursor,
  EmployeeNumberCursor,
} from "@/modules/employees/types/employees.types.js";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isDateOnlyString = (value: unknown): value is string =>
  typeof value === "string" &&
  DATE_ONLY_PATTERN.test(value) &&
  dayjs(value, "YYYY-MM-DD", true).isValid();

const isNameCursor = (payload: unknown): payload is EmployeeNameCursor =>
  isRecord(payload) &&
  isNonEmptyString(payload.lastName) &&
  isNonEmptyString(payload.id) &&
  isNonEmptyString(payload.fingerprint);

const isHireDateCursor = (payload: unknown): payload is EmployeeHireDateCursor =>
  isRecord(payload) &&
  isDateOnlyString(payload.hireDate) &&
  isNonEmptyString(payload.id) &&
  isNonEmptyString(payload.fingerprint);

const isNumberCursor = (payload: unknown): payload is EmployeeNumberCursor =>
  isRecord(payload) &&
  isNonEmptyString(payload.employeeNumber) &&
  isNonEmptyString(payload.id) &&
  isNonEmptyString(payload.fingerprint);

const employeeSelect = {
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
  createdAt: true,
  updatedAt: true,
  department: {
    select: {
      id: true,
      code: true,
      name: true,
    },
  },
} as const;

type EmployeeRow = {
  id: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  workEmail: string | null;
  jobTitle: string;
  level: string | null;
  countryCode: string;
  employmentType: string;
  status: string;
  hireDate: Date;
  terminationDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  department: { id: string; code: string; name: string };
};

type EmployeeSearchRow = Omit<EmployeeRow, "department"> & {
  departmentId: string;
  departmentCode: string;
  departmentName: string;
};

@Injectable()
@TraceBusinessService(["list", "detail", "createEmployee", "updateEmployee", "deleteEmployee"])
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    readonly executionTrace: ExecutionTraceService,
    private readonly departments: DepartmentsService,
    private readonly idempotency: IdempotencyService = new IdempotencyService(prisma),
  ) {}

  private async requireActiveMembership(principal: RequestPrincipal) {
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

  private assertCanViewDirectory(role: string) {
    if (!(EMPLOYEE_DIRECTORY_ROLES as readonly string[]).includes(role)) {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot view the employee directory.",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertCanManageWorkforce(role: string) {
    if (!(EMPLOYEE_WRITE_ROLES as readonly string[]).includes(role)) {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot manage the workforce.",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** True when a Prisma unique violation names the expected tenant-unique field. */
  private isUniqueViolationOn(error: unknown, field: string): boolean {
    return isPrismaUniqueViolationOn(error, field);
  }

  private throwUniqueConflict(target: "employeeNumber" | "workEmail"): never {
    if (target === "employeeNumber") {
      throw new AuthException(
        EMPLOYEE_ERROR_CODES.EMPLOYEE_NUMBER_ALREADY_EXISTS,
        "An employee with this employee number already exists.",
        HttpStatus.CONFLICT,
      );
    }

    throw new AuthException(
      EMPLOYEE_ERROR_CODES.EMPLOYEE_EMAIL_ALREADY_EXISTS,
      "An employee with this work email already exists.",
      HttpStatus.CONFLICT,
    );
  }

  private throwIdempotencyKeyRequired(): never {
    throw new AuthException(
      EMPLOYEE_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      "A valid Idempotency-Key header is required.",
      HttpStatus.BAD_REQUEST,
    );
  }

  private throwIdempotencyConflict(): never {
    throw new AuthException(
      EMPLOYEE_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
      "This idempotency key was already used for a different request.",
      HttpStatus.CONFLICT,
    );
  }

  private resolveSort(sort: string | undefined): EmployeeSort {
    if (sort && (EMPLOYEE_SORTS as readonly string[]).includes(sort)) {
      return sort as EmployeeSort;
    }

    return "lastName";
  }

  private resolveDirection(direction: string | undefined): EmployeeDirection {
    if (direction && (EMPLOYEE_DIRECTIONS as readonly string[]).includes(direction)) {
      return direction as EmployeeDirection;
    }

    return "asc";
  }

  private decodePayload(
    sort: EmployeeSort,
    cursor: string | undefined,
  ): EmployeeCursorPayload | null {
    if (!cursor) {
      return null;
    }

    try {
      if (sort === "hireDate") {
        return decodeCursor<EmployeeHireDateCursor>(cursor, isHireDateCursor);
      }

      if (sort === "employeeNumber") {
        return decodeCursor<EmployeeNumberCursor>(cursor, isNumberCursor);
      }

      return decodeCursor<EmployeeNameCursor>(cursor, isNameCursor);
    } catch {
      throw new AuthException("INVALID_CURSOR", "Invalid cursor.", HttpStatus.BAD_REQUEST);
    }
  }

  private queryFingerprint(
    organizationId: string,
    dto: ListEmployeesDto,
    sort: EmployeeSort,
    direction: EmployeeDirection,
    limit: number,
    search: string | undefined,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          organizationId,
          search: search ?? null,
          departmentId: dto.departmentId ?? null,
          countryCode: dto.countryCode?.toUpperCase() ?? null,
          status: dto.status ?? null,
          employmentType: dto.employmentType ?? null,
          sort,
          direction,
          limit,
        }),
      )
      .digest("base64url");
  }

  private cursorPredicate(
    sort: EmployeeSort,
    direction: EmployeeDirection,
    payload: EmployeeCursorPayload | null,
  ): Prisma.EmployeeWhereInput | null {
    if (!payload) {
      return null;
    }

    const idOp = direction === "asc" ? "gt" : "lt";

    if (sort === "hireDate" && isHireDateCursor(payload)) {
      const date = new Date(payload.hireDate);
      const op = direction === "asc" ? "gt" : "lt";

      return {
        OR: [{ hireDate: { [op]: date } }, { hireDate: date, id: { [idOp]: payload.id } }],
      };
    }

    if (sort === "employeeNumber" && isNumberCursor(payload)) {
      const op = direction === "asc" ? "gt" : "lt";

      return {
        OR: [
          { employeeNumber: { [op]: payload.employeeNumber } },
          { employeeNumber: payload.employeeNumber, id: { [idOp]: payload.id } },
        ],
      };
    }

    if (sort === "lastName" && isNameCursor(payload)) {
      const op = direction === "asc" ? "gt" : "lt";

      return {
        OR: [
          { lastName: { [op]: payload.lastName } },
          { lastName: payload.lastName, id: { [idOp]: payload.id } },
        ],
      };
    }

    return null;
  }

  private orderBy(
    sort: EmployeeSort,
    direction: EmployeeDirection,
  ): Prisma.EmployeeOrderByWithRelationInput[] {
    if (sort === "hireDate") {
      return [{ hireDate: direction }, { id: direction }];
    }

    if (sort === "employeeNumber") {
      return [{ employeeNumber: direction }, { id: direction }];
    }

    return [{ lastName: direction }, { id: direction }];
  }

  private cursorFromItem(sort: EmployeeSort, item: EmployeeListItem, fingerprint: string): string {
    if (sort === "hireDate") {
      return encodeCursor({ fingerprint, hireDate: item.hireDate, id: item.id });
    }

    if (sort === "employeeNumber") {
      return encodeCursor({ employeeNumber: item.employeeNumber, fingerprint, id: item.id });
    }

    return encodeCursor({ fingerprint, lastName: item.lastName, id: item.id });
  }

  private toListItem(row: EmployeeRow): EmployeeListItem {
    return {
      id: row.id,
      employeeNumber: row.employeeNumber,
      firstName: row.firstName,
      lastName: row.lastName,
      workEmail: row.workEmail,
      department: row.department,
      jobTitle: row.jobTitle,
      level: row.level,
      countryCode: row.countryCode,
      employmentType: row.employmentType,
      status: row.status,
      hireDate: toDateOnly(row.hireDate),
    };
  }

  private async searchRows(
    organizationId: string,
    dto: ListEmployeesDto,
    sort: EmployeeSort,
    direction: EmployeeDirection,
    payload: EmployeeCursorPayload | null,
    limit: number,
    search: string,
  ): Promise<EmployeeRow[]> {
    const normalizedSearch = search.toLocaleLowerCase("en-US");
    const conditions: Prisma.Sql[] = [Prisma.sql`e."organizationId" = ${organizationId}`];

    if (dto.departmentId) conditions.push(Prisma.sql`e."departmentId" = ${dto.departmentId}`);
    if (dto.countryCode)
      conditions.push(Prisma.sql`e."countryCode" = ${dto.countryCode.toUpperCase()}`);
    if (dto.status) conditions.push(Prisma.sql`e.status = ${dto.status}`);
    if (dto.employmentType) conditions.push(Prisma.sql`e."employmentType" = ${dto.employmentType}`);

    conditions.push(Prisma.sql`(
      LOWER(e."firstName") LIKE ${`${normalizedSearch}%`}
      OR LOWER(e."lastName") LIKE ${`${normalizedSearch}%`}
      OR LOWER(e."workEmail") LIKE ${`${normalizedSearch}%`}
      OR LOWER(e."employeeNumber") LIKE ${`${normalizedSearch}%`}
    )`);

    if (payload) {
      const idOp = direction === "asc" ? Prisma.raw(">") : Prisma.raw("<");

      if (sort === "hireDate" && isHireDateCursor(payload)) {
        const dateOp = direction === "asc" ? Prisma.raw(">") : Prisma.raw("<");

        conditions.push(
          Prisma.sql`(e."hireDate" ${dateOp} ${new Date(payload.hireDate)} OR (e."hireDate" = ${new Date(payload.hireDate)} AND e.id ${idOp} ${payload.id}))`,
        );
      } else if (sort === "employeeNumber" && isNumberCursor(payload)) {
        conditions.push(
          Prisma.sql`(e."employeeNumber" ${idOp} ${payload.employeeNumber} OR (e."employeeNumber" = ${payload.employeeNumber} AND e.id ${idOp} ${payload.id}))`,
        );
      } else if (sort === "lastName" && isNameCursor(payload)) {
        conditions.push(
          Prisma.sql`(e."lastName" ${idOp} ${payload.lastName} OR (e."lastName" = ${payload.lastName} AND e.id ${idOp} ${payload.id}))`,
        );
      }
    }

    const sortColumn =
      sort === "hireDate"
        ? Prisma.raw('e."hireDate"')
        : sort === "employeeNumber"
          ? Prisma.raw('e."employeeNumber"')
          : Prisma.raw('e."lastName"');
    const sortDirection = Prisma.raw(direction.toUpperCase());
    const rows = await this.prisma.$queryRaw<EmployeeSearchRow[]>(Prisma.sql`
      SELECT e.id, e."employeeNumber", e."firstName", e."lastName", e."workEmail", e."jobTitle",
             e.level, e."countryCode", e."employmentType", e.status, e."hireDate", e."terminationDate",
             e."createdAt", e."updatedAt", d.id AS "departmentId", d.code AS "departmentCode",
             d.name AS "departmentName"
      FROM "Employee" e
      INNER JOIN "Department" d
        ON d.id = e."departmentId" AND d."organizationId" = e."organizationId"
      WHERE ${Prisma.join(conditions, " AND ")}
      ORDER BY ${sortColumn} ${sortDirection}, e.id ${sortDirection}
      LIMIT ${limit + 1}
    `);

    return rows.map(({ departmentId, departmentCode, departmentName, ...row }) => ({
      ...row,
      department: { id: departmentId, code: departmentCode, name: departmentName },
    }));
  }

  async list(
    principal: RequestPrincipal,
    dto: ListEmployeesDto,
  ): Promise<CursorPage<EmployeeListItem>> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanViewDirectory(membership.role);

    const sort = this.resolveSort(dto.sort);
    const direction = this.resolveDirection(dto.direction);
    const limit = normalizeCursorLimit(dto.limit);
    const search = dto.search?.trim() ? dto.search.trim() : undefined;
    const fingerprint = this.queryFingerprint(
      membership.organizationId,
      dto,
      sort,
      direction,
      limit,
      search,
    );
    const payload = this.decodePayload(sort, dto.cursor);

    if (dto.cursor && !payload) {
      throw new AuthException("INVALID_CURSOR", "Invalid cursor.", HttpStatus.BAD_REQUEST);
    }

    if (payload && payload.fingerprint !== fingerprint) {
      throw new AuthException("INVALID_CURSOR", "Invalid cursor.", HttpStatus.BAD_REQUEST);
    }

    const where: Prisma.EmployeeWhereInput = {
      organizationId: membership.organizationId,
      ...(dto.departmentId ? { departmentId: dto.departmentId } : {}),
      ...(dto.countryCode ? { countryCode: dto.countryCode.toUpperCase() } : {}),
      ...(dto.status ? { status: dto.status as EmployeeStatus } : {}),
      ...(dto.employmentType ? { employmentType: dto.employmentType as EmploymentType } : {}),
    };

    const keyset = this.cursorPredicate(sort, direction, payload);

    const rows = search
      ? await this.searchRows(
          membership.organizationId,
          dto,
          sort,
          direction,
          payload,
          limit,
          search,
        )
      : ((await this.prisma.employee.findMany({
          where: keyset ? { AND: [where, keyset] } : where,
          orderBy: this.orderBy(sort, direction),
          take: limit + 1,
          select: employeeSelect,
        })) as unknown as EmployeeRow[]);

    const items = rows.map((row) => this.toListItem(row));

    return buildCursorPage<EmployeeListItem>({
      cursorFromItem: (item) => this.cursorFromItem(sort, item, fingerprint),
      limit,
      rows: items,
    });
  }

  async detail(principal: RequestPrincipal, employeeId: string): Promise<EmployeeDetail> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanViewDirectory(membership.role);

    const row = (await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId: membership.organizationId },
      select: employeeSelect,
    })) as unknown as EmployeeRow | null;

    if (!row) {
      throw new AuthException(
        "EMPLOYEE_NOT_FOUND",
        "Employee was not found.",
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      ...this.toListItem(row),
      terminationDate: row.terminationDate ? toDateOnly(row.terminationDate) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async createEmployee(
    principal: RequestPrincipal,
    dto: CreateEmployeeDto,
    idempotencyKey?: string,
  ): Promise<EmployeeDetail> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanManageWorkforce(membership.role);

    if (!isValidIdempotencyKey(idempotencyKey)) {
      this.throwIdempotencyKeyRequired();
    }

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({ event: "employee.create.start", organizationId });

    // Authoritative normalization boundary: canonicalize here (not only in
    // DTO transforms) so internal callers store the same form and uniqueness
    // checks cannot be bypassed with unnormalized input.
    const employeeNumber = dto.employeeNumber.trim();
    const firstName = dto.firstName.trim();
    const lastName = dto.lastName.trim();
    const normalizedEmail = dto.workEmail ? normalizeEmail(dto.workEmail) : "";
    const workEmail = normalizedEmail.length > 0 ? normalizedEmail : undefined;
    const jobTitle = dto.jobTitle.trim();
    const trimmedLevel = dto.level?.trim();
    const level = trimmedLevel ? trimmedLevel : undefined;
    const countryCode = dto.countryCode.trim().toUpperCase();
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          departmentId: dto.departmentId.trim(),
          employeeNumber,
          firstName,
          lastName,
          workEmail: workEmail ?? null,
          jobTitle,
          level: level ?? null,
          countryCode,
          employmentType: dto.employmentType,
          hireDate: dto.hireDate,
        }),
      )
      .digest("hex");

    try {
      // Strict UTC date-only boundary: DTO @IsDateString alone also accepts
      // datetimes, which would shift the calendar day outside UTC.
      if (!isDateOnlyString(dto.hireDate)) {
        throw new AuthException(
          "INVALID_HIRE_DATE",
          "Hire date must be a calendar date (YYYY-MM-DD).",
          HttpStatus.BAD_REQUEST,
        );
      }

      const idempotencyInput = {
        organizationId,
        operation: "employee.create",
        idempotencyKey,
      };
      const result = await this.prisma.$transaction(async (transaction) => {
        const existing = await this.idempotency.find(transaction, idempotencyInput);

        if (existing) {
          if (existing.requestHash !== requestHash) this.throwIdempotencyConflict();
          if (!existing.resourceId || !existing.responsePayload) {
            throw new AuthException(
              EMPLOYEE_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
              "The previous employee creation did not complete.",
              HttpStatus.CONFLICT,
            );
          }

          return existing.responsePayload as unknown as EmployeeDetail;
        }

        const reserved = await this.idempotency.reserve(transaction, {
          ...idempotencyInput,
          requestHash,
        });
        const department = await transaction.department.findFirst({
          where: { id: dto.departmentId.trim(), organizationId },
          select: { id: true },
        });

        if (!department) {
          throw new AuthException(
            DEPARTMENT_ERROR_CODES.DEPARTMENT_NOT_FOUND,
            "Department was not found.",
            HttpStatus.NOT_FOUND,
          );
        }

        const created = await transaction.employee.create({
          data: {
            organizationId,
            departmentId: department.id,
            employeeNumber,
            firstName,
            lastName,
            workEmail: workEmail ?? null,
            jobTitle,
            level: level ?? null,
            countryCode,
            employmentType: dto.employmentType,
            status: "ACTIVE",
            hireDate: new Date(`${dto.hireDate}T00:00:00.000Z`),
          },
          select: employeeSelect,
        });

        await this.idempotency.complete(
          transaction,
          reserved.id,
          created.id,
          this.toDetail(created as unknown as EmployeeRow),
        );

        return created;
      });

      if (!((result as EmployeeRow).createdAt instanceof Date)) {
        return result as EmployeeDetail;
      }

      const row = result as EmployeeRow;

      const created: EmployeeDetail = {
        ...this.toListItem(row),
        terminationDate: row.terminationDate ? toDateOnly(row.terminationDate) : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };

      this.executionTrace.debug({
        event: "employee.create.complete",
        organizationId,
        employeeId: created.id,
        durationMs: this.executionTrace.durationSince(startedAt),
      });

      return created;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        Array.isArray(error.meta?.target) &&
        (error.meta.target as unknown[]).includes("idempotencyKey")
      ) {
        const replay = await this.idempotency.findCommitted({
          organizationId,
          operation: "employee.create",
          idempotencyKey,
        });

        if (!replay || replay.requestHash !== requestHash || !replay.responsePayload) {
          this.throwIdempotencyConflict();
        }

        return replay.responsePayload as unknown as EmployeeDetail;
      }

      if (this.isUniqueViolationOn(error, "employeeNumber")) {
        this.throwUniqueConflict("employeeNumber");
      }

      if (this.isUniqueViolationOn(error, "workEmail")) {
        this.throwUniqueConflict("workEmail");
      }

      throw error;
    }
  }

  private throwEmployeeNotFound(): never {
    throw new AuthException(
      EMPLOYEE_ERROR_CODES.EMPLOYEE_NOT_FOUND,
      "Employee was not found.",
      HttpStatus.NOT_FOUND,
    );
  }

  private throwCompensationConflict(): never {
    throw new AuthException(
      EMPLOYEE_ERROR_CODES.EMPLOYEE_HAS_COMPENSATION_HISTORY,
      "Employee cannot be deleted because compensation history exists.",
      HttpStatus.CONFLICT,
    );
  }

  private toDetail(row: EmployeeRow): EmployeeDetail {
    return {
      ...this.toListItem(row),
      terminationDate: row.terminationDate ? toDateOnly(row.terminationDate) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async updateEmployee(
    principal: RequestPrincipal,
    employeeId: string,
    dto: UpdateEmployeeDto,
  ): Promise<EmployeeDetail> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanManageWorkforce(membership.role);

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({ event: "employee.update.start", organizationId, employeeId });

    const existing = (await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId },
      select: {
        id: true,
        employeeNumber: true,
        workEmail: true,
        departmentId: true,
        hireDate: true,
        terminationDate: true,
      },
    })) as unknown as {
      id: string;
      employeeNumber: string;
      workEmail: string | null;
      departmentId: string;
      hireDate: Date;
      terminationDate: Date | null;
    } | null;

    if (!existing) {
      this.throwEmployeeNotFound();
    }

    const data: Prisma.EmployeeUpdateInput = {};

    if (dto.employeeNumber !== undefined) {
      const employeeNumber = dto.employeeNumber.trim();

      if (employeeNumber !== existing.employeeNumber) {
        const duplicate = await this.prisma.employee.findFirst({
          where: { organizationId, employeeNumber, id: { not: existing.id } },
          select: { id: true },
        });

        if (duplicate) {
          this.throwUniqueConflict("employeeNumber");
        }

        data.employeeNumber = employeeNumber;
      }
    }

    if (dto.firstName !== undefined) {
      data.firstName = dto.firstName.trim();
    }

    if (dto.lastName !== undefined) {
      data.lastName = dto.lastName.trim();
    }

    if (dto.workEmail !== undefined) {
      if (dto.workEmail === null) {
        data.workEmail = null;
      } else {
        const normalized = normalizeEmail(dto.workEmail);

        if (normalized.length === 0) {
          data.workEmail = null;
        } else {
          if (normalized !== existing.workEmail) {
            const duplicate = await this.prisma.employee.findFirst({
              where: { organizationId, workEmail: normalized, id: { not: existing.id } },
              select: { id: true },
            });

            if (duplicate) {
              this.throwUniqueConflict("workEmail");
            }
          }

          data.workEmail = normalized;
        }
      }
    }

    if (dto.departmentId !== undefined) {
      const department = await this.departments.findTenantDepartmentOrThrow(
        organizationId,
        dto.departmentId.trim(),
      );

      data.department = { connect: { id: department.id } };
    }

    if (dto.jobTitle !== undefined) {
      data.jobTitle = dto.jobTitle.trim();
    }

    if (dto.level !== undefined) {
      if (dto.level === null) {
        data.level = null;
      } else {
        const trimmed = dto.level.trim();

        data.level = trimmed.length > 0 ? trimmed : null;
      }
    }

    if (dto.countryCode !== undefined) {
      data.countryCode = dto.countryCode.trim().toUpperCase();
    }

    if (dto.employmentType !== undefined) {
      data.employmentType = dto.employmentType;
    }

    if (dto.status !== undefined) {
      data.status = dto.status;
    }

    // Strict UTC date-only boundary (same rule as onboarding): the DTO
    // accepts ISO strings, but datetimes would shift the calendar day.
    let effectiveHire = toDateOnly(existing.hireDate);
    let effectiveTermination = existing.terminationDate
      ? toDateOnly(existing.terminationDate)
      : null;

    if (dto.hireDate !== undefined) {
      if (!isDateOnlyString(dto.hireDate)) {
        throw new AuthException(
          "INVALID_HIRE_DATE",
          "Hire date must be a calendar date (YYYY-MM-DD).",
          HttpStatus.BAD_REQUEST,
        );
      }

      data.hireDate = new Date(`${dto.hireDate}T00:00:00.000Z`);
      effectiveHire = dto.hireDate;
    }

    if (dto.terminationDate !== undefined) {
      if (dto.terminationDate === null) {
        data.terminationDate = null;
        effectiveTermination = null;
      } else {
        if (!isDateOnlyString(dto.terminationDate)) {
          throw new AuthException(
            EMPLOYEE_ERROR_CODES.INVALID_TERMINATION_DATE,
            "Termination date must be a calendar date (YYYY-MM-DD).",
            HttpStatus.BAD_REQUEST,
          );
        }

        data.terminationDate = new Date(`${dto.terminationDate}T00:00:00.000Z`);
        effectiveTermination = dto.terminationDate;
      }
    }

    if (effectiveTermination !== null && effectiveTermination < effectiveHire) {
      throw new AuthException(
        EMPLOYEE_ERROR_CODES.INVALID_TERMINATION_DATE,
        "Termination date must be on or after the hire date.",
        HttpStatus.BAD_REQUEST,
      );
    }

    // Explicit nulls are real clears above; an empty PATCH is a no-op read.
    if (Object.keys(data).length === 0) {
      return this.detail(principal, existing.id);
    }

    try {
      const row = (await this.prisma.employee.update({
        where: { id: existing.id },
        data,
        select: employeeSelect,
      })) as unknown as EmployeeRow;

      const updated = this.toDetail(row);

      this.executionTrace.debug({
        event: "employee.update.complete",
        organizationId,
        employeeId: updated.id,
        durationMs: this.executionTrace.durationSince(startedAt),
      });

      return updated;
    } catch (error) {
      if (this.isUniqueViolationOn(error, "employeeNumber")) {
        this.throwUniqueConflict("employeeNumber");
      }

      if (this.isUniqueViolationOn(error, "workEmail")) {
        this.throwUniqueConflict("workEmail");
      }

      // The composite tenant FK is the final backstop if the application
      // department lookup is ever bypassed: stay tenant-safe, not leaky.
      if (isPrismaRelationViolation(error)) {
        throw new AuthException(
          DEPARTMENT_ERROR_CODES.DEPARTMENT_NOT_FOUND,
          "Department was not found.",
          HttpStatus.NOT_FOUND,
        );
      }

      throw error;
    }
  }

  async deleteEmployee(
    principal: RequestPrincipal,
    employeeId: string,
  ): Promise<{ deleted: true }> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanManageWorkforce(membership.role);

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({ event: "employee.delete.start", organizationId, employeeId });

    const existing = await this.prisma.employee.findFirst({
      where: { id: employeeId, organizationId },
      select: { id: true },
    });

    if (!existing) {
      this.throwEmployeeNotFound();
    }

    // Compensation is append-only audit evidence: a protected employee can
    // never be hard-deleted. Check inside the same transaction as the delete
    // so compensation created between precheck and delete still blocks.
    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.employeeCompensation.findUnique({
          where: { employeeId: existing.id },
          select: { id: true },
        });

        if (current) {
          this.throwCompensationConflict();
        }

        const history = await tx.compensationHistory.findFirst({
          where: { employeeId: existing.id },
          select: { id: true },
        });

        if (history) {
          this.throwCompensationConflict();
        }

        await tx.employee.delete({ where: { id: existing.id } });
      });
    } catch (error) {
      // The FK restriction closes the insert-after-precheck race. Preserve the
      // same domain response as the normal precheck without exposing storage details.
      if (isPrismaRelationViolation(error)) {
        this.throwCompensationConflict();
      }

      throw error;
    }

    this.executionTrace.debug({
      event: "employee.delete.complete",
      organizationId,
      employeeId: existing.id,
      durationMs: this.executionTrace.durationSince(startedAt),
    });

    return { deleted: true };
  }
}
