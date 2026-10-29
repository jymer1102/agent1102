// The page Discord / GitHub sign-in returns to (served by /auth/callback). The tokens come in the address after
// the #. They are saved the same way a password sign-in saves them, then the person is sent back to the app.
// (This is a file, not an inline script, because the site's Content-Security-Policy does not allow inline scripts.)
(function () {
  var params = new URLSearchParams(window.location.hash.replace("#", ""));
  var token = params.get("access_token");
  var refresh = params.get("refresh_token");
  if (token) {
    localStorage.setItem("agent1102_token", token);
    // without this the OAuth login would end when the access token expires (about an hour)
    if (refresh) localStorage.setItem("agent1102_refresh_token", refresh);
    window.location.href = "/";
  } else {
    window.location.href = "/?error=oauth_failed";
  }
})();
