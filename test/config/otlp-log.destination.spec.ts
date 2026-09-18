import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import request from "supertest";
import { OtlpLogDestination } from "@/config/otlp-log.destination.js";
import { sanitizeForLog } from "@/common/utils/log-sanitizer.js";

describe("Pino OTLP fan-out", () => {
  it("copies the same sanitized correlation fields to stdout and OTLP", () => {
    const stdout: string[] = [];
    const emit = vi.fn();
    const consoleDestination = new Writable({
      write(chunk, _encoding, callback) {
        stdout.push(chunk.toString());
        callback();
      },
    });
    const logger = pino(
      {
        base: { service: "paylens-server" },
        formatters: {
          log: (event: Record<string, unknown>) => sanitizeForLog(event) as Record<string, unknown>,
        },
      },
      pino.multistream([consoleDestination, new OtlpLogDestination({ emit })]),
    );

    logger.info({
      event: "employee.list.complete",
      requestId: "req-1",
      traceId: "trace-1",
      spanId: "span-1",
      durationMs: 18.42,
      password: "private",
    });

    expect(stdout[0]).toContain('"requestId":"req-1"');
    expect(stdout[0]).toContain('"traceId":"trace-1"');
    expect(stdout[0]).toContain('"spanId":"span-1"');
    expect(stdout[0]).toContain('"password":"***"');
    expect(stdout[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(stdout[0])).toMatchObject({
      event: "employee.list.complete",
      requestId: "req-1",
      traceId: "trace-1",
      spanId: "span-1",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          service: "paylens-server",
          requestId: "req-1",
          traceId: "trace-1",
          spanId: "span-1",
          durationMs: 18.42,
          password: "***",
        }),
      }),
    );
  });

  it("keeps stdout and an HTTP response alive when the OTLP exporter is unavailable", async () => {
    const stdout: string[] = [];
    const diagnostic = vi.fn();
    const consoleDestination = new Writable({
      write(chunk, _encoding, callback) {
        stdout.push(chunk.toString());
        callback();
      },
    });
    const unavailableOtlp = new OtlpLogDestination({
      emit: () => {
        throw new Error("OTLP endpoint unavailable");
      },
      reportFailure: diagnostic,
    });
    const destination = pino.multistream([consoleDestination, unavailableOtlp]);
    const app = express();

    app.use(
      pinoHttp(
        {
          autoLogging: false,
          formatters: {
            log: (event: Record<string, unknown>) =>
              sanitizeForLog(event) as Record<string, unknown>,
          },
        },
        destination,
      ),
    );
    app.get("/health", (req, res) => {
      req.log.info({ event: "hello", requestId: "req-1", password: "private" }, "hello");
      res.status(200).json({ ok: true });
    });

    const response = await request(app).get("/health");

    expect(response).toMatchObject({ statusCode: 200, body: { ok: true } });
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain('"event":"hello"');
    expect(stdout[0]).toContain('"password":"***"');
    expect(stdout[0]).not.toContain("private");
    expect(diagnostic).toHaveBeenCalledOnce();
  });
});
