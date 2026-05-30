// GROQ model routing. Real GROQ production model slugs are hardcoded here (the
// GROQ_MODEL env var is intentionally ignored). This is the single place to
// edit when GROQ rotates its catalogue.
//
// Models are chosen per task:
//   fast      — cheap/low-latency: memory extraction, query planning, routing
//   general   — reliable instruct + tool-following: the main agent loop
//   reasoning — deeper analysis: deep-research synthesis, hard problems
//
// GROQ decommissions models over time, so every call also has a fallback chain
// of the most stable models (see openrouter-style handling in groq.js).

export const MODELS = {
  fast: "llama-3.1-8b-instant",
  general: "llama-3.3-70b-versatile",
  reasoning: "openai/gpt-oss-120b",
};

// Tried in order when the requested model is unavailable/decommissioned.
// Kept to the two most stable, always-available GROQ models.
export const MODEL_FALLBACKS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

export function modelForTask(task) {
  return MODELS[task] || MODELS.general;
}

// Ordered, de-duplicated list of models to try for a given task/explicit model.
export function modelCandidates({ task, model } = {}) {
  const primary = model || modelForTask(task);
  const chain = [primary, ...MODEL_FALLBACKS];
  return [...new Set(chain)];
}
