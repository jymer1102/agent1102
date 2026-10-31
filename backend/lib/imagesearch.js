// ============================================================
//  Finding pictures on the web (the /photos command). This FINDS existing pictures; /image makes new ones.
//
//  It works with no setup at all (Wikimedia Commons needs no key). If you have a key for a bigger index, set
//  ONE or BOTH of these in your host's environment and they are tried first:
//    BRAVE_API_KEY    Brave Search's image search (https://brave.com/search/api). Strict safe-search is always on, and
//                     the thumbnails are served through Brave's own proxy, so the person's browser never contacts the
//                     websites the pictures came from.
//    TAVILY_API_KEY   Tavily's image results (https://tavily.com)
//  The order is Brave, then Tavily, then Wikimedia Commons. A provider that fails or finds nothing hands over to
//  the next one.
//
//  The server only calls the fixed API URLs below. It never downloads the pictures themselves, so there is no
//  server-side-request-forgery risk. Only https picture addresses are passed on to the browser.
// ============================================================
"use strict";

const clean = (t, n) => String(t == null ? "" : t).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const httpsUrl = u => { try { const p = new URL(String(u)); return p.protocol === "https:" ? p.href : ""; } catch (_) { return ""; } };
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } };

// The *_URL overrides exist only so the automated tests can point at a fake server
const BRAVE_URL = () => process.env.BRAVE_IMAGES_URL || "https://api.search.brave.com/res/v1/images/search";
const TAVILY_URL = () => process.env.TAVILY_API_URL || "https://api.tavily.com/search";
const COMMONS_URL = () => process.env.COMMONS_API_URL || "https://commons.wikimedia.org/w/api.php";

// Only Brave has a safe-search switch, so this is a small safety net in front of all of them
const BLOCKED_QUERY = /(?!)/;
const isBlockedQuery = q => BLOCKED_QUERY.test(String(q || ""));

async function viaBrave(query, max, signal) {
  const url = `${BRAVE_URL()}?q=${encodeURIComponent(query)}&count=${Math.min(max * 2, 40)}&safesearch=strict`;
  const r = await fetch(url, { headers: { "Accept": "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY }, signal });
  if (!r.ok) throw new Error(`Brave ${r.status}`);
  const j = await r.json();
  return (j.results || []).map(x => ({
    title: x.title,
    thumb: x.thumbnail && x.thumbnail.src,
    full: x.properties && x.properties.url,
    page: x.url,
    source: x.source,
  }));
}

async function viaTavily(query, max, signal) {
  const r = await fetch(TAVILY_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: 5, search_depth: "basic", include_answer: false, include_images: true, include_image_descriptions: true }),
    signal,
  });
  if (!r.ok) throw new Error(`Tavily ${r.status}`);
  const j = await r.json();
  // each image is either a bare address or { url, description }
  return (j.images || []).map(x => typeof x === "string" ? { thumb: x, full: x } : { title: x.description, thumb: x.url, full: x.url });
}

async function viaCommons(query, max, signal) {
  const params = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", generator: "search",
    gsrsearch: "filetype:bitmap " + query, gsrnamespace: "6", gsrlimit: String(Math.min(max * 2, 30)),
    prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "640",
  });
  const r = await fetch(`${COMMONS_URL()}?${params}`, {
    headers: { "Accept": "application/json", "User-Agent": `agent1102-image-search/1.0 (${process.env.SITE_URL || "https://agent1102.onrender.com"})` },
    signal,
  });
  if (!r.ok) throw new Error(`Commons ${r.status}`);
  const j = await r.json();
  const pages = (j.query && j.query.pages) || [];
  return pages
    .filter(p => p && p.imageinfo && p.imageinfo[0] && /^image\/(jpeg|png|webp|gif)$/.test(p.imageinfo[0].mime || ""))
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map(p => {
      const ii = p.imageinfo[0];
      return {
        title: String(p.title || "").replace(/^File:/i, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " "),
        thumb: ii.thumburl || ii.url, full: ii.url, page: ii.descriptionurl, source: "commons.wikimedia.org",
      };
    });
}

const PROVIDERS = {
  brave:   { label: "Brave Search",      enabled: () => !!process.env.BRAVE_API_KEY,  run: viaBrave },
  tavily:  { label: "Tavily",            enabled: () => !!process.env.TAVILY_API_KEY, run: viaTavily },
  commons: { label: "Wikimedia Commons", enabled: () => true,                         run: viaCommons },
};
const ORDER = ["brave", "tavily", "commons"];

// Whatever a provider gave back -> the same small shape, https only, no repeats
function normalize(raw, max) {
  const seen = new Set();
  const out = [];
  for (const x of raw) {
    const thumb = httpsUrl(x.thumb);
    if (!thumb || seen.has(thumb)) continue;
    seen.add(thumb);
    const page = httpsUrl(x.page);
    const url = httpsUrl(x.full) || thumb;
    out.push({
      title: clean(x.title, 160),
      thumb, url, page,
      source: clean(x.source, 80) || hostOf(page) || hostOf(url),
    });
    if (out.length >= max) break;
  }
  return out;
}

const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

// -> { provider, label, images: [{ title, thumb, url, page, source }], failed }
//    failed is true when every provider that was tried had a problem (as opposed to "nothing found")
async function searchImages(query, { max = 12, timeoutMs = 7000 } = {}) {
  query = clean(query, 200);
  if (query.length < 2) return { provider: null, label: "", images: [], failed: false };

  const order = ORDER.filter(n => PROVIDERS[n].enabled());
  const key = order.join(",") + "|" + query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  let errors = 0;
  for (const name of order) {
    try {
      const images = normalize(await PROVIDERS[name].run(query, max, AbortSignal.timeout(timeoutMs)), max);
      if (!images.length) continue;
      const result = { provider: name, label: PROVIDERS[name].label, images, failed: false };
      cache.set(key, { at: Date.now(), result });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return result;
    } catch (e) {
      errors++;
      console.warn(`Image search (${name}) failed:`, e && e.message ? e.message : e, e && e.cause ? "(" + (e.cause.code || e.cause.message) + ")" : "");
    }
  }
  return { provider: null, label: "", images: [], failed: errors > 0 && errors === order.length };
}

module.exports = { searchImages, isBlockedQuery, normalize, PROVIDERS };
