import { HttpStatus, Injectable } from "@nestjs/common";
import { isPrismaRelationViolation, isPrismaUniqueViolationOn } from "@/common/utils/prisma.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { PrismaService } from "@/database/prisma.service.js";
import { AuthException } from "@/modules/auth/auth.exception.js";
import { AUTH_ERROR_CODES } from "@/modules/auth/constants/auth.constants.js";
import type { RequestPrincipal } from "@/modules/auth/types/auth.types.js";
import { activeTenantMembershipWhere } from "@/modules/auth/utils/tenant-access.utils.js";
import {
  DEPARTMENT_ERROR_CODES,
  DEPARTMENT_READ_ROLES,
  DEPARTMENT_WRITE_ROLES,
} from "@/modules/departments/constants/departments.constants.js";
import type { CreateDepartmentDto } from "@/modules/departments/dto/create-department.dto.js";
import type { UpdateDepartmentDto } from "@/modules/departments/dto/update-department.dto.js";
import type { DepartmentSummary } from "@/modules/departments/types/departments.types.js";

const departmentSelect = {
  id: true,
  code: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { employees: true } },
} as const;

type DepartmentRow = {
  id: string;
  code: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  _count: { employees: number };
};

@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    readonly executionTrace: ExecutionTraceService,
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

  private assertCanReadDepartments(role: string) {
    if (!(DEPARTMENT_READ_ROLES as readonly string[]).includes(role)) {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot view departments.",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertCanManageDepartments(role: string) {
    if (!(DEPARTMENT_WRITE_ROLES as readonly string[]).includes(role)) {
      throw new AuthException(
        AUTH_ERROR_CODES.INSUFFICIENT_PERMISSION,
        "Your role cannot manage departments.",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private throwCodeConflict(): never {
    throw new AuthException(
      DEPARTMENT_ERROR_CODES.DEPARTMENT_CODE_ALREADY_EXISTS,
      "A department with this code already exists.",
      HttpStatus.CONFLICT,
    );
  }

  private throwNotFound(): never {
    throw new AuthException(
      DEPARTMENT_ERROR_CODES.DEPARTMENT_NOT_FOUND,
      "Department was not found.",
      HttpStatus.NOT_FOUND,
    );
  }

  private toSummary(row: DepartmentRow): DepartmentSummary {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      employeeCount: row._count.employees,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Narrow tenant-safe lookup for cross-module use (e.g. employee onboarding).
   * Never reveals whether a foreign-tenant department exists.
   */
  async findTenantDepartmentOrThrow(
    organizationId: string,
    departmentId: string,
  ): Promise<{ id: string }> {
    const department = await this.prisma.department.findFirst({
      where: { id: departmentId, organizationId },
      select: { id: true },
    });

    if (!department) {
      this.throwNotFound();
    }

    return department;
  }

  async list(principal: RequestPrincipal): Promise<DepartmentSummary[]> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanReadDepartments(membership.role);

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({ event: "department.list.start", organizationId });

    const rows = (await this.prisma.department.findMany({
      where: { organizationId },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: departmentSelect,
    })) as unknown as DepartmentRow[];

    const departments = rows.map((row) => this.toSummary(row));

    this.executionTrace.debug({
      event: "department.list.complete",
      organizationId,
      durationMs: this.executionTrace.durationSince(startedAt),
    });

    return departments;
  }

  async detail(principal: RequestPrincipal, departmentId: string): Promise<DepartmentSummary> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanReadDepartments(membership.role);

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({ event: "department.detail.start", organizationId, departmentId });

    const row = (await this.prisma.department.findFirst({
      where: { id: departmentId, organizationId },
      select: departmentSelect,
    })) as unknown as DepartmentRow | null;

    if (!row) {
      this.throwNotFound();
    }

    const department = this.toSummary(row);

    this.executionTrace.debug({
      event: "department.detail.complete",
      organizationId,
      departmentId: department.id,
      durationMs: this.executionTrace.durationSince(startedAt),
    });

    return department;
  }

  async create(principal: RequestPrincipal, dto: CreateDepartmentDto): Promise<DepartmentSummary> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanManageDepartments(membership.role);

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({ event: "department.create.start", organizationId });

    // Normalized here (not only in the DTO transform) so every caller,
    // including direct service use, stores the canonical form.
    const name = dto.name.trim();
    const code = dto.code.trim().toUpperCase();

    const duplicate = await this.prisma.department.findFirst({
      where: { organizationId, code },
      select: { id: true },
    });

    if (duplicate) {
      this.throwCodeConflict();
    }

    try {
      const row = await this.prisma.department.create({
        data: { organizationId, code, name },
        select: { id: true, code: true, name: true, createdAt: true, updatedAt: true },
      });

      const created: DepartmentSummary = {
        id: row.id,
        code: row.code,
        name: row.name,
        employeeCount: 0,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };

      this.executionTrace.debug({
        event: "department.create.complete",
        organizationId,
        departmentId: created.id,
        durationMs: this.executionTrace.durationSince(startedAt),
      });

      return created;
    } catch (error) {
      if (isPrismaUniqueViolationOn(error, "code")) {
        this.throwCodeConflict();
      }

      throw error;
    }
  }

  async update(
    principal: RequestPrincipal,
    departmentId: string,
    dto: UpdateDepartmentDto,
  ): Promise<DepartmentSummary> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanManageDepartments(membership.role);

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({
      event: "department.update.start",
      organizationId,
      departmentId,
    });

    const existing = await this.prisma.department.findFirst({
      where: { id: departmentId, organizationId },
      select: { id: true, code: true },
    });

    if (!existing) {
      this.throwNotFound();
    }

    const name = dto.name?.trim();
    const code = dto.code?.trim().toUpperCase();

    if (code && code !== existing.code) {
      const duplicate = await this.prisma.department.findFirst({
        where: { organizationId, code, id: { not: existing.id } },
        select: { id: true },
      });

      if (duplicate) {
        this.throwCodeConflict();
      }
    }

    try {
      const row = await this.prisma.department.update({
        where: { id: existing.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(code !== undefined ? { code } : {}),
        },
        select: { id: true, code: true, name: true, createdAt: true, updatedAt: true },
      });

      const assigned = await this.prisma.employee.count({
        where: { organizationId, departmentId: existing.id },
      });

      const updated: DepartmentSummary = {
        id: row.id,
        code: row.code,
        name: row.name,
        employeeCount: assigned,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };

      this.executionTrace.debug({
        event: "department.update.complete",
        organizationId,
        departmentId: updated.id,
        durationMs: this.executionTrace.durationSince(startedAt),
      });

      return updated;
    } catch (error) {
      if (isPrismaUniqueViolationOn(error, "code")) {
        this.throwCodeConflict();
      }

      throw error;
    }
  }

  async remove(principal: RequestPrincipal, departmentId: string): Promise<{ deleted: true }> {
    const membership = await this.requireActiveMembership(principal);

    this.assertCanManageDepartments(membership.role);

    const organizationId = membership.organizationId;
    const startedAt = this.executionTrace.now();

    this.executionTrace.debug({
      event: "department.delete.start",
      organizationId,
      departmentId,
    });

    const existing = await this.prisma.department.findFirst({
      where: { id: departmentId, organizationId },
      select: { id: true },
    });

    if (!existing) {
      this.throwNotFound();
    }

    const assigned = await this.prisma.employee.count({
      where: { organizationId, departmentId: existing.id },
    });

    if (assigned > 0) {
      throw new AuthException(
        DEPARTMENT_ERROR_CODES.DEPARTMENT_IN_USE,
        "Department has employees assigned and cannot be deleted.",
        HttpStatus.CONFLICT,
      );
    }

    try {
      await this.prisma.department.delete({ where: { id: existing.id } });
    } catch (error) {
      // A concurrent assignment between the guard check and the delete surfaces
      // as a relation restriction: translate it to the same stable domain code.
      if (isPrismaRelationViolation(error)) {
        throw new AuthException(
          DEPARTMENT_ERROR_CODES.DEPARTMENT_IN_USE,
          "Department has employees assigned and cannot be deleted.",
          HttpStatus.CONFLICT,
        );
      }

      throw error;
    }

    this.executionTrace.debug({
      event: "department.delete.complete",
      organizationId,
      departmentId: existing.id,
      durationMs: this.executionTrace.durationSince(startedAt),
    });

    return { deleted: true };
  }
}
