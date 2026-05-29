// Uploads every secret in .env to the Cloudflare secret store via
// `wrangler secret put`. Keys already declared as [vars] in wrangler.toml are
// skipped, because Cloudflare forbids a name being both a var and a secret.
//
// Usage: npm run secrets   (run after `wrangler login` and after editing .env)

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync(".env")) {
  console.error("[sync-secrets] .env not found. Copy .env.example to .env first.");
  process.exit(1);
}

// Collect [vars] keys from wrangler.toml to avoid var/secret collisions.
const varKeys = new Set();
if (existsSync("wrangler.toml")) {
  const toml = readFileSync("wrangler.toml", "utf8");
  const varsBlock = toml.split(/\[vars\]/)[1];
  if (varsBlock) {
    for (const line of varsBlock.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break; // next section
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m) varKeys.add(m[1]);
    }
  }
}

const entries = [];
for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const value = trimmed.slice(eq + 1).trim();
  if (!value) continue;
  if (varKeys.has(key)) {
    console.log(`[sync-secrets] skipping ${key} (declared as a var in wrangler.toml)`);
    continue;
  }
  entries.push([key, value]);
}

if (!entries.length) {
  console.error("[sync-secrets] No secrets with values found in .env.");
  process.exit(1);
}

for (const [key, value] of entries) {
  console.log(`[sync-secrets] uploading ${key} …`);
  const res = spawnSync("npx", ["wrangler", "secret", "put", key], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (res.status !== 0) {
    console.error(`[sync-secrets] failed on ${key}. Aborting.`);
    process.exit(res.status || 1);
  }
}
console.log(`[sync-secrets] done — ${entries.length} secret(s) uploaded.`);
