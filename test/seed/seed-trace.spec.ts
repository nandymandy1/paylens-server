import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterEach, describe, expect, it } from "vitest";
import { withBatchSpan } from "@/seed/runner.js";

describe("SEED-R1 batch active span", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  provider.register();

  afterEach(() => {
    exporter.reset();
  });

  it("runs the batch operation with the batch span as active parent", async () => {
    const tracer = trace.getTracer("seed-batch-test");
    const phaseSpan = tracer.startSpan("seed.r1.test-phase");
    let activeInside: string | undefined;

    await context.with(trace.setSpan(context.active(), phaseSpan), () =>
      withBatchSpan("test-phase", 0, 500, async () => {
        activeInside = trace.getSpan(context.active())?.spanContext().spanId;
      }),
    );
    phaseSpan.end();

    const spans = exporter.getFinishedSpans();
    const batchSpan = spans.find((span) => span.name === "seed.r1.test-phase.batch")!;

    expect(batchSpan).toBeDefined();
    // The operation observed the batch span as its active parent (not the phase).
    expect(activeInside).toBe(batchSpan.spanContext().spanId);
    // The batch span itself is nested under the phase span.
    expect(batchSpan.parentSpanContext?.spanId).toBe(phaseSpan.spanContext().spanId);
    // Cardinality-safe attributes only: no employee PII.
    expect(batchSpan.attributes["seed.phase"]).toBe("test-phase");
    expect(batchSpan.attributes["seed.batch.index"]).toBe(0);
    expect(batchSpan.attributes["seed.batch.rows"]).toBe(500);
    expect(Object.keys(batchSpan.attributes).join(",")).not.toMatch(/email|name|salary/i);
  });

  it("records exceptions with ERROR status", async () => {
    await expect(
      withBatchSpan("test-phase", 1, 10, async () => {
        throw new Error("batch boom");
      }),
    ).rejects.toThrow(/batch boom/);

    const spans = exporter.getFinishedSpans();
    const failed = spans.find((span) => span.attributes["seed.batch.index"] === 1)!;

    expect(failed.status.code).toBe(2);
    expect(failed.events.length).toBeGreaterThan(0);
  });
});
