import { pathToFileURL } from "node:url";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module.js";

export async function createApplication() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableCors({
    credentials: true,
    origin: config.getOrThrow<string[]>("app.corsOrigins"),
  });
  app.setGlobalPrefix("api/v1", { exclude: ["health", "ready"] });
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("PayLens API")
      .setDescription("PayLens REST API foundation")
      .setVersion("v1")
      .build(),
  );

  SwaggerModule.setup("api/docs", app, document, {
    jsonDocumentUrl: "api/docs-json",
  });

  return app;
}

async function bootstrap() {
  const app = await createApplication();

  await app.listen(app.get(ConfigService).getOrThrow<number>("app.port"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrap();
}
