// Talks to Supabase Auth (GoTrue) AS THE SIGNED-IN PERSON, using their own access token instead of the service key.
// That is what makes Supabase itself send the emails and apply its own rules for the sensitive changes:
//   PUT /user   {email}               -> confirmation email(s) before the address changes   ("Confirm email" / "Secure email change")
//   GET /reauthenticate               -> a 6-digit code emailed to the person               ("Secure password change")
//   PUT /user   {password, nonce}     -> the new password, with that code
// (The old way, the admin API, changed email and password instantly with no confirmation at all.)
"use strict";

const base = () => `${process.env.SUPABASE_URL}/auth/v1`;

async function asUser(token, method, pathname, { body, query } = {}) {
  const url = new URL(base() + pathname);
  for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (_) {
    return { ok: false, status: 0, error: { code: "unreachable", message: "Supabase Auth could not be reached", status: 0 } };
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* an empty or non-JSON reply */ }
  if (res.ok) return { ok: true, status: res.status, data };
  const code = data && typeof data.error_code === "string" ? data.error_code : "";
  const message = (data && (data.msg || data.message || data.error_description || (typeof data.error === "string" ? data.error : ""))) || "";
  return { ok: false, status: res.status, error: { code, message, status: res.status } };
}

const looksLikeEmail = e => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// "samantha@example.com" -> "s*******@example.com": enough to recognise, not enough to leak
function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!name || !domain) return "your email";
  return `${name[0]}${"*".repeat(Math.max(1, Math.min(name.length - 1, 8)))}@${domain}`;
}

module.exports = { asUser, looksLikeEmail, maskEmail };
