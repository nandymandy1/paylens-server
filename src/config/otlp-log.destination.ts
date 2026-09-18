import { Writable } from "node:stream";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { sanitizeForLog } from "@/common/utils/log-sanitizer.js";
import { emitOtelLog } from "@/common/tracing/telemetry.js";

type PinoRecord = Record<string, unknown>;

type OtlpLogDestinationOptions = {
  emit?: (record: {
    severityNumber: SeverityNumber;
    severityText: string;
    body: string;
    attributes: Record<string, string | number | boolean | string[]>;
    traceId?: string;
    spanId?: string;
  }) => void;
  reportFailure?: () => void;
};

const severityByPinoLevel: Record<number, SeverityNumber> = {
  10: SeverityNumber.TRACE,
  20: SeverityNumber.DEBUG,
  30: SeverityNumber.INFO,
  40: SeverityNumber.WARN,
  50: SeverityNumber.ERROR,
  60: SeverityNumber.FATAL,
};

const levelNameByPinoLevel: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

function otelAttributes(record: PinoRecord): Record<string, string | number | boolean | string[]> {
  const attributes: Record<string, string | number | boolean | string[]> = {};

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes[key] = value;
    } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      attributes[key] = value;
    }
  }

  return attributes;
}

/** Turns Pino's one sanitized event into an asynchronous OTLP copy. */
export class OtlpLogDestination extends Writable {
  private readonly emitRecord: NonNullable<OtlpLogDestinationOptions["emit"]>;
  private readonly reportFailure: NonNullable<OtlpLogDestinationOptions["reportFailure"]>;

  constructor(options: OtlpLogDestinationOptions = {}) {
    super();
    this.emitRecord = options.emit ?? emitOtelLog;
    this.reportFailure = options.reportFailure ?? (() => undefined);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const record = sanitizeForLog(JSON.parse(chunk.toString())) as PinoRecord;
      const level = typeof record.level === "number" ? record.level : 30;
      const traceId = typeof record.traceId === "string" ? record.traceId : undefined;
      const spanId = typeof record.spanId === "string" ? record.spanId : undefined;

      this.emitRecord({
        severityNumber: severityByPinoLevel[level] ?? SeverityNumber.INFO,
        severityText: levelNameByPinoLevel[level] ?? "INFO",
        body: JSON.stringify(record),
        attributes: otelAttributes(record),
        traceId,
        spanId,
      });
    } catch {
      // Never allow a remote telemetry issue to backpressure Pino or HTTP.
      this.reportFailure();
    }

    callback();
  }
}
