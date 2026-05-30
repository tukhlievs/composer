// GROQ chat client (OpenAI-compatible API).
//
// The model is chosen per call via a task ("fast" | "general" | "reasoning")
// or an explicit model id, resolved through src/llm/models.js. The GROQ_MODEL
// env var is deliberately ignored. The underlying model is never returned to
// callers or logged, so the bot stays model-agnostic and keeps it secret.

import { requestJson } from "../utils/http.js";
import { modelCandidates } from "./models.js";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export class LLM {
  constructor(config) {
    this.apiKey = config.groq.apiKey;
  }

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @param {{task?:string, model?:string, temperature?:number, maxTokens?:number, json?:boolean}} opts
   * @returns {Promise<string>} assistant text
   */
  async chat(messages, opts = {}) {
    const candidates = modelCandidates({ task: opts.task, model: opts.model });
    let lastErr;
    for (const model of candidates) {
      try {
        return await this.#callOnce(model, messages, opts);
      } catch (err) {
        lastErr = err;
        // If the model itself is gone, try the next candidate; otherwise fail.
        if (this.#isModelUnavailable(err)) continue;
        throw err;
      }
    }
    throw lastErr;
  }

  async #callOnce(model, messages, opts) {
    const base = {
      model,
      messages,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1200,
    };
    const headers = { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };

    // JSON mode is best-effort: some models reject response_format with a 4xx,
    // so retry once without it. The agent loop parses leniently regardless.
    let data;
    try {
      const payload = opts.json ? { ...base, response_format: { type: "json_object" } } : base;
      data = await requestJson(ENDPOINT, { method: "POST", headers, body: payload, timeoutMs: 60000, retries: 2 });
    } catch (err) {
      if (opts.json && this.#isJsonModeError(err)) {
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

  #isModelUnavailable(err) {
    const status = err && err.status;
    const body = (err && err.body) || {};
    const code = body.error && body.error.code;
    const msg = (body.error && body.error.message) || "";
    if (code === "model_decommissioned" || code === "model_not_found") return true;
    if ((status === 404 || status === 400) && /decommission|not.?found|does not exist|no longer/i.test(msg)) return true;
    return false;
  }

  #isJsonModeError(err) {
    const status = err && err.status;
    // Don't swallow model-unavailability here — only genuine 4xx for the param.
    return status >= 400 && status < 500 && !this.#isModelUnavailable(err);
  }
}
