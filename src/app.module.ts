import { MiddlewareConsumer, Module, NestModule, RequestMethod } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { HttpExceptionFilter } from "@/common/filters/http-exception.filter.js";
import { ResponseEnvelopeInterceptor } from "@/common/interceptors/response-envelope.interceptor.js";
import { RequestContextMiddleware } from "@/common/middleware/request-id.middleware.js";
import { createGlobalValidationPipe } from "@/common/pipes/global-validation.pipe.js";
import { ControllerTraceInterceptor } from "@/common/tracing/controller-trace.interceptor.js";
import { ExecutionTraceService } from "@/common/tracing/execution-trace.service.js";
import appConfig from "@/config/app.config.js";
import { validateEnvironment } from "@/config/env.validation.js";
import { buildLoggerModuleOptions } from "@/config/logger.config.js";
import { DatabaseModule } from "@/database/database.module.js";
import { HealthModule } from "@/modules/health/health.module.js";
import { AuthModule } from "@/modules/auth/auth.module.js";
import { EmailModule } from "@/modules/email/email.module.js";
import { OrganizationsModule } from "@/modules/organizations/organizations.module.js";
import { QueueModule } from "@/queue/queue.module.js";
import { RedisModule } from "@/redis/redis.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      load: [appConfig],
      validate: validateEnvironment,
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildLoggerModuleOptions,
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.getOrThrow<number>("app.throttleTtlMs"),
          limit: config.getOrThrow<number>("app.throttleLimit"),
        },
      ],
    }),
    DatabaseModule,
    RedisModule,
    QueueModule,
    EmailModule,
    AuthModule,
    OrganizationsModule,
    HealthModule,
  ],
  providers: [
    ExecutionTraceService,
    RequestContextMiddleware,
    { provide: APP_PIPE, useFactory: createGlobalValidationPipe },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ControllerTraceInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes({ path: "*", method: RequestMethod.ALL });
  }
}
