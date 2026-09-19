import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { SEED_EMPLOYEE_PREFIX } from "@/seed/constants.js";
import { expectedSeedEmployeeIds, generateOrganizations, type SeedEmployee } from "@/seed/data.js";
import { reconcileSeedEmployees, resolveSeedEmployeeScope } from "@/seed/runner.js";

const organizations = generateOrganizations();

type StoredEmployee = {
  id: string;
  organizationId: string;
  employeeNumber: string;
  workEmail?: string;
};

const syntheticEmployees = (count: number, start = 0): SeedEmployee[] => {
  const ids = expectedSeedEmployeeIds(organizations).slice(start, start + count);

  return ids.map((id, index) => ({
    id,
    organizationId: organizations[0].id,
    departmentId: "seed-r1-department-test",
    employeeNumber: `${SEED_EMPLOYEE_PREFIX}TEST-${String(start + index + 1).padStart(5, "0")}`,
    firstName: "Test",
    lastName: `Employee${start + index + 1}`,
    workEmail: `test.employee${start + index + 1}@seed.paylens.test`,
    jobTitle: "Specialist",
    level: "L2",
    countryCode: "US",
    employmentType: "FULL_TIME",
    status: "ACTIVE",
    hireDate: new Date(Date.UTC(2020, 0, 1)),
    terminationDate: null,
  })) as SeedEmployee[];
};

/**
 * In-memory fake that applies real `where` predicates instead of ignoring
 * them: `id IN [...]` resolves by exact ID, `employeeNumber startsWith`
 * resolves by prefix. This is what makes the tests exercise production
 * query intent rather than rubber-stamping prefix discovery.
 */
const fakeEmployeeDb = (store: StoredEmployee[]) => {
  const idChunkSizes: number[] = [];
  const deleteSizes: number[] = [];
  const createSizes: number[] = [];
  const matches = (row: StoredEmployee, where: Record<string, unknown>): boolean => {
    const idClause = where.id as { in?: string[] } | undefined;
    const numberClause = where.employeeNumber as
      { startsWith?: string; not?: { startsWith?: string } } | undefined;
    const emailClause = where.workEmail as { in?: string[] } | undefined;

    if (idClause?.in && !idClause.in.includes(row.id)) return false;

    if (typeof where.organizationId === "string" && row.organizationId !== where.organizationId) {
      return false;
    }

    if (
      emailClause?.in &&
      !(row.workEmail !== undefined && emailClause.in.includes(row.workEmail))
    ) {
      return false;
    }

    if (numberClause?.startsWith && !row.employeeNumber.startsWith(numberClause.startsWith)) {
      return false;
    }

    if (
      numberClause?.not?.startsWith &&
      row.employeeNumber.startsWith(numberClause.not.startsWith)
    ) {
      return false;
    }

    return true;
  };
  const db = {
    employee: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        if (args.where.id !== undefined) {
          idChunkSizes.push(((args.where.id as { in: string[] }).in ?? []).length);
        }

        return store.filter((row) => matches(row, args.where));
      }),
      deleteMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => {
        deleteSizes.push(args.where.id.in.length);
        const doomed = new Set(args.where.id.in);

        for (let index = store.length - 1; index >= 0; index -= 1) {
          if (doomed.has(store[index].id)) store.splice(index, 1);
        }

        return { count: deleteSizes.at(-1) };
      }),
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        createSizes.push(args.data.length);

        return { count: args.data.length };
      }),
    },
  };

  return {
    db: db as unknown as PrismaClient,
    idChunkSizes,
    deleteSizes,
    createSizes,
  };
};

const storedFrom = (employees: SeedEmployee[]): StoredEmployee[] =>
  employees.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    employeeNumber: row.employeeNumber,
    workEmail: row.workEmail ?? undefined,
  }));

