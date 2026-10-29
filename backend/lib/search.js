// ============================================================
//  Improvement 6: up-to-date, expert-level facts via live web search (optional).
//  It runs ONLY when the person types /search <question> (see lib/searchcmd.js), never automatically.
//
//  Set ONE of these in your host's environment and the feature switches on by itself:
//    TAVILY_API_KEY   (https://tavily.com, free tier)
//    BRAVE_API_KEY    (https://brave.com/search/api, "Data for Search" plan)
//  With neither set, nothing changes: the model just answers from what it knows and is told to flag anything
//  that may be out of date.
//
//  The server only calls the fixed search API URL. It never fetches the result pages, so there is no
//  server-side-request-forgery risk, and results are handed to the model as untrusted text.
// ============================================================
"use strict";

const clean = (t, n) => String(t == null ? "" : t).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const httpUrl = u => { try { const p = new URL(u); return /^https?:$/.test(p.protocol) ? p.href : ""; } catch (_) { return ""; } };

const provider = () => (process.env.TAVILY_API_KEY ? "tavily" : process.env.BRAVE_API_KEY ? "brave" : null);
const enabled = () => !!provider();

async function viaTavily(query, max, signal) {
  const r = await fetch(process.env.TAVILY_API_URL || "https://api.tavily.com/search", { // TAVILY_API_URL is only for tests
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: max, search_depth: "basic", include_answer: false }),
    signal,
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}`);
  const j = await r.json();
  return (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content }));
}

async function viaBrave(query, max, signal) {
  const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`, {
    headers: { "Accept": "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY },
    signal,
  });
  if (!r.ok) throw new Error(`Brave ${r.status}`);
  const j = await r.json();
  return ((j.web && j.web.results) || []).map(x => ({ title: x.title, url: x.url, snippet: x.description }));
}

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

// -> [{ title, url, snippet }] (at most `max`), or [] on any problem. Never throws.
async function searchWeb(query, { max = 5, timeoutMs = 6000 } = {}) {
  const p = provider();
  query = clean(query, 300);
  if (!p || query.length < 4) return [];
  const key = p + "|" + query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const raw = p === "tavily" ? await viaTavily(query, max, signal) : await viaBrave(query, max, signal);
    const results = raw
      .map(x => ({ title: clean(x.title, 140), url: httpUrl(x.url), snippet: clean(x.snippet, 500) }))
      .filter(x => x.url && x.title)
      .slice(0, max);
    cache.set(key, { at: Date.now(), results });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return results;
  } catch (e) {
    console.warn("Web search failed:", e && e.message ? e.message : e);
    return [];
  }
}

module.exports = { searchWeb, enabled, provider };
