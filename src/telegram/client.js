// Telegram Bot API client. Sends text/media. Files can be passed either as a
// URL string (Telegram fetches it; ~20 MB limit) or as a Blob (multipart
// upload; ~50 MB limit).

import { fetchWithTimeout } from "../utils/http.js";

// Base64-encode bytes in chunks (avoids call-stack limits on large images).
function toBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function guessMime(path) {
  const p = path.toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  if (p.endsWith(".heic")) return "image/heic";
  return "image/jpeg";
}

export class Telegram {
  constructor(token) {
    this.token = token;
    this.base = `https://api.telegram.org/bot${token}`;
    this.fileBase = `https://api.telegram.org/file/bot${token}`;
  }

  // Resolve a file_id to a downloadable path.
  getFile(fileId) {
    return this.call("getFile", { file_id: fileId });
  }

  // Download a Telegram file (by file_path) and return its bytes as base64,
  // for feeding images to a vision model.
  async downloadFile(filePath) {
    const res = await fetchWithTimeout(`${this.fileBase}/${filePath}`, {}, 30000);
    if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, base64: toBase64(bytes), mimeType: guessMime(filePath) };
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

  // Video from in-memory bytes (e.g. a yt-dlp download). Multipart upload, so
  // the ~50 MB bot limit applies (vs ~20 MB for send-by-URL).
  sendVideoBlob(chatId, bytes, filename, opts = {}) {
    const blob = new Blob([bytes], { type: opts.contentType || "video/mp4" });
    return this.callMultipart(
      "sendVideo",
      { chat_id: chatId, caption: opts.caption, supports_streaming: true },
      { field: "video", blob, filename }
    );
  }

  // Audio from in-memory bytes (e.g. an extracted mp3).
  sendAudioBlob(chatId, bytes, filename, opts = {}) {
    const blob = new Blob([bytes], { type: opts.contentType || "audio/mpeg" });
    return this.callMultipart(
      "sendAudio",
      { chat_id: chatId, caption: opts.caption, title: opts.title, performer: opts.performer },
      { field: "audio", blob, filename }
    );
  }

  setWebhook(url, secretToken) {
    return this.call("setWebhook", {
      url,
      secret_token: secretToken || undefined,
      allowed_updates: ["message", "edited_message", "callback_query"],
    });
  }

  // Acknowledge a button press (removes the client-side spinner; optional toast).
  answerCallbackQuery(id, text) {
    return this.call("answerCallbackQuery", { callback_query_id: id, text });
  }

  // Replace/remove a message's inline keyboard. Pass undefined replyMarkup to remove it.
  editMessageReplyMarkup(chatId, messageId, replyMarkup) {
    return this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }

  editMessageText(chatId, messageId, text, opts = {}) {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: opts.parseMode || "HTML",
      reply_markup: opts.replyMarkup,
    });
  }

  deleteWebhook(dropPending = false) {
    return this.call("deleteWebhook", { drop_pending_updates: dropPending });
  }

  // Long-poll for updates. The HTTP timeout is kept comfortably above the
  // long-poll window so the connection isn't aborted mid-wait.
  async getUpdates(offset, timeoutSec = 25) {
    const res = await fetchWithTimeout(
      `${this.base}/getUpdates`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset,
          timeout: timeoutSec,
          allowed_updates: ["message", "edited_message", "callback_query"],
        }),
      },
      (timeoutSec + 15) * 1000
    );
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram getUpdates failed: ${data.description || res.status}`);
    return data.result;
  }
}
