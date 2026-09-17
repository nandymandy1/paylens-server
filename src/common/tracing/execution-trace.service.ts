import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PinoLogger } from "nestjs-pino";
import { requestContext } from "@/common/context/request-context.js";

type TraceEvent = Record<string, unknown> & { event: string };

@Injectable()
export class ExecutionTraceService {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: PinoLogger,
  ) {}

  get requestId(): string | undefined {
    return requestContext.getStore()?.requestId;
  }

  now(): number {
    return performance.now();
  }

  durationSince(startedAt: number): number {
    return Number((performance.now() - startedAt).toFixed(2));
  }

  debug(event: TraceEvent): void {
    if (!this.config.getOrThrow<boolean>("app.executionTraceEnabled")) {
      return;
    }

    this.logger.debug(this.withRequestId(event));
  }

  info(event: TraceEvent): void {
    this.logger.info(this.withRequestId(event));
  }

  warn(event: TraceEvent): void {
    this.logger.warn(this.withRequestId(event));
  }

  private withRequestId(event: TraceEvent): TraceEvent {
    return {
      ...event,
      requestId: event.requestId ?? this.requestId,
    };
  }
}
