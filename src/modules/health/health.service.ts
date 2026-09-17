import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../redis/redis.service.js';
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}
  health() {
    return { status: 'ok' };
  }
  async ready() {
    const [database, redis] = await Promise.all([
      this.prisma.isReady(),
      this.redis.isReady(),
    ]);
    return { ready: database && redis, dependencies: { database, redis } };
  }
}
