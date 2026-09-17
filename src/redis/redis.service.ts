import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type { RedisClientType } from "redis";
import { PinoLogger } from "nestjs-pino";

export const REDIS_CLIENT = Symbol("REDIS_CLIENT");

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: RedisClientType,
    private readonly logger: PinoLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.client.on("error", (error: Error) => {
      this.logger.error({ err: error }, "Redis client error");
    });

    try {
      await this.connect();
    } catch (error) {
      this.logger.warn(
        { error: { name: error instanceof Error ? error.name : "UnknownError" } },
        "Redis is unavailable during startup",
      );
    }
  }

  private async connect(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }
  async isReady(): Promise<boolean> {
    try {
      if (!this.client.isReady) {
        return false;
      }

      return (await this.client.ping()) === "PONG";
    } catch {
      return false;
    }
  }
  async onModuleDestroy() {
    if (this.client.isOpen) await this.client.quit();
  }
}
