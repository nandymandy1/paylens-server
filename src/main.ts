import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor.js';
import { requestIdMiddleware } from './common/middleware/request-id.middleware.js';

export async function createApplication() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  app.useLogger(app.get('PinoLogger'));
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.enableCors({
    credentials: true,
    origin: config.getOrThrow<string[]>('app.corsOrigins'),
  });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter(app.get('PinoLogger')));
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('PayLens API')
      .setDescription('PayLens REST API foundation')
      .setVersion('v1')
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
  });
  return app;
}

async function bootstrap() {
  const app = await createApplication();
  await app.listen(app.get(ConfigService).getOrThrow<number>('app.port'));
}
void bootstrap();
