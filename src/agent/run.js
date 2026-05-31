// Orchestrates a single user turn: assembles context (system prompt + memory +
// history), runs the ReAct loop (which streams each step's message to the user
// via ctx.emit), persists the clean exchange, and returns the final reply text.
//
// prepareRun() is shared with the Queue runtime (runtime/queue.js), which drives
// the same state one cycle per Worker request instead of looping in-process.

import { runReact } from "./react.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { toolSpecs } from "./tools.js";

// Build the initial ReAct state for a turn: system prompt + recent history +
// the new user message. Plain serialisable data so it can live in KV.
export async function prepareRun(ctx, userText) {
  const { config, store, chatId } = ctx;

  const [memory, plan, history] = await Promise.all([
    store.getMemory(chatId),
    store.getPlan(chatId),
    store.getHistory(chatId),
  ]);

  const system = buildSystemPrompt({ config, toolSpecs: toolSpecs(), memory, plan });

  const messages = [
    { role: "system", content: system },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userText },
  ];

  return { messages, steps: 0, maxSteps: config.bot.maxSteps, userText, done: false, final: "" };
}

export async function runAgent(ctx, userText) {
  const { store, chatId } = ctx;

  const state = await prepareRun(ctx, userText);

  // Checkpoint the live run so "history + current step" survives across cycles
  // (KV on Workers, in-memory in polling). Best-effort; never breaks the turn.
  ctx.checkpoint = async (s) => {
    try {
      if (store.saveRun) await store.saveRun(chatId, s);
    } catch {
      /* ignore checkpoint failures */
    }
  };

  await runReact(state, ctx);

  const final = (state.final && state.final.trim()) || "Готово.";
  // Safety net: if the loop produced nothing to show, still send the fallback.
  if (!(state.final && state.final.trim()) && ctx.emit) await ctx.emit(final);

  // Persist only the clean exchange, not the intermediate tool chatter.
  await store.appendHistory(chatId, "user", userText);
  await store.appendHistory(chatId, "assistant", final);
  if (store.clearRun) await store.clearRun(chatId).catch(() => {});

  return final;
}
