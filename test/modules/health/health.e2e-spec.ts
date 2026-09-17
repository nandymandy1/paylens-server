import type { INestApplication } from "@nestjs/common";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Health endpoints (e2e)", () => {
  let app: INestApplication;
  let postgres: StartedTestContainer;
  let redis: StartedTestContainer;
  const originalEnvironment = { ...process.env };

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

    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = `postgresql://paylens:paylens@${postgres.getHost()}:${postgres.getMappedPort(5432)}/paylens`;
    process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env.CORS_ORIGINS = "http://localhost:3000";
    process.env.THROTTLE_LIMIT = "2";
    process.env.EXECUTION_TRACE_ENABLED = "true";

    const { createApplication } = await import("@/main.js");

    app = await createApplication();
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop();
    await postgres?.stop();
    process.env = originalEnvironment;
  });

  it("uses the real AppModule, bootstrap configuration, and response envelope", async () => {
    const requestId = "e2e-health-request";
    const response = await request(app.getHttpServer())
      .get("/health")
      .set("x-request-id", requestId)
      .expect(200);

    expect(response.headers["x-request-id"]).toBe(requestId);
    expect(response.body).toEqual({
      success: true,
      requestId,
      data: { status: "ok" },
    });

    await request(app.getHttpServer())
      .get("/ready")
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.ready).toBe(true);
        expect(body.data.dependencies).toEqual({ database: true, redis: true });
      });

    await request(app.getHttpServer()).get("/api/docs").expect(200);
  });

  it("enforces the global throttler guard with the live exception filter", async () => {
    await request(app.getHttpServer()).get("/health").expect(200);

    const response = await request(app.getHttpServer()).get("/health").expect(429);

    expect(response.body).toMatchObject({
      success: false,
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests.",
    });
  });
});
