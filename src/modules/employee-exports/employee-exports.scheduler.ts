import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import {
  EMPLOYEE_EXPORT_CLEANUP_EVERY_MS,
  EMPLOYEE_EXPORT_CLEANUP_JOB,
  EMPLOYEE_EXPORT_CLEANUP_JOB_ID,
  EMPLOYEE_EXPORT_QUEUE,
} from "./employee-exports.constants.js";

/**
 * Hourly TTL sweeper registration. The repeatable BullMQ job (not a new
 * scheduling framework) expires completed artifacts and stale debris.
 * Registration failure must never prevent API boot.
 */
@Injectable()
export class EmployeeExportsCleanupScheduler {
  private readonly logger = new Logger(EmployeeExportsCleanupScheduler.name);

  constructor(@InjectQueue(EMPLOYEE_EXPORT_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      // Upsert is idempotent across restarts: one hourly sweeper, never two.
      await this.queue.upsertJobScheduler(
        EMPLOYEE_EXPORT_CLEANUP_JOB_ID,
        { every: EMPLOYEE_EXPORT_CLEANUP_EVERY_MS },
        {
          name: EMPLOYEE_EXPORT_CLEANUP_JOB,
          data: {},
          opts: { removeOnComplete: true, removeOnFail: 50 },
        },
      );
    } catch {
      this.logger.warn("employee export cleanup schedule deferred (queue unavailable)");
    }
  }
}
