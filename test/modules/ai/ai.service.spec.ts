import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { AiService } from "@/modules/ai/ai.service.js";

vi.mock("axios");

const post = vi.mocked(axios.post);

const configWith = (key: string) => ({
  get: vi.fn((name: string) => (name === "app.openaiApiKey" ? key : "gpt-4o-mini")),
});

describe("AiService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null without a key and never calls the provider", async () => {
    const service = new AiService(configWith("") as never);

    expect(service.isConfigured).toBe(false);
    expect(await service.completeJson({ system: "s", user: {} }, (raw) => raw)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("posts JSON via axios and returns the parsed answer", async () => {
    const service = new AiService(configWith("sk-test") as never);

    post.mockResolvedValueOnce({
      data: {
        choices: [
          { message: { content: JSON.stringify({ mapping: { "Emp No": "Employee Number" } }) } },
        ],
      },
    });

    const result = await service.completeJson(
      { system: "map", user: { headers: ["Emp No"] } },
      (raw) => (raw as { mapping: Record<string, string> }).mapping,
    );

    expect(result).toEqual({ "Emp No": "Employee Number" });
    expect(post).toHaveBeenCalledTimes(1);

    const [url, body, options] = post.mock.calls[0] as [
      string,
      Record<string, unknown>,
      { timeout: number; headers: Record<string, string> },
    ];

    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(options.timeout).toBe(15_000);
    expect(options.headers.authorization).toBe("Bearer sk-test");
    expect(JSON.stringify(body)).toContain("Emp No");
    expect(body.temperature).toBe(0);
    expect(body.store).toBe(false);
  });

  it("fail-closes when Chat Completions content is malformed", async () => {
    const service = new AiService(configWith("sk-test") as never);

    post.mockResolvedValueOnce({ data: { choices: [{ message: { content: "not-json" } }] } });

    await expect(service.completeJson({ system: "s", user: {} }, (raw) => raw)).resolves.toBeNull();
  });

  it("fail-closes to null when the provider throws", async () => {
    const service = new AiService(configWith("sk-test") as never);

    post.mockRejectedValueOnce(new Error("network down"));

    await expect(service.completeJson({ system: "s", user: {} }, (raw) => raw)).resolves.toBeNull();
  });
});
