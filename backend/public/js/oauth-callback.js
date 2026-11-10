// The page every link from Supabase comes back to (served by /auth/callback): Discord / GitHub sign-in, and the links in the
// emails (confirm sign-up, reset password, confirm a new email address). What the link is for is in the address after the #.
// (This is a file, not an inline script, because the site's Content-Security-Policy does not allow inline scripts.)
(function () {
  var params = new URLSearchParams(window.location.hash.replace("#", ""));
  var token = params.get("access_token");
  var refresh = params.get("refresh_token");
  var type = params.get("type");
  // replace(), not href=: the address that still has the login tokens in it must not stay in the back-button history
  var go = function (url) { window.location.replace(url); };
  var saveLogin = function () {
    localStorage.setItem("agent1102_token", token);
    // without this the login would end when the access token expires (about an hour)
    if (refresh) localStorage.setItem("agent1102_refresh_token", refresh);
    // This tab was just signed in by a link. Mark it as active so session.js (the "Stay signed in" check) can't mistake it for an
    // old login that someone left behind with the box unticked and sign it straight back out.
    try { sessionStorage.setItem("agent1102_tab_alive", "1"); localStorage.setItem("agent1102_last_seen", String(Date.now())); } catch (_) { /* storage blocked */ }
  };

  if (params.get("error")) {
    // an email link that is old, or was already used, comes back as otp_expired; anything else is a sign-in that didn't complete
    var why = (params.get("error_code") || "") + " " + (params.get("error_description") || "");
    return go(/otp_expired|email link|expired|invalid/i.test(why) ? "/?notice=link_invalid" : "/?error=oauth_failed");
  }

  if (token && type === "recovery") {
    // The reset-password link. Its login is kept for THIS tab only, and only to set the new password: it is not a normal sign-in yet.
    sessionStorage.setItem("agent1102_recovery", JSON.stringify({ a: token, r: refresh }));
    return go("/?reset=1");
  }
  if (token && type === "signup") { saveLogin(); return go("/?notice=confirmed"); }
  if (token && type === "email_change") { saveLogin(); return go("/?notice=email_changed"); }
  if (token) { saveLogin(); return go("/"); } // Discord / GitHub

  // With "Secure email change" on, the first link opened only says "now confirm at the other address" and carries no login
  if (params.get("message")) return go("/?notice=email_pending");
  go("/?error=oauth_failed");
})();
