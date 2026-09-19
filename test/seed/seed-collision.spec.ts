import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import {
  generateControlledUsers,
  generateDepartments,
  generateOrganizations,
} from "@/seed/data.js";
import {
  assertSeedOwnership,
  reconcileDepartments,
  reconcileOrganizations,
  reconcileUsers,
} from "@/seed/runner.js";

const TEST_PASSWORD = "Seed-R1-Test-Password-!";

let canonicalHash = "";

beforeAll(async () => {
  canonicalHash = await new PasswordService().hash(TEST_PASSWORD);
});

const controlledUsers = generateControlledUsers();
const organizations = generateOrganizations();

type FakeDb = {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  organization: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  department: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

const fakeDb = (): FakeDb => ({
  user: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  organization: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  department: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
});

const asDb = (fake: FakeDb): PrismaClient => fake as unknown as PrismaClient;

describe("SEED-R1 collision-before-mutation", () => {
  it("assertSeedOwnership throws on foreign ownership and passes on match or absence", () => {
    expect(() => assertSeedOwnership("user email", "a@x.test", "foreign-id", "seed-id")).toThrow(
      /Collision/,
    );
    expect(() => assertSeedOwnership("user email", "a@x.test", "seed-id", "seed-id")).not.toThrow();
    expect(() => assertSeedOwnership("user email", "a@x.test", null, "seed-id")).not.toThrow();
  });

  it("user collision fails before any write and leaves the foreign row untouched", async () => {
    const fake = fakeDb();
    const foreign = {
      id: "foreign-user-id",
      passwordHash: canonicalHash,
      firstName: "Real",
      lastName: "Developer",
    };

    fake.user.findUnique.mockImplementation(async ({ where }: { where: { email: string } }) =>
      where.email === controlledUsers[0].email ? foreign : null,
    );
    fake.user.create.mockImplementation(async ({ data }: { data: { id: string } }) => ({
      id: data.id,
    }));

    await expect(reconcileUsers(TEST_PASSWORD, asDb(fake))).rejects.toThrow(/Collision/);
    // The colliding entity is first in reconciliation order, so zero writes happen.
    expect(fake.user.update).not.toHaveBeenCalled();
    expect(fake.user.create).not.toHaveBeenCalled();
  });

  it("organization collision fails before any update of the foreign organization", async () => {
    const fake = fakeDb();

    fake.organization.findUnique.mockImplementation(
      async ({ where }: { where: { slug: string } }) =>
        where.slug === organizations[0].slug ? { id: "foreign-org-id" } : null,
    );

    await expect(reconcileOrganizations(asDb(fake))).rejects.toThrow(/Collision/);
    expect(fake.organization.update).not.toHaveBeenCalled();
    expect(fake.organization.create).not.toHaveBeenCalled();
  });

  it("department collision fails before any update of the foreign department", async () => {
    const fake = fakeDb();
    const firstDepartment = generateDepartments(organizations[0])[0];

    fake.department.findUnique.mockImplementation(
      async ({ where }: { where: { organizationId_code: { code: string } } }) =>
        where.organizationId_code.code === firstDepartment.code ? { id: "foreign-dept-id" } : null,
    );

    await expect(reconcileDepartments(asDb(fake))).rejects.toThrow(/Collision/);
    expect(fake.department.update).not.toHaveBeenCalled();
    expect(fake.department.create).not.toHaveBeenCalled();
  });

  it("owned seed rows reconcile without collision errors", async () => {
    const fake = fakeDb();

    fake.user.findUnique.mockResolvedValue(null);
    fake.user.create.mockImplementation(async ({ data }: { data: { id: string } }) => ({
      id: data.id,
    }));
    fake.organization.findUnique.mockResolvedValue(null);
    fake.organization.create.mockImplementation(async ({ data }: { data: { id: string } }) => ({
      id: data.id,
    }));
    fake.department.findUnique.mockResolvedValue(null);
    fake.department.create.mockImplementation(async ({ data }: { data: { id: string } }) => ({
      id: data.id,
    }));

    await expect(reconcileUsers(TEST_PASSWORD, asDb(fake))).resolves.toMatchObject({
      reconciled: controlledUsers.length,
    });
    await expect(reconcileOrganizations(asDb(fake))).resolves.toBeUndefined();
    await expect(reconcileDepartments(asDb(fake))).resolves.toBeUndefined();
    expect(fake.user.create).toHaveBeenCalledTimes(controlledUsers.length);
    expect(fake.organization.create).toHaveBeenCalledTimes(organizations.length);
  });
});
