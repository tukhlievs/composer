// Web search and multi-step deep research. Retrieval uses DuckDuckGo's keyless
// HTML endpoint (no API key, no Tavily dependency); synthesis uses the
// configured LLM. The search backend is isolated here, so swapping it for a
// keyed provider later is a one-file change.

import { fetchWithTimeout } from "../utils/http.js";

const DDG_HTML = "https://html.duckduckgo.com/html/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function webSearch(config, query, { maxResults = 5 } = {}) {
  try {
    const region = (config.search && config.search.region) || "wt-wt";
    const body = new URLSearchParams({ q: query, kl: region }).toString();
    const res = await fetchWithTimeout(
      DDG_HTML,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          Accept: "text/html",
        },
        body,
      },
      20000
    );
    if (!res.ok) return { ok: false, error: `search HTTP ${res.status}`, results: [] };
    const html = await res.text();
    const results = parseDuckDuckGo(html).slice(0, maxResults);
    if (!results.length) return { ok: false, error: "no results", results: [] };
    // DuckDuckGo HTML has no synthesized answer; the LLM synthesizes from the
    // snippets where one is needed (e.g. deep_research).
    return { ok: true, answer: "", results };
  } catch (err) {
    return { ok: false, error: err.message, results: [] };
  }
}

// Parse the DuckDuckGo HTML results page into { title, url, content } items.
// Resilient to minor markup changes: anchors with class result__a carry the
// title + (possibly redirected) URL; result__snippet carries the description.
function parseDuckDuckGo(html) {
  const out = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [];
  let sm;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));
  let m;
  let i = 0;
  while ((m = linkRe.exec(html))) {
    const url = resolveDdgUrl(m[1]);
    const title = stripTags(m[2]);
    if (!url || !title) continue;
    out.push({ title, url, content: snippets[i] || "" });
    i++;
  }
  return out;
}

// DuckDuckGo wraps result links as /l/?uddg=<encoded>. Unwrap to the real URL.
function resolveDdgUrl(href) {
  try {
    let h = href.replace(/&amp;/g, "&");
    if (h.startsWith("//")) h = "https:" + h;
    const u = new URL(h, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (/^https?:$/.test(u.protocol) && !/duckduckgo\.com$/.test(u.hostname)) return u.toString();
    return uddg || h;
  } catch {
    return href;
  }
}

function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Deep research: the LLM proposes focused sub-queries, we search each, then the
// LLM writes a structured, cited report. Returns markdown text.
export async function deepResearch(config, llm, topic, { rounds = 3 } = {}) {
  const planRaw = await llm.chat(
    [
      { role: "system", content: "You break a research topic into focused web-search sub-queries. Reply with a JSON array of strings only." },
      { role: "user", content: `Topic: ${topic}\nReturn ${rounds} distinct, specific search queries as a JSON array.` },
    ],
    { task: "plan", temperature: 0.3, maxTokens: 300, json: true }
  );

  let queries = [];
  try {
    const parsed = JSON.parse(planRaw.match(/\[[\s\S]*\]/)?.[0] || planRaw);
    if (Array.isArray(parsed)) queries = parsed.slice(0, rounds).map(String);
  } catch {
    queries = [topic];
  }
  if (queries.length === 0) queries = [topic];

  const findings = [];
  for (const q of queries) {
    const res = await webSearch(config, q, { maxResults: 5 });
    if (res.ok) {
      findings.push({
        query: q,
        answer: res.answer,
        sources: res.results.map((r) => `- ${r.title} (${r.url}): ${truncate(r.content, 400)}`).join("\n"),
      });
    }
  }

  if (findings.length === 0) {
    return { ok: false, error: "No search results were retrievable.", report: "" };
  }

  const context = findings
    .map((f, i) => `### Sub-query ${i + 1}: ${f.query}\nKey answer: ${f.answer}\nSources:\n${f.sources}`)
    .join("\n\n");

  const report = await llm.chat(
    [
      {
        role: "system",
        content:
          "You are a meticulous research analyst. Using only the supplied findings, write a structured, well-organised report in the SAME LANGUAGE as the topic. Include a short summary, themed sections, and a Sources list with URLs. Be concrete and avoid inventing facts.",
      },
      { role: "user", content: `Research topic: ${topic}\n\nFindings:\n${context}\n\nWrite the report now.` },
    ],
    { task: "report", temperature: 0.4, maxTokens: 2800 }
  );

  const allSources = findings.flatMap((f) => f.sources.split("\n")).filter(Boolean);
  return { ok: true, report, sourceCount: allSources.length };
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
