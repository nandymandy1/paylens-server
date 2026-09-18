import { getErrorMetadata as errorMetadata } from "@/common/utils/error.js";
import { ExecutionTraceService } from "./execution-trace.service.js";

type TraceableInstance = {
  executionTrace: ExecutionTraceService;
  constructor: {
    name: string;
  };
};

export function TraceMethod(): MethodDecorator {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value as (...args: never[]) => unknown;
    const method = String(propertyKey);
    const service = target.constructor.name;

    descriptor.value = async function (this: TraceableInstance, ...args: never[]) {
      const startedAt = this.executionTrace.now();

      this.executionTrace.debug({ event: "service.start", service, method });

      try {
        const result = await originalMethod.apply(this, args);

        this.executionTrace.debug({
          event: "service.complete",
          service,
          method,
          durationMs: this.executionTrace.durationSince(startedAt),
        });

        return result;
      } catch (error) {
        this.executionTrace.debug({
          event: "service.error",
          service,
          method,
          durationMs: this.executionTrace.durationSince(startedAt),
          error: errorMetadata(error),
        });

        throw error;
      }
    };
  };
}
