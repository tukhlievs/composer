// Telegram long-polling runtime. Lets Composer run as a normal long-lived
// process (e.g. `node`) with NO webhook and NO public URL — the temporary,
// dependency-light run mode. The same handleUpdate logic powers both this and
// the Cloudflare Worker webhook path.

import { handleUpdate } from "../telegram/router.js";
import { log } from "../utils/log.js";

export async function startPolling(base, { signal, longPollSec = 25 } = {}) {
  const tg = base.telegram;

  // getUpdates and a webhook are mutually exclusive (Telegram returns 409 if a
  // webhook is set), so drop any existing webhook first.
  try {
    await tg.deleteWebhook(false);
  } catch (err) {
    log.warn("deleteWebhook failed (continuing)", { error: err.message });
  }

  log.info(`${base.config.bot.name} polling started`);

  let offset = 0;
  let stopped = false;
  if (signal) signal.addEventListener("abort", () => (stopped = true));

  while (!stopped) {
    let updates = [];
    try {
      updates = await tg.getUpdates(offset, longPollSec);
    } catch (err) {
      log.error("getUpdates failed; backing off", err);
      await sleep(2000);
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;
      // Fire-and-forget so a slow LLM call doesn't stall polling. Errors are
      // already handled inside handleUpdate; this catch is a final safety net.
      Promise.resolve(handleUpdate(update, base)).catch((err) => log.error("handleUpdate threw", err));
    }
  }

  log.info("polling stopped");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
