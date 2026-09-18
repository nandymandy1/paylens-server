// OTel SDK must be registered before any Nest module import (Prisma, ioredis).
import "./telemetry-bootstrap.js";

import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { createApplication } from "./application.js";

async function bootstrap(): Promise<void> {
  const logger = new Logger("Bootstrap");

  try {
    const app = await createApplication();
    const config = app.get(ConfigService);

    app.enableShutdownHooks();

    const port = config.getOrThrow<number>("app.port");

    await app.listen(port);
    logger.log(`PayLens API listening on port ${port}`);
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);

    logger.error("PayLens bootstrap failed", message);
    // Synchronous fallback: Pino writes asynchronously and process.exit below
    // could otherwise truncate the structured log above. No secrets logged.
    process.stderr.write(`PayLens bootstrap failed: ${message}\n`);
    process.exit(1);
  }
}

void bootstrap();
