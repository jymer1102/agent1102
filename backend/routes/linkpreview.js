// Link previews: the title / description / image cards shown under AI replies (GET /link-preview).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)
const { assertPublicUrl, safeFetch } = require("../lib/ssrf");

module.exports = function registerLinkpreview(ctx) {
const { app, needUser, L } = ctx;

// --- LINK PREVIEW (title / description / image for the cards under AI replies) ---
// Fetches the page server-side (the browser can't, CORS) and reads its Open Graph tags.
// SSRF-safe: http(s) only, public IPs only (checked again on every redirect and at connect time; see lib/ssrf.js), small body, short timeout.
const LINK_PREVIEW_TTL = 6 * 60 * 60 * 1000;
const LINK_PREVIEW_FAIL_TTL = 5 * 60 * 1000; // a page that couldn't be read gets another try soon, not in six hours
const linkPreviewCache = new Map();
// Sites that block bots: show a good card anyway.
const KNOWN_PREVIEWS = {
  "jymer1102.github.io": { title: "jymer1102", description: "jymer1102's website.", image: "/images/jymer1102_horizontal_banner.png", siteName: "jymer1102.github.io" },
  "linktr.ee": { title: "jymer1102 | Linktree", description: "All of jymer1102's links in one place.", image: "/images/jymer1102_horizontal_banner.png", siteName: "Linktree" },
};

async function fetchPageHtml(startUrl) {
  let u = startUrl;
  for (let i = 0; i < 4; i++) {
    assertPublicUrl(u);
    const r = await safeFetch(u, {
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; agent1102LinkPreview/1.0)", "Accept": "text/html,application/xhtml+xml" },
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = new URL(r.headers.get("location"), u); continue; }
    if (!r.ok) throw new Error("status " + r.status);
    if (!/text\/html|application\/xhtml/i.test(r.headers.get("content-type") || "")) throw new Error("not html");
    // read at most ~512KB
    const reader = r.body.getReader();
    const chunks = []; let total = 0;
    while (total < 512 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    try { await reader.cancel(); } catch (_) {}
    return { html: Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8"), finalUrl: u };
  }
  throw new Error("too many redirects");
}
const fromCode = n => (Number.isInteger(n) && n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF)) ? String.fromCodePoint(n) : "\uFFFD";
const decodeEntities = t => String(t || "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCode(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => fromCode(parseInt(d, 10)));
function metaContent(html, keys) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const key of keys) {
    for (const tag of tags) {
      const name = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!name || name[1].toLowerCase() !== key) continue;
      const c = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
      const val = c && (c[2] ?? c[3]);
      if (val && val.trim()) return decodeEntities(val).trim();
    }
  }
  return "";
}
function parsePreview(html, finalUrl) {
  const head = html.slice(0, 400 * 1024);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const title = metaContent(head, ["og:title", "twitter:title"]) || decodeEntities(titleTag ? titleTag[1] : "").replace(/\s+/g, " ").trim();
  const description = metaContent(head, ["og:description", "twitter:description", "description"]);
  let image = metaContent(head, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  if (image) { try { const iu = new URL(image, finalUrl); image = /^https?:$/.test(iu.protocol) ? iu.href : ""; } catch (_) { image = ""; } }
  const siteName = metaContent(head, ["og:site_name"]) || finalUrl.hostname.replace(/^www\./, "");
  return { title: title.slice(0, 160), description: description.slice(0, 240), image, siteName: siteName.slice(0, 80) };
}
app.get("/link-preview", needUser, L.linkPreview, async (req, res) => {
  let u;
  try { u = new URL(String(req.query.url || "")); } catch (_) { return res.status(400).json({ error: "That link isn't valid." }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return res.status(400).json({ error: "That link isn't valid." });
  const key = u.href;
  const hit = linkPreviewCache.get(key);
  if (hit && Date.now() - hit.at < (hit.failed ? LINK_PREVIEW_FAIL_TTL : LINK_PREVIEW_TTL)) return res.json(hit.data);
  const host = u.hostname.replace(/^www\./, "");
  let data, failed = false;
  try {
    const { html, finalUrl } = await fetchPageHtml(u);
    data = parsePreview(html, finalUrl);
  } catch (err) {
    failed = true;
    data = { title: "", description: "", image: "", siteName: host };
  }
  const known = KNOWN_PREVIEWS[host];
  if (known && (host !== "linktr.ee" || /^\/jymer1102\/?$/i.test(u.pathname)) && (host !== "jymer1102.github.io" || /^\/jymer1102\/?$/i.test(u.pathname) || u.pathname === "/")) {
    data = { title: data.title || known.title, description: data.description || known.description, image: data.image || known.image, siteName: data.siteName || known.siteName };
  }
  linkPreviewCache.set(key, { at: Date.now(), data, failed });
  if (linkPreviewCache.size > 500) linkPreviewCache.delete(linkPreviewCache.keys().next().value);
  res.set("Cache-Control", failed ? "private, max-age=60" : "private, max-age=3600").json(data);
});

// handed to the files that register after this one
Object.assign(ctx, { decodeEntities, fetchPageHtml });
};
