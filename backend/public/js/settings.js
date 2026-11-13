// ============================================================
//  Settings: the window opened from the button at the bottom of the sidebar.
//    Profile      picture (with a small x to remove it), username, email, password
//    AI           how the AI should talk to you, what it should know about you, saved memories,
//                 and your own Groq API key (the "Suggested" option)
//    Danger Zone  log out, delete account
//  The chat commands /memory, /remember, /forget and /style used to do some of this; they live here now.
// ============================================================
(function () {
  "use strict";

  const $ = id => document.getElementById(id);
  const tabs = [...document.querySelectorAll(".settings-tab")];
  const pages = { profile: $("page-profile"), ai: $("page-ai"), danger: $("page-danger") };
  const SERVER_DOWN = "I can't reach the server right now. Check your connection and try again.";
  const GENERIC = "Something went wrong. Please try again.";

  // ---------- helpers ----------
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(`${BACKEND_URL}${path}`, {
        method,
        headers: { "Authorization": `Bearer ${userToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) { throw new Error(SERVER_DOWN); }
    let data = {};
    try { data = await res.json(); } catch (_) { /* an empty or non-JSON reply */ }
    if (!res.ok || data.error) {
      const err = new Error(data.error || GENERIC);
      err.status = res.status;
      err.needsCode = !!data.needsCode; // Supabase wants a fresh emailed code before it will change the password
      err.badCode = !!data.badCode;     // the code that was typed is wrong or has expired
      throw err;
    }
    return data;
  }

  // a status line under a form: green for done, red for a problem
  function say(el, text, kind) {
    el.textContent = text || "";
    el.classList.toggle("ok", kind === "ok");
    el.classList.toggle("err", kind === "err");
  }

  // runs `work` with the button disabled so a double tap can't send it twice
  async function busy(button, work) {
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  }

  const isOpen = () => settingsModal.classList.contains("open");

  // empties the password boxes
  function resetPasswordForm() {
    for (const id of ["profile-password", "profile-password-confirm"]) $(id).value = "";
    hidePasswords();
  }

  // ---------- open / close / pages ----------
  let returnFocus = null;

  function selectPage(name, focusTab) {
    if (!pages[name]) name = "profile";
    tabs.forEach(t => {
      const on = t.dataset.page === name;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focusTab) t.focus();
    });
    Object.entries(pages).forEach(([key, el]) => { el.hidden = key !== name; });
    if (name === "ai") loadAi();
  }

  function openSettings(page) {
    if (!userToken) return;
    if (typeof closeSidebarFn === "function") closeSidebarFn(); // on a phone the sidebar covers the screen
    returnFocus = document.activeElement;
    $("profile-name").value = localStorage.getItem("agent1102_name") || "";
    $("profile-email").value = "";
    resetPasswordForm();
    say($("profile-msg"), "");
    selectPage(page || "profile", false);
    settingsModal.classList.add("open");
    tabs.find(t => t.getAttribute("aria-selected") === "true").focus();
  }

  // also called when signing out, so the window never stays open on top of the sign-in screen
  function closeSettings() {
    if (!isOpen()) return;
    settingsModal.classList.remove("open");
    resetPasswordForm(); $("groq-key").value = ""; // nothing secret is left sitting in a hidden box
    hidePasswords();
    // Put focus back where it came from. The Settings button lives in the sidebar, which closed when this window opened, so it usually
    // can't take focus any more: then use the button that opens the sidebar. (Check that the focus really landed: a hidden element
    // keeps focus until the next repaint, so "is anything focused?" would be answered too early.)
    let restored = false;
    if (returnFocus && typeof returnFocus.focus === "function" && document.contains(returnFocus)) { returnFocus.focus(); restored = document.activeElement === returnFocus; }
    if (!restored) { const h = document.getElementById("history-btn"); if (h) h.focus(); }
    returnFocus = null;
  }
  window.closeSettings = closeSettings;

  settingsBtn.addEventListener("click", () => openSettings("profile"));
  $("settings-close").addEventListener("click", closeSettings);
  settingsModal.addEventListener("click", e => { if (e.target === settingsModal) closeSettings(); });

  tabs.forEach(t => t.addEventListener("click", () => selectPage(t.dataset.page, false)));
  $("settings-modal").addEventListener("keydown", e => {
    if (e.key === "Escape") { closeSettings(); return; }
    const onTab = e.target.closest && e.target.closest(".settings-tab");
    if (onTab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { // arrow keys move between the pages, like any tab bar
      e.preventDefault();
      const i = tabs.indexOf(onTab);
      const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      selectPage(tabs[next].dataset.page, true);
      return;
    }
    if (e.key === "Tab") { // keep keyboard focus inside the window while it's open
      const focusable = [...settingsModal.querySelectorAll("button, input, textarea, summary, a[href], label.glass-btn")]
        .filter(el => !el.disabled && !el.hidden && el.tabIndex !== -1 && el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // ---------- Profile ----------
  const profileMsg = $("profile-msg");

  async function saveProfileField(button, fields, doneText, after) {
    await busy(button, async () => {
      say(profileMsg, "");
      try {
        await api("POST", "/auth/update", fields);
        if (after) after();
        say(profileMsg, doneText, "ok");
      } catch (e) { say(profileMsg, e.message, "err"); }
    });
  }

  $("save-name").addEventListener("click", () => {
    const name = $("profile-name").value.trim();
    if (!name) return say(profileMsg, "Type the name you'd like to use first.", "err");
    saveProfileField($("save-name"), { name }, "Username saved.", () => setDisplayName(name));
  });

  // Change email: Supabase emails a confirmation link to the NEW address. The address only changes once that link is opened.
  $("save-email").addEventListener("click", () => busy($("save-email"), async () => {
    const email = $("profile-email").value.trim();
    if (!email) return say(profileMsg, "Type your new email address first.", "err");
    say(profileMsg, "");
    try {
      const r = await api("POST", "/auth/email/change", { email });
      $("profile-email").value = "";
      if (r.changed) { setAccountEmail(r.email); setPendingEmail(""); return say(profileMsg, "Email changed.", "ok"); }
      setPendingEmail(r.pendingEmail || email);
      say(profileMsg, `Check your inbox: I sent a confirmation link to ${r.pendingEmail || email}. Your email stays the same until you open it.`, "ok");
    } catch (e) { say(profileMsg, e.message, "err"); }
  }));

  // Change password. Supabase emails a 6-digit code to the current address and the person types it into the full-screen code window
  // (js/codedialog.js); the code and the new password then go to the server together. Once a code has been accepted, the rest of
  // this session (this tab, until they sign out) doesn't ask again. If Supabase itself wants a fresh code, the window opens anyway.
  const codeDialog = window.agent1102CodeDialog;
  const newPassword = () => $("profile-password").value.trim(), newPasswordAgain = () => $("profile-password-confirm").value.trim();

  function checkNewPassword() {
    if (!newPassword()) { say(profileMsg, "Type your new password first.", "err"); return false; }
    if (newPassword() !== newPasswordAgain()) { say(profileMsg, newPasswordAgain() ? "The two passwords don't match. Please type them again." : "Type your new password a second time to confirm it.", "err"); return false; }
    return true;
  }
  const sendPasswordCode = () => api("POST", "/auth/password/code");
  const passwordChanged = () => {
    resetPasswordForm();
    say(profileMsg, "Password changed. Your other devices were signed out.", "ok");
  };

  $("save-password").addEventListener("click", () => busy($("save-password"), async () => {
    if (!checkNewPassword()) return;
    say(profileMsg, "");

    // already confirmed with a code in this session: just try. Supabase has the last word, and asks for a fresh code if it wants one.
    if (codeDialog.verifiedThisSession()) {
      try {
        await api("POST", "/auth/password", { password: newPassword(), confirmPassword: newPasswordAgain() });
        return passwordChanged();
      } catch (e) {
        if (!e.needsCode) return say(profileMsg, e.message, "err");
        codeDialog.clearVerified();
      }
    }

    let sent;
    try { sent = await sendPasswordCode(); } catch (e) { return say(profileMsg, e.message, "err"); }
    const outcome = await codeDialog.open({
      title: "Confirm it's you",
      email: sent.sentTo,
      note: "This is to protect your account. You won't be asked again until your next sign-in.",
      resend: sendPasswordCode,
      // the code and the new password go together. A wrong code keeps the window open for another try; anything else (a password that's
      // too weak, say) closes it, and the reason shows here.
      verify: async code => {
        try { return await api("POST", "/auth/password", { password: newPassword(), confirmPassword: newPasswordAgain(), code }); }
        catch (e) { if (!e.badCode) e.closeDialog = true; throw e; }
      },
    });
    if (outcome.ok) { codeDialog.markVerified(); return passwordChanged(); }
    if (outcome.error) return say(profileMsg, outcome.error.message, "err");
    say(profileMsg, "Your password wasn't changed.");
  }));

  // ---------- Danger Zone ----------
  profileDelete.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to delete your account? This can't be undone!")) return;
    if (!confirm("Last chance — all your chats will be permanently deleted too. Continue?")) return;
    try {
      await api("DELETE", "/auth/delete");
      localStorage.clear();
      closeSettings();
      showAuth();
    } catch (e) {
      showToast(agent1102Render.escapeHtml(e.message === GENERIC ? "I couldn't delete your account. Please try again." : e.message));
    }
  });
  // (Log out is wired in ui.js; it calls showAuth(), which closes this window.)

  // ---------- AI: written preferences ----------
  const talkBox = $("ai-talk"), aboutBox = $("ai-about"), aiMsg = $("ai-msg");
  let aiLoaded = false;

  function showGroqStatus(groq) {
    const hasKey = !!(groq && groq.hasKey), unreadable = !!(groq && groq.unreadable);
    $("groq-status").textContent = hasKey ? `Using your own key (ending in ${groq.last4}).`
      : unreadable ? "Your saved key can't be read any more, so the shared key is being used. Please paste your key again."
      : "Using the shared key.";
    $("groq-status").classList.toggle("own", hasKey);
    $("groq-remove").hidden = !(hasKey || unreadable); // an unreadable key can still be removed
  }

  function applySettings(s, { fillText } = { fillText: true }) {
    if (fillText) { talkBox.value = s.talkStyle || ""; aboutBox.value = s.aboutMe || ""; }
    showGroqStatus(s.groq);
    const off = !s.available;
    [$("ai-save"), $("groq-save")].forEach(b => { b.disabled = off; });
    if (off) say(aiMsg, "Saving preferences isn't set up on this server yet. The site owner needs to run supabase/settings.sql once.", "err");
    else if (!s.canStoreKey) say($("groq-msg"), "Saving a key isn't set up on this server yet. The site owner needs to set KEY_ENCRYPTION_SECRET.", "err");
  }

  async function loadAi() {
    loadMemories();
    if (aiLoaded) return;
    try {
      const s = await api("GET", "/settings");
      aiLoaded = true;
      applySettings(s);
    } catch (e) { say(aiMsg, e.message, "err"); }
  }

  $("ai-save").addEventListener("click", () => busy($("ai-save"), async () => {
    say(aiMsg, "");
    try {
      const s = await api("POST", "/settings/ai", { talkStyle: talkBox.value, aboutMe: aboutBox.value });
      applySettings(s, { fillText: false });
      say(aiMsg, "Saved. The AI will follow these from your next message.", "ok");
    } catch (e) { say(aiMsg, e.message, "err"); }
  }));

  // ---------- AI: your own Groq key ----------
  const keyBox = $("groq-key"), keyMsg = $("groq-msg");

  $("groq-save").addEventListener("click", () => busy($("groq-save"), async () => {
    say(keyMsg, "");
    const key = keyBox.value.trim();
    if (!key) return say(keyMsg, "Paste your Groq API key first.", "err");
    say(keyMsg, "Checking your key with Groq...");
    try {
      const s = await api("POST", "/settings/groq-key", { key });
      keyBox.value = ""; hidePasswords();
      applySettings(s, { fillText: false });
      say(keyMsg, "Key saved. The AI now uses your own usage limits.", "ok");
    } catch (e) { say(keyMsg, e.message, "err"); }
  }));

  $("groq-remove").addEventListener("click", () => busy($("groq-remove"), async () => {
    if (!confirm("Remove your key? The AI will go back to the shared key and its limits.")) return;
    say(keyMsg, "");
    try {
      const s = await api("DELETE", "/settings/groq-key");
      applySettings(s, { fillText: false });
      say(keyMsg, "Your key was removed. The AI is using the shared key again.", "ok");
    } catch (e) { say(keyMsg, e.message, "err"); }
  }));

  // ---------- AI: saved memories (this replaces /memory, /remember and /forget) ----------
  const memList = $("memory-list"), memEmpty = $("memory-empty"), memToggle = $("memory-toggle");

  function renderMemories(d) {
    memToggle.checked = !!d.enabled;
    memList.textContent = "";
    for (const m of d.memories || []) {
      const li = document.createElement("li");
      const text = document.createElement("span");
      text.className = "mem-text";
      text.textContent = m.content; // text, never HTML: a memory can contain anything the person ever said
      const x = document.createElement("button");
      x.type = "button"; x.className = "mem-x"; x.title = "Forget this"; x.setAttribute("aria-label", "Forget this: " + m.content);
      x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      x.addEventListener("click", async () => {
        x.disabled = true;
        try { await api("DELETE", `/memory/${encodeURIComponent(m.id)}`); li.remove(); memEmpty.hidden = memList.children.length > 0; }
        catch (e) { x.disabled = false; showToast(agent1102Render.escapeHtml(e.message)); }
      });
      li.append(text, x);
      memList.append(li);
    }
    memEmpty.hidden = memList.children.length > 0;
    memEmpty.textContent = "Nothing saved yet. The AI picks up lasting facts as you chat.";
    $("memory-clear").disabled = memList.children.length === 0;
  }

  async function loadMemories() {
    try { renderMemories(await api("GET", "/memory")); }
    catch (e) { memList.textContent = ""; memEmpty.hidden = false; memEmpty.textContent = e.message; memToggle.disabled = true; $("memory-clear").disabled = true; }
  }

  memToggle.addEventListener("change", async () => {
    const wanted = memToggle.checked;
    try { await api("POST", "/prefs", { updates: { memory: wanted } }); }
    catch (e) { memToggle.checked = !wanted; showToast(agent1102Render.escapeHtml(e.message)); }
  });

  $("memory-clear").addEventListener("click", () => busy($("memory-clear"), async () => {
    if (!confirm("Delete everything the AI remembers about you? This can't be undone.")) return;
    try { await api("DELETE", "/memory"); await loadMemories(); showToast('<span class="toast-success">Memories cleared <i class="fa-solid fa-circle-check"></i></span>'); }
    catch (e) { showToast(agent1102Render.escapeHtml(e.message)); }
  }));

  $("style-reset").addEventListener("click", () => busy($("style-reset"), async () => {
    try { await api("POST", "/prefs", { command: "reset" }); showToast('<span class="toast-success">Learned style reset <i class="fa-solid fa-circle-check"></i></span>'); }
    catch (e) { showToast(agent1102Render.escapeHtml(e.message)); }
  }));

  // ---------- the old chat commands ----------
  const MOVED = /^\/(memory|remember|forget|style)\b/i;
  const isMovedCommand = text => MOVED.test(String(text || "").trim());

  // shown in the chat, never added to the conversation the AI sees
  function explainMovedCommand(text) {
    const user = window.addMsg("user", String(text).trim(), null, history.length);
    const box = $("input"); if (box) box.value = "";
    const ai = window.addMsg("ai", "Those commands moved into **Settings**. Tap your name at the bottom of the sidebar, then open **AI**. There you can tell me how to talk to you and what to know about you, see or delete what I've remembered, and add your own Groq API key.", null, history.length);
    const retry = ai && ai.querySelector(".retry-btn"); if (retry) retry.remove();
    return { user, ai };
  }

  // ---------- reset when the account changes ----------
  window.agent1102Settings = {
    open: openSettings, close: closeSettings, isMovedCommand, explainMovedCommand,
    forgetLoaded() { aiLoaded = false; talkBox.value = ""; aboutBox.value = ""; keyBox.value = ""; showGroqStatus(null); say(aiMsg, ""); say(keyMsg, ""); },
  };
})();
