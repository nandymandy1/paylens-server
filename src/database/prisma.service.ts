import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly executionTrace?: ExecutionTraceService) {
    super({ log: [{ emit: "event", level: "query" }] } as Prisma.PrismaClientOptions);

    this.$on("query" as never, (event: Prisma.QueryEvent) => {
      const [model, action] = event.target.split(".");

      this.executionTrace?.recordDatabaseQuery({
        model,
        action,
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
