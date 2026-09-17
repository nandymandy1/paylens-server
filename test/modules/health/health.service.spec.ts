import { describe, expect, it } from "vitest";
import { HealthService } from "@/modules/health/health.service.js";

const createService = (database: boolean, redis: boolean) =>
  new HealthService(
    { isReady: async () => database } as never,
    { isReady: async () => redis } as never,
    {
      now: () => 0,
      debug: () => undefined,
      durationSince: () => 0,
    } as never,
  );

describe("HealthService", () => {
  it("is ready when database and Redis are up", async () => {
    await expect(createService(true, true).ready()).resolves.toEqual({
      ready: true,
      dependencies: { database: true, redis: true },
    });
  });

  it("stays ready when Redis is down while reporting it degraded", async () => {
    await expect(createService(true, false).ready()).resolves.toEqual({
      ready: true,
      dependencies: { database: true, redis: false },
    });
  });

  it("is not ready when the database is down", async () => {
    await expect(createService(false, true).ready()).resolves.toEqual({
      ready: false,
      dependencies: { database: false, redis: true },
    });
  });
});
