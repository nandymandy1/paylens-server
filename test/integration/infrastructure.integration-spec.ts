import { createClient } from "redis";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "@/database/prisma.service.js";
import { RedisService } from "@/redis/redis.service.js";

describe("infrastructure containers", () => {
  let postgres: StartedTestContainer;
  let redis: StartedTestContainer;
  let prisma: PrismaService;
  let redisService: RedisService;
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
    redis = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();

    process.env.DATABASE_URL = `postgresql://paylens:paylens@${postgres.getHost()}:${postgres.getMappedPort(5432)}/paylens`;
    prisma = new PrismaService();
    await prisma.onModuleInit();

    const redisClient = createClient({
      url: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    });

    redisService = new RedisService(
      redisClient as never,
      {
        error: () => undefined,
        warn: () => undefined,
      } as never,
    );
    await redisService.onModuleInit();
  }, 120_000);

  afterAll(async () => {
    await redisService?.onModuleDestroy();
    await prisma?.onModuleDestroy();
    await redis?.stop();
    await postgres?.stop();
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("connects Prisma to PostgreSQL and checks health with safe SQL", async () => {
    await expect(prisma.isReady()).resolves.toBe(true);
  });

  it("connects Redis during lifecycle initialization and pings readiness", async () => {
    await expect(redisService.isReady()).resolves.toBe(true);
  });
});
