// Parses a Telegram update, handles slash-commands, and dispatches everything
// else to the agent. Replies are HTML-formatted and chunked to fit limits.

import { runAgent } from "../agent/run.js";
import { extractMemory } from "../memory/extract.js";
import { toTelegramHtml, chunk, escapeHtml } from "./format.js";
import { log } from "../utils/log.js";

const HELP = {
  start: (name) =>
    `Привет! Я ${name} — мультиинструментальный ИИ-ассистент.\n\n` +
    `Что я умею: искать и скачивать музыку, видео из YouTube, Instagram, Pinterest и TikTok, ` +
    `проводить глубокое исследование (deep research), делать детальные PDF-отчёты, ` +
    `ставить напоминания, планировать задачи и запоминать важное о тебе.\n\n` +
    `Просто напиши, что нужно, или пришли ссылку. /help — список команд.\n\n` +
    `Hi! I'm ${name}, a multi-tool AI assistant. Send a request or a link. /help for commands.`,
  help: (name) =>
    `<b>${name}</b> — команды:\n` +
    `/start — приветствие\n` +
    `/help — эта справка\n` +
    `/memory — что я о тебе помню\n` +
    `/reminders — мои активные напоминания\n` +
    `/diag — проверить, какие модели сейчас доступны\n` +
    `/forget — стереть память обо мне\n` +
    `/reset — очистить историю диалога\n\n` +
    `В обычных сообщениях: «напомни через 20 секунд …» → напоминание; ссылка на видео/трек → скачаю; ` +
    `«найди и скачай …» → музыка; «исследуй …» → deep research; «сделай PDF …» → отчёт; «запомни …» → память.`,
};

// A short, safe, user-facing reason from an error (no keys, capped length).
function shortReason(err) {
  if (!err) return "неизвестная ошибка";
  let msg = (err.body && err.body.error && err.body.error.message) || err.message || String(err);
  msg = String(msg).replace(/key=[\w.-]+/gi, "key=***").slice(0, 240);
  const status = err.status ? ` (HTTP ${err.status})` : "";
  return msg + status;
}

// Handles the two reminder buttons. callback_data is "rem:stop:<id>" or
// "rem:snooze:<id>". Always answer the callback so the user's client stops
// spinning, then strip the buttons from the pressed message.
async function handleReminderCallback(cq, base) {
  const tg = base.telegram;
  const data = cq.data || "";
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const msgId = cq.message && cq.message.message_id;
  const m = data.match(/^rem:(stop|snooze):(.+)$/);

  if (!m || !base.reminders) {
    return void (await tg.answerCallbackQuery(cq.id).catch(() => {}));
  }
  const [, action, id] = m;
  try {
    if (action === "stop") {
      await base.reminders.cancel(id);
      if (chatId && msgId) await tg.editMessageReplyMarkup(chatId, msgId, undefined).catch(() => {});
      await tg.answerCallbackQuery(cq.id, "Напоминание остановлено").catch(() => {});
    } else {
      const ok = await base.reminders.snooze(id);
      if (chatId && msgId) await tg.editMessageReplyMarkup(chatId, msgId, undefined).catch(() => {});
      await tg.answerCallbackQuery(cq.id, ok ? "Отложено на 3 минуты" : "Напоминание не найдено").catch(() => {});
    }
  } catch (err) {
    log.error("reminder callback failed", err);
    await tg.answerCallbackQuery(cq.id).catch(() => {});
  }
}

// Pick a downloadable image from a message: a photo (largest size) or an
// image document. Returns { fileId } or null.
function pickPhoto(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) {
    return { fileId: msg.photo[msg.photo.length - 1].file_id };
  }
  if (msg.document && /^image\//.test(msg.document.mime_type || "")) {
    return { fileId: msg.document.file_id };
  }
  return null;
}

function renderProfile(profile) {
  const lines = [
    profile.name ? `Имя: ${escapeHtml(profile.name)}` : null,
    profile.age ? `Возраст: ${escapeHtml(String(profile.age))}` : null,
    profile.language ? `Язык: ${escapeHtml(profile.language)}` : null,
    profile.style ? `Стиль общения: ${escapeHtml(profile.style)}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

export async function handleUpdate(update, base) {
  // Inline button presses on reminders (Stop / Snooze).
  if (update.callback_query) {
    return void (await handleReminderCallback(update.callback_query, base));
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  let text = (msg.text || msg.caption || "").trim();
  const originalText = text;
  const ctx = { ...base, chatId, userId: msg.from && msg.from.id };
  const tg = base.telegram;

  try {
    // Slash commands
    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
      if (cmd === "/start") return void (await tg.sendMessage(chatId, HELP.start(base.config.bot.name)));
      if (cmd === "/help") return void (await tg.sendMessage(chatId, HELP.help(base.config.bot.name)));
      if (cmd === "/reset") {
        await base.store.resetHistory(chatId);
        return void (await tg.sendMessage(chatId, "История диалога очищена."));
      }
      if (cmd === "/forget") {
        await base.store.clearMemory(chatId);
        return void (await tg.sendMessage(chatId, "Память обо мне очищена."));
      }
      if (cmd === "/memory") {
        const mem = await base.store.getMemory(chatId);
        const profile = renderProfile(mem.profile || {});
        const facts = mem.facts.length ? mem.facts.map((f, i) => `${i + 1}. ${escapeHtml(f.text)}`).join("\n") : "";
        const body = [profile, facts].filter(Boolean).join("\n\n") || "Пока ничего не запомнил.";
        return void (await tg.sendMessage(chatId, body));
      }
      if (cmd === "/reminders") {
        if (!base.reminders) return void (await tg.sendMessage(chatId, "Напоминания недоступны в этом режиме."));
        const list = await base.reminders.list(chatId);
        const body = list.length
          ? list.map((r) => `• ${new Date(r.dueTs).toISOString()} — ${escapeHtml(r.text)} [${r.id}]`).join("\n")
          : "Активных напоминаний нет.";
        return void (await tg.sendMessage(chatId, body));
      }
      if (cmd === "/diag") {
        await tg.sendChatAction(chatId, "typing");
        const out = [];
        try {
          await base.llm.groq.chat([{ role: "user", content: "Ответь одним словом: ок" }], { maxTokens: 16, temperature: 0 });
          out.push("GROQ groq/compound (мозг): ок");
        } catch (e) {
          out.push("GROQ: ОШИБКА — " + shortReason(e));
        }
        return void (await tg.sendMessage(chatId, out.join("\n")));
      }
      // Unknown command — fall through to the agent.
    }

    // Image recognition was removed (Gemini cut). A photo with no caption gets
    // a clear note; a photo with a caption is handled as plain text.
    const photo = pickPhoto(msg);
    if (photo && !originalText) {
      return void (await tg.sendMessage(chatId, "Сейчас я работаю только с текстом — изображения не распознаю."));
    }

    if (!text) {
      return void (await tg.sendMessage(chatId, "Пришли текст, ссылку или изображение."));
    }

    await tg.sendChatAction(chatId, "typing");
    const reply = await runAgent(ctx, text);

    for (const part of chunk(reply)) {
      await tg.sendMessage(chatId, toTelegramHtml(part));
    }

    // After replying, quietly update the user's memory file (fast model).
    try {
      await extractMemory(ctx, originalText);
    } catch (err) {
      log.warn("memory extraction failed", { error: err.message });
    }
  } catch (err) {
    log.error("handleUpdate failed", err);
    try {
      await tg.sendMessage(chatId, "Что-то пошло не так: " + shortReason(err));
    } catch {
      /* ignore */
    }
  }
}
