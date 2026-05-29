// Registers the deployed Worker's /webhook endpoint with Telegram.
//
// Usage: node scripts/set-webhook.mjs https://composer.<your-subdomain>.workers.dev
// (or set WORKER_URL in your shell). Reads the bot token and webhook secret
// from .env. You can also just open https://<worker>/set-webhook?secret=...

import { readFileSync, existsSync } from "node:fs";

function readEnv() {
  const env = {};
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  }
  return env;
}

const env = readEnv();
const token = env.TELEGRAM_BOT_TOKEN;
const secret = env.TELEGRAM_WEBHOOK_SECRET;
const workerUrl = (process.argv[2] || process.env.WORKER_URL || "").replace(/\/+$/, "");

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN missing in .env");
  process.exit(1);
}
if (!workerUrl) {
  console.error("Pass the Worker URL: node scripts/set-webhook.mjs https://composer.<sub>.workers.dev");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: `${workerUrl}/webhook`,
    secret_token: secret || undefined,
    allowed_updates: ["message", "edited_message", "callback_query"],
  }),
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
process.exit(data.ok ? 0 : 1);
