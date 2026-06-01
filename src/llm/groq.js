// GROQ chat client. The model is hardcoded here (qwen/qwen3-32b); the
// GROQ_MODEL env var is intentionally ignored. The API key comes from GROQ_API.
//
// qwen3 is a reasoning model that otherwise emits <think>...</think> traces,
// which would break the JSON tool protocol. We disable reasoning via
// reasoning_effort, ask for JSON best-effort, and strip any stray <think>
// block from the output. Empty content (a common failure with strict JSON mode
// or reasoning truncation) triggers one retry without those constraints before
// we give up.

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
    // First try with JSON mode (if requested). If the model returns empty
    // content — which happens when a model can't honour response_format, or a
    // reasoning model spends its whole budget thinking — retry once plainly.
    let text = await this.#post(messages, opts, !!opts.json);
    if (!text && opts.json) {
      text = await this.#post(messages, opts, false);
    }
    if (!text) throw new Error("empty response");
    return text;
  }

  async #post(messages, opts, useJson) {
    const headers = { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
    const core = {
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1200,
    };
    const primary = { ...core, reasoning_effort: "none" };
    if (useJson) primary.response_format = { type: "json_object" };

    let data;
    try {
      data = await requestJson(ENDPOINT, { method: "POST", headers, body: primary, timeoutMs: 60000, retries: 2 });
    } catch (err) {
      const status = err && err.status;
      // An optional param (reasoning_effort / response_format) was rejected
      // (4xx) — retry with the bare request.
      if (status >= 400 && status < 500) {
        data = await requestJson(ENDPOINT, { method: "POST", headers, body: core, timeoutMs: 60000, retries: 1 });
      } else {
        throw err;
      }
    }

    const choice = data && data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (data && data.error && data.error.message && !content) {
      throw new Error(data.error.message);
    }
    return stripThink(typeof content === "string" ? content : content ? JSON.stringify(content) : "");
  }
}
