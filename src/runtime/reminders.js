// Reminder scheduling, two backends with the same interface:
//   add(chatId, text, dueTs) -> {id, chatId, text, dueTs}
//   list(chatId?)            -> reminder[]
//   cancel(id)               -> boolean
//
// Durable Object backend (Workers): persists reminders in DO storage and uses
// a single DO alarm set to the earliest due time — precise to the second and
// survives isolate sleep. fireDueReminders() is called from the DO's alarm().
//
// In-memory backend (Node polling): plain setTimeout. Lives for the process.

const KEY = "reminders";

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

// ---- Durable Object backend -------------------------------------------------
export function makeDurableReminders(state) {
  const storage = state.storage;
  return {
    async add(chatId, text, dueTs) {
      const list = (await storage.get(KEY)) || [];
      const item = { id: rid(), chatId, text, dueTs };
      list.push(item);
      await storage.put(KEY, list);
      await reschedule(storage, list);
      return item;
    },
    async list(chatId) {
      const list = (await storage.get(KEY)) || [];
      return chatId == null ? list : list.filter((r) => String(r.chatId) === String(chatId));
    },
    async cancel(id) {
      const list = (await storage.get(KEY)) || [];
      const next = list.filter((r) => r.id !== id);
      await storage.put(KEY, next);
      await reschedule(storage, next);
      return next.length !== list.length;
    },
  };
}

// Called from the Durable Object's alarm() handler.
export async function fireDueReminders(state, telegram) {
  const storage = state.storage;
  const now = Date.now();
  const list = (await storage.get(KEY)) || [];
  const due = list.filter((r) => r.dueTs <= now);
  const rest = list.filter((r) => r.dueTs > now);
  for (const r of due) {
    try {
      await telegram.sendMessage(r.chatId, `Напоминание: ${r.text}`);
    } catch {
      /* ignore individual send failures */
    }
  }
  await storage.put(KEY, rest);
  await reschedule(storage, rest);
  return due.length;
}

async function reschedule(storage, list) {
  if (!list.length) {
    await storage.deleteAlarm();
    return;
  }
  const next = Math.min(...list.map((r) => r.dueTs));
  await storage.setAlarm(next);
}

// ---- In-memory backend (Node polling) --------------------------------------
export function makeMemoryReminders(telegram) {
  const items = new Map(); // id -> {item, timer}
  return {
    async add(chatId, text, dueTs) {
      const item = { id: rid(), chatId, text, dueTs };
      const delay = Math.max(0, dueTs - Date.now());
      const timer = setTimeout(async () => {
        items.delete(item.id);
        try {
          await telegram.sendMessage(chatId, `Напоминание: ${text}`);
        } catch {
          /* ignore */
        }
      }, Math.min(delay, 2_147_483_000)); // setTimeout 32-bit ceiling
      if (timer.unref) timer.unref();
      items.set(item.id, { item, timer });
      return item;
    },
    async list(chatId) {
      const all = [...items.values()].map((x) => x.item);
      return chatId == null ? all : all.filter((r) => String(r.chatId) === String(chatId));
    },
    async cancel(id) {
      const entry = items.get(id);
      if (!entry) return false;
      clearTimeout(entry.timer);
      items.delete(id);
      return true;
    },
  };
}
