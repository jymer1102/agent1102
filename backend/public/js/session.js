// "Stay signed in"
//
// The login (access token + refresh token) is kept in localStorage so every tab, and the games (which open in
// their own tab), can use it. When someone signs in with "Stay signed in" unticked, that login must not outlive
// their browser session. A page can't tell that the browser is closing, so instead:
//   - while any tab of the site is open, a "last seen" time is refreshed every 20 seconds
//   - when the site loads and finds an unticked login, it ends that login if this tab is brand new AND nothing
//     was seen for 3 minutes (i.e. the browser was closed in between)
// A tab that is reloaded, restored or woken from sleep keeps a marker in sessionStorage, so it stays signed in.
// This file loads before config.js, which reads the token, so an ended login is never picked up.
(function () {
  const STAY = "agent1102_stay_signed_in"; // "0" = unticked. Missing or anything else = stay signed in (also covers logins saved before this existed)
  const SEEN = "agent1102_last_seen";
  const TAB = "agent1102_tab_alive";
  const GAP_MS = 3 * 60 * 1000;            // longer than the slowest timer a background tab gets (about a minute)
  const safe = fn => { try { return fn(); } catch (_) { return undefined; } }; // storage can be blocked (private mode, settings)

  const stay = () => safe(() => localStorage.getItem(STAY)) !== "0";

  function touch() {
    safe(() => {
      sessionStorage.setItem(TAB, "1");
      if (!stay()) localStorage.setItem(SEEN, String(Date.now()));
    });
  }

  function end() {
    safe(() => {
      localStorage.removeItem("agent1102_token");
      localStorage.removeItem("agent1102_refresh_token");
      localStorage.removeItem(SEEN);
    });
  }

  // On load: was an unticked login left behind by a browser that has since been closed?
  safe(() => {
    if (stay() || !localStorage.getItem("agent1102_token")) return;
    const knownTab = sessionStorage.getItem(TAB) === "1";
    const idleMs = Date.now() - (Number(localStorage.getItem(SEEN)) || 0);
    if (!knownTab && idleMs > GAP_MS) end();
  });

  touch();
  setInterval(touch, 20 * 1000);
  window.addEventListener("pagehide", touch);
  document.addEventListener("visibilitychange", touch);

  window.agent1102Session = {
    stay,                                  // true unless the last sign-in on this device had the box unticked
    begin(wantStay) {                      // call when a sign-in starts or completes, with the checkbox's value
      safe(() => localStorage.setItem(STAY, wantStay ? "1" : "0"));
      touch();
    },
    end,                                   // signing out: removes the saved login
  };
})();
