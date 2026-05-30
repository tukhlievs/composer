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
    description:
      "Generate a polished PDF report and send it to the user. Write rich Markdown in `content`: use ## and ### headings to structure sections, fenced ```code``` blocks for commands/examples, '- ' bullet lists, '1.' numbered steps, '> ' callouts for tips/warnings, and **bold** / `inline code`. Aim for a thorough, well-organised document (intro, themed sections, examples, a short summary or cheatsheet). Do NOT put emojis in the content — they are stripped. Cyrillic is fully supported.",
    args: { title: "string", content: "string (rich Markdown)" },
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
    description: "Create a step-by-step plan for a multi-part task. Provide a goal; steps are optional — the planner model will expand the goal into concrete ordered steps.",
    args: { goal: "string", steps: "string[] (optional)" },
    async run({ goal, steps }, ctx) {
      let list = Array.isArray(steps) ? steps.filter(Boolean) : steps ? String(steps).split("\n").filter(Boolean) : [];
      // Planning runs on the planner model (Gemini). If the agent didn't supply
      // a real list, ask Gemini to decompose the goal.
      if (list.length < 2 && goal) {
        try {
          const raw = await ctx.llm.chat(
            [
              { role: "system", content: "You are a planner. Break the goal into 3-7 concrete, ordered, actionable steps. Reply with a JSON array of short strings only." },
              { role: "user", content: `Goal: ${goal}` },
            ],
            { task: "plan", temperature: 0.3, maxTokens: 400, json: true }
          );
          const parsed = JSON.parse((raw.match(/\[[\s\S]*\]/) || [])[0] || raw);
          if (Array.isArray(parsed) && parsed.length) list = parsed.map(String);
        } catch {
          /* fall back to whatever was provided */
        }
      }
      if (!list.length) return "Provide a goal (and optionally steps) to plan.";
      const plan = await ctx.store.setPlan(ctx.chatId, goal, list);
      return `Plan created with ${plan.steps.length} steps (decomposed by the planner). Now execute them one by one.`;
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
  {
    name: "update_profile",
    description:
      "Save durable profile fields about the user: name, age, language, communication style. Use when the user states these about themselves.",
    args: { name: "string?", age: "number?", language: "string?", style: "string?" },
    async run(args, ctx) {
      const patch = {};
      if (args.name) patch.name = String(args.name).slice(0, 80);
      if (args.age != null && Number.isFinite(Number(args.age))) patch.age = Number(args.age);
      if (args.language) patch.language = String(args.language).slice(0, 40);
      if (args.style) patch.style = String(args.style).slice(0, 200);
      if (!Object.keys(patch).length) return "Nothing to update.";
      await ctx.store.setProfile(ctx.chatId, patch);
      return `Saved to profile: ${Object.keys(patch).join(", ")}.`;
    },
  },
  {
    name: "set_reminder",
    description:
      "Schedule a reminder. Provide the reminder text plus a delay via seconds/minutes/hours, or an absolute ISO datetime in 'at'. The user gets a message when it is due.",
    args: { text: "string", seconds: "number?", minutes: "number?", hours: "number?", at: "ISO datetime?" },
    async run(args, ctx) {
      if (!ctx.reminders) return "Reminders are not available in this runtime.";
      const text = String(args.text || "").trim();
      if (!text) return "A reminder text is required.";
      let dueTs;
      if (args.at) {
        const t = Date.parse(args.at);
        if (Number.isNaN(t)) return "Could not parse the 'at' datetime.";
        dueTs = t;
      } else {
        const secs =
          (Number(args.seconds) || 0) + (Number(args.minutes) || 0) * 60 + (Number(args.hours) || 0) * 3600;
        if (secs <= 0) return "Provide a positive delay (seconds/minutes/hours) or an 'at' time.";
        dueTs = Date.now() + secs * 1000;
      }
      if (dueTs <= Date.now()) return "That time is already in the past.";
      const item = await ctx.reminders.add(ctx.chatId, text, dueTs);
      const inSec = Math.round((item.dueTs - Date.now()) / 1000);
      return `Reminder scheduled (id ${item.id}) to first fire in ~${inSec}s. It will then repeat every 3 minutes with "Остановить напоминание" / "Продлить" buttons until the user stops it. Confirm this to the user.`;
    },
  },
  {
    name: "list_reminders",
    description: "List the user's pending reminders.",
    args: {},
    async run(_args, ctx) {
      if (!ctx.reminders) return "Reminders are not available.";
      const list = await ctx.reminders.list(ctx.chatId);
      if (!list.length) return "No pending reminders.";
      return list.map((r) => `- [${r.id}] ${new Date(r.dueTs).toISOString()} — ${r.text}`).join("\n");
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its id (from list_reminders).",
    args: { id: "string" },
    async run({ id }, ctx) {
      if (!ctx.reminders) return "Reminders are not available.";
      const ok = await ctx.reminders.cancel(String(id));
      return ok ? `Cancelled reminder ${id}.` : `No reminder found with id ${id}.`;
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
