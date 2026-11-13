// ============================================================
//  Verified-user lookup with a short cache.
//
//  Reading someone's memories or style settings must NEVER trust an unverified token (decoding a JWT
//  locally doesn't prove it's real). Asking Supabase every time is slow, so a token that Supabase has
//  already vouched for is remembered for a short while (never longer than the token itself lives).
//
//  Bans: Supabase only stops a banned person from signing in or refreshing. A token they already hold keeps working until it
//  runs out (up to an hour), and Supabase's own endpoints do not turn it away. So the app has to check `banned_until` itself,
//  on the user Supabase just vouched for (isBanned below). The cache is kept short so a new ban is noticed within a minute.
// ============================================================
"use strict";

// true while the account is banned or suspended (Supabase: banned_until is a date in the future)
function isBanned(user) {
  const until = user && user.banned_until;
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > Date.now();
}

function createAuth(supabase, { ttlMs = 60 * 1000, maxEntries = 500, rejectTtlMs = 30 * 1000, maxRejected = 1000 } = {}) {
  const cache = new Map();    // token -> { user, until }
  const rejected = new Map(); // token -> until: tokens Supabase has definitively refused (a short memory, so junk can't make us call it over and over)
  const inflight = new Map(); // token -> the lookup already running for it (the same request asks several times at once)

  const bearer = req => (req.headers.authorization || "").split(" ")[1] || null;

  function jwtExpMs(token) {
    try { return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).exp * 1000 || 0; }
    catch (_) { return 0; }
  }

  async function lookup(token, now) {
    let res;
    try { res = await supabase.auth.getUser(token); } catch (_) { return null; } // a network failure: not remembered either way
    const user = res && res.data && res.data.user;
    if (!user) {
      // Only a clear "this token is not valid" (4xx) is remembered. A 5xx or a missing status means Supabase itself had trouble.
      const status = res && res.error && res.error.status;
      if (status >= 400 && status < 500) {
        rejected.set(token, now + rejectTtlMs);
        if (rejected.size > maxRejected) rejected.delete(rejected.keys().next().value);
      }
      return null;
    }
    const exp = jwtExpMs(token);
    cache.set(token, { user, until: Math.min(now + ttlMs, exp || now + ttlMs) });
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return user;
  }

  async function verify(token) {
    if (!token || typeof token !== "string") return null;
    const now = Date.now();
    const hit = cache.get(token);
    if (hit && hit.until > now) return hit.user;
    cache.delete(token);
    const bad = rejected.get(token);
    if (bad && bad > now) return null;
    rejected.delete(token);
    if (inflight.has(token)) return inflight.get(token);
    const p = lookup(token, now).finally(() => inflight.delete(token));
    inflight.set(token, p);
    return p;
  }

  // Call after changing a user's metadata so the next request sees the new values
  function invalidate(userId) {
    for (const [t, v] of cache) if (v.user && v.user.id === userId) cache.delete(t);
    // (rejected tokens belong to nobody, so there is nothing to clear for them)
  }

  return { verify, bearer, invalidate };
}

module.exports = { createAuth, isBanned };
