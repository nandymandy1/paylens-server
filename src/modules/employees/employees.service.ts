import { HttpStatus, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { EmployeeStatus, EmploymentType, type Prisma } from "@prisma/client";
import { dayjs, toDateOnly } from "@/common/utils/date.js";
import { isRecord } from "@/common/utils/object.js";
import { isPrismaUniqueViolationOn } from "@/common/utils/prisma.js";
import { normalizeEmail } from "@/common/utils/string.js";
import {
  buildCursorPage,
  decodeCursor,
  encodeCursor,
  normalizeCursorLimit,
} from "@/common/pagination/cursor-pagination.util.js";
import type { CursorPage } from "@/common/pagination/cursor-pagination.type.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { PrismaService } from "@/database/prisma.service.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import { AUTH_ERROR_CODES } from "@/modules/auth/constants/auth.constants.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { activeTenantMembershipWhere } from "@/modules/auth/utils/tenant-access.utils.js";
import { DepartmentsService } from "@/modules/departments/departments.service.js";
import {
  EMPLOYEE_DIRECTIONS,
  EMPLOYEE_DIRECTORY_ROLES,
  EMPLOYEE_SORTS,
  EMPLOYEE_ERROR_CODES,
  EMPLOYEE_WRITE_ROLES,
  type EmployeeDirection,
  type EmployeeSort,
} from "@/modules/employees/constants/employees.constants.js";
import type { CreateEmployeeDto, ListEmployeesDto } from "@/modules/employees/dto/employees.dto.js";
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

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    readonly executionTrace: ExecutionTraceService,
    private readonly departments: DepartmentsService,
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
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: "insensitive" } },
              { lastName: { contains: search, mode: "insensitive" } },
              { workEmail: { contains: search, mode: "insensitive" } },
              { employeeNumber: { contains: search, mode: "insensitive" } },
              { jobTitle: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const keyset = this.cursorPredicate(sort, direction, payload);

    const rows = (await this.prisma.employee.findMany({
      where: keyset ? { AND: [where, keyset] } : where,
      orderBy: this.orderBy(sort, direction),
      take: limit + 1,
      select: employeeSelect,
    })) as unknown as EmployeeRow[];

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
  ): Promise<EmployeeDetail> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanManageWorkforce(membership.role);

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({ event: "employee.create.start", organizationId });

    const department = await this.departments.findTenantDepartmentOrThrow(
      organizationId,
      dto.departmentId,
    );

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

    const duplicateNumber = await this.prisma.employee.findFirst({
      where: { organizationId, employeeNumber },
      select: { id: true },
    });

    if (duplicateNumber) {
      this.throwUniqueConflict("employeeNumber");
    }

    if (workEmail) {
      const duplicateEmail = await this.prisma.employee.findFirst({
        where: { organizationId, workEmail },
        select: { id: true },
      });

      if (duplicateEmail) {
        this.throwUniqueConflict("workEmail");
      }
    }

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

      const row = (await this.prisma.employee.create({
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
      })) as unknown as EmployeeRow;

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
      if (this.isUniqueViolationOn(error, "employeeNumber")) {
        this.throwUniqueConflict("employeeNumber");
      }

      if (this.isUniqueViolationOn(error, "workEmail")) {
        this.throwUniqueConflict("workEmail");
      }

      throw error;
    }
  }
}
