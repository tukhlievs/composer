// Music: find a track from a free-text query (or a direct link) and return its
// audio. This is a thin wrapper over our yt-dlp downloader — yt-dlp does the
// search (ytsearch) AND the audio extraction, so there is no dependency on any
// external search or download service.

import { searchAndDownloadAudio } from "./ytdlp.js";

export async function resolveMusic(config, query) {
  return searchAndDownloadAudio(config, query);
}
