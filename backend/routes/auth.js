// Sign-up, sign-in, OAuth, sessions, account changes, profile pictures and account deletion (/auth/*).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)
const express = require("express");
const { toE164 } = require("../lib/phone");

module.exports = function registerAuth(ctx) {
const { app, supabase, supabaseAdmin, auth, isBanned, needUser, MSG, fail, friendlyAuthError, L, siteUrl } = ctx;

// --- BANNED OR SUSPENDED ---
// Supabase answers a banned person's sign-in / refresh with error code "user_banned" (its message is "User is banned").
const isBanError = e => !!e && (String(e.code || "").toLowerCase() === "user_banned" || /\bbanned\b/i.test(String(e.message || "")));
const bannedReply = res => res.status(403).json({ error: MSG.banned, code: "user_banned" });

// --- PHONE NUMBERS ---
// Sign-up passes the phone to Supabase as user_metadata, which does NOT fill the account's real phone column (auth.users.phone).
// So the server writes it there itself, in E.164 form, with the admin API. (The number is saved but not marked "confirmed": nobody
// has proved it is theirs. An account's phone must be unique: if another account already has this number the save is refused and
// the number stays in the profile only.)
async function saveAuthPhone(userId, e164) {
  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { phone: e164 });
    if (error) { console.warn(`Could not save the phone number to auth.users for ${userId}: ${error.message}`); return false; }
    return true;
  } catch (e) { console.warn("Could not save the phone number to auth.users:", e && e.message ? e.message : e); return false; }
}
const phoneTried = new Set(); // accounts already tried since the server started, so a number Supabase refuses isn't retried on every sign-in
// For accounts made before this existed: the number typed at sign-up is in user_metadata but not in auth.users.phone. Done in the
// background at sign-in and session refresh, so nobody waits for it.
function syncAuthPhone(user) {
  if (!user || !user.id || user.phone || phoneTried.has(user.id)) return;
  const e164 = toE164(user.user_metadata && user.user_metadata.phone);
  if (!e164) return;
  phoneTried.add(user.id);
  if (phoneTried.size > 5000) phoneTried.delete(phoneTried.values().next().value);
  saveAuthPhone(user.id, e164).then(saved => saved && supabaseAdmin.from("profiles").upsert({ id: user.id, phone: e164, updated_at: new Date().toISOString() }).then(() => {}, () => {}));
}

// --- AUTH ---
app.post("/auth/refresh", L.refresh, async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(401).json({ error: MSG.session });
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error && isBanError(error)) return bannedReply(res); // a banned person can't get a new token: tell the page why, not just "session expired"
  if (error) {
    // 401 = Supabase rejected the token (expired, already used, revoked): the saved login is dead and the
    // user has to sign in again. Anything else (network blip, Supabase 5xx, rate limit) is temporary, so
    // answer 503 and the client keeps the saved login and retries later instead of signing the user out.
    const rejected = error.status >= 400 && error.status < 500 && error.status !== 429;
    if (!rejected) console.error("Session refresh failed:", error.message);
    return res.status(rejected ? 401 : 503).json({ error: rejected ? MSG.session : "I couldn't refresh your session right now. Please try again in a moment." });
  }
  const refreshed = data.session && data.session.user;
  if (isBanned(refreshed)) { // (Supabase normally refuses this itself; this is the safety net)
    Promise.resolve().then(() => supabaseAdmin.auth.admin.signOut(data.session.access_token, "global")).catch(() => {});
    return bannedReply(res);
  }
  syncAuthPhone(refreshed);
  res.json({ session: data.session });
});

// The page asks this now and then while someone is signed in. All it needs is the answer: the ban check in server.js runs before
// any route, so a banned person gets a 403 "user_banned" here and the page signs them out.
app.get("/auth/session", needUser, (req, res) => res.json({ ok: true }));

