// Tool registry. Each tool declares a name, a human description, an args map
// (used to document the call signature in the system prompt) and a run()
// function. run(args, ctx) returns a short string OBSERVATION fed back to the
// model. Tools that produce files send them to Telegram directly and return a
// status line.
//
// ctx = { config, llm, store, telegram, chatId }

import { webSearch, deepResearch } from "../tools/research.js";
import { cobaltResolve, detectPlatform } from "../tools/media.js";
import { resolveMusic } from "../tools/music.js";
import { makePdf } from "../tools/pdf.js";

const tools = [
  {
    name: "web_search",
    description: "Quick web search for facts, links or current info. Returns a synthesized answer and top sources.",
    args: { query: "string" },
    async run({ query }, ctx) {
      const r = await webSearch(ctx.config, query, { maxResults: 5 });
      if (!r.ok) return `Search failed: ${r.error}`;
      const sources = r.results.map((s, i) => `(${i + 1}) ${s.title} — ${s.url}\n${trim(s.content, 300)}`).join("\n");
      return `Answer: ${r.answer || "(none)"}\nSources:\n${sources}`;
    },
  },
  {
    name: "deep_research",
    description:
      "Multi-step research on a topic: plans sub-queries, searches each, and synthesizes a structured cited report. Set as_pdf=true to deliver the report as a PDF file instead of text (preferred for long reports).",
    args: { topic: "string", as_pdf: "boolean (optional)" },
    async run({ topic, as_pdf }, ctx) {
      await ctx.telegram.sendChatAction(ctx.chatId, "typing");
      const r = await deepResearch(ctx.config, ctx.llm, topic, { rounds: 3 });
      if (!r.ok) return `Deep research failed: ${r.error}`;
      if (as_pdf) {
        await ctx.telegram.sendChatAction(ctx.chatId, "upload_document");
        const bytes = await makePdf(ctx.config, { title: topic, content: r.report });
        await ctx.telegram.sendDocumentBlob(ctx.chatId, bytes, sanitizeFilename(topic) + ".pdf", {
          contentType: "application/pdf",
          caption: `Research report: ${trim(topic, 200)}`,
        });
        return `Delivered a PDF research report (${r.sourceCount} sources) to the user. Give a one-line confirmation.`;
      }
      return `Research report (relay to the user, optionally trimmed):\n\n${r.report}`;
    },
  },
  {
    name: "download_media",
    description:
      "Download a video or its audio from a URL (YouTube, Instagram, Pinterest, TikTok, X, etc.) and send it to the user. mode: 'auto' (video), 'audio' (audio only), 'mute' (no sound).",
    args: { url: "string", mode: "'auto'|'audio'|'mute' (optional)" },
    async run({ url, mode = "auto" }, ctx) {
      const platform = detectPlatform(url);
      await ctx.telegram.sendChatAction(ctx.chatId, mode === "audio" ? "upload_voice" : "upload_video");
      const out = await cobaltResolve(ctx.config, url, { mode });
      if (out.kind === "error") return `Could not download from ${platform}: ${out.error}`;

      if (out.kind === "single") {
        if (mode === "audio") await ctx.telegram.sendAudioUrl(ctx.chatId, out.url, { caption: `From ${platform}` });
        else await ctx.telegram.sendVideoUrl(ctx.chatId, out.url, { caption: `From ${platform}` });
        return `Sent the ${mode === "audio" ? "audio" : "video"} from ${platform} to the user.`;
      }
      // picker = carousel / multiple assets
      let count = 0;
      for (const item of out.items.slice(0, 10)) {
        try {
          if (item.type === "video") await ctx.telegram.sendVideoUrl(ctx.chatId, item.url);
          else await ctx.telegram.sendDocumentUrl(ctx.chatId, item.url);
          count++;
        } catch {
          /* skip individual failures */
        }
      }
      if (out.audio) await ctx.telegram.sendAudioUrl(ctx.chatId, out.audio).catch(() => {});
      return `Sent ${count} item(s) from ${platform} to the user.`;
    },
  },
  {
    name: "download_music",
    description:
      "Find and download a music track as audio. Pass a search query like 'artist - title' or a direct YouTube/SoundCloud URL.",
    args: { query: "string" },
    async run({ query }, ctx) {
      await ctx.telegram.sendChatAction(ctx.chatId, "upload_voice");
      const out = await resolveMusic(ctx.config, query, { audioFormat: "mp3" });
      if (out.kind === "error") return `Could not get that track: ${out.error}`;
      await ctx.telegram.sendAudioUrl(ctx.chatId, out.url, { caption: trim(query, 200) });
      return `Sent the requested track to the user.`;
    },
  },
  {
    name: "make_pdf",
    description: "Generate a PDF report from a title and body text (Markdown-ish, Cyrillic supported) and send it to the user.",
    args: { title: "string", content: "string" },
    async run({ title, content }, ctx) {
      await ctx.telegram.sendChatAction(ctx.chatId, "upload_document");
      const bytes = await makePdf(ctx.config, { title, content });
      await ctx.telegram.sendDocumentBlob(ctx.chatId, bytes, sanitizeFilename(title) + ".pdf", {
        contentType: "application/pdf",
        caption: trim(title, 200),
      });
      return `Generated and sent the PDF "${trim(title, 120)}" to the user.`;
    },
  },
  {
    name: "remember",
    description: "Store a durable fact about the user (preference, goal, project, personal detail) for future conversations.",
    args: { fact: "string" },
    async run({ fact }, ctx) {
      await ctx.store.addFact(ctx.chatId, fact);
      return `Remembered: ${trim(fact, 200)}`;
    },
  },
  {
    name: "recall",
    description: "Retrieve everything currently remembered about the user.",
    args: {},
    async run(_args, ctx) {
      const mem = await ctx.store.getMemory(ctx.chatId);
      if (!mem.facts.length) return "No stored memories yet.";
      return mem.facts.map((f, i) => `${i + 1}. ${f.text}`).join("\n");
    },
  },
  {
    name: "save_knowledge",
    description: "Save a titled note into the knowledge base for later retrieval.",
    args: { title: "string", content: "string" },
    async run({ title, content }, ctx) {
      const item = await ctx.store.addKnowledge(ctx.chatId, title, content);
      return `Saved knowledge note "${item.title}".`;
    },
  },
  {
    name: "search_knowledge",
    description: "Search the saved knowledge base by keywords.",
    args: { query: "string" },
    async run({ query }, ctx) {
      const hits = await ctx.store.searchKnowledge(ctx.chatId, query, 5);
      if (!hits.length) return "No matching knowledge notes.";
      return hits.map((h) => `# ${h.title}\n${trim(h.content, 500)}`).join("\n\n");
    },
  },
  {
    name: "create_plan",
    description: "Create a step-by-step plan for a multi-part task. Provide a goal and an ordered list of step strings.",
    args: { goal: "string", steps: "string[]" },
    async run({ goal, steps }, ctx) {
      const list = Array.isArray(steps) ? steps : String(steps).split("\n").filter(Boolean);
      const plan = await ctx.store.setPlan(ctx.chatId, goal, list);
      return `Plan created with ${plan.steps.length} steps. Now execute them one by one.`;
    },
  },
  {
    name: "update_plan",
    description: "Mark a plan step as done by its 1-based index.",
    args: { index: "number" },
    async run({ index }, ctx) {
      const plan = await ctx.store.markPlanStep(ctx.chatId, index);
      if (!plan) return "No active plan.";
      const remaining = plan.steps.filter((s) => !s.done).length;
      return `Step ${index} marked done. ${remaining} step(s) remaining.`;
    },
  },
];

const byName = new Map(tools.map((t) => [t.name, t]));

export function toolSpecs() {
  return tools.map(({ name, description, args }) => ({ name, description, args }));
}

export async function runTool(name, args, ctx) {
  const tool = byName.get(name);
  if (!tool) return `Unknown tool "${name}".`;
  try {
    return await tool.run(args || {}, ctx);
  } catch (err) {
    return `Tool "${name}" error: ${err.message}`;
  }
}

function trim(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function sanitizeFilename(s) {
  return String(s || "report")
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    .trim()
    .slice(0, 60)
    .replace(/\s+/g, "_") || "report";
}
