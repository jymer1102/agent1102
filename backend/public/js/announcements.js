// Notifications from the site owner: a bar at the top of the app, one row per message, each with an x that hides it for good (for this account).
// The server decides what is on right now and what this person already dismissed (GET /announcements). Loaded on sign-in, then re-checked every
// few minutes and when you come back to the tab, so a new message shows up without a reload and an expired one goes away.
(function () {
  "use strict";
  const bar = document.getElementById("announcement-bar");
  if (!bar) return;
  let timer = 0, loading = false, shown = new Map(); // id -> the row on screen

  const headers = () => ({ "Authorization": `Bearer ${userToken}` });

  function render(list) {
    const ids = new Set(list.map(a => a.id));
    for (const [id, row] of shown) if (!ids.has(id)) { row.remove(); shown.delete(id); }          // expired, removed by the owner, or hidden in another tab
    for (const a of list) {
      if (shown.has(a.id)) continue;
      const row = document.createElement("div");
      row.className = "announcement";
      row.setAttribute("role", "status");
      const icon = document.createElement("i"); icon.className = "fa-solid fa-bullhorn announcement-icon"; icon.setAttribute("aria-hidden", "true");
      const text = document.createElement("span"); text.className = "announcement-text"; text.textContent = a.message; // textContent: the message is never read as HTML
      const x = document.createElement("button");
      x.type = "button"; x.className = "icon-btn announcement-x"; x.title = "Dismiss"; x.setAttribute("aria-label", "Dismiss this notification");
      x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      x.addEventListener("click", () => dismiss(a.id));
      row.append(icon, text, x);
      bar.append(row);
      shown.set(a.id, row);
    }
    bar.hidden = shown.size === 0;
  }

  async function dismiss(id) {
    const row = shown.get(id);
    if (row) { row.remove(); shown.delete(id); }   // gone at once; the server is told in the background
    bar.hidden = shown.size === 0;
    if (!userToken) return;
    try { await fetch(`${BACKEND_URL}/announcements/${encodeURIComponent(id)}/dismiss`, { method: "POST", headers: headers() }); }
    catch (_) { /* offline: it may come back on the next check, and the x works again */ }
  }

  async function load() {
    if (!userToken || loading) return;
    loading = true;
    try {
      const res = await fetch(`${BACKEND_URL}/announcements`, { headers: headers() });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (data && Array.isArray(data.announcements)) render(data.announcements);
    } catch (_) { /* offline or the server is waking up: try again next time */ }
    finally { loading = false; }
  }

  function start() {
    load();
    clearInterval(timer);
    timer = setInterval(load, 5 * 60 * 1000);
  }
  function clear() {            // signing out: the next person on this browser starts with no bar
    clearInterval(timer); timer = 0;
    shown.forEach(row => row.remove()); shown.clear();
    bar.hidden = true;
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") load(); });

  window.agent1102Announcements = { start, clear, load };
})();
