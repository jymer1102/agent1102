// ============================================================
//  Every answer from the server passes through here first.
//  If the account was banned or suspended while the person was signed in, the server answers any request with a 403 whose
//  body says code "user_banned". This tells the rest of the page (auth.js) straight away, so they are signed out at once
//  and see the reason, whichever part of the app made the request (chat, settings, saving a chat, the background check...).
//  The answer itself is passed on untouched.
// ============================================================
(function () {
  "use strict";
  const real = window.fetch;
  if (typeof real !== "function") return;
  window.fetch = function () {
    return real.apply(this, arguments).then(res => {
      if (res && res.status === 403 && typeof res.clone === "function") {
        // (a copy is read, so the caller can still read the original)
        res.clone().json().then(body => {
          if (body && body.code === "user_banned") window.dispatchEvent(new CustomEvent("agent1102:banned", { detail: { message: String(body.error || "") } }));
        }).catch(() => { /* not JSON: not ours */ });
      }
      return res;
    });
  };
})();
