// ============================================================
//  A small in-memory rate limiter (no extra package needed).
//
//  Each limiter counts requests per key (a person, an email address, an IP address) in a fixed time window and
//  answers 429 with a plain message once the limit is passed. Memory only: it resets when the server restarts,
//  and each server instance counts for itself, which is fine for a single Render instance.
//
//  RATE_LIMIT_SCALE (env, default 1) multiplies every limit, e.g. 1000 in automated tests.
// ============================================================
"use strict";

const SCALE = Math.max(Number(process.env.RATE_LIMIT_SCALE) || 1, 0.01);
const MAX_KEYS = 20000; // a flood of different keys can't make the map grow without limit

function waitText(seconds) {
  if (seconds < 60) return `${Math.max(seconds, 1)} second${seconds === 1 ? "" : "s"}`;
  const m = Math.ceil(seconds / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

// key(req) returns a string to count under (it may be async), or null/undefined to not limit this request.
// skipSuccessful: only failed requests (status 400+) count, e.g. wrong passwords but not good sign-ins.
function createLimiter({ windowMs, max, key, message, skipSuccessful = false }) {
  const limit = Math.max(Math.floor(max * SCALE), 1);
  const buckets = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.min(windowMs, 60 * 1000));
  if (sweep.unref) sweep.unref(); // never keeps the process alive on its own

  async function limiter(req, res, next) {
    let k;
    try { k = await key(req); } catch (_) { k = null; }
    if (!k) return next();
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value);
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(k, b);
    }
    b.count++;
    if (b.count > limit) {
      const wait = Math.max(Math.ceil((b.resetAt - now) / 1000), 1);
      res.set("Retry-After", String(wait));
      return res.status(429).json({ error: typeof message === "function" ? message(waitText(wait)) : message });
    }
    if (skipSuccessful) res.on("finish", () => { if (res.statusCode < 400 && b.count > 0) b.count--; });
    next();
  }
  limiter.reset = () => buckets.clear(); // for tests
  return limiter;
}

module.exports = { createLimiter, waitText };
