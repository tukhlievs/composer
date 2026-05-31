// Unified LLM facade.
//   chat()         -> GROQ (qwen/qwen3-32b) for all text work
//   describeImage() -> Gemini (GROQ has no vision)
// Routing is centralized in models.js (providerForTask). Callers may force a
// provider with opts.provider.

import { GroqClient } from "./groq.js";
import { GeminiClient } from "./gemini.js";
import { providerForTask } from "./models.js";

export class LLM {
  constructor(config) {
    this.groq = new GroqClient(config);
    this.gemini = new GeminiClient(config);
  }

  async chat(messages, opts = {}) {
    const provider = opts.provider || providerForTask(opts.task);
    return provider === "gemini" ? this.gemini.chat(messages, opts) : this.groq.chat(messages, opts);
  }

  // Image recognition — always Gemini.
  describeImage(prompt, image, opts = {}) {
    return this.gemini.describeImage(prompt, image, opts);
  }
}
