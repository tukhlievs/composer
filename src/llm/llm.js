// Unified LLM facade. Text-only now (Gemini removed, so no vision):
//   chat() -> OpenRouter (model hardcoded in openrouter.js)
// GROQ is kept but disabled; force it with opts.provider = "groq" if needed.

import { OpenRouterClient } from "./openrouter.js";
import { GroqClient } from "./groq.js";
import { providerForTask } from "./models.js";

export class LLM {
  constructor(config) {
    this.minimax = new OpenRouterClient(config);
    this.groq = new GroqClient(config);
  }

  async chat(messages, opts = {}) {
    const provider = opts.provider || providerForTask(opts.task);
    return provider === "groq" ? this.groq.chat(messages, opts) : this.minimax.chat(messages, opts);
  }
}
