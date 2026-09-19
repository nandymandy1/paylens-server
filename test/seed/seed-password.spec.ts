import type { PrismaClient } from "@prisma/client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PasswordService } from "@/modules/auth/services/password.service.js";
import { generateControlledUsers } from "@/seed/data.js";
import { reconcileUsers } from "@/seed/runner.js";

const TEST_PASSWORD = "Seed-R1-Test-Password-!";
const WRONG_PASSWORD = "Some-Other-Password-!";

let canonicalHash = "";
let wrongHash = "";

beforeAll(async () => {
  const passwords = new PasswordService();

  canonicalHash = await passwords.hash(TEST_PASSWORD);
  wrongHash = await passwords.hash(WRONG_PASSWORD);
});

const controlledUsers = generateControlledUsers();

const byEmail = (email: string) => controlledUsers.find((user) => user.email === email)!;

const fakeUserDb = (findUnique: ReturnType<typeof vi.fn>) =>
  ({
    user: {
      findUnique,
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "x", ...data })),
      create: vi.fn(async ({ data }: { data: { id: string } }) => ({ id: data.id })),
    },
  }) as unknown as PrismaClient;

describe("SEED-R1 controlled-password reconciliation", () => {
  it("preserves the canonical hash without rewriting it", async () => {
    const findUnique = vi.fn(async ({ where }: { where: { email: string } }) => ({
      id: byEmail(where.email).id,
      passwordHash: canonicalHash,
    }));
    const db = fakeUserDb(findUnique);

    const result = await reconcileUsers(TEST_PASSWORD, db);

    expect(result.unchanged).toBe(controlledUsers.length);
    expect(result.reconciled).toBe(0);
    const updates = (db.user.update as unknown as ReturnType<typeof vi.fn>).mock.calls;

    expect(updates).toHaveLength(controlledUsers.length);
    for (const [args] of updates) {
      expect(args.data).not.toHaveProperty("passwordHash");
    }
  });

  it("restores a wrong controlled hash", async () => {
    const findUnique = vi.fn(async ({ where }: { where: { email: string } }) => {
      const canonical = byEmail(where.email);

      return where.email === controlledUsers[0].email
        ? { id: canonical.id, passwordHash: wrongHash }
        : { id: canonical.id, passwordHash: canonicalHash };
    });
    const db = fakeUserDb(findUnique);

    const result = await reconcileUsers(TEST_PASSWORD, db);

    expect(result.reconciled).toBe(1);
    const updates = (db.user.update as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const firstUserUpdate = updates.find(
      (call: unknown[]) =>
        (call[0] as { where: { id: string } }).where.id === controlledUsers[0].id,
    ) as unknown as [{ where: { id: string }; data: Record<string, unknown> }];

    expect(firstUserUpdate[0].data).toHaveProperty("passwordHash");
    const passwords = new PasswordService();

    expect(
      await passwords.verify(firstUserUpdate[0].data.passwordHash as string, TEST_PASSWORD),
    ).toBe(true);
  });

  it("restores a missing controlled hash", async () => {
    const findUnique = vi.fn(async ({ where }: { where: { email: string } }) => {
      const canonical = byEmail(where.email);

      return where.email === controlledUsers[1].email
        ? { id: canonical.id, passwordHash: null }
        : { id: canonical.id, passwordHash: canonicalHash };
    });
    const db = fakeUserDb(findUnique);

    await reconcileUsers(TEST_PASSWORD, db);

    const updates = (db.user.update as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const target = updates.find(
      (call: unknown[]) =>
        (call[0] as { where: { id: string } }).where.id === controlledUsers[1].id,
    ) as unknown as [{ where: { id: string }; data: Record<string, unknown> }];

    expect(target[0].data).toHaveProperty("passwordHash");
  });

  it("never touches non-seed users", async () => {
    const findUnique = vi.fn(async () => null);
    const db = fakeUserDb(findUnique);

    await reconcileUsers(TEST_PASSWORD, db);

    const creates = (db.user.create as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const emails = creates.map(
      (call: unknown[]) => (call[0] as { data: { email: string } }).data.email,
    );

    expect(emails).toHaveLength(controlledUsers.length);
    expect(emails.every((email: string) => email.endsWith("@seed.paylens.test"))).toBe(true);
  });
});