const MAX_NAME = 60;
// Only the NAME is changed here. Email and password changes are not instant any more: they go through the emails Supabase sends
// (a confirmation link for a new email address, a 6-digit code for a new password). See routes/authemail.js.
app.post("/auth/update", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const body = req.body || {};
  if (body.email != null || body.password != null) {
    return res.status(400).json({ error: "To change your email or password, use the confirmation emails in Settings." });
  }
  if (body.name != null && typeof body.name !== "string") return res.status(400).json({ error: "Those details don't look right. Please check them and try again." });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return res.status(400).json({ error: "Please type the name you'd like to use." });
  if (name.length > MAX_NAME) return res.status(400).json({ error: `Names can be up to ${MAX_NAME} characters.` });
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData.user) {
    return res.status(401).json({ error: MSG.session });
  }
  const user = userData.user;
  try {
    // user_metadata is where Supabase keeps it; the helper re-reads it first so a change made at the same moment isn't lost
    await ctx.userMeta.patch(user.id, { name });
  } catch (e) {
    return fail(res, 500, "I couldn't save those changes. Please try again.", e);
  }

  // keep profiles table in sync
  await supabaseAdmin.from("profiles").upsert({ id: user.id, name, updated_at: new Date().toISOString() });
  // keep the username on the score tables in sync too
  await Promise.all(["trex_highscores", "pacman_highscores"].map(table =>
    supabaseAdmin.from(table).update({ username: name }).eq("user_id", user.id)
  ));
  // and the identity columns on saved chats: the name and the author (each separately and ignoring errors, so a column that
  // hasn't been added yet doesn't stop the other)
  await Promise.all(["username", "author"].map(col =>
    supabaseAdmin.from("chats").update({ [col]: name }).eq("user_id", user.id).then(() => {}, () => {})
  ));

  res.json({ success: true });
});

// --- AVATARS ---
// Profile pictures live in the public "avatars" Supabase Storage bucket, stored exactly as
// uploaded (no resizing or re-encoding). The public URL is saved in profiles.avatar_url, which
// is what every device reads after signing in.
const AVATAR_BUCKET = "avatars";
const AVATAR_MAX_BYTES = 10 * 1024 * 1024; // keep in sync with the bucket's file_size_limit
const AVATAR_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Don't trust the Content-Type header, check the file's real magic bytes.
function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// Delete a user's stored avatar files (all of them, or all except `keep`).
async function removeUserAvatars(userId, keep) {
  const { data: files } = await supabaseAdmin.storage.from(AVATAR_BUCKET).list(userId, { limit: 100 });
  const stale = (files || []).map(f => `${userId}/${f.name}`).filter(p => p !== keep);
  if (stale.length) await supabaseAdmin.storage.from(AVATAR_BUCKET).remove(stale);
}

// The client POSTs the raw image file as the body (Content-Type: image/jpeg | png | webp).
app.post("/auth/avatar",
  express.raw({ type: Object.keys(AVATAR_TYPES), limit: AVATAR_MAX_BYTES }),
  async (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: MSG.signIn });
    const { data: userData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userData.user) {
      return res.status(401).json({ error: MSG.session });
    }
    const userId = userData.user.id;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Choose a JPG, PNG or WEBP picture to upload." });
    }
    const contentType = sniffImageType(req.body);
    if (!contentType) return res.status(400).json({ error: "Profile pictures must be JPG, PNG or WEBP images." });

    // A new filename per upload means the CDN/browser never serves a stale picture.
    const filePath = `${userId}/avatar-${Date.now()}.${AVATAR_TYPES[contentType]}`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(AVATAR_BUCKET)
      .upload(filePath, req.body, { contentType, cacheControl: "31536000", upsert: false });
    if (uploadErr) return fail(res, 500, MSG.generic, uploadErr);

    const avatar_url = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(filePath).data.publicUrl;
    const { error: dbErr } = await supabaseAdmin
      .from("profiles")
      .upsert({ id: userId, avatar_url, updated_at: new Date().toISOString() });
    if (dbErr) {
      await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([filePath]);
      return fail(res, 500, MSG.generic, dbErr);
    }

    // Only one picture per user is kept, so storage doesn't grow with every change.
    removeUserAvatars(userId, filePath).catch(err => console.warn("Avatar cleanup failed:", err.message));
    res.json({ success: true, avatar_url });
  }
);

// The small x on the profile picture: remove it, and the person goes back to the default icon.
app.delete("/auth/avatar", needUser, async (req, res) => {
  const userId = req.user.id;
  const { error } = await supabaseAdmin.from("profiles").update({ avatar_url: null, updated_at: new Date().toISOString() }).eq("id", userId);
  if (error) return fail(res, 500, MSG.generic, error);
  await removeUserAvatars(userId).catch(err => console.warn("Avatar cleanup failed:", err.message)); // no file left behind
  res.json({ success: true });
});

app.delete("/auth/delete", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData.user) return res.status(401).json({ error: MSG.signIn });
  const userId = userData.user.id;
  // Delete the account FIRST: the tables reference it with "on delete cascade", so one step removes the chats, memories,
  // scores and profile together. Before, a failure on the last step left a person with their data wiped but their account alive.
  let { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    // a project whose tables were made without the cascade: clear the rows by hand, then try once more
    await supabaseAdmin.from("chats").delete().eq("user_id", userId);
    await supabaseAdmin.from("user_memories").delete().eq("user_id", userId).then(() => {}, () => {}); // ignore if memory.sql was never run
    await supabaseAdmin.from("profiles").delete().eq("id", userId);
    ({ error } = await supabaseAdmin.auth.admin.deleteUser(userId));
  }
  if (error) return fail(res, 500, MSG.generic, error);
  auth.invalidate(userId); // the old token must stop working now, not when its cached copy expires
  await removeUserAvatars(userId).catch(err => console.warn("Avatar cleanup failed:", err.message)); // pictures are in Storage, which the cascade doesn't reach
  res.json({ success: true });
});

