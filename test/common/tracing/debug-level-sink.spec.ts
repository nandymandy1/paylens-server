import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";

class CollectStream extends Writable {
  events: object[] = [];
  _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error) => void) {
    this.events.push(JSON.parse(chunk.toString()));
    cb();
  }
}

/**
 * Regression: Pino multistream previously used the default stream level (info),
 * silently dropping DEBUG events even when LOG_LEVEL=debug. Streams must now
 * explicitly inherit the configured level.
 */
describe("Pino multistream debug-level sink", () => {
  it("emits level=20 (DEBUG) events to stdout when level is debug", async () => {
    const collector = new CollectStream();

    // Multistream with explicit level: "debug" — mirrors the fixed logger.config.ts
    const logger = pino(
      { level: "debug" },
      pino.multistream([{ level: "debug", stream: collector }]),
    );

    logger.debug({ event: "test.debug.event", value: 42 });
    logger.info({ event: "test.info.event" });

    // Give async streams a tick to flush
    await new Promise((r) => setTimeout(r, 50));

    const debugEvents = collector.events.filter((e) => (e as { level?: number }).level === 20);
    const infoEvents = collector.events.filter((e) => (e as { level?: number }).level === 30);

    expect(debugEvents.length).toBeGreaterThanOrEqual(1);
    expect(infoEvents.length).toBeGreaterThanOrEqual(1);
    expect(debugEvents[0]).toMatchObject({ event: "test.debug.event", value: 42 });
  });

  it("drops DEBUG when multistream level defaults to info", async () => {
    const collector = new CollectStream();

    // Default level (no explicit level) — the old broken behavior
    const logger = pino({ level: "info" }, pino.multistream([{ stream: collector }]));

    logger.debug({ event: "should.be.dropped" });
    logger.info({ event: "should.appear" });

    await new Promise((r) => setTimeout(r, 50));

    const debugEvents = collector.events.filter((e) => (e as { level?: number }).level === 20);

    expect(debugEvents).toHaveLength(0);
  });
});
