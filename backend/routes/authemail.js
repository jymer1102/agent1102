// Account changes that go through the emails Supabase sends.
//   POST /auth/forgot          "Forgot password?": Supabase emails a link; the link brings the person back to choose a new one
//   POST /auth/resend          send the sign-up confirmation email again
//   POST /auth/email/change    Supabase emails a confirmation link to the NEW address (and the old one, if "Secure email change" is on);
//                              the address only changes once the link is opened
//   POST /auth/verify-code     the 6-digit code from a sign-up or reset email (when the email template includes the code): signs the person in
//   POST /auth/password/code   Supabase emails a 6-digit code to the person's current address
//   POST /auth/password        set the new password, with that code (or straight after opening a reset-password link)
// Everything signed-in is done with the PERSON'S OWN token (lib/gotrue.js), so Supabase decides what is allowed and what must be
// confirmed. The service key is never used to change an email or password.
"use strict";
const { asUser, looksLikeEmail, maskEmail } = require("../lib/gotrue");

module.exports = function (ctx) {
  const { app, supabase, supabaseAdmin, auth, isBanned, needUser, MSG, friendlyAuthError, L, siteUrl } = ctx;

  // Every emailed code in the app is 6 digits. (How many digits Supabase puts in the email is its own setting: Authentication ->
  // Sign In / Providers -> Email -> "Email OTP Length". It has to be 6 there too, or a code can never be typed in.)
  const CODE_RE = /^\d{6}$/;
  const CODE_SHAPE = "The code is 6 digits. Please type the 6-digit code from the email.";
  const CODE_WRONG = "That code isn't right, or it has expired. Check your newest email, or ask for a new code.";

  const callback = () => `${siteUrl()}/auth/callback`;
  // The same answer whether or not an account exists, so this can't be used to find out who has one
  const LINK_SENT = "If there's an account for that email, I've sent it a message. It can take a minute, and it may land in your spam folder.";

  // a failed call to Supabase, as a plain-words answer and the right status
  function sendProblem(res, error, fallback) {
    const status = error.status === 401 || error.status === 403 ? 401 : error.status === 429 ? 429 : error.status >= 500 || error.status === 0 ? 503 : 400;
    const message = status === 401 ? MSG.session
      : status === 503 ? "I couldn't reach the account service just now. Please try again in a moment."
      : friendlyAuthError(error, fallback);
    // badCode: the problem is the code itself (wrong, or expired), so the code window stays open for another try.
    // needsCode: Supabase wants a fresh code first.
    const badCode = error.code === "reauthentication_not_valid" || error.code === "otp_expired" || /nonce|token has expired or is invalid|otp.*expired/i.test(error.message || "");
    return res.status(status).json({ error: message, ...(error.code === "reauthentication_needed" ? { needsCode: true } : {}), ...(badCode ? { badCode: true } : {}) });
  }

  const tokenOf = req => auth.bearer(req);

  // ---------- not signed in: reset link, and resending the sign-up email ----------
  app.post("/auth/forgot", L.emailIp, L.emailAddr, async (req, res) => {
    const email = typeof (req.body || {}).email === "string" ? req.body.email.trim() : "";
    if (!looksLikeEmail(email)) return res.status(400).json({ error: "Please type the email address you signed up with." });
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: callback() });
      if (error && (error.status === 429 || /rate limit/i.test(error.message || "") || /rate_limit/.test(error.code || ""))) {
        return res.status(429).json({ error: "A lot of emails have gone out lately. Please wait a few minutes and try again." });
      }
      if (error) console.warn("Reset email not sent:", error.code || "", error.message); // still the same reply: no hints about who has an account
    } catch (e) { console.error("Reset email failed:", e.message); }
    res.json({ ok: true, message: LINK_SENT });
  });

  app.post("/auth/resend", L.emailIp, L.emailAddr, async (req, res) => {
    const email = typeof (req.body || {}).email === "string" ? req.body.email.trim() : "";
    if (!looksLikeEmail(email)) return res.status(400).json({ error: "Please type the email address you signed up with." });
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: callback() } });
      if (error && (error.status === 429 || /rate limit|for security purposes/i.test(error.message || ""))) {
        return res.status(429).json({ error: "I just sent one. Please wait a minute before asking for another." });
      }
      if (error) console.warn("Confirmation email not resent:", error.code || "", error.message);
    } catch (e) { console.error("Resend failed:", e.message); }
    res.json({ ok: true, message: LINK_SENT });
  });

  // The code from a sign-up confirmation or a "forgot password" email. It works when the email template shows the code
  // ({{ .Token }}); the link in the same email keeps working too. Success signs the person in (a reset code lets them choose a new password).
  app.post("/auth/verify-code", L.codeIp, L.codeEmail, async (req, res) => {
    const body = req.body || {};
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!looksLikeEmail(email)) return res.status(400).json({ error: "Please type the email address the code was sent to." });
    const token = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
    if (!CODE_RE.test(token)) return res.status(400).json({ error: CODE_SHAPE });
    const type = body.type === "recovery" ? "recovery" : body.type === "signup" ? "signup" : "";
    if (!type) return res.status(400).json({ error: MSG.badRequest });
    try {
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type });
      if (error) {
        if (String(error.code || "").toLowerCase() === "user_banned" || /\bbanned\b/i.test(String(error.message || ""))) return res.status(403).json({ error: MSG.banned, code: "user_banned" });
        if (error.status === 429) return res.status(429).json({ error: "Too many attempts. Please wait a minute and try again." });
        if (!error.status || error.status >= 500) return res.status(503).json({ error: "I couldn't reach the account service just now. Please try again in a moment." });
        return res.status(400).json({ error: CODE_WRONG });
      }
      if (!data || !data.session) return res.status(400).json({ error: CODE_WRONG });
      if (isBanned(data.user)) {
        Promise.resolve().then(() => supabaseAdmin.auth.admin.signOut(data.session.access_token, "global")).catch(() => {});
        return res.status(403).json({ error: MSG.banned, code: "user_banned" });
      }
      res.json({ session: data.session, user: data.user });
    } catch (e) {
      console.error("Code check failed:", e && e.message ? e.message : e);
      res.status(500).json({ error: MSG.generic });
    }
  });

  // ---------- signed in: change email ----------
  app.post("/auth/email/change", needUser, L.emailPerson, async (req, res) => {
    const email = typeof (req.body || {}).email === "string" ? req.body.email.trim() : "";
    if (!looksLikeEmail(email)) return res.status(400).json({ error: "That email address doesn't look right." });
    if (email.toLowerCase() === String(req.user.email || "").toLowerCase()) return res.status(400).json({ error: "That's already your email address." });

    const r = await asUser(tokenOf(req), "PUT", "/user", { body: { email }, query: { redirect_to: callback() } });
    if (!r.ok) return sendProblem(res, r.error, "I couldn't start that change. Please check the address and try again.");
    auth.invalidate(req.user.id);

    const u = r.data || {};
    // If the project has email confirmation turned off, Supabase changes it at once; keep the saved profile in step
    if (u.email && u.email.toLowerCase() === email.toLowerCase() && !u.new_email) {
      supabaseAdmin.from("profiles").upsert({ id: req.user.id, email, updated_at: new Date().toISOString() }).then(() => {}, () => {});
      return res.json({ changed: true, email });
    }
    res.json({ pendingEmail: u.new_email || email, currentEmail: req.user.email || "" });
  });

  // ---------- signed in (or just opened a reset link): password ----------
  app.post("/auth/password/code", needUser, L.emailPerson, async (req, res) => {
    const r = await asUser(tokenOf(req), "GET", "/reauthenticate");
    if (!r.ok) return sendProblem(res, r.error, "I couldn't send that code. Please try again in a moment.");
    res.json({ ok: true, sentTo: maskEmail(req.user.email) });
  });

  app.post("/auth/password", needUser, L.codeTries, async (req, res) => {
    const { password, confirmPassword, code } = req.body || {};
    if (typeof password !== "string" || !password) return res.status(400).json({ error: "Please type your new password." });
    if (password.length > 128) return res.status(400).json({ error: "That password is too long." });
    if (confirmPassword != null && confirmPassword !== password) return res.status(400).json({ error: "The two passwords don't match. Please type them again." });
    if (code != null && typeof code !== "string") return res.status(400).json({ error: CODE_SHAPE });
    const nonce = String(code || "").replace(/\s+/g, "");
    if (nonce && !CODE_RE.test(nonce)) return res.status(400).json({ error: CODE_SHAPE });

    const r = await asUser(tokenOf(req), "PUT", "/user", { body: { password, ...(nonce ? { nonce } : {}) } });
    if (!r.ok) return sendProblem(res, r.error, "I couldn't change your password. Please try again.");
    auth.invalidate(req.user.id);
    // a new password should end every OTHER signed-in session (a thief's, or an old phone); this one stays
    Promise.resolve().then(() => supabaseAdmin.auth.admin.signOut(tokenOf(req), "others")).catch(e => console.warn("Signing out other sessions failed:", e.message));
    res.json({ ok: true });
  });
};
