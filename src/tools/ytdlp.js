// Our own content-download system, built directly on yt-dlp — no third-party
// HTTP services (Cobalt is gone). yt-dlp is the de-facto standard extractor for
// YouTube and many other sites; paired with ffmpeg it can also extract audio
// and merge separate video/audio streams.
//
// RUNTIME NOTE — Node only:
// yt-dlp is a native program, so it needs a real process with a filesystem and
// the ability to spawn children. That exists in the Node long-polling runtime
// (`npm start`), NOT in the Cloudflare Workers V8 isolate. On Workers these
// functions return a clear "Node runtime required" error instead of crashing,
// and `child_process` is imported dynamically so it never breaks the Worker
// bundle. Install yt-dlp and ffmpeg on the host that runs the Node mode.

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- runtime detection -------------------------------------------------------
// Dynamically resolve child_process so importing this file is safe on Workers.
let _spawnPromise;
function loadSpawn() {
  if (_spawnPromise === undefined) {
    _spawnPromise = import("node:child_process")
      .then((m) => m.spawn)
      .catch(() => null);
  }
  return _spawnPromise;
}

// True only when a real Node process with child_process is available.
export async function ytdlpRuntimeAvailable() {
  if (typeof process === "undefined" || !(process.versions && process.versions.node)) return false;
  return (await loadSpawn()) != null;
}

