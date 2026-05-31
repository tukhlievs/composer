// GROQ chat client. The model is hardcoded here (qwen/qwen3-32b); the
// GROQ_MODEL env var is intentionally ignored. GROQ is the text brain
// (planning, agent loop, reports, extraction). It has no vision, so image
// recognition stays on Gemini.
//
// qwen3 is a reasoning model that otherwise emits <think>...</think> traces,
// which would break the JSON tool protocol. We disable reasoning via
// reasoning_effort and also strip any stray <think> block from the output.

import { requestJson } from "../utils/http.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODEL = "qwen/qwen3-32b";

function stripThink(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

export class GroqClient {
  constructor(config) {
    this.apiKey = config.groq.apiKey;
    this.model = GROQ_MODEL;
  }

  async chat(messages, opts = {}) {
    const headers = { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
    const core = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1200,
    };
    // Primary attempt: no reasoning traces + JSON mode when asked.
    const primary = { ...core, reasoning_effort: "none" };
    if (opts.json) primary.response_format = { type: "json_object" };

    let data;
    try {
      data = await requestJson(ENDPOINT, { method: "POST", headers, body: primary, timeoutMs: 60000, retries: 2 });
    } catch (err) {
      const status = err && err.status;
      // Some params may be rejected (4xx) — retry with the bare request.
      if (status >= 400 && status < 500) {
        data = await requestJson(ENDPOINT, { method: "POST", headers, body: core, timeoutMs: 60000, retries: 1 });
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
