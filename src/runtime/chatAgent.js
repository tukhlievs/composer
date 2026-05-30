// One Durable Object instance per Telegram chat — the chat's persistent "actor".
//
// Why a Durable Object: on Cloudflare Workers there is no long-lived process and
// no filesystem, so request-scoped code cannot keep a per-user memory file or
// fire a reminder "in 20 seconds". A Durable Object gives each chat its own
// durable storage (the memory file lives here) plus a precise alarm() callback
// for reminders. All updates for a chat are routed to the same instance, so
// state is consistent and serialized.

import { loadConfig } from "../config.js";
import { Store, DurableKV } from "../memory/store.js";
import { LLM } from "../llm/groq.js";
import { Telegram } from "../telegram/client.js";
import { handleUpdate } from "../telegram/router.js";
import { makeDurableReminders, fireDueReminders } from "./reminders.js";
import { log } from "../utils/log.js";

export class ChatAgent {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.config = loadConfig(env);
  }

  #base() {
    const store = new Store(new DurableKV(this.state.storage), { historyLimit: this.config.bot.historyLimit });
    return {
      config: this.config,
      telegram: new Telegram(this.config.telegram.token),
      llm: new LLM(this.config),
      store,
      reminders: makeDurableReminders(this.state),
    };
  }

  // Internal entry: the Worker forwards each Telegram update here.
  async fetch(request) {
    let update;
    try {
      ({ update } = await request.json());
    } catch {
      return new Response("bad request", { status: 400 });
    }
    try {
      await handleUpdate(update, this.#base());
    } catch (err) {
      log.error("ChatAgent.handleUpdate failed", err);
    }
    return new Response("ok");
  }

  // Fired by the runtime when the earliest reminder is due.
  async alarm() {
    try {
      const telegram = new Telegram(this.config.telegram.token);
      await fireDueReminders(this.state, telegram);
    } catch (err) {
      log.error("ChatAgent.alarm failed", err);
    }
  }
}
