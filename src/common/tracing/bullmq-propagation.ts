/**
 * BullMQ trace context propagation — injects/extracts W3C trace context
 * through job metadata so producer and consumer spans share the same trace.
 *
 * Producer: propagation.inject() → job data.__traceContext
 * Consumer: propagation.extract() → activated context → CONSUMER span
 */

import { context, propagation, trace } from "@opentelemetry/api";

const TRACE_CONTEXT_KEY = "__traceContext";

export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/**
 * Inject the current active trace context into a carrier object.
 * The carrier is attached to the BullMQ job data under a reserved key.
 */
export function injectTraceContext(target: Record<string, unknown>): void {
  const carrier: TraceCarrier = {};

  propagation.inject(context.active(), carrier);

  // Only attach if there's a valid traceparent (i.e., we're in a trace)
  if (carrier.traceparent) {
    target[TRACE_CONTEXT_KEY] = carrier;
  }
}

/**
 * Extract trace context from a carrier object and return the extracted context.
 * If no valid context exists, returns the current active context.
 */
export function extractTraceContext(
  carrier: Record<string, unknown> | undefined,
): import("@opentelemetry/api").Context {
  if (!carrier || typeof carrier[TRACE_CONTEXT_KEY] !== "object") {
    return context.active();
  }

  const traceCarrier = carrier[TRACE_CONTEXT_KEY] as TraceCarrier;

  if (!traceCarrier.traceparent) {
    return context.active();
  }

  return propagation.extract(context.active(), traceCarrier);
}

/**
 * Get the traceId from the carrier's trace context, if valid.
 * Returns undefined when no valid trace context exists.
 */
export function getTraceIdFromCarrier(
  carrier: Record<string, unknown> | undefined,
): string | undefined {
  const ctx = extractTraceContext(carrier);
  const span = trace.getSpan(ctx);
  const spanContext = span?.spanContext();

  if (!spanContext) return undefined;

  // Validate: must be 32 hex chars, not all-zero
  if (!/^[0-9a-fA-F]{32}$/.test(spanContext.traceId)) return undefined;
  if (/^0{32}$/.test(spanContext.traceId)) return undefined;

  return spanContext.traceId;
}
