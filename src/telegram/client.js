// Telegram Bot API client. Sends text/media. Files can be passed either as a
// URL string (Telegram fetches it; ~20 MB limit) or as a Blob (multipart
// upload; ~50 MB limit).

import { fetchWithTimeout } from "../utils/http.js";

export class Telegram {
  constructor(token) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async call(method, payload = {}) {
    const res = await fetchWithTimeout(
      `${this.base}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      30000
    );
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
    return data.result;
  }

  async callMultipart(method, fields, file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) form.append(k, String(v));
    }
    if (file) form.append(file.field, file.blob, file.filename);
    const res = await fetchWithTimeout(`${this.base}/${method}`, { method: "POST", body: form }, 60000);
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
    return data.result;
  }

  sendChatAction(chatId, action = "typing") {
    return this.call("sendChatAction", { chat_id: chatId, action }).catch(() => {});
  }

  sendMessage(chatId, text, opts = {}) {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: opts.parseMode || "HTML",
      disable_web_page_preview: opts.preview === true ? false : true,
      reply_markup: opts.replyMarkup,
    });
  }

  // Media by URL — Telegram downloads the file itself.
  sendAudioUrl(chatId, url, opts = {}) {
    return this.call("sendAudio", { chat_id: chatId, audio: url, title: opts.title, performer: opts.performer, caption: opts.caption });
  }
  sendVideoUrl(chatId, url, opts = {}) {
    return this.call("sendVideo", { chat_id: chatId, video: url, caption: opts.caption, supports_streaming: true });
  }
  sendDocumentUrl(chatId, url, opts = {}) {
    return this.call("sendDocument", { chat_id: chatId, document: url, caption: opts.caption });
  }

  // Document from in-memory bytes (e.g. generated PDF).
  sendDocumentBlob(chatId, bytes, filename, opts = {}) {
    const blob = new Blob([bytes], { type: opts.contentType || "application/octet-stream" });
    return this.callMultipart(
      "sendDocument",
      { chat_id: chatId, caption: opts.caption },
      { field: "document", blob, filename }
    );
  }

  setWebhook(url, secretToken) {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken || undefined,
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
  }
}
