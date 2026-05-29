// Reads and validates configuration from the Worker `env` object.
//
// In production, secrets are injected by Cloudflare (uploaded from .env via
// `npm run secrets`). Locally, Wrangler reads .dev.vars, which is generated
// from the same .env by `npm run predev`. Either way .env is the only file a
// human edits.

const REQUIRED_SECRETS = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY", "OPENROUTER_MODEL"];

export function loadConfig(env) {
  const cfg = {
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
    },
    openrouter: {
      apiKey: env.OPENROUTER_API_KEY,
      // The model id is intentionally read only here and never surfaced to users.
      model: env.OPENROUTER_MODEL,
      appUrl: env.OPENROUTER_APP_URL || "https://github.com/tukhlievs/composer",
      appTitle: env.OPENROUTER_APP_TITLE || "Composer",
    },
    cobalt: {
      apiUrl: (env.COBALT_API_URL || "").replace(/\/+$/, ""),
      apiKey: env.COBALT_API_KEY || "",
    },
    research: {
      tavilyKey: env.TAVILY_API_KEY || "",
    },
    pdf: {
      fontUrl: env.PDF_FONT_URL,
      fontBoldUrl: env.PDF_FONT_BOLD_URL || env.PDF_FONT_URL,
    },
    bot: {
      name: env.BOT_NAME || "Composer",
      maxSteps: clampInt(env.AGENT_MAX_STEPS, 6, 1, 12),
      historyLimit: clampInt(env.HISTORY_LIMIT, 16, 2, 60),
    },
    kv: env.COMPOSER_KV || null,
  };
  return cfg;
}

export function validateConfig(env) {
  const missing = REQUIRED_SECRETS.filter((k) => !env[k]);
  if (!env.COMPOSER_KV) missing.push("COMPOSER_KV (KV binding)");
  return missing;
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
