import type { INestApplication } from "@nestjs/common";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Health endpoints (e2e)", () => {
  let app: INestApplication;
  let postgres: StartedTestContainer;
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

    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = `postgresql://paylens:paylens@${postgres.getHost()}:${postgres.getMappedPort(5432)}/paylens`;
    // No Redis container: Redis is an optional capability and /ready must stay green without it.
    process.env.REDIS_URL = "redis://127.0.0.1:6390";
    process.env.CORS_ORIGINS = "http://localhost:3000";
    process.env.EXECUTION_TRACE_ENABLED = "true";

    const { createApplication } = await import("@/application.js");

    app = await createApplication();
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
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
  });

  it("reports not-ready when Redis is unavailable: sessions are Redis-backed", async () => {
    await request(app.getHttpServer())
      .get("/ready")
      .expect(503)
      .expect(({ body }) => {
        expect(body.code).toBe("SERVICE_UNAVAILABLE");
      });

    await request(app.getHttpServer()).get("/api/docs").expect(200);
  });

  it("never throttles health/readiness probes", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(app.getHttpServer()).get("/health").expect(200);
      await request(app.getHttpServer()).get("/ready").expect(200);
    }
  });
});