app.get("/auth/oauth/:provider", async (req, res) => {
  const { provider } = req.params;
  if (!/^[a-z0-9_]{1,30}$/.test(provider)) return res.status(400).json({ error: "I couldn't start that sign-in. Please try again." });
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${siteUrl()}/auth/callback` }
  });
  if (error) return fail(res, 400, "I couldn't start that sign-in. Please try again.", error);
  res.redirect(data.url);
});

app.get("/auth/callback", (req, res) => {
  // the tokens arrive in the address after the #; public/js/oauth-callback.js saves them and goes back to the page
  res.send('<!doctype html><meta charset="utf-8"><title>Signing you in</title><p>Signing you in...</p><script src="/js/oauth-callback.js"></script>');
});

app.post("/auth/signup", L.signupIp, L.signupEmail, async (req, res) => {
  const { email, password } = req.body;
  // name and phone are stored on the account (and travel inside every sign-in token), so keep them plain and short
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 60) : undefined;
  const phoneText = typeof req.body.phone === "string" ? req.body.phone.trim() : "";
  // A phone number is optional, but one that is typed must be usable: Supabase only accepts international (E.164) numbers.
  const phone = phoneText ? toE164(phoneText) : undefined;
  if (phoneText && !phone) return res.status(400).json({ error: "That phone number doesn't look right. Include your country code (like +1 555 123 4567), or leave it blank." });
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  if (typeof email !== "string" || typeof password !== "string" || email.length > 254 || password.length > 128) return res.status(400).json({ error: "Please check your email and password and try again." });
  if (req.body.confirmPassword != null && req.body.confirmPassword !== password) return res.status(400).json({ error: "The two passwords don't match. Please type them again." });
  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      // the link in the confirmation email comes back to the app (which signs the person in), not to a blank page
      options: { data: { name, phone }, emailRedirectTo: `${siteUrl()}/auth/callback` }
    });
    if (error) {
      console.log(`SIGNUP ERROR MESSAGE: ${error.message} (status ${error.status})`);
      return res.status(400).json({ error: friendlyAuthError(error, "I couldn't create your account. Please check your details and try again.") });
    }
    // If "Confirm email" is enabled in Supabase's Auth settings (the default for
    // new projects), signUp succeeds but issues no session until the user clicks
    // the confirmation link in their email — data.session is null in that case.
    // Tell the client explicitly instead of letting it crash on session.access_token.
    // An address that already has an account comes back looking like a new user but with no identities (so nobody can use
    // sign-up to find out who has an account). Only a genuinely new account gets its phone number saved.
    const isNew = data.user && data.user.id && !(Array.isArray(data.user.identities) && data.user.identities.length === 0);
    if (isNew && phone) {
      await saveAuthPhone(data.user.id, phone);
      await supabaseAdmin.from("profiles").upsert({ id: data.user.id, name: name || null, email: data.user.email || email, phone, updated_at: new Date().toISOString() }).then(() => {}, () => {});
    }
    if (!data.session) {
      return res.json({ user: data.user, session: null, needsConfirmation: true });
    }
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    console.error("Signup failed:", err);
    res.status(500).json({ error: "I couldn't create your account right now. Please try again in a moment." });
  }
});

app.post("/auth/login", L.loginIp, L.loginEmail, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error && isBanError(error)) return bannedReply(res);
    if (error) {
      console.log(`LOGIN ERROR MESSAGE: ${error.message} (status ${error.status})`);
      const unconfirmed = error.code === "email_not_confirmed" || /email not confirmed/i.test(error.message || "");
      return res.status(400).json({ error: friendlyAuthError(error, "I couldn't sign you in. Please check your details and try again."), ...(unconfirmed ? { needsConfirmation: true } : {}) });
    }
    if (isBanned(data.user)) { // (Supabase normally refuses this itself; this is the safety net)
      Promise.resolve().then(() => supabaseAdmin.auth.admin.signOut(data.session.access_token, "global")).catch(() => {});
      return bannedReply(res);
    }
    syncAuthPhone(data.user);
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "I couldn't sign you in right now. Please try again in a moment." });
  }
});

// handed to the files that register after this one
Object.assign(ctx, { AVATAR_MAX_BYTES });
};
