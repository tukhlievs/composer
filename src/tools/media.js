// Media downloading via a Cobalt instance (https://github.com/imputnet/cobalt).
//
// WHY COBALT AND NOT yt-dlp DIRECTLY:
// Cloudflare Workers run in a V8 isolate with no filesystem and no ability to
// spawn native processes, so yt-dlp / ffmpeg cannot execute here. Cobalt is the
// modern, self-hostable HTTP service that wraps that exact capability (it uses
// yt-dlp-class extractors under the hood) and supports YouTube, Instagram,
// Pinterest, TikTok, SoundCloud, Twitter and more. The Worker stays the
// orchestrator and offloads the heavy extraction to Cobalt over HTTPS.

import { requestJson } from "../utils/http.js";

export async function cobaltResolve(config, url, { mode = "auto", audioFormat = "mp3", videoQuality = "1080" } = {}) {
  if (!config.cobalt.apiUrl) {
    return { kind: "error", error: "Media service is not configured (COBALT_API_URL is empty)." };
  }
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (config.cobalt.apiKey) headers.Authorization = `Api-Key ${config.cobalt.apiKey}`;

  let data;
  try {
    data = await requestJson(config.cobalt.apiUrl + "/", {
      method: "POST",
      headers,
      body: { url, downloadMode: mode, audioFormat, videoQuality, filenameStyle: "basic" },
      timeoutMs: 45000,
      retries: 1,
    });
  } catch (err) {
    return { kind: "error", error: `Media service unreachable: ${err.message}` };
  }

  switch (data.status) {
    case "tunnel":
    case "redirect":
      return { kind: "single", url: data.url, filename: data.filename || "media" };
    case "picker":
      return {
        kind: "picker",
        items: (data.picker || []).map((p) => ({ type: p.type || "photo", url: p.url })),
        audio: data.audio || null,
      };
    case "stream":
      return { kind: "single", url: data.url, filename: data.filename || "media" };
    case "error":
    default:
      return { kind: "error", error: (data.error && (data.error.code || data.error.text)) || "unknown media error" };
  }
}

// Heuristic: figure out what platform a URL points at, for nicer messages.
export function detectPlatform(url) {
  const u = url.toLowerCase();
  if (/youtu\.?be/.test(u)) return "YouTube";
  if (/instagram\.com/.test(u)) return "Instagram";
  if (/pin(terest)?\.|pin\.it/.test(u)) return "Pinterest";
  if (/tiktok\.com/.test(u)) return "TikTok";
  if (/soundcloud\.com/.test(u)) return "SoundCloud";
  if (/(twitter|x)\.com/.test(u)) return "X";
  return "the web";
}
