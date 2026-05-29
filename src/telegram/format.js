// Formatting helpers for Telegram HTML messages.

const TG_LIMIT = 4096;

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Convert a small subset of Markdown the model tends to emit into Telegram HTML.
// Everything else is HTML-escaped so user/model text never breaks the parser.
export function toTelegramHtml(text) {
  let out = escapeHtml(text);
  // Code blocks ```...``` -> <pre>
  out = out.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => `<pre>${code.replace(/&amp;/g, "&amp;")}</pre>`);
  // Inline code `...`
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // Bold **...**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  // Italic _..._
  out = out.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<i>$2</i>");
  return out;
}

// Split long text on paragraph/line/space boundaries to respect Telegram's
// 4096-character message limit.
export function chunk(text, limit = TG_LIMIT) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
