// Single provider: ALL tasks run on GROQ (model hardcoded as "qwen/qwen3-32b"
// in src/llm/groq.js; GROQ_MODEL env is ignored, key from GROQ_API). Gemini is
// removed (no image recognition); OpenRouter is kept in code but unused. To
// switch the text provider, change the return value here ("groq", "minimax").
export function providerForTask() {
  return "groq";
}
