// Reads and validates configuration from the Worker `env` object.
//
// In production, secrets are injected by Cloudflare (uploaded from .env via
// `npm run secrets`). Locally, Wrangler reads .dev.vars, which is generated
// from the same .env by `npm run predev`. Either way .env is the only file a
// human edits.

// OpenRouter is the text brain (model hardcoded in src/llm/openrouter.js, so
// OPENROUTER_MODEL is not required). Gemini is removed; GROQ is off.
const REQUIRED_SECRETS = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API"];

export function loadConfig(env) {
  const cfg = {
    telegram: {
      token: env.TELEGRAM_BOT_TOKEN,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || "",
    },
    // OpenRouter: the text brain. Model is hardcoded in src/llm/openrouter.js,
    // so OPENROUTER_MODEL env is ignored.
    openrouter: {
      apiKey: env.OPENROUTER_API,
      appUrl: env.OPENROUTER_APP_URL || "https://github.com/tukhlievs/composer",
      appTitle: env.OPENROUTER_APP_TITLE || "Composer",
    },
    // GROQ: kept in code but disabled. Only used if providerForTask returns "groq".
    groq: {
      apiKey: env.GROQ_API,
    },
    // Our own download system. yt-dlp + ffmpeg run as native processes, so this
    // only works in the Node runtime (not Workers). No API keys needed.
    ytdlp: {
      bin: env.YTDLP_BIN || "yt-dlp",
      maxFilesizeMb: clampInt(env.YTDLP_MAX_FILESIZE_MB, 50, 1, 2000),
      defaultHeight: clampInt(env.YTDLP_DEFAULT_HEIGHT, 1080, 144, 4320),
      // Optional cookies to defeat YouTube's "confirm you're not a bot" gate on
      // datacenter IPs: a Netscape cookies.txt path, or a browser name to read
      // cookies from (chrome/firefox/edge/…). Leave empty if not needed.
      cookies: env.YTDLP_COOKIES || "",
      cookiesFromBrowser: env.YTDLP_COOKIES_FROM_BROWSER || "",
    },
    // Keyless web search (DuckDuckGo). `region` maps to DuckDuckGo's kl param.
    search: {
      region: env.SEARCH_REGION || "wt-wt",
    },
    pdf: {
      fontUrl: env.PDF_FONT_URL,
      fontBoldUrl: env.PDF_FONT_BOLD_URL || env.PDF_FONT_URL,
      // Monospace font for code blocks; falls back to the regular font.
      fontMonoUrl: env.PDF_FONT_MONO_URL || env.PDF_FONT_URL,
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
  // KV is optional in this temporary mode — the store falls back to in-memory.
  return REQUIRED_SECRETS.filter((k) => !env[k]);
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
