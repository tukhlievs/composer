// Alarm-style reminders: once a reminder first fires, it KEEPS firing every
// REPEAT_MS (3 minutes) until the user stops it. Every ring carries two inline
// buttons — "Остановить напоминание" (stop) and "Продлить" (snooze). To avoid a
// pile of actionable old rings, the previous ring's buttons are stripped before
// a new one is sent.
//
// Two backends, same interface:
//   add(chatId, text, dueTs, repeatMs?) -> item
//   list(chatId?)                       -> item[]   (item.dueTs = next ring)
//   cancel(id)                          -> boolean  (stop)
//   snooze(id, ms?)                     -> boolean  (postpone next ring)
//
// Durable Object backend (Workers): reminders in DO storage, a single DO alarm
// set to the earliest next ring; fireDueReminders() runs from the DO alarm().
// In-memory backend (Node polling): per-reminder setTimeout that re-arms itself.

export const REPEAT_MS = 3 * 60 * 1000; // 3 minutes
const KEY = "reminders";

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

export function reminderKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: "Остановить напоминание", callback_data: `rem:stop:${id}` },
        { text: "Продлить", callback_data: `rem:snooze:${id}` },
      ],
    ],
  };
}

// Strip the previous ring's buttons, send a fresh ring with buttons, return the
// new message id. Best-effort: never throws.
async function sendRing(telegram, item) {
  if (item.lastMsgId) {
    try {
      await telegram.editMessageReplyMarkup(item.chatId, item.lastMsgId, undefined);
    } catch {
      /* old message may be gone; ignore */
    }
  }
  try {
    const msg = await telegram.sendMessage(item.chatId, `Напоминание: ${item.text}`, {
      replyMarkup: reminderKeyboard(item.id),
    });
    return (msg && msg.message_id) || null;
  } catch {
    return item.lastMsgId || null;
  }
}

// ---- Durable Object backend -------------------------------------------------
export function makeDurableReminders(state) {
  const storage = state.storage;
  const load = async () => (await storage.get(KEY)) || [];
  const save = async (list) => {
    await storage.put(KEY, list);
    await reschedule(storage, list);
  };
  return {
    async add(chatId, text, dueTs, repeatMs = REPEAT_MS) {
      const list = await load();
      const item = { id: rid(), chatId, text, dueTs, repeatMs, lastMsgId: null };
      list.push(item);
      await save(list);
      return item;
    },
    async list(chatId) {
      const list = await load();
      return chatId == null ? list : list.filter((r) => String(r.chatId) === String(chatId));
    },
    async cancel(id) {
      const list = await load();
      const next = list.filter((r) => r.id !== id);
      await save(next);
      return next.length !== list.length;
    },
    async snooze(id, ms) {
      const list = await load();
      const item = list.find((r) => r.id === id);
      if (!item) return false;
      item.dueTs = Date.now() + (ms || item.repeatMs || REPEAT_MS);
      await save(list);
      return true;
    },
  };
}

// Called from the Durable Object's alarm(): ring everything due, then re-arm
// each due reminder REPEAT_MS into the future so it keeps nagging.
export async function fireDueReminders(state, telegram) {
  const storage = state.storage;
  const now = Date.now();
  const list = (await storage.get(KEY)) || [];
  let fired = 0;
  for (const item of list) {
    if (item.dueTs <= now) {
      item.lastMsgId = await sendRing(telegram, item);
      item.dueTs = Date.now() + (item.repeatMs || REPEAT_MS);
      fired++;
    }
  }
  await storage.put(KEY, list);
  await reschedule(storage, list);
  return fired;
}

async function reschedule(storage, list) {
  if (!list.length) {
    await storage.deleteAlarm();
    return;
  }
  await storage.setAlarm(Math.min(...list.map((r) => r.dueTs)));
}

// ---- In-memory backend (Node polling) --------------------------------------
export function makeMemoryReminders(telegram) {
  const items = new Map(); // id -> item (with .timer)

  function arm(item) {
    const delay = Math.max(0, item.dueTs - Date.now());
    item.timer = setTimeout(() => ring(item), Math.min(delay, 2_147_483_000));
    if (item.timer && item.timer.unref) item.timer.unref();
  }
  async function ring(item) {
    item.lastMsgId = await sendRing(telegram, item);
    item.dueTs = Date.now() + (item.repeatMs || REPEAT_MS); // repeat
    arm(item);
  }
  const strip = (item) => {
    const { timer, ...rest } = item;
    return rest;
  };

  return {
    async add(chatId, text, dueTs, repeatMs = REPEAT_MS) {
      const item = { id: rid(), chatId, text, dueTs, repeatMs, lastMsgId: null, timer: null };
      items.set(item.id, item);
      arm(item);
      return strip(item);
    },
    async list(chatId) {
      const all = [...items.values()].map(strip);
      return chatId == null ? all : all.filter((r) => String(r.chatId) === String(chatId));
    },
    async cancel(id) {
      const item = items.get(id);
      if (!item) return false;
      clearTimeout(item.timer);
      items.delete(id);
      return true;
    },
    async snooze(id, ms) {
      const item = items.get(id);
      if (!item) return false;
      clearTimeout(item.timer);
      item.dueTs = Date.now() + (ms || item.repeatMs || REPEAT_MS);
      arm(item);
      return true;
    },
  };
}
