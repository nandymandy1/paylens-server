import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { RedisClientType } from 'redis';
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
@Injectable()
export class RedisService implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: RedisClientType) {}
  async isReady(): Promise<boolean> {
    try {
      if (!this.client.isOpen) {
        await this.client.connect();
      }
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
  async onModuleDestroy() {
    if (this.client.isOpen) await this.client.quit();
  }
}
