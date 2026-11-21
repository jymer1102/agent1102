// The admin window (sidebar -> shield button, shown only to admins; the server checks again on every request).
//   Overview: setup checks + one-click fixes    Users: search, open an account, see its chats, suspend / unban
//   Notify: a message for everyone, for as long as you choose    Ask AI: ask anything about the users and what they ask    Activity: what admins did
(function () {
  "use strict";
  const btn = document.getElementById("admin-btn");
  const modal = document.getElementById("admin-modal");
  const body = document.getElementById("admin-body");
  if (!btn || !modal || !body) return;
  const tabs = [...modal.querySelectorAll(".admin-tab")];
  let page = "overview", returnFocus = null, askUser = null; // askUser: { id, label } when "Ask AI about this user" was used

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const when = v => { const d = new Date(v); return v && !isNaN(d) ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never"; };
  const day = v => { const d = new Date(v); return v && !isNaN(d) ? d.toLocaleDateString([], { dateStyle: "medium" }) : "never"; };

  async function api(method, path, payload) {
    let res;
    try {
      res = await fetch(`${BACKEND_URL}${path}`, { method, headers: { "Authorization": `Bearer ${userToken}`, ...(payload ? { "Content-Type": "application/json" } : {}) }, body: payload ? JSON.stringify(payload) : undefined });
    } catch (_) { throw new Error("I can't reach the server right now. Check your connection and try again."); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || "Something went wrong. Please try again."); e.status = res.status; e.data = data; throw e; }
    return data;
  }
  const say = (el, text, kind) => { if (!el) return; el.textContent = text || ""; el.className = "settings-msg" + (kind ? " " + kind : ""); };
  const statusBadge = u => u.status === "active" ? "" : `<span class="admin-badge ${u.status}">${u.status === "banned" ? "Banned" : "Suspended"}</span>`;

  // ---------- window ----------
  function open(startPage) {
    if (btn.hidden || !userToken) return;
    if (typeof closeSidebarFn === "function") closeSidebarFn();
    returnFocus = document.activeElement;
    modal.classList.add("open");
    select(startPage || page);
  }
  function close() {
    if (!modal.classList.contains("open")) return;
    modal.classList.remove("open");
    body.innerHTML = "";
    if (returnFocus && document.contains(returnFocus) && typeof returnFocus.focus === "function") returnFocus.focus();
    returnFocus = null;
  }
  function select(next) {
    page = next;
    tabs.forEach(t => { const on = t.dataset.page === next; t.setAttribute("aria-selected", on ? "true" : "false"); t.tabIndex = on ? 0 : -1; });
    ({ overview, users, notify, ask, activity })[next]();
  }
  btn.addEventListener("click", () => open("overview"));
  document.getElementById("admin-close").addEventListener("click", close);
  modal.addEventListener("click", e => { if (e.target === modal) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("open") && !(typeof agent1102CodeDialog !== "undefined" && agent1102CodeDialog.isOpen)) close(); });
  tabs.forEach(t => t.addEventListener("click", () => select(t.dataset.page)));

  // ---------- Overview ----------
  async function overview() {
    body.innerHTML = '<section class="settings-page"><h3 class="settings-h"><i class="fa-solid fa-gauge"></i> Setup check</h3><p class="field-note">Checking your Supabase setup...</p></section>';
    let data;
    try { data = await api("GET", "/admin/health"); } catch (e) { body.innerHTML = `<section class="settings-page"><p class="settings-msg err">${esc(e.message)}</p></section>`; return; }
    if (page !== "overview") return;
    body.innerHTML = `<section class="settings-page"><h3 class="settings-h"><i class="fa-solid fa-gauge"></i> Setup check</h3>
      <ul class="admin-list">${data.checks.map(c => `<li class="admin-row"><div class="admin-row-main"><strong><i class="fa-solid ${c.ok ? "fa-circle-check admin-ok" : "fa-triangle-exclamation admin-bad"}"></i> ${esc(c.label)}</strong><span class="field-note">${esc(c.detail)}</span></div>${c.fix ? `<button type="button" class="modal-btn primary" data-fix="${esc(c.fix)}">${esc(c.fixLabel || "Fix")}</button>` : ""}</li>`).join("")}</ul>
      <p id="admin-msg" class="settings-msg" role="status" aria-live="polite"></p></section>`;
    body.querySelectorAll("[data-fix]").forEach(b => b.addEventListener("click", async () => {
      const msg = document.getElementById("admin-msg");
      b.disabled = true; say(msg, "Working...");
      try {
        const r = await api("POST", "/admin/" + b.dataset.fix);
        if (b.dataset.fix === "backfill-authors") say(msg, `Filled in the author on ${r.chats} chat(s) for ${r.users} account(s).`, "ok");
        else if (r.failed && r.failed.length) say(msg, `Saved ${r.updated} number(s). ${r.failed.length} could not be saved. First problem: ${r.failed[0].email}: ${r.failed[0].reason}`, "err");
        else say(msg, `Saved ${r.updated} phone number(s).`, "ok");
        setTimeout(() => { if (page === "overview") overview(); }, 2500);
      } catch (e) { say(msg, e.message, "err"); b.disabled = false; }
    }));
  }

  // ---------- Users ----------
  let userQuery = "";
  async function users() {
    body.innerHTML = `<section class="settings-page"><h3 class="settings-h"><i class="fa-solid fa-users"></i> Users</h3>
      <div class="field-row"><input type="text" id="admin-search" class="modal-input" placeholder="Search by name, email, phone or id" value="${esc(userQuery)}" autocomplete="off" spellcheck="false" aria-label="Search users" /></div>
      <ul class="admin-list" id="admin-users"><li class="field-note">Loading...</li></ul><p id="admin-msg" class="settings-msg" role="status" aria-live="polite"></p></section>`;
    const input = document.getElementById("admin-search");
    let t = 0;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { userQuery = input.value.trim(); loadUsers(); }, 250); });
    loadUsers();
  }
  async function loadUsers() {
    const list = document.getElementById("admin-users"); if (!list) return;
    try {
      const data = await api("GET", "/admin/users?q=" + encodeURIComponent(userQuery));
      if (!document.getElementById("admin-users")) return;
      list.innerHTML = data.users.length ? data.users.map(u => `<li><button type="button" class="admin-row admin-user" data-id="${esc(u.id)}"><div class="admin-row-main"><strong>${esc(u.name || u.email || "(no name)")} ${statusBadge(u)}</strong><span class="field-note">${esc(u.email || "no email")} &middot; last sign-in ${esc(day(u.last_sign_in_at))}</span></div><i class="fa-solid fa-chevron-right"></i></button></li>`).join("")
        : '<li class="field-note">No one matches that.</li>';
      say(document.getElementById("admin-msg"), `Showing ${data.shown} of ${data.total} account(s).`);
      list.querySelectorAll(".admin-user").forEach(b => b.addEventListener("click", () => userDetail(b.dataset.id)));
    } catch (e) { list.innerHTML = ""; say(document.getElementById("admin-msg"), e.message, "err"); }
  }

  async function userDetail(id) {
    body.innerHTML = '<section class="settings-page"><p class="field-note">Loading...</p></section>';
    let d;
    try { d = await api("GET", "/admin/users/" + encodeURIComponent(id)); } catch (e) { body.innerHTML = `<section class="settings-page"><button type="button" class="modal-btn subtle" id="admin-back">Back</button><p class="settings-msg err">${esc(e.message)}</p></section>`; document.getElementById("admin-back").addEventListener("click", users); return; }
    if (page !== "users") return;
    const u = d.user;
    const sus = u.status !== "active";
    body.innerHTML = `<section class="settings-page">
      <button type="button" class="modal-btn subtle admin-back" id="admin-back"><i class="fa-solid fa-chevron-left"></i> All users</button>
      <h3 class="settings-h">${esc(u.name || u.email || "Account")} ${statusBadge(u)}</h3>
      <dl class="admin-facts">
        <dt>Email</dt><dd>${esc(u.email || "none")}</dd>
        <dt>Phone</dt><dd>${esc(u.phone || "none")}${u.phone && !u.phone_in_auth ? ' <span class="field-note">(not yet saved on the account)</span>' : ""}</dd>
        <dt>Signed up</dt><dd>${esc(when(u.created_at))} via ${esc(u.provider)}</dd>
        <dt>Last sign-in</dt><dd>${esc(when(u.last_sign_in_at))}</dd>
        <dt>Account id</dt><dd><code>${esc(u.id)}</code></dd>
        ${sus ? `<dt>${u.status === "banned" ? "Banned" : "Suspended"} until</dt><dd>${u.status === "banned" ? "further notice" : esc(when(u.banned_until))}</dd>` : ""}
      </dl>
      <div class="field-row">
        <button type="button" class="modal-btn primary" id="admin-ask-user"><i class="fa-solid fa-wand-magic-sparkles"></i> Ask AI about this user</button>
        ${u.admin ? "" : sus ? '<button type="button" class="modal-btn subtle" id="admin-unban">Lift suspension</button>' : ""}
      </div>
      ${u.admin ? '<p class="field-note">This is an admin account, so it can\'t be suspended from here.</p>' : sus ? "" : `<div class="field admin-suspend"><label for="admin-sus-len">Suspend this account</label>
        <div class="field-row"><select id="admin-sus-len" class="modal-input"><option value="1">1 day</option><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option><option value="permanent">Permanently (ban)</option></select>
        <button type="button" class="modal-btn danger-solid" id="admin-suspend">Suspend</button></div>
        <p class="field-note">They are signed out right away and see a banned message if they try to sign in. Lift it any time.</p></div>`}
      <p id="admin-msg" class="settings-msg" role="status" aria-live="polite"></p>
      <h3 class="settings-h"><i class="fa-solid fa-comments"></i> Chats (${d.chats.length})</h3>
      <ul class="admin-list">${d.chats.length ? d.chats.map(c => `<li><button type="button" class="admin-row admin-chat" data-chat="${esc(c.id)}"><div class="admin-row-main"><strong>${esc(c.title)}</strong><span class="field-note">${esc(day(c.updated_at || c.created_at))} &middot; ${c.messages} message(s)${c.preview ? " &middot; " + esc(c.preview) : ""}</span></div><i class="fa-solid fa-chevron-right"></i></button></li>`).join("") : '<li class="field-note">No saved chats.</li>'}</ul>
      ${d.memories.length ? `<h3 class="settings-h"><i class="fa-solid fa-brain"></i> Saved memories (${d.memories.length})</h3><ul class="admin-list">${d.memories.map(m => `<li class="admin-row"><div class="admin-row-main"><span>${esc(m.content)}</span><span class="field-note">${esc(m.kind)}</span></div></li>`).join("")}</ul>` : ""}
    </section>`;
    document.getElementById("admin-back").addEventListener("click", users);
    document.getElementById("admin-ask-user").addEventListener("click", () => { askUser = { id: u.id, label: u.name || u.email || u.id }; select("ask"); });
    body.querySelectorAll(".admin-chat").forEach(b => b.addEventListener("click", () => chatView(u.id, b.dataset.chat)));
    const msg = document.getElementById("admin-msg");
    const sb = document.getElementById("admin-suspend");
    if (sb) sb.addEventListener("click", async () => {
      const v = document.getElementById("admin-sus-len").value;
      if (!confirm(v === "permanent" ? `Ban ${u.email || "this account"} permanently?` : `Suspend ${u.email || "this account"} for ${v} day(s)?`)) return;
      sb.disabled = true; say(msg, "Working...");
      try { await api("POST", `/admin/users/${encodeURIComponent(u.id)}/suspend`, v === "permanent" ? { permanent: true } : { days: Number(v) }); userDetail(u.id); }
      catch (e) { say(msg, e.message, "err"); sb.disabled = false; }
    });
    const ub = document.getElementById("admin-unban");
    if (ub) ub.addEventListener("click", async () => {
      ub.disabled = true; say(msg, "Working...");
      try { await api("POST", `/admin/users/${encodeURIComponent(u.id)}/unban`); userDetail(u.id); }
      catch (e) { say(msg, e.message, "err"); ub.disabled = false; }
    });
  }

  async function chatView(userId, chatId) {
    body.innerHTML = '<section class="settings-page"><p class="field-note">Loading...</p></section>';
    try {
      const { chat } = await api("GET", `/admin/users/${encodeURIComponent(userId)}/chats/${encodeURIComponent(chatId)}`);
      if (page !== "users") return;
      body.innerHTML = `<section class="settings-page"><button type="button" class="modal-btn subtle admin-back" id="admin-back"><i class="fa-solid fa-chevron-left"></i> Back to account</button>
        <h3 class="settings-h">${esc(chat.title)}</h3><p class="field-note">${esc(chat.author ? "By " + chat.author + " · " : "")}${esc(when(chat.created_at))}</p>
        <div class="admin-chat-log">${chat.messages.map(m => `<div class="admin-msg ${m.role}"><span class="admin-msg-who">${m.role === "user" ? "User" : "AI"}</span><div class="admin-msg-text">${esc(m.text)}</div></div>`).join("") || '<p class="field-note">This chat is empty.</p>'}</div></section>`;
      document.getElementById("admin-back").addEventListener("click", () => userDetail(userId));
    } catch (e) { body.innerHTML = `<section class="settings-page"><button type="button" class="modal-btn subtle" id="admin-back">Back</button><p class="settings-msg err">${esc(e.message)}</p></section>`; document.getElementById("admin-back").addEventListener("click", () => userDetail(userId)); }
  }

  // ---------- Notify ----------
  async function notify() {
    body.innerHTML = `<section class="settings-page"><h3 class="settings-h"><i class="fa-solid fa-bullhorn"></i> Notify everyone</h3>
      <div class="field"><label for="admin-note">Message</label>
        <textarea id="admin-note" rows="3" maxlength="500" placeholder="For example: A new update is coming on December 3."></textarea></div>
      <div class="field"><label for="admin-note-n">Show it for</label>
        <div class="field-row"><input type="number" id="admin-note-n" class="modal-input" min="1" max="365" value="3" inputmode="numeric" />
        <select id="admin-note-unit" class="modal-input"><option value="hours">hours</option><option value="days">days</option><option value="weeks" selected>weeks</option></select>
        <button type="button" class="modal-btn primary" id="admin-note-send">Send</button></div>
        <p class="field-note">Everyone who is signed in sees it at the top of the app until it runs out. They can close it with the x.</p></div>
      <p id="admin-msg" class="settings-msg" role="status" aria-live="polite"></p>
      <h3 class="settings-h"><i class="fa-solid fa-list"></i> Recent notifications</h3><ul class="admin-list" id="admin-notes"><li class="field-note">Loading...</li></ul></section>`;
    document.getElementById("admin-note-send").addEventListener("click", async e => {
      const msg = document.getElementById("admin-msg"), send = e.currentTarget;
      const message = document.getElementById("admin-note").value.trim();
      const n = Number(document.getElementById("admin-note-n").value), unit = document.getElementById("admin-note-unit").value;
      if (!message) return say(msg, "Type the message to show.", "err");
      if (!(n >= 1)) return say(msg, "Choose how long to show it.", "err");
      send.disabled = true; say(msg, "Sending...");
      try {
        await api("POST", "/admin/announcements", { message, ...(unit === "hours" ? { hours: n } : { days: unit === "weeks" ? n * 7 : n }) });
        document.getElementById("admin-note").value = "";
        say(msg, "Sent. Everyone will see it within a few minutes.", "ok");
        loadNotes();
      } catch (err) { say(msg, err.message, "err"); }
      send.disabled = false;
    });
    loadNotes();
  }
  async function loadNotes() {
    const list = document.getElementById("admin-notes"); if (!list) return;
    try {
      const { announcements } = await api("GET", "/admin/announcements");
      if (!document.getElementById("admin-notes")) return;
      list.innerHTML = announcements.length ? announcements.map(a => `<li class="admin-row"><div class="admin-row-main"><span>${esc(a.message)}</span><span class="field-note">${a.active ? "Showing until " + esc(when(a.expires_at)) : "Ended " + esc(when(a.expires_at))}</span></div>${'<button type="button" class="modal-btn subtle" data-del="' + esc(a.id) + '">' + (a.active ? "Stop" : "Delete") + "</button>"}</li>`).join("") : '<li class="field-note">Nothing sent yet.</li>';
      list.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
        b.disabled = true;
        try { await api("DELETE", "/admin/announcements/" + encodeURIComponent(b.dataset.del)); loadNotes(); } catch (e) { say(document.getElementById("admin-msg"), e.message, "err"); b.disabled = false; }
      }));
    } catch (e) { list.innerHTML = ""; say(document.getElementById("admin-msg"), e.message, "err"); }
  }

  // ---------- Ask AI ----------
  async function ask() {
    body.innerHTML = `<section class="settings-page"><h3 class="settings-h"><i class="fa-solid fa-wand-magic-sparkles"></i> Ask the AI about your users</h3>
      <p class="field-note">${askUser ? `Asking about <strong>${esc(askUser.label)}</strong> (their most recent chats).` : "It reads the account list and what people typed in the most recent chats across the site."} <button type="button" class="auth-toggle" id="admin-ask-scope">${askUser ? "Ask about everyone instead" : ""}</button></p>
      <div class="field"><textarea id="admin-q" rows="3" maxlength="1000" placeholder="${askUser ? "What has this person been asking about?" : "What are people asking about this week? Who signed up recently?"}" aria-label="Your question"></textarea></div>
      <button type="button" class="modal-btn primary" id="admin-ask-go">Ask</button>
      <p id="admin-msg" class="settings-msg" role="status" aria-live="polite"></p>
      <div id="admin-answer" class="admin-answer" hidden></div></section>`;
    const scope = document.getElementById("admin-ask-scope");
    if (askUser) scope.addEventListener("click", () => { askUser = null; ask(); }); else scope.hidden = true;
    const go = document.getElementById("admin-ask-go"), q = document.getElementById("admin-q");
    const run = async () => {
      const question = q.value.trim(), msg = document.getElementById("admin-msg"), out = document.getElementById("admin-answer");
      if (!question) return say(msg, "Type your question first.", "err");
      go.disabled = true; out.hidden = true; say(msg, "Reading the chats...");
      try {
        const r = await api("POST", "/admin/ask", { question, ...(askUser ? { userId: askUser.id } : {}) });
        out.textContent = r.answer; out.hidden = false;
        say(msg, `Read ${r.chatsRead} chat(s)${r.truncated ? " (older ones were left out to fit)" : ""}. It only sees what people typed, and it can be wrong, so check anything important.`);
      } catch (e) { say(msg, e.message, "err"); }
      go.disabled = false;
    };
    go.addEventListener("click", run);
    q.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } });
  }

  // ---------- Activity ----------
  const ACTIONS = { view_user: "Opened an account", view_chat: "Read a chat", ask_ai: "Asked the AI", suspend: "Suspended", ban: "Banned", unban: "Lifted a suspension", announce: "Sent a notification", remove_announcement: "Removed a notification", backfill_authors: "Filled in chat authors", sync_phones: "Saved phone numbers" };
  async function activity() {
    body.innerHTML = '<section class="settings-page"><h3 class="settings-h"><i class="fa-solid fa-clock-rotate-left"></i> What admins did</h3><ul class="admin-list" id="admin-log"><li class="field-note">Loading...</li></ul><p id="admin-msg" class="settings-msg" role="status" aria-live="polite"></p></section>';
    try {
      const { entries } = await api("GET", "/admin/audit");
      const list = document.getElementById("admin-log"); if (!list) return;
      list.innerHTML = entries.length ? entries.map(r => `<li class="admin-row"><div class="admin-row-main"><strong>${esc(ACTIONS[r.action] || r.action)}${r.target ? " &middot; " + esc(r.target) : ""}</strong><span class="field-note">${esc(r.admin_email || "an admin")} &middot; ${esc(when(r.created_at))}${r.detail && r.detail.question ? " &middot; " + esc(r.detail.question) : ""}${r.detail && r.detail.message ? " &middot; " + esc(r.detail.message) : ""}</span></div></li>`).join("") : '<li class="field-note">Nothing yet.</li>';
    } catch (e) { const l = document.getElementById("admin-log"); if (l) l.innerHTML = ""; say(document.getElementById("admin-msg"), e.message, "err"); }
  }

  // ---------- who sees the button ----------
  async function refresh() {
    if (!userToken) { btn.hidden = true; return; }
    try {
      const res = await fetch(`${BACKEND_URL}/admin/me`, { headers: { "Authorization": `Bearer ${userToken}` } });
      const data = res.ok ? await res.json().catch(() => null) : null;
      btn.hidden = !(data && data.admin === true);
    } catch (_) { /* offline: leave it as it was */ }
  }
  function reset() { btn.hidden = true; askUser = null; userQuery = ""; page = "overview"; modal.classList.remove("open"); body.innerHTML = ""; }

  window.agent1102Admin = { refresh, reset, open, close };
})();
