// ============================================================
//  Verified-user lookup with a short cache.
//
//  Reading someone's memories or style settings must NEVER trust an unverified token (decoding a JWT
//  locally doesn't prove it's real). Asking Supabase every time is slow, so a token that Supabase has
//  already vouched for is remembered for a few minutes (never longer than the token itself lives).
// ============================================================
"use strict";

function createAuth(supabase, { ttlMs = 5 * 60 * 1000, maxEntries = 500 } = {}) {
  const cache = new Map(); // token -> { user, until }

  const bearer = req => (req.headers.authorization || "").split(" ")[1] || null;

  function jwtExpMs(token) {
    try { return JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).exp * 1000 || 0; }
    catch (_) { return 0; }
  }

  async function verify(token) {
    if (!token || typeof token !== "string") return null;
    const now = Date.now();
    const hit = cache.get(token);
    if (hit && hit.until > now) return hit.user;
    cache.delete(token);
    let res;
    try { res = await supabase.auth.getUser(token); } catch (_) { return null; }
    const user = res && res.data && res.data.user;
    if (!user) return null;
    const exp = jwtExpMs(token);
    cache.set(token, { user, until: Math.min(now + ttlMs, exp || now + ttlMs) });
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return user;
  }

  // Call after changing a user's metadata so the next request sees the new values
  function invalidate(userId) {
    for (const [t, v] of cache) if (v.user && v.user.id === userId) cache.delete(t);
  }

  return { verify, bearer, invalidate };
}

module.exports = { createAuth };
