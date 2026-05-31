// Unified LLM facade.
//   chat()          -> OpenRouter (OPENROUTER_MODEL) for all text work
//   describeImage() -> Gemini (OpenRouter model may have no vision)
// Routing is centralized in models.js (providerForTask). Callers may force a
// provider with opts.provider ("minimax" | "gemini" | "groq").

import { OpenRouterClient } from "./openrouter.js";
import { GeminiClient } from "./gemini.js";
import { GroqClient } from "./groq.js";
import { providerForTask } from "./models.js";

export class LLM {
  constructor(config) {
    this.minimax = new OpenRouterClient(config);
    this.gemini = new GeminiClient(config);
    this.groq = new GroqClient(config);
  }

  async chat(messages, opts = {}) {
    const provider = opts.provider || providerForTask(opts.task);
    if (provider === "gemini") return this.gemini.chat(messages, opts);
    if (provider === "groq") return this.groq.chat(messages, opts);
    return this.minimax.chat(messages, opts);
  }

  // Image recognition — always Gemini.
  describeImage(prompt, image, opts = {}) {
    return this.gemini.describeImage(prompt, image, opts);
  }
}