describe("SEED-R1 production reconciliation batching and prefix safety", () => {
  it("discovers 1,200 canonical IDs through production exact-ID reads in 500/500/200", async () => {
    const employees = syntheticEmployees(1_200);
    const { db, idChunkSizes, deleteSizes, createSizes } = fakeEmployeeDb(storedFrom(employees));

    const result = await reconcileSeedEmployees(employees, db);

    expect(idChunkSizes).toEqual([500, 500, 200]);
    expect(result).toEqual({ batches: 6 });
    expect(deleteSizes).toEqual([500, 500, 200]);
    expect(createSizes).toEqual([500, 500, 200]);
  });

  it("discovers a canonical ID renamed to a non-prefix number, with no recreate collision", async () => {
    const employees = syntheticEmployees(5);
    const renamedId = employees[0].id;
    const store = storedFrom(employees);

    store[0].employeeNumber = "RENAMED-999";

    const { db } = fakeEmployeeDb(store);
    const scope = await resolveSeedEmployeeScope(
      db,
      new Set(employees.map((row) => row.id)),
      "seed",
    );

    expect(scope).toContain(renamedId);
    expect(scope).toHaveLength(5);

    // Full reconciliation deletes the renamed canonical row, then recreates it:
    // exactly one delete batch carrying the renamed ID, no PK collision path.
    const { db: reconcileDb, deleteSizes } = fakeEmployeeDb(
      storedFrom(employees).map((row) =>
        row.id === renamedId ? { ...row, employeeNumber: "RENAMED-999" } : row,
      ),
    );

    await reconcileSeedEmployees(employees, reconcileDb);
    expect(deleteSizes).toEqual([5]);
  });

  it("fails safe on a reserved-prefix foreign employee with zero writes", async () => {
    const employees = syntheticEmployees(10);
    const store: StoredEmployee[] = [
      ...storedFrom(employees),
      {
        id: "foreign-manual-employee-1",
        organizationId: organizations[0].id,
        employeeNumber: `${SEED_EMPLOYEE_PREFIX}MANUAL-001`,
      },
    ];
    const { db } = fakeEmployeeDb(store);

    await expect(reconcileSeedEmployees(employees, db)).rejects.toThrow(
      /reserved SEED-R1 employee-number namespace/,
    );
    await expect(reconcileSeedEmployees(employees, db)).rejects.toThrow(
      /foreign-manual-employee-1/,
    );
    expect(db.employee.deleteMany as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(db.employee.createMany as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // Intruder row untouched in the store.
    expect(store).toContainEqual({
      id: "foreign-manual-employee-1",
      organizationId: organizations[0].id,
      employeeNumber: `${SEED_EMPLOYEE_PREFIX}MANUAL-001`,
    });
  });

  it("fails safe when a foreign ID owns a canonical seed workEmail, with zero writes", async () => {
    const employees = syntheticEmployees(10);
    const stolenEmail = employees[0].workEmail!;
    const store: StoredEmployee[] = [
      ...storedFrom(employees),
      {
        id: "foreign-manual-employee-email",
        organizationId: organizations[0].id,
        employeeNumber: "EMP-999",
        workEmail: stolenEmail,
      },
    ];
    const { db } = fakeEmployeeDb(store);

    await expect(reconcileSeedEmployees(employees, db)).rejects.toThrow(
      /canonical seed workEmail is owned by a non-seed row/,
    );
    await expect(reconcileSeedEmployees(employees, db)).rejects.toThrow(
      /foreign-manual-employee-email/,
    );
    expect(db.employee.deleteMany as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(db.employee.createMany as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    // Foreign row unchanged in the store.
    expect(store).toContainEqual({
      id: "foreign-manual-employee-email",
      organizationId: organizations[0].id,
      employeeNumber: "EMP-999",
      workEmail: stolenEmail,
    });
  });

  it("passes the workEmail preflight when the canonical ID owns its canonical email", async () => {
    const employees = syntheticEmployees(5);
    const { db, deleteSizes, createSizes } = fakeEmployeeDb(storedFrom(employees));

    await reconcileSeedEmployees(employees, db);
    expect(deleteSizes).toEqual([5]);
    expect(createSizes).toEqual([5]);
  });

  it("leaves a normal foreign employee out of scope and untouched", async () => {
    const employees = syntheticEmployees(5);
    const store: StoredEmployee[] = [
      ...storedFrom(employees),
      { id: "real-employee-1", organizationId: organizations[0].id, employeeNumber: "EMP-001" },
    ];
    const { db, deleteSizes } = fakeEmployeeDb(store);

    const scope = await resolveSeedEmployeeScope(
      db,
      new Set(employees.map((row) => row.id)),
      "rollback",
    );

    expect(scope).not.toContain("real-employee-1");
    expect(scope).toHaveLength(5);

    await reconcileSeedEmployees(employees, db);
    expect(deleteSizes).toEqual([5]);
    expect(store).toContainEqual({
      id: "real-employee-1",
      organizationId: organizations[0].id,
      employeeNumber: "EMP-001",
    });
  });
});
