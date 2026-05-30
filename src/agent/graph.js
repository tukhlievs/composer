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
export function extractAction(text) {
  if (!text) return { final: "" };
  let t = text.trim();
  // Strip markdown fences if the model wrapped its JSON.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  // Find the first balanced {...} block.
  const start = t.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === "{") depth++;
      else if (t[i] === "}") {
        depth--;
        if (depth === 0) {
          const slice = t.slice(start, i + 1);
          try {
            const obj = JSON.parse(slice);
            if (obj && (obj.tool || obj.final !== undefined)) return obj;
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

// ---- The agent graph --------------------------------------------------------
export function buildAgentGraph() {
  const g = new StateGraph();

  // "agent" node: ask the model for the next JSON action.
  g.addNode("agent", async (state, ctx) => {
    const raw = await ctx.llm.chat(state.messages, { task: "general", temperature: 0.4, maxTokens: 3200, json: true });
    state.messages.push({ role: "assistant", content: raw });
    const action = extractAction(raw);
    state.action = action;
    if (action.final !== undefined) state.final = String(action.final);
    return state;
  });

  // "tools" node: execute the requested tool and append the observation.
  g.addNode("tools", async (state, ctx) => {
    const { tool, args } = state.action;
    const observation = await runTool(tool, args, ctx);
    state.messages.push({ role: "user", content: `OBSERVATION (${tool}):\n${truncate(observation, 4000)}` });
    state.steps = (state.steps || 0) + 1;
    return state;
  });

  g.setEntryPoint("agent");
  g.addConditionalEdges("agent", (state) => {
    if (state.final !== undefined && state.final !== null) return END;
    if (!state.action || !state.action.tool) return END;
    if ((state.steps || 0) >= state.maxSteps) return "force_finish";
    return "tools";
  });
  g.addEdge("tools", "agent");

  // "force_finish": budget exhausted — get one plain answer, no more tools.
  g.addNode("force_finish", async (state, ctx) => {
    state.messages.push({
      role: "user",
      content: "You have reached the tool-step limit. Reply now with a final JSON object {\"final\": \"...\"} answering the user using what you have.",
    });
    const raw = await ctx.llm.chat(state.messages, { task: "general", temperature: 0.3, maxTokens: 2000, json: true });
    state.final = extractAction(raw).final || raw.trim();
    return state;
  });
  g.addEdge("force_finish", END);

  return g.compile();
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…[truncated]" : s;
}
