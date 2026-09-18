import { getErrorMetadata as errorMetadata } from "@/common/utils/error.js";
import { ExecutionTraceService } from "./execution-trace.service.js";

type TraceableInstance = {
  executionTrace?: ExecutionTraceService;
  constructor: {
    name: string;
  };
};

export const TraceMethod = (): MethodDecorator => {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    const originalMethod = descriptor.value as (...args: never[]) => unknown;
    const method = String(propertyKey);
    const service = target.constructor.name;

    descriptor.value = async function (this: TraceableInstance, ...args: never[]) {
      if (!this.executionTrace || typeof this.executionTrace.withinSpan !== "function") {
        return originalMethod.apply(this, args);
      }

      const executionTrace = this.executionTrace;
      const startedAt = executionTrace.now();

      return executionTrace.withinSpan(
        `service.${service}.${method}`,
        { service, method },
        async () => {
          executionTrace.debug({
            event: "service.started",
            service,
            serviceClass: service,
            method,
          });

          try {
            const result = await originalMethod.apply(this, args);

            executionTrace.debug({
              event: "service.completed",
              service,
              serviceClass: service,
              method,
              durationMs: executionTrace.durationSince(startedAt),
            });

            return result;
          } catch (error) {
            executionTrace.error({
              event: "service.failed",
              service,
              serviceClass: service,
              method,
              durationMs: executionTrace.durationSince(startedAt),
              error: errorMetadata(error),
            });
            throw error;
          }
        },
      );
    };
  };
};

/** Applies the canonical business-span boundary only to named public methods. */
export const TraceBusinessService = (methods: readonly string[]): ClassDecorator => {
  return (target) => {
    for (const method of methods) {
      const descriptor = Object.getOwnPropertyDescriptor(target.prototype, method);

      if (!descriptor || typeof descriptor.value !== "function") continue;

      TraceMethod()(target.prototype, method, descriptor);

      // Reinstall the modified descriptor so Nest picks up the wrapped method.
      Object.defineProperty(target.prototype, method, descriptor);
    }
  };
};
