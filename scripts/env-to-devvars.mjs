// Bridges the single .env source of truth to Wrangler's local-dev format.
// Wrangler reads secrets for `wrangler dev` from .dev.vars, not .env, so we
// regenerate .dev.vars from .env before every dev run (npm "predev" hook).
// You only ever edit .env.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENV_PATH = ".env";
const OUT_PATH = ".dev.vars";

if (!existsSync(ENV_PATH)) {
  console.warn("[env-to-devvars] .env not found — copy .env.example to .env and fill it in.");
  process.exit(0);
}

const lines = readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
const kept = [];
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (!value) continue; // skip empty keys so they fall back to wrangler.toml [vars]
  kept.push(`${key}=${value}`);
}

writeFileSync(OUT_PATH, kept.join("\n") + "\n");
console.log(`[env-to-devvars] wrote ${kept.length} variables to ${OUT_PATH}`);
