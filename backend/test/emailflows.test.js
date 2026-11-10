// The email flows in the page: sign-in / sign-up / forgot / reset modes, resend, the return from email links, and Settings'
// change-email and change-password (with a code). Plus the callback script every email link lands on.
// run:  node test/emailflows.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { bootApp } = require("./app-harness");

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); } }
async function withApp(opts, fn) {
  const app = await bootApp(opts);
  try { app.w.confirm = () => true; await fn(app); assert.deepStrictEqual(app.errors.map(e => String(e && e.message || e)), [], "the page reported script errors"); }
  finally { app.close(); }
}
const ok = json => ({ status: 200, json });
const bad = (status, json) => ({ status, json: typeof json === "string" ? { error: json } : json });
const txt = el => el.textContent.replace(/\s+/g, " ").trim();
const callsTo = (app, p, method) => app.calls.filter(c => c.path === p && (!method || c.method === method));
const shown = el => el.style.display !== "none" && !el.hidden;
const fill = (app, sel, v) => { app.$(sel).value = v; };
const signedOut = (extra = {}) => ({ signedOut: true, ...extra });
// a real-looking access token (JWT with an expiry an hour away), like the one a reset-password link carries
const b64url = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const RECOVERY_TOKEN = `${b64url({ alg: "HS256" })}.${b64url({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const RECOVERY = JSON.stringify({ a: RECOVERY_TOKEN, r: "RECOVERY-REFRESH" });

(async () => {
  console.log("sign-in screen modes");
  await t("starts as plain sign-in: no confirm box, 'Forgot password?' offered, nothing about resending yet", () => withApp(signedOut(), async app => {
    assert(shown(app.$("#auth-forgot")) && !shown(app.$("#auth-confirm-wrap")) && !shown(app.$("#auth-resend")));
    assert.strictEqual(txt(app.$("#auth-submit")), "Sign In");
    assert(shown(app.$("#auth-social")) && shown(app.$("#auth-stay-label")));
  }));
  await t("sign-up adds name, phone and confirm-password; going back to sign-in removes them", () => withApp(signedOut(), async app => {
    app.$("#auth-toggle").click();
    assert(shown(app.$("#auth-name")) && shown(app.$("#auth-phone")) && shown(app.$("#auth-confirm-wrap")));
    assert(!shown(app.$("#auth-forgot")), "no 'Forgot password?' while creating an account");
    assert.strictEqual(txt(app.$("#auth-submit")), "Sign Up"); assert.strictEqual(app.$("#auth-password").autocomplete, "new-password");
    app.$("#auth-toggle").click();
    assert(!shown(app.$("#auth-name")) && !shown(app.$("#auth-confirm-wrap")) && shown(app.$("#auth-forgot")));
    assert.strictEqual(app.$("#auth-password").autocomplete, "current-password");
  }));
  await t("sign-up: the two passwords must match; nothing is sent until they do, and the request carries the confirmation", () => withApp(signedOut({ routes: { "/auth/signup": b => ok({ session: null, needsConfirmation: true }) } }), async app => {
    app.$("#auth-toggle").click();
    fill(app, "#auth-name", "Nia"); fill(app, "#auth-email", "nia@x.co"); fill(app, "#auth-password", "longenough1");
    app.$("#auth-submit").click(); await app.sleep(30);
    assert(/second time/.test(txt(app.$("#auth-error"))), "asks for the confirmation"); assert.strictEqual(callsTo(app, "/auth/signup").length, 0);
    fill(app, "#auth-confirm", "different"); app.$("#auth-submit").click(); await app.sleep(30);
    assert(/don't match/.test(txt(app.$("#auth-error")))); assert.strictEqual(callsTo(app, "/auth/signup").length, 0);
    fill(app, "#auth-confirm", "longenough1"); app.$("#auth-submit").click(); await app.sleep(50);
    assert.deepStrictEqual(callsTo(app, "/auth/signup")[0].body, { email: "nia@x.co", password: "longenough1", confirmPassword: "longenough1", name: "Nia", phone: "" });
  }));
  await t("after sign-up: tells them to open the emailed link, in green, and offers to resend it", () => withApp(signedOut({ routes: { "/auth/signup": () => ok({ session: null, needsConfirmation: true }) } }), async app => {
    app.$("#auth-toggle").click();
    fill(app, "#auth-name", "Nia"); fill(app, "#auth-email", "nia@x.co"); fill(app, "#auth-password", "longenough1"); fill(app, "#auth-confirm", "longenough1");
    app.$("#auth-submit").click(); await app.sleep(50);
    assert(/confirmation link to nia@x\.co/.test(txt(app.$("#auth-error"))), txt(app.$("#auth-error")));
    assert(app.$("#auth-error").classList.contains("info"), "good news is green, not red");
    assert(shown(app.$("#auth-resend")));
  }));
  await t("signing in with an unconfirmed email shows the message and offers to resend; an ordinary wrong password does not", () => withApp(signedOut({ routes: { "/auth/login": b => b.password === "unconfirmed" ? bad(400, { error: "Please confirm your email first. Check your inbox for the link.", needsConfirmation: true }) : bad(400, "That email or password isn't right. Please try again.") } }), async app => {
    fill(app, "#auth-email", "nia@x.co"); fill(app, "#auth-password", "unconfirmed"); app.$("#auth-submit").click(); await app.sleep(40);
    assert(/confirm your email/.test(txt(app.$("#auth-error")))); assert(shown(app.$("#auth-resend")));
    fill(app, "#auth-password", "wrong"); app.$("#auth-submit").click(); await app.sleep(40);
    assert(!shown(app.$("#auth-resend")), "a wrong password is not an email problem");
  }));
  await t("resend: asks for the email first, then sends it once and holds the button for a while", () => withApp(signedOut({ routes: { "/auth/resend": () => ok({ ok: true, message: "If there's an account for that email, I've sent it a message." }) } }), async app => {
    app.$("#auth-resend").hidden = false;
    app.$("#auth-resend").click(); await app.sleep(20);
    assert(/Type your email/.test(txt(app.$("#auth-error")))); assert.strictEqual(callsTo(app, "/auth/resend").length, 0);
    fill(app, "#auth-email", "nia@x.co"); app.$("#auth-resend").click(); await app.sleep(40);
    assert.deepStrictEqual(callsTo(app, "/auth/resend")[0].body, { email: "nia@x.co" });
    assert(/I've sent it a message/.test(txt(app.$("#auth-error")))); assert(app.$("#auth-error").classList.contains("info"));
    assert.strictEqual(app.$("#auth-resend").disabled, true, "no hammering the button");
  }));

  console.log("\nForgot password");
  await t("'Forgot password?' shows just the email box and a 'Send reset link' button; 'Back to sign in' returns", () => withApp(signedOut(), async app => {
    fill(app, "#auth-email", "nia@x.co"); app.$("#auth-forgot").click();
    assert.strictEqual(txt(app.$("#auth-subtitle")), "Reset your password"); assert.strictEqual(txt(app.$("#auth-submit")), "Send reset link");
    assert(shown(app.$("#auth-email")) && !shown(app.$("#auth-password-wrap")) && !shown(app.$("#auth-confirm-wrap")) && !shown(app.$("#auth-social")) && !shown(app.$("#auth-stay-label")) && !shown(app.$("#auth-forgot")));
    assert.strictEqual(app.$("#auth-email").value, "nia@x.co", "the address they already typed is kept");
    assert.strictEqual(txt(app.$("#auth-toggle")), "Back to sign in");
    app.$("#auth-toggle").click();
    assert.strictEqual(txt(app.$("#auth-submit")), "Sign In"); assert(shown(app.$("#auth-password-wrap")) && shown(app.$("#auth-social")));
  }));
  await t("sending the link: needs an email, sends it, shows the same friendly answer in green; a limit shows in red", () => withApp(signedOut({ routes: { "/auth/forgot": b => b.email === "limited@x.co" ? bad(429, "A lot of emails have gone out lately. Please wait a few minutes and try again.") : ok({ ok: true, message: "If there's an account for that email, I've sent it a message. It can take a minute, and it may land in your spam folder." }) } }), async app => {
    app.$("#auth-forgot").click(); app.$("#auth-submit").click(); await app.sleep(20);
    assert(/Please type the email/.test(txt(app.$("#auth-error")))); assert.strictEqual(callsTo(app, "/auth/forgot").length, 0);
    fill(app, "#auth-email", "nia@x.co"); app.$("#auth-submit").click(); await app.sleep(40);
    assert.deepStrictEqual(callsTo(app, "/auth/forgot")[0].body, { email: "nia@x.co" });
    assert(/spam folder/.test(txt(app.$("#auth-error"))) && app.$("#auth-error").classList.contains("info"));
    assert.strictEqual(txt(app.$("#auth-submit")), "Send reset link", "the button is usable again");
    fill(app, "#auth-email", "limited@x.co"); app.$("#auth-submit").click(); await app.sleep(40);
    assert(/wait a few minutes/.test(txt(app.$("#auth-error")))); assert(!app.$("#auth-error").classList.contains("info"));
  }));

  console.log("\nComing back from a reset-password link");
  await t("opens on 'Choose a new password' with only the two password boxes, and tidies the address bar", () => withApp({ url: "http://localhost/?reset=1", session: { agent1102_recovery: RECOVERY } }, async app => {
    assert.strictEqual(app.w.location.search, "", "?reset=1 is removed");
    assert.strictEqual(txt(app.$("#auth-subtitle")), "Choose a new password"); assert.strictEqual(txt(app.$("#auth-submit")), "Save new password");
    assert(!shown(app.$("#auth-email")) && shown(app.$("#auth-password-wrap")) && shown(app.$("#auth-confirm-wrap")) && !shown(app.$("#auth-social")) && !shown(app.$("#auth-toggle")) && !shown(app.$("#auth-forgot")));
    assert.strictEqual(app.$("#app").style.display, "none", "even if they happened to be signed in already, the new password comes first");
    assert.strictEqual(app.$("#auth-screen").style.display, "flex");
  }));
  await t("both boxes must match and be filled; nothing is sent otherwise", () => withApp({ url: "http://localhost/?reset=1", session: { agent1102_recovery: RECOVERY } }, async app => {
    app.$("#auth-submit").click(); await app.sleep(20); assert(/type your new password/.test(txt(app.$("#auth-error"))));
    fill(app, "#auth-password", "brandnew123"); fill(app, "#auth-confirm", "brandnew124"); app.$("#auth-submit").click(); await app.sleep(20);
    assert(/don't match/.test(txt(app.$("#auth-error")))); assert.strictEqual(callsTo(app, "/auth/password").length, 0);
  }));
  await t("saving: the new password goes with the LINK's login (not a code), then they are signed in and told", () => withApp({ url: "http://localhost/?reset=1", session: { agent1102_recovery: RECOVERY }, routes: { "/auth/password": () => ok({ ok: true }) } }, async app => {
    fill(app, "#auth-password", "brandnew123"); fill(app, "#auth-confirm", "brandnew123"); app.$("#auth-submit").click(); await app.sleep(120);
    const call = callsTo(app, "/auth/password", "POST")[0];
    assert.deepStrictEqual(call.body, { password: "brandnew123", confirmPassword: "brandnew123" }, "no code: opening the link was the confirmation");
    assert.strictEqual(call.headers.Authorization, `Bearer ${RECOVERY_TOKEN}`);
    assert.strictEqual(app.w.localStorage.getItem("agent1102_token"), RECOVERY_TOKEN, "now a normal sign-in");
    assert.strictEqual(app.w.localStorage.getItem("agent1102_refresh_token"), "RECOVERY-REFRESH");
    assert.strictEqual(app.w.sessionStorage.getItem("agent1102_recovery"), null, "the one-time login is used up");
    assert.notStrictEqual(app.$("#app").style.display, "none"); assert.strictEqual(app.$("#auth-screen").style.display, "none");
    assert(/Password changed/.test(app.w.document.body.textContent));
    assert.strictEqual(txt(app.$("#auth-submit")), "Sign In", "the sign-in screen is back to normal for next time");
  }));
  await t("a link that turned out to be expired sends them to ask for a new one; a rejected password shows the reason", () => withApp({ url: "http://localhost/?reset=1", session: { agent1102_recovery: RECOVERY }, routes: { "/auth/password": b => b.password === "short" ? bad(400, "That password is too short. Please use at least 6 characters.") : bad(401, "Your session expired. Please sign in again.") } }, async app => {
    fill(app, "#auth-password", "short"); fill(app, "#auth-confirm", "short"); app.$("#auth-submit").click(); await app.sleep(40);
    assert(/too short/.test(txt(app.$("#auth-error")))); assert.strictEqual(txt(app.$("#auth-submit")), "Save new password", "can try again");
    fill(app, "#auth-password", "longenough1"); fill(app, "#auth-confirm", "longenough1"); app.$("#auth-submit").click(); await app.sleep(40);
    assert.strictEqual(txt(app.$("#auth-subtitle")), "Reset your password"); assert(/expired or was already used/.test(txt(app.$("#auth-error"))));
    assert.strictEqual(app.w.sessionStorage.getItem("agent1102_recovery"), null);
  }));
  await t("?reset=1 with no saved link login (opened twice, or in another browser) says so and offers a fresh link", () => withApp(signedOut({ url: "http://localhost/?reset=1" }), async app => {
    assert.strictEqual(txt(app.$("#auth-subtitle")), "Reset your password"); assert(/expired or was already used/.test(txt(app.$("#auth-error"))));
    assert.strictEqual(app.w.location.search, "");
  }));

  console.log("\nNotices after the other email links");
  await t("signed in after confirming the sign-up email: a toast, and the address bar is tidied", () => withApp({ url: "http://localhost/?notice=confirmed" }, async app => {
    await app.sleep(50); assert(/email is confirmed/.test(app.w.document.body.textContent)); assert.strictEqual(app.w.location.search, "");
  }));
  await t("an email change that was confirmed: a toast", () => withApp({ url: "http://localhost/?notice=email_changed" }, async app => { await app.sleep(50); assert(/email address was changed/.test(app.w.document.body.textContent)); }));
  await t("the first of the two links for a secure email change says to open the other one (signed out: a green message)", () => withApp(signedOut({ url: "http://localhost/?notice=email_pending" }), async app => {
    assert(/OTHER address/.test(txt(app.$("#auth-error")))); assert(app.$("#auth-error").classList.contains("info"));
  }));
  await t("an old or used link: a red message, and the resend option is there", () => withApp(signedOut({ url: "http://localhost/?notice=link_invalid" }), async app => {
    assert(/expired or was already used/.test(txt(app.$("#auth-error")))); assert(!app.$("#auth-error").classList.contains("info")); assert(shown(app.$("#auth-resend")));
  }));
  await t("an unknown notice does nothing (nobody can put their own words on the page through the address)", () => withApp(signedOut({ url: "http://localhost/?notice=<b>hi</b>" }), async app => { assert.strictEqual(txt(app.$("#auth-error")), ""); }));
  await t("the Discord/GitHub failure message still works", () => withApp(signedOut({ url: "http://localhost/?error=oauth_failed" }), async app => { assert(/That sign-in didn't work/.test(txt(app.$("#auth-error")))); }));

  console.log("\nSettings: change email");
  const openProfile = async app => { app.$("#settings-btn").click(); await app.sleep(30); };
  await t("sends a confirmation link and shows 'waiting for confirmation', without changing the shown address", () => withApp({ routes: { "/profile": () => ok({ profile: { name: "Sam", email: "sam@x.co" } }), "/auth/email/change": b => ok({ pendingEmail: b.email, currentEmail: "sam@x.co" }) } }, async app => {
    await openProfile(app);
    assert(!shown(app.$("#profile-email-pending")));
    app.$("#save-email").click(); await app.sleep(20);
    assert(/Type your new email/.test(txt(app.$("#profile-msg")))); assert.strictEqual(callsTo(app, "/auth/email/change").length, 0);
    fill(app, "#profile-email", "new@x.co"); app.$("#save-email").click(); await app.sleep(40);
    assert.deepStrictEqual(callsTo(app, "/auth/email/change")[0].body, { email: "new@x.co" });
    assert(shown(app.$("#profile-email-pending")) && txt(app.$("#profile-email-pending-address")) === "new@x.co");
    assert.strictEqual(txt(app.$("#profile-email-current")), "sam@x.co", "still the old one until the link is opened");
    assert(/confirmation link to new@x\.co/.test(txt(app.$("#profile-msg")))); assert(app.$("#profile-msg").classList.contains("ok"));
    assert.strictEqual(app.$("#profile-email").value, "");
  }));
  await t("a change Supabase makes at once updates the shown address; a refused address shows the reason", () => withApp({ routes: { "/auth/email/change": b => b.email === "taken@x.co" ? bad(400, "An account with that email already exists.") : ok({ changed: true, email: b.email }) } }, async app => {
    await openProfile(app);
    fill(app, "#profile-email", "taken@x.co"); app.$("#save-email").click(); await app.sleep(40);
    assert(/already exists/.test(txt(app.$("#profile-msg")))); assert(app.$("#profile-msg").classList.contains("err"));
    fill(app, "#profile-email", "instant@x.co"); app.$("#save-email").click(); await app.sleep(40);
    assert.strictEqual(txt(app.$("#profile-email-current")), "instant@x.co"); assert(!shown(app.$("#profile-email-pending")));
  }));
  await t("a change still waiting is shown when Settings opens after a page reload", () => withApp({ routes: { "/profile": () => ok({ profile: { name: "Sam", email: "sam@x.co", pendingEmail: "later@x.co" } }) } }, async app => {
    await openProfile(app);
    assert(shown(app.$("#profile-email-pending")) && txt(app.$("#profile-email-pending-address")) === "later@x.co");
  }));

  console.log("\nSettings: change password with an emailed code");
  const pwRoutes = (over = {}) => ({ "/auth/password/code": () => ok({ ok: true, sentTo: "s**@x.co" }), "/auth/password": () => ok({ ok: true }), ...over });
  await t("step 1 needs both boxes to match; nothing is emailed until they do; then the code box appears with the masked address", () => withApp({ routes: pwRoutes() }, async app => {
    await openProfile(app);
    assert(!shown(app.$("#password-code-box")));
    app.$("#send-password-code").click(); await app.sleep(20); assert(/new password first/.test(txt(app.$("#profile-msg"))));
    fill(app, "#profile-password", "newpassword1"); app.$("#send-password-code").click(); await app.sleep(20); assert(/second time/.test(txt(app.$("#profile-msg"))));
    fill(app, "#profile-password-confirm", "different"); app.$("#send-password-code").click(); await app.sleep(20); assert(/don't match/.test(txt(app.$("#profile-msg"))));
    assert.strictEqual(callsTo(app, "/auth/password/code").length, 0, "no email was sent");
    fill(app, "#profile-password-confirm", "newpassword1"); app.$("#send-password-code").click(); await app.sleep(40);
    assert.strictEqual(callsTo(app, "/auth/password/code").length, 1);
    assert(shown(app.$("#password-code-box"))); assert(/emailed a code to s\*\*@x\.co/.test(txt(app.$("#password-code-note"))));
    assert.strictEqual(callsTo(app, "/auth/password").length, 0, "the password is NOT changed yet");
  }));
  await t("step 2 sends the code with both passwords; success clears everything and hides the code box", () => withApp({ routes: pwRoutes() }, async app => {
    await openProfile(app);
    fill(app, "#profile-password", "newpassword1"); fill(app, "#profile-password-confirm", "newpassword1"); app.$("#send-password-code").click(); await app.sleep(40);
    app.$("#save-password").click(); await app.sleep(20);
    assert(/Type the code/.test(txt(app.$("#profile-msg")))); assert.strictEqual(callsTo(app, "/auth/password").length, 0);
    fill(app, "#password-code", " 123456 "); app.$("#save-password").click(); await app.sleep(40);
    assert.deepStrictEqual(callsTo(app, "/auth/password")[0].body, { password: "newpassword1", confirmPassword: "newpassword1", code: "123456" });
    for (const id of ["#profile-password", "#profile-password-confirm", "#password-code"]) assert.strictEqual(app.$(id).value, "", id + " cleared");
    assert(!shown(app.$("#password-code-box"))); assert(/Password changed/.test(txt(app.$("#profile-msg")))); assert(app.$("#profile-msg").classList.contains("ok"));
  }));
  await t("a wrong code shows Supabase's reason and keeps the box open to try again; 'Send a new code' asks for another", () => withApp({ routes: pwRoutes({ "/auth/password": () => bad(400, "That code isn't right, or it has expired. Check your newest email, or ask for a new code.") }) }, async app => {
    await openProfile(app);
    fill(app, "#profile-password", "newpassword1"); fill(app, "#profile-password-confirm", "newpassword1"); app.$("#send-password-code").click(); await app.sleep(40);
    fill(app, "#password-code", "000000"); app.$("#save-password").click(); await app.sleep(40);
    assert(/isn't right/.test(txt(app.$("#profile-msg")))); assert(app.$("#profile-msg").classList.contains("err"));
    assert(shown(app.$("#password-code-box")) && app.$("#profile-password").value === "newpassword1", "nothing they typed is lost");
    app.$("#resend-password-code").click(); await app.sleep(40);
    assert.strictEqual(callsTo(app, "/auth/password/code").length, 2);
  }));
  await t("closing Settings drops a half-finished password change: boxes emptied, code step gone", () => withApp({ routes: pwRoutes() }, async app => {
    await openProfile(app);
    fill(app, "#profile-password", "newpassword1"); fill(app, "#profile-password-confirm", "newpassword1"); app.$("#send-password-code").click(); await app.sleep(40);
    fill(app, "#password-code", "123456"); app.$("#settings-close").click();
    await openProfile(app);
    for (const id of ["#profile-password", "#profile-password-confirm", "#password-code"]) assert.strictEqual(app.$(id).value, "", id);
    assert(!shown(app.$("#password-code-box")));
  }));

  console.log("\nthe callback page every email link lands on (public/js/oauth-callback.js)");
  const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "public", "js", "oauth-callback.js"), "utf8");
  function landOn(hash) {
    const local = {}, sess = {}; let replaced = null, hrefSet = false;
    const store = o => ({ setItem: (k, v) => { o[k] = String(v); }, getItem: k => (k in o ? o[k] : null) });
    const win = { location: { hash, replace: u => { replaced = u; }, set href(v) { hrefSet = true; } } };
    vm.runInNewContext(SCRIPT, { window: win, localStorage: store(local), sessionStorage: store(sess), URLSearchParams, Date });
    return { to: replaced, local, sess, hrefSet };
  }
  await t("Discord/GitHub: login saved, back to the app, tab marked active so 'Stay signed in' can't sign it straight out", () => {
    const r = landOn("#access_token=AT&refresh_token=RT&token_type=bearer");
    assert.strictEqual(r.to, "/"); assert.deepStrictEqual([r.local.agent1102_token, r.local.agent1102_refresh_token], ["AT", "RT"]);
    assert.strictEqual(r.sess.agent1102_tab_alive, "1"); assert(Number(r.local.agent1102_last_seen) > 0);
  });
  await t("reset-password link: its login is kept for THIS tab only (never in localStorage) and the app opens the new-password screen", () => {
    const r = landOn("#access_token=AT&refresh_token=RT&type=recovery");
    assert.strictEqual(r.to, "/?reset=1"); assert.deepStrictEqual(JSON.parse(r.sess.agent1102_recovery), { a: "AT", r: "RT" });
    assert.deepStrictEqual(r.local, {}, "no normal sign-in is created by the link alone");
  });
  await t("confirm-sign-up link signs them in; confirmed-email-change link signs them in; each says what happened", () => {
    const a = landOn("#access_token=AT&refresh_token=RT&type=signup"), b = landOn("#access_token=AT2&refresh_token=RT2&type=email_change");
    assert.deepStrictEqual([a.to, a.local.agent1102_token], ["/?notice=confirmed", "AT"]); assert.deepStrictEqual([b.to, b.local.agent1102_token], ["/?notice=email_changed", "AT2"]);
  });
  await t("the first link of a secure email change carries no login, only a message: say to open the other one", () => {
    const r = landOn("#message=Confirmation+link+accepted.+Please+proceed+to+confirm+link+sent+to+the+other+email");
    assert.strictEqual(r.to, "/?notice=email_pending"); assert.deepStrictEqual(r.local, {});
  });
  await t("an expired or already-used link says so; a refused Discord/GitHub sign-in keeps its own message; an empty visit is a failed sign-in", () => {
    assert.strictEqual(landOn("#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired").to, "/?notice=link_invalid");
    assert.strictEqual(landOn("#error=access_denied&error_description=The+user+denied+access").to, "/?error=oauth_failed");
    assert.strictEqual(landOn("").to, "/?error=oauth_failed");
  });
  await t("it uses replace(), so the address that holds the login tokens is not left in the back-button history", () => {
    for (const h of ["#access_token=AT&type=recovery", "#access_token=AT", "#error=x", ""]) { const r = landOn(h); assert(r.to && !r.hrefSet, h); }
  });

  console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
  process.exit(failed ? 1 : 0);
})();
