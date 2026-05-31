// OpenRouter client used for Minimax (the "hands": agent loop, coding, reports).
// Reads the key from OPENROUTER_API and the model slug from OPENROUTER_MODEL.
// OpenAI-compatible chat completions; the model id is never logged or returned.

import { requestJson } from "../utils/http.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// Hardcoded model; the OPENROUTER_MODEL env var is intentionally ignored.
export const OPENROUTER_MODEL = "openrouter/free";

// Some OpenRouter models (deepseek-r1, qwen, etc.) emit <think>...</think>
// reasoning traces that would break the JSON tool protocol — strip them.
function stripThink(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export class OpenRouterClient {
  constructor(config) {
    this.apiKey = config.openrouter.apiKey;
    this.model = OPENROUTER_MODEL; // hardcoded; env OPENROUTER_MODEL ignored
    this.appUrl = config.openrouter.appUrl;
    this.appTitle = config.openrouter.appTitle;
  }

  async chat(messages, opts = {}) {
    const base = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1200,
    };
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": this.appUrl,
      "X-Title": this.appTitle,
    };

    let data;
    try {
      const payload = opts.json ? { ...base, response_format: { type: "json_object" } } : base;
      data = await requestJson(ENDPOINT, { method: "POST", headers, body: payload, timeoutMs: 60000, retries: 2 });
    } catch (err) {
      const status = err && err.status;
      if (opts.json && status >= 400 && status < 500) {
        data = await requestJson(ENDPOINT, { method: "POST", headers, body: base, timeoutMs: 60000, retries: 1 });
      } else {
        throw err;
      }
    }

    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) throw new Error((data && data.error && data.error.message) || "empty response");
    return stripThink(typeof content === "string" ? content : JSON.stringify(content));
  }
}
