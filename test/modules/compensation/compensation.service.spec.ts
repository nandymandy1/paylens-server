import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { CompensationService } from "@/modules/compensation/compensation.service.js";
import type { ChangeCompensationDto } from "@/modules/compensation/dto/compensation.dto.js";

const principal = {
  userId: "user-1",
  sessionId: "session-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  role: "HR_MANAGER",
} as const;

const changeInput = (overrides: Partial<ChangeCompensationDto> = {}): ChangeCompensationDto => ({
  annualBaseSalary: "100000.00",
  currency: "USD",
  effectiveFrom: "2026-01-01",
  expectedVersion: 0,
  ...overrides,
});

const createHarness = () => {
  const idempotency = {
    find: vi.fn(async (): Promise<unknown> => null),
    reserve: vi.fn(async () => ({ id: "idem-1" })),
    complete: vi.fn(async () => undefined),
    findCommitted: vi.fn(async () => null),
  };
  const prisma = {
    organizationMembership: { findFirst: vi.fn(async () => ({ role: "HR_MANAGER" })) },
    employee: { findFirst: vi.fn(async () => ({ id: "employee-1" })) },
    employeeCompensation: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({
        id: "current-1",
        employeeId: "employee-1",
        annualBaseSalary: new Prisma.Decimal("100000.00"),
        currency: "USD",
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        version: 1,
      })),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    compensationHistory: { create: vi.fn(async () => ({ id: "history-1" })) },
    $transaction: vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation(prisma),
    ),
  };
  const trace = {
    now: () => 0,
    durationSince: () => 0,
    debug: () => undefined,
  };
  const service = new CompensationService(prisma as never, idempotency as never, trace as never);

  return { idempotency, prisma, service };
};

describe("CompensationService change", () => {
  it("replays the immutable committed response instead of rereading current compensation", async () => {
    const { idempotency, prisma, service } = createHarness();

    const first = await service.change(
      principal,
      "employee-1",
      changeInput(),
      "compensation-replay-key-0001",
    );
    const requestHash = (idempotency.reserve.mock.calls as unknown[][])[0]?.[1] as {
      requestHash: string;
    };

    idempotency.find.mockResolvedValueOnce({
      requestHash: requestHash.requestHash,
      resourceId: "history-1",
      responsePayload: first,
    });
    prisma.employeeCompensation.create.mockClear();

    await expect(
      service.change(principal, "employee-1", changeInput(), "compensation-replay-key-0001"),
    ).resolves.toEqual(first);
    expect(prisma.employeeCompensation.create).not.toHaveBeenCalled();
  });

  it("requires a non-INITIAL reason for a versioned change", async () => {
    const { service } = createHarness();

    await expect(
      service.change(
        principal,
        "employee-1",
        changeInput({ expectedVersion: 1, reason: undefined }),
        "compensation-reason-key-0001",
      ),
    ).rejects.toMatchObject({ code: "INVALID_COMPENSATION_REASON", status: 400 });
  });

  it("maps a concurrent initial-compensation unique conflict to a version conflict", async () => {
    const { prisma, service } = createHarness();

    prisma.employeeCompensation.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("duplicate initial compensation", {
        clientVersion: "test",
        code: "P2002",
        meta: { target: ["employeeId"] },
      }),
    );

    await expect(
      service.change(principal, "employee-1", changeInput(), "compensation-race-key-0001"),
    ).rejects.toMatchObject({ code: "COMPENSATION_VERSION_CONFLICT", status: 409 });
  });
});
