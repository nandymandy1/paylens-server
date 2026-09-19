import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { getSqlStatementType } from "@/common/utils/sql.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly executionTrace?: ExecutionTraceService) {
    super({ log: [{ emit: "event", level: "query" }] } as Prisma.PrismaClientOptions);

    this.$on("query" as never, (event: Prisma.QueryEvent) => {
      this.executionTrace?.recordDatabaseQuery({
        statementType: getSqlStatementType(event.query),
        durationMs: event.duration,
      });
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async isReady(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;

      return true;
    } catch {
      return false;
    }
  }
}
