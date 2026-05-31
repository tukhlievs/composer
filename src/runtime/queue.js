// "Workers + KV + Queue" runtime for the ReAct loop (issue #3).
//
// Each agent cycle is ONE Worker invocation:
//   producer  (webhook)  -> handle commands inline; for an agent turn, save the
//                           initial run state to KV and enqueue a job
//   consumer  (queue())  -> load state from KV, advance ONE ReAct cycle, save
//                           state back, and re-enqueue until the run finishes.
// This keeps any single request well under the Workers CPU limit and stores the
// "history + current step" in KV between cycles, exactly as the issue sketches.
//
// OPT-IN: Cloudflare Queues require the Workers Paid plan, and this path uses KV
// (not a Durable Object), so reminders are unavailable here. The DEFAULT path
// (Durable Object, see chatAgent.js) runs the same ReAct core in-process with
// full memory + reminders and works on the free plan. Enable this by binding a
// queue named AGENT_QUEUE and a KV namespace COMPOSER_KV in wrangler.toml, then
// routing the webhook through routeQueued() (see the commented block in index.js).

import { loadConfig } from "../config.js";
import { createStore } from "../memory/store.js";
import { LLM } from "../llm/llm.js";
import { Telegram } from "../telegram/client.js";
import { prepareRun } from "../agent/run.js";
import { advanceRun } from "../agent/react.js";
import { handleControl } from "../telegram/router.js";
import { extractMemory } from "../memory/extract.js";
import { toTelegramHtml, chunk } from "../telegram/format.js";
import { log } from "../utils/log.js";

// Shared per-chat services backed by KV (no Durable Object -> no reminders).
function buildBase(env) {
  const config = loadConfig(env);
  return {
    config,
    telegram: new Telegram(config.telegram.token),
    llm: new LLM(config),
    store: createStore(config),
    reminders: null,
  };
}

function emitter(telegram, chatId) {
  return async (out) => {
    const s = String(out || "").trim();
    if (!s) return;
    for (const part of chunk(s)) await telegram.sendMessage(chatId, toTelegramHtml(part));
  };
}

// Producer: deal with commands inline; enqueue the first cycle of an agent turn.
export async function routeQueued(update, env) {
  const base = buildBase(env);
  const ctrl = await handleControl(update, base);
  if (ctrl.handled) return;

  const ctx = { ...base, chatId: ctrl.chatId, emit: emitter(base.telegram, ctrl.chatId) };
  const state = await prepareRun(ctx, ctrl.text);
  await base.store.saveRun(ctrl.chatId, state);
  await base.telegram.sendChatAction(ctrl.chatId, "typing");
  await env.AGENT_QUEUE.send({ chatId: String(ctrl.chatId), userText: ctrl.text });
}

// Consumer: advance each queued run by exactly one cycle.
export async function handleQueueBatch(batch, env) {
  for (const message of batch.messages) {
    try {
      await runOneCycle(env, (message.body || {}).chatId, (message.body || {}).userText);
    } catch (err) {
      log.error("queue cycle failed", err);
    }
    // Ack regardless so a poisoned message never hot-loops.
    message.ack();
  }
}

async function runOneCycle(env, chatId, userText) {
  if (chatId == null) return;
  const base = buildBase(env);
  const ctx = { ...base, chatId, emit: emitter(base.telegram, chatId) };

  const saved = await base.store.getRun(chatId);
  const state = saved && !saved.done ? saved : await prepareRun(ctx, userText || "");

  await advanceRun(state, ctx);

  if (!state.done) {
    // Persist progress and schedule the next cycle.
    await base.store.saveRun(chatId, state);
    await env.AGENT_QUEUE.send({ chatId: String(chatId), userText: state.userText || userText });
    return;
  }

  // Finished: emit a fallback if nothing was shown, persist the exchange, learn.
  const final = (state.final && state.final.trim()) || "Готово.";
  if (!(state.final && state.final.trim())) await ctx.emit(final);
  await base.store.appendHistory(chatId, "user", state.userText || userText || "");
  await base.store.appendHistory(chatId, "assistant", final);
  await base.store.clearRun(chatId).catch(() => {});
  try {
    await extractMemory(ctx, state.userText || userText || "");
  } catch (err) {
    log.warn("queue memory extraction failed", { error: err.message });
  }
}
