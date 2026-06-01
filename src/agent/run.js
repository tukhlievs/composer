// Orchestrates a single user turn: assembles context (system prompt + memory +
// history), runs the agent graph, persists the exchange, and returns the final
// reply text.

import { buildAgentGraph } from "./graph.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { toolSpecs } from "./tools.js";

const graph = buildAgentGraph();

export async function runAgent(ctx, userText) {
  const { config, store, chatId } = ctx;

  const [memory, plan, history] = await Promise.all([
    store.getMemory(chatId),
    store.getPlan(chatId),
    store.getHistory(chatId),
  ]);

  const system = buildSystemPrompt({
    config,
    toolSpecs: toolSpecs(),
    memory,
    plan,
  });

  const messages = [
    { role: "system", content: system },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userText },
  ];

  const state = await graph.invoke(
    { messages, steps: 0, maxSteps: config.bot.maxSteps },
    ctx,
    { maxNodeVisits: config.bot.maxSteps * 2 + 4 }
  );

  const finalText = (state.final || "").toString().trim();
  // If progress messages were already sent and there's no extra final text,
  // stay silent instead of tacking on a filler "done".
  const reply = finalText || (state.progressed ? "" : "Готово.");

  // Persist only the clean exchange, not the intermediate tool chatter.
  await store.appendHistory(chatId, "user", userText);
  if (reply) await store.appendHistory(chatId, "assistant", reply);

  return reply;
}
