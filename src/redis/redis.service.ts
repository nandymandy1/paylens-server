import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

const CONNECT_TIMEOUT_MS = 5_000;

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Redis connection timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis,
    private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.client.on("ready", () => {
      this.logger.info("Redis connection ready");
    });
    this.client.on("error", (error: Error) => {
      this.logger.error({ err: error }, "Redis client error");
    });
    this.client.on("close", () => {
      this.logger.warn("Redis connection closed");
    });
    this.client.on("reconnecting", () => {
      this.logger.warn("Redis connection reconnecting");
    });

    try {
      await withTimeout(this.client.connect(), CONNECT_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(
        { error: { name: error instanceof Error ? error.name : "UnknownError" } },
        "Redis is unavailable during startup",
      );
    }
  }

  async isReady(): Promise<boolean> {
    try {
      if (this.client.status !== "ready") {
        return false;
      }

      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.client.status !== "end") {
        await this.client.quit();
      }
    } catch {
      this.client.disconnect();
    }
  }
}
