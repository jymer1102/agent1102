// Sign-up, sign-in, OAuth, sessions, account changes, profile pictures and account deletion (/auth/*).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)
const express = require("express");

module.exports = function registerAuth(ctx) {
const { app, supabase, supabaseAdmin, MSG, fail, friendlyAuthError, L } = ctx;

// --- AUTH ---
app.post("/auth/refresh", L.refresh, async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(401).json({ error: MSG.session });
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error) {
    // 401 = Supabase rejected the token (expired, already used, revoked): the saved login is dead and the
    // user has to sign in again. Anything else (network blip, Supabase 5xx, rate limit) is temporary, so
    // answer 503 and the client keeps the saved login and retries later instead of signing the user out.
    const rejected = error.status >= 400 && error.status < 500 && error.status !== 429;
    if (!rejected) console.error("Session refresh failed:", error.message);
    return res.status(rejected ? 401 : 503).json({ error: rejected ? MSG.session : "I couldn't refresh your session right now. Please try again in a moment." });
  }
  res.json({ session: data.session });
});

app.post("/auth/update", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const { name, email, password } = req.body;
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData.user) {
    return res.status(401).json({ error: MSG.session });
  }
  const user = userData.user;
  const updates = {};
  if (email) updates.email = email;
  if (password) updates.password = password;
  if (name) updates.data = { ...user.user_metadata, name };
  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(user.id, updates);
  if (error) return res.status(error.status && error.status < 500 ? 400 : 500).json({ error: friendlyAuthError(error, "I couldn't save those changes. Please try again.") });

  // keep profiles table in sync
  if (name || email) {
    await supabaseAdmin.from("profiles").upsert({
      id: user.id,
      ...(name && { name }),
      ...(email && { email }),
      updated_at: new Date().toISOString()
    });
  }

  // keep the username on the score tables in sync too
  if (name) {
    await Promise.all(["trex_highscores", "pacman_highscores"].map(table =>
      supabaseAdmin.from(table).update({ username: name }).eq("user_id", user.id)
    ));
  }
  // and the identity columns on saved chats (ignore errors if the columns aren't added yet)
  if (name || email) {
    await supabaseAdmin.from("chats").update({ ...(name && { username: name }), ...(email && { email }) }).eq("user_id", user.id).then(() => {}, () => {});
  }

  res.json({ success: true, user: data.user });
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

app.delete("/auth/delete", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData.user) return res.status(401).json({ error: MSG.signIn });
  const userId = userData.user.id;
  await supabaseAdmin.from("chats").delete().eq("user_id", userId);
  await supabaseAdmin.from("user_memories").delete().eq("user_id", userId).then(() => {}, () => {}); // ignore if memory.sql was never run
  await removeUserAvatars(userId).catch(err => console.warn("Avatar cleanup failed:", err.message));
  await supabaseAdmin.from("profiles").delete().eq("id", userId);
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) return fail(res, 500, MSG.generic, error);
  res.json({ success: true });
});

app.get("/auth/oauth/:provider", async (req, res) => {
  const { provider } = req.params;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${process.env.SITE_URL || "https://agent1102.onrender.com"}/auth/callback` }
  });
  if (error) return fail(res, 400, "I couldn't start that sign-in. Please try again.", error);
  res.redirect(data.url);
});

app.get("/auth/callback", (req, res) => {
  // the tokens arrive in the address after the #; public/js/oauth-callback.js saves them and goes back to the page
  res.send('<!doctype html><meta charset="utf-8"><title>Signing you in</title><p>Signing you in...</p><script src="/js/oauth-callback.js"></script>');
});

app.post("/auth/signup", L.signupIp, L.signupEmail, async (req, res) => {
  const { email, password, name, phone } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { name, phone } }
    });
    if (error) {
      console.log(`SIGNUP ERROR MESSAGE: ${error.message} (status ${error.status})`);
      return res.status(400).json({ error: friendlyAuthError(error, "I couldn't create your account. Please check your details and try again.") });
    }
    // If "Confirm email" is enabled in Supabase's Auth settings (the default for
    // new projects), signUp succeeds but issues no session until the user clicks
    // the confirmation link in their email — data.session is null in that case.
    // Tell the client explicitly instead of letting it crash on session.access_token.
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
    if (error) {
      console.log(`LOGIN ERROR MESSAGE: ${error.message} (status ${error.status})`);
      return res.status(400).json({ error: friendlyAuthError(error, "I couldn't sign you in. Please check your details and try again.") });
    }
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "I couldn't sign you in right now. Please try again in a moment." });
  }
});

// handed to the files that register after this one
Object.assign(ctx, { AVATAR_MAX_BYTES });
};
