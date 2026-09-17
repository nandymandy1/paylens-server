import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RedisService } from "@/redis/redis.service.js";

const createClient = (overrides: Record<string, unknown> = {}) =>
  Object.assign(new EventEmitter(), {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    ping: vi.fn().mockResolvedValue("PONG"),
    quit: vi.fn().mockResolvedValue("OK"),
    status: "ready",
    ...overrides,
  });

const createLogger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() });

describe("RedisService", () => {
  it("connects on init, reports ready, and quits on destroy", async () => {
    const client = createClient();
    const logger = createLogger();
    const service = new RedisService(client as never, logger as never);

    await service.onModuleInit();
    client.emit("ready");

    expect(client.connect).toHaveBeenCalledOnce();
    await expect(service.isReady()).resolves.toBe(true);
    expect(logger.info).toHaveBeenCalledWith("Redis connection ready");

    await service.onModuleDestroy();

    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("survives startup failure without leaking connection details", async () => {
    const client = createClient({
      connect: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:6390")),
      status: "reconnecting",
    });
    const logger = createLogger();
    const service = new RedisService(client as never, logger as never);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    client.emit("error", new Error("connect ECONNREFUSED 127.0.0.1:6390"));

    await expect(service.isReady()).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      { error: { name: "Error" } },
      "Redis is unavailable during startup",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Redis client error",
    );
    for (const call of [...logger.warn.mock.calls, ...logger.error.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain("127.0.0.1");
    }
  });

  it("disconnects when graceful quit fails", async () => {
    const client = createClient({ quit: vi.fn().mockRejectedValue(new Error("closed")) });
    const service = new RedisService(client as never, createLogger() as never);

    await service.onModuleDestroy();

    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});
