import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      // BullMQ builds its own dedicated ioredis connections from this URL;
      // the single REDIS_URL contract stays the only configuration surface.
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.getOrThrow<string>("app.redisUrl"),
          maxRetriesPerRequest: null,
        },
      }),
    }),
  ],
})
export class QueueModule {}
