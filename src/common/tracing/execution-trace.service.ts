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

  get authUserId(): string | undefined {
    return requestContext.getStore()?.authUserId;
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

    this.logger.debug(this.withContext(event));
  }

  info(event: TraceEvent): void {
    this.logger.info(this.withContext(event));
  }

  warn(event: TraceEvent): void {
    this.logger.warn(this.withContext(event));
  }

  error(event: TraceEvent): void {
    this.logger.error(this.withContext(event));
  }

  private withContext(event: TraceEvent): TraceEvent {
    const authUserId = event.authUserId ?? this.authUserId;

    return {
      ...event,
      requestId: event.requestId ?? this.requestId,
      ...(authUserId === undefined ? {} : { authUserId }),
    };
  }
}
