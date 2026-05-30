// Web search and multi-step deep research, powered by Tavily for retrieval and
// the configured LLM for synthesis.

import { requestJson } from "../utils/http.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";

export async function webSearch(config, query, { maxResults = 5, depth = "basic" } = {}) {
  if (!config.research.tavilyKey) {
    return { ok: false, error: "Search is not configured (TAVILY_API_KEY is empty).", results: [] };
  }
  try {
    const data = await requestJson(TAVILY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        api_key: config.research.tavilyKey,
        query,
        search_depth: depth,
        max_results: maxResults,
        include_answer: true,
      },
      timeoutMs: 30000,
      retries: 1,
    });
    return {
      ok: true,
      answer: data.answer || "",
      results: (data.results || []).map((r) => ({ title: r.title, url: r.url, content: r.content })),
    };
  } catch (err) {
    return { ok: false, error: err.message, results: [] };
  }
}

// Deep research: the LLM proposes focused sub-queries, we search each, then the
// LLM writes a structured, cited report. Returns markdown text.
export async function deepResearch(config, llm, topic, { rounds = 3 } = {}) {
  const planRaw = await llm.chat(
    [
      { role: "system", content: "You break a research topic into focused web-search sub-queries. Reply with a JSON array of strings only." },
      { role: "user", content: `Topic: ${topic}\nReturn ${rounds} distinct, specific search queries as a JSON array.` },
    ],
    { task: "fast", temperature: 0.3, maxTokens: 300, json: true }
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
    const res = await webSearch(config, q, { maxResults: 5, depth: "advanced" });
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
    { task: "reasoning", temperature: 0.4, maxTokens: 1800 }
  );

  const allSources = findings.flatMap((f) => f.sources.split("\n")).filter(Boolean);
  return { ok: true, report, sourceCount: allSources.length };
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}
