// Minimal structured logger. Never logs secrets or the underlying model id.
const SENSITIVE = /(token|key|secret|authorization|model)/i;

function redact(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE.test(k)) out[k] = "[redacted]";
    else if (v && typeof v === "object") out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

export const log = {
  info(msg, meta) {
    console.log(JSON.stringify({ level: "info", msg, ...(meta ? { meta: redact(meta) } : {}) }));
  },
  warn(msg, meta) {
    console.warn(JSON.stringify({ level: "warn", msg, ...(meta ? { meta: redact(meta) } : {}) }));
  },
  error(msg, err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg,
        error: err && err.message ? err.message : String(err),
      })
    );
  },
};
