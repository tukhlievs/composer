// Cloudflare Worker entry point.
//
// Routes:
//   GET  /health        -> liveness probe
//   GET  /set-webhook   -> registers this Worker's /webhook with Telegram
//                          (guarded by ?secret=<TELEGRAM_WEBHOOK_SECRET>)
//   POST /webhook       -> Telegram update intake
//
// The heavy work runs in ctx.waitUntil so we acknowledge Telegram immediately
// and avoid duplicate-delivery retries.

import { loadConfig, validateConfig } from "./config.js";
import { LLM } from "./llm/openrouter.js";
import { Store } from "./memory/store.js";
import { Telegram } from "./telegram/client.js";
import { handleUpdate } from "./telegram/router.js";
import { log } from "./utils/log.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ ok: true, service: "composer" });
    }

    const missing = validateConfig(env);
    if (missing.length) {
      log.error("Missing configuration", new Error(missing.join(", ")));
      return json({ ok: false, error: "Service not fully configured." }, 500);
    }

    const config = loadConfig(env);
    const telegram = new Telegram(config.telegram.token);

    if (url.pathname === "/set-webhook") {
      if (!config.telegram.webhookSecret || url.searchParams.get("secret") !== config.telegram.webhookSecret) {
        return json({ ok: false, error: "Forbidden" }, 403);
      }
      const hookUrl = `${url.origin}/webhook`;
      try {
        const result = await telegram.setWebhook(hookUrl, config.telegram.webhookSecret);
        return json({ ok: true, webhook: hookUrl, result });
      } catch (err) {
        return json({ ok: false, error: err.message }, 502);
      }
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      // Reject forged calls: Telegram echoes our secret in this header.
      if (config.telegram.webhookSecret) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
        if (got !== config.telegram.webhookSecret) return json({ ok: false }, 403);
      }
      let update;
      try {
        update = await request.json();
      } catch {
        return json({ ok: false, error: "bad json" }, 400);
      }

      const base = {
        config,
        telegram,
        llm: new LLM(config),
        store: new Store(config.kv, { historyLimit: config.bot.historyLimit }),
      };

      // Process in the background; acknowledge now.
      ctx.waitUntil(handleUpdate(update, base));
      return json({ ok: true });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
