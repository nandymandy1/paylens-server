import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RedisService } from "@/redis/redis.service.js";

describe("RedisService", () => {
  it("handles startup failures and registered client errors without unsafe logging", async () => {
    const client = Object.assign(new EventEmitter(), {
      connect: vi.fn().mockRejectedValue(new Error("connection refused")),
      isOpen: false,
      isReady: false,
      ping: vi.fn(),
      quit: vi.fn(),
    });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const service = new RedisService(client as never, logger as never);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    client.emit("error", new Error("connection refused"));

    await expect(service.isReady()).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      { error: { name: "Error" } },
      "Redis is unavailable during startup",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Redis client error",
    );
  });
});
