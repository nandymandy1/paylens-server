import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/database/prisma.service.js";

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$/;

export const isValidIdempotencyKey = (key: string | undefined): key is string =>
  Boolean(key && IDEMPOTENCY_KEY_PATTERN.test(key));

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    transaction: Prisma.TransactionClient,
    input: { organizationId: string; operation: string; idempotencyKey: string },
  ) {
    return transaction.mutationIdempotency.findUnique({
      where: {
        organizationId_operation_idempotencyKey: input,
      },
    });
  }

  async reserve(
    transaction: Prisma.TransactionClient,
    input: {
      organizationId: string;
      operation: string;
      idempotencyKey: string;
      requestHash: string;
    },
  ) {
    return transaction.mutationIdempotency.create({ data: input });
  }

  async complete(
    transaction: Prisma.TransactionClient,
    id: string,
    resourceId: string,
    responsePayload: Prisma.InputJsonValue,
  ) {
    return transaction.mutationIdempotency.update({
      where: { id },
      data: { resourceId, responsePayload },
    });
  }

  async findCommitted(input: {
    organizationId: string;
    operation: string;
    idempotencyKey: string;
  }) {
    return this.prisma.mutationIdempotency.findUnique({
      where: { organizationId_operation_idempotencyKey: input },
    });
  }
}
