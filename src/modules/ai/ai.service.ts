import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios from "axios";
import { AI_JSON_TIMEOUT_MS, OPENAI_CHAT_COMPLETIONS_URL } from "./ai.constants.js";
// eslint-disable-next-line no-restricted-imports
import type { AiJsonPrompt } from "./types/ai.types.js";

/**
 * Standalone AI boundary. All OpenAI traffic goes through this service —
 * feature modules never call the provider inline. Transport is axios-only
 * (no fetch), responses are validated by caller-supplied parsers, and every
 * failure is fail-closed to null so deterministic behavior still applies.
 * Callers own data minimization: only explicitly passed prompt content leaves
 * this process.
 */
@Injectable()
export class AiService {
  constructor(private readonly config: ConfigService) {}

  get isConfigured(): boolean {
    return Boolean(this.config.get<string>("app.openaiApiKey"));
  }

  async completeJson<T>(
    prompt: AiJsonPrompt,
    parse: (raw: unknown) => T | null,
  ): Promise<T | null> {
    const apiKey = this.config.get<string>("app.openaiApiKey") ?? "";

    if (!apiKey) return null;

    try {
      const { data } = await axios.post(
        OPENAI_CHAT_COMPLETIONS_URL,
        {
          model: prompt.model ?? this.config.get<string>("app.openaiModel") ?? "gpt-4o-mini",
          temperature: 0,
          // Import assistance is intentionally ephemeral. No employee rows are
          // ever passed to this boundary, and OpenAI must not retain prompts.
          store: false,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: prompt.system,
            },
            {
              role: "user",
              content: JSON.stringify(prompt.user),
            },
          ],
        },
        {
          timeout: AI_JSON_TIMEOUT_MS,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
        },
      );

      const content = data?.choices?.[0]?.message?.content;

      if (typeof content !== "string" || !content.trim()) return null;

      return parse(JSON.parse(content));
    } catch {
      return null;
    }
  }
}
