import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import { REDIS_CLIENT, RedisService } from "./redis.service.js";

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis(config.getOrThrow<string>("app.redisUrl"), {
          lazyConnect: true,
          enableOfflineQueue: false,
        }),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
