// Single provider: ALL tasks run on OpenRouter (model hardcoded as
// "openrouter/free" in src/llm/openrouter.js; OPENROUTER_MODEL env is ignored).
// Gemini has been removed, so there is no image recognition. GROQ is kept in
// code but disabled. To switch the text provider, change the return value here
// ("minimax" = OpenRouter, "groq").
export function providerForTask() {
  return "minimax";
}
