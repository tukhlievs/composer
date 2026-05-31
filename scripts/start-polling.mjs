// Local launcher: run Composer with long polling, in-memory store, Gemini +
// Minimax — no Cloudflare, no KV, no webhook, no public URL.
//
// Usage: npm start   (after `npm install` and filling in .env)

import { readFileSync, existsSync } from "node:fs";
import { loadConfig, validateConfig } from "../src/config.js";
import { createStore } from "../src/memory/store.js";
import { LLM } from "../src/llm/llm.js";
import { Telegram } from "../src/telegram/client.js";
import { startPolling } from "../src/runtime/polling.js";
import { makeMemoryReminders } from "../src/runtime/reminders.js";

// Minimal .env loader (real environment variables take precedence).
function loadDotenv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (val && process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotenv();

const missing = validateConfig(process.env);
if (missing.length) {
  console.error("Missing required variables in .env: " + missing.join(", "));
  console.error("Need TELEGRAM_BOT_TOKEN, OPENROUTER_API and OPENROUTER_MODEL (GEMINI_API is optional, for image recognition).");
  process.exit(1);
}

const config = loadConfig(process.env); // no COMPOSER_KV -> in-memory store
const telegram = new Telegram(config.telegram.token);
const base = {
  config,
  telegram,
  llm: new LLM(config),
  store: createStore(config),
  // In polling mode reminders use in-process timers (lost on restart).
  reminders: makeMemoryReminders(telegram),
};

const controller = new AbortController();
process.on("SIGINT", () => {
  console.log("\nShutting down…");
  controller.abort();
  setTimeout(() => process.exit(0), 200);
});

startPolling(base, { signal: controller.signal }).catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
