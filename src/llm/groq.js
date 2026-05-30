// GROQ chat client (OpenAI-compatible API). The model id comes from config
// (env GROQ_MODEL) and is never returned to callers or logged, so the bot stays
// model-agnostic and the underlying model remains secret.

import { requestJson } from "../utils/http.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export class LLM {
  constructor(config) {
    this.cfg = config.groq;
  }

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @param {{temperature?:number, maxTokens?:number, json?:boolean}} opts
   * @returns {Promise<string>} assistant text
   */
  async chat(messages, opts = {}) {
    const base = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1200,
    };
    const headers = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "Content-Type": "application/json",
    };

    // Ask for JSON when the caller drives a structured protocol. Some models
    // reject response_format with a 4xx, so we degrade gracefully: try with it,
    // and on a client error retry once without it. The agent loop parses
    // leniently either way.
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
    if (!content) {
      const reason = data && data.error ? data.error.message : "empty response";
      throw new Error(`LLM error: ${reason}`);
    }
    return typeof content === "string" ? content : JSON.stringify(content);
  }
}
