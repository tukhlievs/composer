// GROQ chat client. The model is hardcoded here (groq/compound); the
// GROQ_MODEL env var is intentionally ignored. The API key comes from
// GROQ_API. groq/compound is GROQ's agentic compound system. We keep the
// request minimal (it may reject extra params), ask for JSON best-effort, and
// strip any stray <think> block from the output so the JSON tool protocol holds.

import { requestJson } from "../utils/http.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
export const GROQ_MODEL = "groq/compound";

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
    // Ask for JSON best-effort; compound may reject it, so fall back to bare.
    const primary = opts.json ? { ...core, response_format: { type: "json_object" } } : core;

    let data;
    try {
      data = await requestJson(ENDPOINT, { method: "POST", headers, body: primary, timeoutMs: 60000, retries: 2 });
    } catch (err) {
      const status = err && err.status;
      // response_format (or another param) rejected (4xx) — retry bare.
      if (opts.json && status >= 400 && status < 500) {
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
