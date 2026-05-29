// KV-backed persistence for everything the agent must remember between turns:
//   mem:{chatId}    -> { profile, facts: [{id, text, ts}] }   long-term memory
//   kb:{chatId}     -> [{ id, title, content, ts }]            knowledge base
//   plan:{chatId}   -> { goal, steps: [{text, done}], ts }     current plan
//   hist:{chatId}   -> [{ role, content }]                     chat history
//
// KV has no query engine, so knowledge search is a keyword scan over a small
// per-chat list. For larger scale, swap this layer for D1 (schema in README).

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export class Store {
  constructor(kv, { historyLimit = 16 } = {}) {
    this.kv = kv;
    this.historyLimit = historyLimit;
  }

  async #get(key, fallback) {
    const raw = await this.kv.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  #put(key, value) {
    return this.kv.put(key, JSON.stringify(value));
  }

  // ---- Long-term memory ----------------------------------------------------
  async getMemory(chatId) {
    return this.#get(`mem:${chatId}`, { profile: {}, facts: [] });
  }
  async addFact(chatId, text) {
    const mem = await this.getMemory(chatId);
    const clean = String(text).trim();
    if (!clean) return mem;
    // De-duplicate near-identical facts.
    if (!mem.facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) {
      mem.facts.push({ id: uid(), text: clean, ts: Date.now() });
      if (mem.facts.length > 100) mem.facts = mem.facts.slice(-100);
      await this.#put(`mem:${chatId}`, mem);
    }
    return mem;
  }
  async setProfile(chatId, patch) {
    const mem = await this.getMemory(chatId);
    mem.profile = { ...mem.profile, ...patch };
    await this.#put(`mem:${chatId}`, mem);
    return mem;
  }
  async forgetFact(chatId, idOrIndex) {
    const mem = await this.getMemory(chatId);
    const before = mem.facts.length;
    if (/^\d+$/.test(String(idOrIndex))) {
      const i = parseInt(idOrIndex, 10) - 1;
      if (i >= 0 && i < mem.facts.length) mem.facts.splice(i, 1);
    } else {
      mem.facts = mem.facts.filter((f) => f.id !== idOrIndex);
    }
    await this.#put(`mem:${chatId}`, mem);
    return before !== mem.facts.length;
  }
  async clearMemory(chatId) {
    await this.kv.delete(`mem:${chatId}`);
  }

  // ---- Knowledge base ------------------------------------------------------
  async addKnowledge(chatId, title, content) {
    const items = await this.#get(`kb:${chatId}`, []);
    const item = { id: uid(), title: String(title).trim(), content: String(content).trim(), ts: Date.now() };
    items.push(item);
    if (items.length > 200) items.shift();
    await this.#put(`kb:${chatId}`, items);
    return item;
  }
  async searchKnowledge(chatId, query, limit = 5) {
    const items = await this.#get(`kb:${chatId}`, []);
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const scored = items
      .map((it) => {
        const hay = `${it.title} ${it.content}`.toLowerCase();
        const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
        return { it, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.it);
    return scored;
  }

  // ---- Plan ----------------------------------------------------------------
  async setPlan(chatId, goal, steps) {
    const plan = { goal, steps: steps.map((s) => ({ text: s, done: false })), ts: Date.now() };
    await this.#put(`plan:${chatId}`, plan);
    return plan;
  }
  async getPlan(chatId) {
    return this.#get(`plan:${chatId}`, null);
  }
  async markPlanStep(chatId, index) {
    const plan = await this.getPlan(chatId);
    if (!plan) return null;
    const i = parseInt(index, 10) - 1;
    if (i >= 0 && i < plan.steps.length) {
      plan.steps[i].done = true;
      await this.#put(`plan:${chatId}`, plan);
    }
    return plan;
  }

  // ---- Chat history --------------------------------------------------------
  async getHistory(chatId) {
    return this.#get(`hist:${chatId}`, []);
  }
  async appendHistory(chatId, role, content) {
    const hist = await this.getHistory(chatId);
    hist.push({ role, content });
    const trimmed = hist.slice(-this.historyLimit);
    await this.#put(`hist:${chatId}`, trimmed);
    return trimmed;
  }
  async resetHistory(chatId) {
    await this.kv.delete(`hist:${chatId}`);
  }
}
