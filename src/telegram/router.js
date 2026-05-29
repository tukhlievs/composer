// Parses a Telegram update, handles slash-commands, and dispatches everything
// else to the agent. Replies are HTML-formatted and chunked to fit limits.

import { runAgent } from "../agent/run.js";
import { toTelegramHtml, chunk, escapeHtml } from "./format.js";
import { log } from "../utils/log.js";

const HELP = {
  start: (name) =>
    `Привет! Я ${name} — мультиинструментальный ИИ-ассистент.\n\n` +
    `Что я умею: искать и скачивать музыку, видео из YouTube, Instagram, Pinterest и TikTok, ` +
    `проводить глубокое исследование (deep research), делать PDF-отчёты, планировать задачи и ` +
    `запоминать важное о тебе.\n\n` +
    `Просто напиши, что нужно, или пришли ссылку. /help — список команд.\n\n` +
    `Hi! I'm ${name}, a multi-tool AI assistant. Send a request or a link. /help for commands.`,
  help: (name) =>
    `<b>${name}</b> — команды:\n` +
    `/start — приветствие\n` +
    `/help — эта справка\n` +
    `/memory — что я о тебе помню\n` +
    `/forget — стереть память обо мне\n` +
    `/reset — очистить историю диалога\n\n` +
    `В обычных сообщениях: ссылка на видео/трек → скачаю; «найди и скачай …» → музыка; ` +
    `«исследуй …» → deep research; «сделай PDF …» → отчёт; «запомни …» → память.`,
};

export async function handleUpdate(update, base) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const text = (msg.text || msg.caption || "").trim();
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
        const body = mem.facts.length
          ? mem.facts.map((f, i) => `${i + 1}. ${escapeHtml(f.text)}`).join("\n")
          : "Пока ничего не запомнил.";
        return void (await tg.sendMessage(chatId, body));
      }
      // Unknown command — fall through to the agent.
    }

    if (!text) {
      return void (await tg.sendMessage(chatId, "Пришли текст или ссылку — пока я работаю с текстовыми сообщениями."));
    }

    await tg.sendChatAction(chatId, "typing");
    const reply = await runAgent(ctx, text);

    for (const part of chunk(reply)) {
      await tg.sendMessage(chatId, toTelegramHtml(part));
    }
  } catch (err) {
    log.error("handleUpdate failed", err);
    try {
      await tg.sendMessage(chatId, "Что-то пошло не так при обработке запроса. Попробуй ещё раз чуть позже.");
    } catch {
      /* ignore */
    }
  }
}
