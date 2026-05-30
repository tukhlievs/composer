// Cloudflare Worker entry point.
//
// Routes:
//   GET  /health        -> liveness probe
//   GET  /set-webhook   -> registers this Worker's /webhook with Telegram
//                          (guarded by ?secret=<TELEGRAM_WEBHOOK_SECRET>)
//   POST /webhook       -> Telegram update intake
//
// Each chat is handled by its own Durable Object (ChatAgent), which owns that
// user's memory file and reminder alarms. The Worker just authenticates the
// webhook and forwards the update to the right actor. We forward inside
// ctx.waitUntil so Telegram is acknowledged immediately (no retries) while the
// actor finishes the turn.

import { loadConfig, validateConfig } from "./config.js";
import { Telegram } from "./telegram/client.js";
import { log } from "./utils/log.js";

// The Durable Object class must be exported from the Worker's main module.
export { ChatAgent } from "./runtime/chatAgent.js";

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

      const chatId = chatIdOf(update);
      if (chatId == null || !env.CHAT_AGENT) {
        return json({ ok: true }); // nothing actionable
      }

      // Route to this chat's Durable Object actor.
      const stub = env.CHAT_AGENT.get(env.CHAT_AGENT.idFromName(String(chatId)));
      const forward = stub.fetch("https://chat-agent/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update }),
      });
      ctx.waitUntil(forward);
      return json({ ok: true });
    }

    return json({ ok: false, error: "Not found" }, 404);
  },
};

function chatIdOf(update) {
  const msg = update.message || update.edited_message || (update.callback_query && update.callback_query.message);
  return msg && msg.chat ? msg.chat.id : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
