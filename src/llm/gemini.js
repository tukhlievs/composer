// Google Gemini client (Generative Language API). Used for planning and for
// image recognition (vision). The model is hardcoded in models.js. The API key
// (GEMINI_API) is passed as a query param and never logged.

import { requestJson } from "../utils/http.js";
import { GEMINI_MODELS } from "./models.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Convert OpenAI-style messages to Gemini's format: system messages become a
// single systemInstruction; assistant -> "model", everything else -> "user".
export function toGemini(messages) {
  const sys = [];
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      sys.push(m.content);
      continue;
    }
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] });
  }
  return { systemInstruction: sys.join("\n\n") || null, contents };
}

export class GeminiClient {
  constructor(config) {
    this.apiKey = config.gemini.apiKey;
  }

  async chat(messages, opts = {}) {
    const { systemInstruction, contents } = toGemini(messages);
    const body = {
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 1200,
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
      },
    };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    return this.#generate(body);
  }

  // Image recognition: prompt + inline image bytes (base64).
  async describeImage(prompt, { base64, mimeType = "image/jpeg" }, opts = {}) {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType, data: base64 } }] }],
      generationConfig: { temperature: opts.temperature ?? 0.3, maxOutputTokens: opts.maxTokens ?? 1400 },
    };
    return this.#generate(body);
  }

  async #generate(body) {
    let lastErr;
    for (const model of GEMINI_MODELS) {
      try {
        const data = await requestJson(`${BASE}/${model}:generateContent?key=${this.apiKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          timeoutMs: 60000,
          retries: 2,
        });
        const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
        const text = Array.isArray(parts) ? parts.map((p) => p.text).filter(Boolean).join("") : "";
        if (!text) throw new Error((data && data.error && data.error.message) || "empty Gemini response");
        return text;
      } catch (err) {
        lastErr = err;
        if (this.#modelMissing(err)) continue;
        throw err;
      }
    }
    throw lastErr;
  }

  #modelMissing(err) {
    const status = err && err.status;
    const msg = (err && err.body && err.body.error && err.body.error.message) || "";
    return status === 404 || /not found|not supported|does not exist|unknown model/i.test(msg);
  }
}
