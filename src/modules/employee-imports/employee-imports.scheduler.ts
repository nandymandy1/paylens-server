import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import {
  EMPLOYEE_IMPORT_CLEANUP_EVERY_MS,
  EMPLOYEE_IMPORT_CLEANUP_JOB,
  EMPLOYEE_IMPORT_CLEANUP_JOB_ID,
  EMPLOYEE_IMPORT_QUEUE,
} from "./employee-imports.constants.js";

/** Registers the existing BullMQ scheduler pattern; it never blocks API boot. */
@Injectable()
export class EmployeeImportsCleanupScheduler {
  private readonly logger = new Logger(EmployeeImportsCleanupScheduler.name);

  constructor(@InjectQueue(EMPLOYEE_IMPORT_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.upsertJobScheduler(
        EMPLOYEE_IMPORT_CLEANUP_JOB_ID,
        { every: EMPLOYEE_IMPORT_CLEANUP_EVERY_MS },
        {
          name: EMPLOYEE_IMPORT_CLEANUP_JOB,
          data: {},
          opts: { removeOnComplete: true, removeOnFail: 50 },
        },
      );
    } catch {
      this.logger.warn("employee import cleanup schedule deferred (queue unavailable)");
    }
  }
}
