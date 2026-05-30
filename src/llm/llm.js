// Unified LLM facade. Routes each call to the right provider by task:
//   plan / vision / fast -> Gemini
//   work / report / default -> Minimax (OpenRouter)
// Vision (describeImage) always uses Gemini. Callers can force a provider with
// opts.provider.

import { GeminiClient } from "./gemini.js";
import { OpenRouterClient } from "./openrouter.js";
import { providerForTask } from "./models.js";

export class LLM {
  constructor(config) {
    this.gemini = new GeminiClient(config);
    this.minimax = new OpenRouterClient(config);
  }

  async chat(messages, opts = {}) {
    const provider = opts.provider || providerForTask(opts.task);
    return provider === "gemini" ? this.gemini.chat(messages, opts) : this.minimax.chat(messages, opts);
  }

  // Image recognition — always Gemini.
  describeImage(prompt, image, opts = {}) {
    return this.gemini.describeImage(prompt, image, opts);
  }
}
