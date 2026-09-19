// OTel SDK must be registered before any Nest module import (Prisma, ioredis).
import "./telemetry-bootstrap.js";

import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const bootstrap = async (): Promise<void> => {
  const logger = new Logger("Bootstrap");

  try {
    // Dynamic import ensures telemetry-bootstrap has executed before
    // application.ts statically imports AppModule (which imports Prisma, etc.).
    const { createApplication } = await import("./application.js");
    const app = await createApplication();
    const config = app.get(ConfigService);

    app.enableShutdownHooks();

    const port = config.getOrThrow<number>("app.port");

    await app.listen(port);
    logger.log(`PayLens API listening on port ${port}`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);

    logger.error("PayLens bootstrap failed", message);
    process.stderr.write(`PayLens bootstrap failed: ${message}\n`);
    process.exit(1);
  }
};

void bootstrap();
