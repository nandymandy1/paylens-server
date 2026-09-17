import { Injectable } from "@nestjs/common";
import { PrismaService } from "@/database/prisma.service.js";
import { RedisService } from "@/redis/redis.service.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import { TraceMethod } from "@/common/tracing/trace-method.decorator.js";

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    readonly executionTrace: ExecutionTraceService,
  ) {}

  @TraceMethod()
  health() {
    return { status: "ok" };
  }
  @TraceMethod()
  async ready() {
    const [database, redis] = await Promise.all([this.prisma.isReady(), this.redis.isReady()]);

    // Sessions are Redis-backed: without Redis the authenticated application cannot serve.
    return { ready: database && redis, dependencies: { database, redis } };
  }
}
