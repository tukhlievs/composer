// ReAct loop (Reason -> Act), without LangGraph.
//
// On every cycle the model returns ONE structured step:
//   { "thought": "...", "action": "<tool>|respond|finish", "message": "...", "args": {...} }
// We render `message` to the user (a progress note for a tool step, or the
// final answer for respond/finish), then — if it is a tool — execute it and
// feed the OBSERVATION back. The run state (messages + step counter) is plain
// data, so it can live in KV and a single cycle can run per Worker request
// (see runtime/queue.js) or the whole loop can run in-process (Durable Object
// and Node polling) via runReact().

import { runTool } from "./tools.js";

const FINAL_ACTIONS = new Set(["respond", "finish", "final", "answer", "done", "reply"]);

// respond / finish / empty action all mean "this message is the final answer".
export function isFinalAction(action) {
  return !action || FINAL_ACTIONS.has(String(action).toLowerCase());
}

// Parse one structured step from raw model output. Tolerant: strips ``` fences,
// scans for the first balanced JSON object (quote-aware so braces inside strings
// don't fool it), and accepts a few legacy field aliases so a slightly-off model
// never dead-ends. Anything non-JSON is treated as a plain final answer.
export function extractStep(text) {
  if (text == null) return { action: "respond", message: "", args: {} };
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  const obj = firstJsonObject(t);
  if (obj && typeof obj === "object") {
    const action = obj.action ?? obj.tool ?? (obj.final !== undefined ? "respond" : "");
    const message = obj.message ?? obj.final ?? obj.text ?? obj.response ?? "";
    const args = obj.args ?? obj.arguments ?? obj.input ?? obj.parameters ?? {};
    const thought = obj.thought ?? obj.reasoning ?? "";
    return {
      thought: String(thought || ""),
      action: String(action || "").trim(),
      message: message == null ? "" : String(message),
      args: args && typeof args === "object" ? args : {},
    };
  }
  // No JSON protocol at all — treat the whole reply as the answer.
  return { action: "respond", message: t, args: {} };
}

// Return the first balanced {...} object as parsed JSON, or null. String-aware
// so braces/quotes inside values are handled correctly.
function firstJsonObject(t) {
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(t.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const FORCE_FINISH =
  'You have reached the tool-step limit. Reply NOW with a final step ' +
  '{"action":"respond","message":"<your answer>"} using only what you already have. Do not call any more tools.';

// Advance the run by exactly ONE cycle. Mutates and returns `state`. When the
// model gives a final answer, sets state.done and state.final.
export async function reactStep(state, ctx) {
  const raw = await ctx.llm.chat(state.messages, { task: "work", temperature: 0.4, maxTokens: 3200, json: true });
  state.messages.push({ role: "assistant", content: raw });

  const step = extractStep(raw);
  const message = (step.message || "").trim();

  if (isFinalAction(step.action)) {
    if (message && ctx.emit) await ctx.emit(message);
    state.final = message;
    state.done = true;
    return state;
  }

  // Tool step: narrate the human message first (the issue's flow), then act.
  if (message && ctx.emit) await ctx.emit(message);
  const observation = await runTool(step.action, step.args || {}, ctx);
  state.messages.push({ role: "user", content: `OBSERVATION (${step.action}):\n${truncate(observation, 4000)}` });
  state.steps = (state.steps || 0) + 1;
  return state;
}

// Budget spent: ask the model for one last plain answer, no more tools.
async function forceFinal(state, ctx) {
  state.messages.push({ role: "user", content: FORCE_FINISH });
  const raw = await ctx.llm.chat(state.messages, { task: "work", temperature: 0.3, maxTokens: 2000, json: true });
  state.messages.push({ role: "assistant", content: raw });
  const message = (extractStep(raw).message || "").trim();
  if (message && ctx.emit) await ctx.emit(message);
  state.final = message;
  state.done = true;
  return state;
}

// One step for the Queue-driven runtime: advance by a single cycle, or force the
// final answer if the step budget is already spent. Returns state (state.done
// flags completion).
export async function advanceRun(state, ctx) {
  if (state.done) return state;
  if ((state.steps || 0) >= (state.maxSteps || 6)) return forceFinal(state, ctx);
  return reactStep(state, ctx);
}

// In-process driver (Durable Object + Node polling): loop cycles until the run
// finishes or the visit cap is hit. Checkpoints state after each cycle so the
// "history + current step" persists (KV / DO storage) and is visible mid-run.
export async function runReact(state, ctx) {
  const maxVisits = (state.maxSteps || 6) * 2 + 4;
  let visits = 0;
  while (!state.done && visits < maxVisits) {
    visits++;
    if ((state.steps || 0) >= (state.maxSteps || 6)) {
      await forceFinal(state, ctx);
      break;
    }
    await reactStep(state, ctx);
    if (ctx.checkpoint) await ctx.checkpoint(state);
  }
  if (!state.done) await forceFinal(state, ctx);
  return state;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}
