// Music: find a track from a free-text query, then extract audio.
//
// Cobalt downloads audio from a known URL but does not search, so for a plain
// query ("artist - title") we first locate a source URL with web search
// (restricted to YouTube / SoundCloud) and then hand that URL to Cobalt for
// audio extraction. A direct link can be passed straight through.

import { webSearch } from "./research.js";
import { cobaltResolve } from "./media.js";

const SOURCE_RE = /(https?:\/\/[^\s)]+(?:youtube\.com\/watch|youtu\.be\/|soundcloud\.com\/)[^\s)]*)/i;

export async function findTrackUrl(config, query) {
  // Direct URL provided.
  const direct = query.match(/https?:\/\/\S+/);
  if (direct) return direct[0];

  if (!config.research.tavilyKey) {
    return null;
  }
  const res = await webSearch(config, `${query} site:youtube.com OR site:soundcloud.com`, { maxResults: 6 });
  if (!res.ok) return null;
  for (const r of res.results) {
    const m = `${r.url}`.match(SOURCE_RE);
    if (m) return m[1];
  }
  // Fall back to the first plausible result URL.
  const first = res.results.find((r) => /youtube\.com|youtu\.be|soundcloud\.com/.test(r.url));
  return first ? first.url : null;
}

export async function resolveMusic(config, query, { audioFormat = "mp3" } = {}) {
  const url = await findTrackUrl(config, query);
  if (!url) return { kind: "error", error: "Could not find a downloadable source for that track." };
  const out = await cobaltResolve(config, url, { mode: "audio", audioFormat });
  if (out.kind === "single") out.sourceUrl = url;
  return out;
}
