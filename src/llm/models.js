// Two-provider model routing. GROQ is temporarily removed.
//
//   Gemini  -> planning, vision (image recognition), quick structured parsing
//   Minimax (via OpenRouter) -> the "hands": main agent loop, coding, reports
//
// The Gemini model is hardcoded here ON PURPOSE — there is no GEMINI_MODEL env
// var. The Minimax model comes from OPENROUTER_MODEL in .env.
//
// To flip a task between providers (the "иногда наоборот" case), just move its
// task name in/out of GEMINI_TASKS below.

// Tried in order; falls through on "model not found" so a renamed model can't
// break the bot.
export const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"];

// Current setup: ALL text tasks run on GROQ (qwen/qwen3-32b, hardcoded in
// groq.js). Gemini is used ONLY for image recognition (describeImage), since
// GROQ has no vision. Minimax/OpenRouter is off. To change the text model,
// edit GROQ_MODEL in src/llm/groq.js.
export function providerForTask() {
  return "groq";
}
