// A small, dependency-free state-graph engine in the spirit of LangGraph's
// StateGraph: named nodes, plain edges, and conditional edges. We run the
// agent as a graph of two nodes — "agent" (think / decide) and "tools" (act) —
// looping until the agent emits a final answer or the step budget is spent.
//
// Why not @langchain/langgraph directly: the bot targets free OpenRouter models
// that don't reliably support OpenAI-style function calling. So tool-calling is
// done with a model-agnostic JSON protocol parsed here, which works on any
// model and keeps the Workers bundle tiny. The graph shape mirrors LangGraph so
// it can be swapped later if you move to a function-calling model.

import { runTool } from "./tools.js";
import { toTelegramHtml } from "../telegram/format.js";

export const END = "__end__";

export class StateGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.conditionals = new Map();
    this.entry = null;
  }
  addNode(name, fn) {
    this.nodes.set(name, fn);
    return this;
  }
  addEdge(from, to) {
    this.edges.set(from, to);
    return this;
  }
  addConditionalEdges(from, router) {
    this.conditionals.set(from, router);
    return this;
  }
  setEntryPoint(name) {
    this.entry = name;
    return this;
  }
  compile() {
    if (!this.entry) throw new Error("Graph has no entry point");
    return new CompiledGraph(this);
  }
}

class CompiledGraph {
  constructor(graph) {
    this.graph = graph;
  }
  async invoke(state, ctx, { maxNodeVisits = 24 } = {}) {
    let current = this.graph.entry;
    let visits = 0;
    while (current !== END && visits < maxNodeVisits) {
      visits++;
      const fn = this.graph.nodes.get(current);
      if (!fn) throw new Error(`Unknown node "${current}"`);
      state = (await fn(state, ctx)) || state;

      if (this.graph.conditionals.has(current)) {
        current = this.graph.conditionals.get(current)(state);
      } else if (this.graph.edges.has(current)) {
        current = this.graph.edges.get(current);
      } else {
        current = END;
      }
    }
    return state;
  }
}

// ---- JSON action parsing ----------------------------------------------------
// Normalises the step protocol { thought, action, message, args } (and the
// older { thought, tool, args, final } shape) into one of:
//   { tool, args, message }   -> run a tool, after showing `message`
//   { final, message }        -> final answer (text in `message`/`final`)
const FINAL_ACTIONS = new Set(["respond", "finish", "answer", "reply", "none", ""]);

export function extractAction(text) {
  if (!text) return { final: "" };
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  const start = t.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === "{") depth++;
      else if (t[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(t.slice(start, i + 1));
            const norm = normalizeAction(obj);
            if (norm) return norm;
          } catch {
            /* fall through to prose fallback */
          }
          break;
        }
      }
    }
  }
  // Not valid JSON / no protocol fields: treat the whole thing as a final reply.
  return { final: text.trim() };
}

function normalizeAction(obj) {
  if (!obj || typeof obj !== "object") return null;
  const message = typeof obj.message === "string" ? obj.message : undefined;

  // New protocol: { action, message, args }
  if (typeof obj.action === "string") {
    const action = obj.action.trim();
    if (FINAL_ACTIONS.has(action.toLowerCase())) {
      return { final: message != null ? message : "", message };
    }
    return { tool: action, args: obj.args || {}, message };
  }
  // Older protocol: { tool, args } / { final }
  if (typeof obj.tool === "string") return { tool: obj.tool, args: obj.args || {}, message };
  if (obj.final !== undefined) return { final: String(obj.final), message };
  // A bare { message: "..." } with no action -> treat as final answer.
  if (message !== undefined) return { final: message, message };
  return null;
}

// ---- The agent graph --------------------------------------------------------
export function buildAgentGraph() {
  const g = new StateGraph();

  // "agent" node: ask the model for the next JSON step. For a tool step we show
  // its human-readable `message` to the user immediately (Reason -> show -> Act).
  g.addNode("agent", async (state, ctx) => {
    const raw = await ctx.llm.chat(state.messages, { task: "work", temperature: 0.4, maxTokens: 3200, json: true });
    state.messages.push({ role: "assistant", content: raw });
    const a = extractAction(raw);
    if (a.tool) {
      if (a.message && a.message.trim()) {
        await sendProgress(ctx, a.message);
        state.progressed = true;
      }
      state.action = { tool: a.tool, args: a.args || {} };
    } else {
      state.final = String(a.final != null ? a.final : a.message != null ? a.message : "");
      state.action = {};
    }
    return state;
  });

  // "tools" node: execute the requested tool and append the observation.
  // Tracks consecutive failures and repeated identical calls so the agent can't
  // get stuck hammering a failing tool (e.g. a rate-limited API).
  g.addNode("tools", async (state, ctx) => {
    const { tool, args } = state.action;
    const sig = `${tool}:${JSON.stringify(args || {})}`;
    state.repeat = sig === state.lastSig ? (state.repeat || 0) + 1 : 0;
    state.lastSig = sig;

    const observation = await runTool(tool, args, ctx);
    const failed = /\b(error|failed|rate.?limit|429|too many|quota|unavailable|ошибк|не удалось)\b/i.test(observation);
    state.toolErrors = failed ? (state.toolErrors || 0) + 1 : 0;

    state.messages.push({ role: "user", content: `OBSERVATION (${tool}):\n${truncate(observation, 4000)}` });
    state.steps = (state.steps || 0) + 1;
    return state;
  });

  g.setEntryPoint("agent");
  g.addConditionalEdges("agent", (state) => {
    if (state.final !== undefined && state.final !== null) return END;
    if (!state.action || !state.action.tool) return END;
    if ((state.steps || 0) >= state.maxSteps) return "force_finish";
    // Loop guards: stop after repeated failures or the same call being retried.
    if ((state.toolErrors || 0) >= 2) return "force_finish";
    if ((state.repeat || 0) >= 2) return "force_finish";
    return "tools";
  });
  g.addEdge("tools", "agent");

  // "force_finish": budget exhausted or stuck — get one final answer, no tools.
  g.addNode("force_finish", async (state, ctx) => {
    state.messages.push({
      role: "user",
      content:
        'Stop using tools and respond now. Output JSON {"action":"respond","message":"<the final answer to the user>"} using what you already have.',
    });
    const raw = await ctx.llm.chat(state.messages, { task: "work", temperature: 0.3, maxTokens: 2000, json: true });
    const a = extractAction(raw);
    state.final = String(a.final != null ? a.final : a.message != null ? a.message : raw).trim();
    return state;
  });
  g.addEdge("force_finish", END);

  return g.compile();
}

// Send a short progress line to the user (best-effort, HTML-escaped).
async function sendProgress(ctx, message) {
  if (!ctx || !ctx.telegram || !ctx.chatId) return;
  try {
    await ctx.telegram.sendMessage(ctx.chatId, toTelegramHtml(message));
  } catch {
    /* progress is best-effort */
  }
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}