// --- low-level runner --------------------------------------------------------
// Spawn yt-dlp with args, capture stdout/stderr, resolve { code, stdout, stderr }.
async function runYtdlp(bin, args, { timeoutMs = 120000, cwd } = {}) {
  const spawn = await loadSpawn();
  if (!spawn) throw new Error("child_process unavailable (not a Node runtime)");
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true });
    } catch (err) {
      return reject(err);
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout && child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr && child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      // ENOENT = the yt-dlp binary is not installed / not on PATH.
      if (err && err.code === "ENOENT") {
        reject(new Error(`yt-dlp not found (looked for "${bin}"). Install it: pip install yt-dlp`));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// --- quality parsing ---------------------------------------------------------
// Turn a free-text quality/mode hint into a structured spec. Only honour what
// the user actually asked for; otherwise fall back to sensible defaults.
//   "audio" | "mp3" | "звук"      -> audio-only
//   "mute" | "без звука"          -> video without audio
//   "1080" | "720p" | "480"       -> cap video height
//   "best" | "" | anything else   -> best video up to the configured default
export function parseQuality(input) {
  const s = String(input || "").toLowerCase().trim();
  // NB: JS \b word boundaries are ASCII-only, so they don't work around
  // Cyrillic — we match these keywords as plain substrings instead.
  if (!s || s === "auto" || s === "video" || s === "видео") return { audio: false, mute: false, maxHeight: null };
  // "mute" must be checked before "audio": "без звука" also contains "звук".
  if (/(mute|muted|немой|без\s*звук)/.test(s)) return { audio: false, mute: true, maxHeight: heightOf(s) };
  if (/(audio|mp3|m4a|sound|звук|аудио|песн|музык)/.test(s)) return { audio: true, mute: false, maxHeight: null };
  if (s === "best" || s === "max" || s === "макс") return { audio: false, mute: false, maxHeight: null };
  return { audio: false, mute: false, maxHeight: heightOf(s) };
}

function heightOf(s) {
  const m = s.match(/(\d{3,4})\s*p?/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 144 && n <= 4320 ? n : null;
}

// Optional cookies, to pass YouTube's bot check on datacenter IPs.
function cookieArgs(config) {
  const c = config.ytdlp || {};
  if (c.cookies) return ["--cookies", c.cookies];
  if (c.cookiesFromBrowser) return ["--cookies-from-browser", c.cookiesFromBrowser];
  return [];
}

// --- format selection --------------------------------------------------------
function buildFormatArgs(spec, defaultHeight) {
  if (spec.audio) {
    // Extract audio and transcode to mp3 (needs ffmpeg).
    return ["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
  }
  const h = spec.maxHeight || defaultHeight || 1080;
  if (spec.mute) {
    // Video-only (no audio track).
    return ["-f", `bv*[height<=${h}]/bv*/b[height<=${h}]/b`, "--merge-output-format", "mp4"];
  }
  // Video with audio, capped at the requested/default height. Prefer mp4 so
  // Telegram can stream it; merge with ffmpeg when streams are separate.
  return [
    "-f",
    `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`,
    "--merge-output-format",
    "mp4",
  ];
}

// --- main entry points -------------------------------------------------------
// Download a video (or its audio) from a URL and return the bytes so the caller
// can upload them to Telegram. `target` may also be a yt-dlp search term such
// as "ytsearch1:daft punk one more time".
export async function downloadMedia(config, target, { quality } = {}) {
  if (!(await ytdlpRuntimeAvailable())) {
    return { kind: "error", error: "Скачивание доступно только в Node-режиме (yt-dlp нельзя запустить на Cloudflare Workers)." };
  }
  const bin = (config.ytdlp && config.ytdlp.bin) || "yt-dlp";
  const maxMb = (config.ytdlp && config.ytdlp.maxFilesizeMb) || 50;
  const defaultHeight = (config.ytdlp && config.ytdlp.defaultHeight) || 1080;
  const spec = parseQuality(quality);

  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), "composer-dl-"));
  } catch (err) {
    return { kind: "error", error: `Не удалось создать временную папку: ${err.message}` };
  }

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--restrict-filenames",
    "--max-filesize",
    `${maxMb}M`,
    ...cookieArgs(config),
    "-o",
    join(dir, "%(title).80s.%(ext)s"),
    ...buildFormatArgs(spec, defaultHeight),
    target,
  ];

  try {
    const { code, stderr } = await runYtdlp(bin, args, { timeoutMs: 150000, cwd: dir });
    const produced = await pickOutputFile(dir);

    if (!produced) {
      // No file: distinguish a too-large file from a genuine failure.
      if (/file is larger than|max-filesize|larger than the/i.test(stderr)) {
        return {
          kind: "error",
          error: `Файл больше лимита ${maxMb} МБ — Telegram не примет его загрузкой. Попроси аудио или меньшее качество (например, 480p).`,
          tooLarge: true,
        };
      }
      // YouTube bot-gate on shared/datacenter IPs — point at the cookies fix.
      if (/confirm you.?re not a bot|sign in to confirm/i.test(stderr)) {
        return {
          kind: "error",
          error: "YouTube требует подтверждения («не робот»). Настрой cookies для yt-dlp: переменная YTDLP_COOKIES (путь к cookies.txt) или YTDLP_COOKIES_FROM_BROWSER.",
        };
      }
      return { kind: "error", error: cleanYtdlpError(stderr) || `yt-dlp завершился с кодом ${code}` };
    }

    const info = await stat(produced.path);
    if (info.size > maxMb * 1024 * 1024) {
      return {
        kind: "error",
        error: `Файл ~${Math.round(info.size / 1024 / 1024)} МБ, это больше лимита Telegram (${maxMb} МБ). Попроси аудио или качество пониже.`,
        tooLarge: true,
      };
    }

    const bytes = new Uint8Array(await readFile(produced.path));
    return {
      kind: "single",
      bytes,
      filename: produced.name,
      audio: spec.audio,
      contentType: spec.audio ? "audio/mpeg" : "video/mp4",
    };
  } catch (err) {
    return { kind: "error", error: err.message };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Find a music track by free-text query (or a direct URL) and return its audio
// bytes. Uses yt-dlp's built-in YouTube search — no external search service.
export async function searchAndDownloadAudio(config, query) {
  const direct = String(query || "").match(/https?:\/\/\S+/);
  const target = direct ? direct[0] : `ytsearch1:${String(query || "").trim()}`;
  if (!direct && !String(query || "").trim()) {
    return { kind: "error", error: "Пустой запрос." };
  }
  return downloadMedia(config, target, { quality: "audio" });
}

// Pick the single produced media file out of the temp dir, ignoring sidecar
// artefacts (.part, .ytdl, thumbnails, subtitles).
async function pickOutputFile(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const ignore = /\.(part|ytdl|temp|json|jpg|jpeg|png|webp|vtt|srt)$/i;
  const candidates = names.filter((n) => !ignore.test(n));
  if (!candidates.length) return null;
  // If multiple, prefer the largest (the merged/transcoded output).
  let best = null;
  for (const name of candidates) {
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (s.isFile() && (!best || s.size > best.size)) best = { name, path, size: s.size };
    } catch {
      /* ignore */
    }
  }
  return best;
}

// Trim yt-dlp's stderr to a short, user-safe reason.
function cleanYtdlpError(stderr) {
  const line = String(stderr || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^ERROR:/i.test(l))
    .pop();
  if (!line) return "";
  return line.replace(/^ERROR:\s*/i, "").slice(0, 240);
}

// Friendly platform label for messages. Instagram/Pinterest support is
// postponed, so they are intentionally not listed here.
export function detectPlatform(url) {
  const u = String(url || "").toLowerCase();
  if (/youtu\.?be/.test(u)) return "YouTube";
  if (/tiktok\.com/.test(u)) return "TikTok";
  if (/soundcloud\.com/.test(u)) return "SoundCloud";
  if (/(twitter|x)\.com/.test(u)) return "X";
  return "веб";
}
