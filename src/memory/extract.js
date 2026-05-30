// After each reply, quietly mine the user's message for durable personal info
// and merge it into their memory file. Runs on the fast model (Gemini, task
// "fast") so it adds little latency. Strictly conservative: only stores what the
// user explicitly stated about themselves.

function safeJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

export async function extractMemory(ctx, userText) {
  const text = (userText || "").trim();
  if (text.length < 4 || text.startsWith("/")) return;

  const mem = await ctx.store.getMemory(ctx.chatId);
  const known = JSON.stringify(mem.profile || {});

  let raw;
  try {
    raw = await ctx.llm.chat(
      [
        {
          role: "system",
          content:
            "You extract durable personal information a user explicitly reveals about themselves. " +
            "Output JSON only, no prose. Never infer or guess; if something is not explicitly stated, use null or an empty array.",
        },
        {
          role: "user",
          content:
            `Known profile (do not repeat unchanged values): ${known}\n\n` +
            `User message:\n"""${text.slice(0, 1500)}"""\n\n` +
            `Return exactly: {"name": string|null, "age": number|null, "language": string|null, ` +
            `"style": string|null, "facts": string[]}\n` +
            `- name/age/language/style: only if the user states them about themselves.\n` +
            `- style: a short phrase describing how they want to be talked to, if expressed.\n` +
            `- facts: other durable preferences/details they explicitly shared (max 3, short).`,
        },
      ],
      { task: "fast", temperature: 0, maxTokens: 280, json: true }
    );
  } catch {
    return; // extraction is best-effort; never break the turn
  }

  const data = safeJson(raw);
  if (!data) return;

  const patch = {};
  if (data.name && typeof data.name === "string") patch.name = data.name.trim().slice(0, 80);
  if (data.age != null && Number.isFinite(Number(data.age))) {
    const age = Number(data.age);
    if (age > 0 && age < 120) patch.age = age;
  }
  if (data.language && typeof data.language === "string") patch.language = data.language.trim().slice(0, 40);
  if (data.style && typeof data.style === "string") patch.style = data.style.trim().slice(0, 200);
  if (Object.keys(patch).length) await ctx.store.setProfile(ctx.chatId, patch);

  if (Array.isArray(data.facts)) {
    for (const f of data.facts.slice(0, 3)) {
      if (f && typeof f === "string" && f.trim().length > 2) {
        await ctx.store.addFact(ctx.chatId, f.trim().slice(0, 200));
      }
    }
  }
}
