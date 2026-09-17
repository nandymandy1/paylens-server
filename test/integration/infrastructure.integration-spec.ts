import { Redis } from "ioredis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PinoLogger } from "nestjs-pino";
import { PrismaService } from "@/database/prisma.service.js";
import { RedisService } from "@/redis/redis.service.js";

describe("infrastructure containers", () => {
  let postgres: StartedTestContainer;
  let prisma: PrismaService;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    postgres = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_DB: "paylens",
        POSTGRES_PASSWORD: "paylens",
        POSTGRES_USER: "paylens",
      })
      .withExposedPorts(5432)
      .start();

    process.env.DATABASE_URL = `postgresql://paylens:paylens@${postgres.getHost()}:${postgres.getMappedPort(5432)}/paylens`;
    prisma = new PrismaService();
    await prisma.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await postgres?.stop();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("connects Prisma to PostgreSQL and checks health with safe SQL", async () => {
    await expect(prisma.isReady()).resolves.toBe(true);
  });
});

// Runs only against an explicitly supplied external Redis; never provisions one via Docker.
describe.runIf(process.env.REDIS_URL)("external Redis lifecycle", () => {
  let client: Redis;
  let redisService: RedisService;

  beforeAll(async () => {
    client = new Redis(process.env.REDIS_URL as string, {
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    redisService = new RedisService(client, {
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    } as unknown as PinoLogger);
    await redisService.onModuleInit();
  }, 60_000);

  afterAll(async () => {
    await redisService?.onModuleDestroy();
  });

  it("connects Redis during lifecycle initialization and pings readiness", async () => {
    await expect(redisService.isReady()).resolves.toBe(true);
  });
});
