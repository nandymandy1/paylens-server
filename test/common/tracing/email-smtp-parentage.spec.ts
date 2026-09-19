import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  SpanKind,
  trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

describe("email SMTP trace parentage", () => {
  it("exports PRODUCER → CONSUMER → SMTP CLIENT using real OTel Context values", () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tracer = provider.getTracer("paylens.email-parentage-test");
    const propagator = new W3CTraceContextPropagator();

    const producer = tracer.startSpan("email.queue.publish", { kind: SpanKind.PRODUCER });
    const producerCtx = trace.setSpan(context.active(), producer);
    const carrier: Record<string, string> = {};

    propagator.inject(producerCtx, carrier, defaultTextMapSetter);
    const extractedContext = propagator.extract(context.active(), carrier, defaultTextMapGetter);
    const consumer = tracer.startSpan(
      "email.queue.process",
      { kind: SpanKind.CONSUMER },
      extractedContext,
    );
    const consumerCtx = trace.setSpan(extractedContext, consumer);
    const smtp = tracer.startSpan("email.smtp.send", { kind: SpanKind.CLIENT }, consumerCtx);

    smtp.end();
    consumer.end();
    producer.end();

    const spans = exporter.getFinishedSpans();
    const byName = new Map(spans.map((span) => [span.name, span]));
    const exportedProducer = byName.get("email.queue.publish");
    const exportedConsumer = byName.get("email.queue.process");
    const exportedSmtp = byName.get("email.smtp.send");

    expect(exportedProducer).toBeDefined();
    expect(exportedConsumer).toBeDefined();
    expect(exportedSmtp).toBeDefined();
    expect(exportedProducer?.kind).toBe(SpanKind.PRODUCER);
    expect(exportedConsumer?.kind).toBe(SpanKind.CONSUMER);
    expect(exportedSmtp?.kind).toBe(SpanKind.CLIENT);
    expect(exportedConsumer?.spanContext().traceId).toBe(exportedProducer?.spanContext().traceId);
    expect(exportedSmtp?.spanContext().traceId).toBe(exportedProducer?.spanContext().traceId);
    expect(exportedConsumer?.parentSpanContext?.spanId).toBe(
      exportedProducer?.spanContext().spanId,
    );
    expect(exportedSmtp?.parentSpanContext?.spanId).toBe(exportedConsumer?.spanContext().spanId);
  });
});
