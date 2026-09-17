import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { REDIS_CLIENT, RedisService } from './redis.service.js';
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createClient({ url: config.getOrThrow<string>('app.redisUrl') }),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
