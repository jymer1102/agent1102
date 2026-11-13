// ============================================================
//  The 6-digit code window
//  ONE full-screen window for every code the app asks for from an email: six boxes, one digit each. Used for confirming a new
//  account, choosing a new password after "Forgot password?", and confirming a password change in Settings.
//
//    const r = await agent1102CodeDialog.open({
//      title: "Confirm your email",
//      email: "s*****@example.com",          // shown in the text: where the code was sent
//      note: "Can't find it? Check your spam folder.",   // optional small print
//      verify: async code => { ... },        // checks the code. Return anything on success; throw an Error to say what is wrong
//                                            // (the window stays open and shows the message; give the Error closeDialog = true to close it instead)
//      resend: async () => { ... },          // optional: sends a new code (the "Send a new code" button, after a short wait)
//      cooldownMs: 30000,                    // optional: how long before "Send a new code" can be used
//    });
//    // r = { ok: true, result }  the code was accepted        { ok: false }  the person closed the window
//    //     { ok: false, error }  verify() asked for the window to close because of some other problem
//
//  Typing: a digit moves on to the next box; Backspace goes back; paste (or an autofilled code) fills all six; the code is sent as
//  soon as the sixth digit is in. Escape or the X closes it.
//
//  "Once per session": after a code has been accepted, markVerified() remembers it for this browser tab (verifiedThisSession()),
//  so the next thing that needs confirming in the same session can skip the window. Signing out forgets it (clearVerified()).
// ============================================================
(function () {
  "use strict";

  const LENGTH = 6;
  let defaultCooldownMs = 30000; // how long "Send a new code" is held back after a send (an open() call can set its own)
  const cooldownFor = opts => (opts && opts.cooldownMs != null ? opts.cooldownMs : defaultCooldownMs);
  const VERIFIED_KEY = "agent1102_code_verified";

  // ---------- "confirmed once this session" ----------
  let verifiedInMemory = false; // for a browser that blocks sessionStorage
  const verifiedThisSession = () => { try { return sessionStorage.getItem(VERIFIED_KEY) === "1"; } catch (_) { return verifiedInMemory; } };
  function markVerified() { verifiedInMemory = true; try { sessionStorage.setItem(VERIFIED_KEY, "1"); } catch (_) { /* storage blocked */ } }
  function clearVerified() { verifiedInMemory = false; try { sessionStorage.removeItem(VERIFIED_KEY); } catch (_) { /* storage blocked */ } }

  // ---------- the window (built the first time it is needed) ----------
  let root = null, boxesEl = null, boxes = [], titleEl, textEl, errorEl, infoEl, noteEl, verifyBtn, resendBtn, cancelBtn, closeBtn;
  let active = null; // the one that is open: { opts, resolve, busy, returnTo, timer }

  function build() {
    root = document.createElement("div");
    root.id = "code-dialog";
    root.className = "code-dialog";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "code-dialog-title");
    root.setAttribute("aria-describedby", "code-dialog-text");
    root.innerHTML =
      '<button type="button" class="icon-btn code-dialog-close" id="code-dialog-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="code-dialog-card">' +
        '<div class="code-dialog-icon" aria-hidden="true"><i class="fa-solid fa-envelope-circle-check"></i></div>' +
        '<h2 id="code-dialog-title"></h2>' +
        '<p id="code-dialog-text" class="code-dialog-text"></p>' +
        '<div class="code-boxes" id="code-boxes" role="group" aria-label="' + LENGTH + '-digit code"></div>' +
        '<p class="code-dialog-error" id="code-dialog-error" role="alert"></p>' +
        '<p class="code-dialog-info" id="code-dialog-info" role="status" aria-live="polite"></p>' +
        '<button type="button" class="modal-btn primary code-dialog-verify" id="code-dialog-verify">Confirm</button>' +
        '<button type="button" class="modal-btn subtle" id="code-dialog-resend" hidden>Send a new code</button>' +
        '<p class="code-dialog-note" id="code-dialog-note"></p>' +
        '<button type="button" class="auth-toggle" id="code-dialog-cancel">Cancel</button>' +
      '</div>';
    document.body.appendChild(root);

    boxesEl = root.querySelector("#code-boxes");
    titleEl = root.querySelector("#code-dialog-title");
    textEl = root.querySelector("#code-dialog-text");
    errorEl = root.querySelector("#code-dialog-error");
    infoEl = root.querySelector("#code-dialog-info");
    noteEl = root.querySelector("#code-dialog-note");
    verifyBtn = root.querySelector("#code-dialog-verify");
    resendBtn = root.querySelector("#code-dialog-resend");
    cancelBtn = root.querySelector("#code-dialog-cancel");
    closeBtn = root.querySelector("#code-dialog-close");

    for (let i = 0; i < LENGTH; i++) {
      const b = document.createElement("input");
      b.type = "text";
      b.className = "code-digit";
      b.setAttribute("inputmode", "numeric");
      b.setAttribute("pattern", "[0-9]*");
      b.setAttribute("autocapitalize", "off");
      b.setAttribute("autocorrect", "off");
      b.spellcheck = false;
      b.autocomplete = i === 0 ? "one-time-code" : "off"; // lets a phone offer the code from the email in the first box
      b.setAttribute("aria-label", "Digit " + (i + 1) + " of " + LENGTH);
      b.addEventListener("input", () => onInput(i));
      b.addEventListener("keydown", e => onKey(i, e));
      b.addEventListener("focus", () => b.select());
      b.addEventListener("paste", e => {
        const text = (e.clipboardData || window.clipboardData || { getData: () => "" }).getData("text");
        if (!/\d/.test(text)) return; // nothing usable: let the browser do what it does
        e.preventDefault();
        fill(String(text).replace(/\D/g, "").length >= LENGTH ? 0 : i, text);
      });
      boxesEl.appendChild(b);
      boxes.push(b);
    }

    verifyBtn.addEventListener("click", submit);
    resendBtn.addEventListener("click", resend);
    cancelBtn.addEventListener("click", () => finish({ ok: false }));
    closeBtn.addEventListener("click", () => finish({ ok: false }));
    root.addEventListener("keydown", onRootKey);
  }

  const code = () => boxes.map(b => b.value).join("");
  const focusBox = i => { const b = boxes[Math.max(0, Math.min(LENGTH - 1, i))]; if (b) { b.focus(); b.select(); } };
  function refreshLook() {
    boxes.forEach(b => b.classList.toggle("filled", b.value !== ""));
    verifyBtn.disabled = !!(active && active.busy) || code().length < LENGTH;
  }
  function clearBoxes() { boxes.forEach(b => { b.value = ""; }); refreshLook(); }
  function setError(text) {
    errorEl.textContent = text || "";
    boxesEl.classList.toggle("error", !!text);
    if (text) boxes.forEach(b => b.setAttribute("aria-invalid", "true")); else boxes.forEach(b => b.removeAttribute("aria-invalid"));
  }
  const setInfo = text => { infoEl.textContent = text || ""; };
  function setBusy(on) {
    if (active) active.busy = on;
    boxes.forEach(b => { b.disabled = on; });
    cancelBtn.disabled = closeBtn.disabled = on;
    verifyBtn.textContent = on ? "Checking..." : "Confirm";
    refreshLook();
  }
  function shake() {
    boxesEl.classList.remove("shake");
    void boxesEl.offsetWidth; // restart the animation
    boxesEl.classList.add("shake");
  }

  // put digits into the boxes from box `from` on (a pasted or autofilled code); sends it once all six are there
  function fill(from, text) {
    const digits = String(text).replace(/\D/g, "");
    if (!digits) return;
    let i = from;
    for (const ch of digits) { if (i >= LENGTH) break; boxes[i].value = ch; i++; }
    setError("");
    refreshLook();
    focusBox(i);
    if (code().length === LENGTH) submit();
  }

  function onInput(i) {
    const b = boxes[i];
    const digits = b.value.replace(/\D/g, "");
    if (digits.length >= LENGTH) { b.value = ""; return fill(0, digits); } // a whole code arrived in one box (autofill)
    b.value = digits.slice(-1); // typed over a digit that was already there: the new one wins
    setError("");
    refreshLook();
    if (b.value) { if (i < LENGTH - 1) focusBox(i + 1); else if (code().length === LENGTH) submit(); }
  }

  function onKey(i, e) {
    if (e.key === "Backspace") {
      if (!boxes[i].value && i > 0) { e.preventDefault(); boxes[i - 1].value = ""; refreshLook(); focusBox(i - 1); }
    } else if (e.key === "ArrowLeft") { e.preventDefault(); focusBox(i - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); focusBox(i + 1); }
    else if (e.key === "Home") { e.preventDefault(); focusBox(0); }
    else if (e.key === "End") { e.preventDefault(); focusBox(LENGTH - 1); }
    else if (e.key === "Enter") { e.preventDefault(); submit(); }
  }

  // Escape closes; Tab stays inside the window (it covers the whole screen, so nothing behind it should be reachable)
  function onRootKey(e) {
    if (!active) return;
    if (e.key === "Escape" && !active.busy) { e.preventDefault(); finish({ ok: false }); return; }
    if (e.key !== "Tab") return;
    const items = [...root.querySelectorAll("button, input")].filter(el => !el.disabled && !el.hidden && el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  async function submit() {
    if (!active || active.busy) return;
    if (code().length < LENGTH) { setError("Type all " + LENGTH + " digits of the code."); shake(); return; }
    setError(""); setInfo("");
    setBusy(true);
    try {
      const result = await active.opts.verify(code());
      finish({ ok: true, result });
    } catch (e) {
      if (!active) return;
      setBusy(false);
      if (e && e.closeDialog) return finish({ ok: false, error: e });
      setError((e && e.message) || "That code didn't work. Please try again.");
      shake();
      clearBoxes();
      focusBox(0);
    }
  }

  // "Send a new code" is held back for a moment after each send, so it can't be pressed over and over
  function startCooldown(ms) {
    if (!active || !active.opts.resend) return;
    clearInterval(active.timer);
    let left = Math.ceil(ms / 1000);
    const show = () => {
      resendBtn.disabled = left > 0;
      resendBtn.textContent = left > 0 ? "Send a new code (" + left + "s)" : "Send a new code";
    };
    show();
    if (left <= 0) return;
    active.timer = setInterval(() => { left--; show(); if (left <= 0) clearInterval(active && active.timer); }, 1000);
  }
  async function resend() {
    if (!active || !active.opts.resend || active.busy || resendBtn.disabled) return;
    resendBtn.disabled = true;
    setError("");
    try {
      await active.opts.resend();
      if (!active) return;
      clearBoxes();
      setInfo("I sent a new code. It can take a minute, and it may land in your spam folder.");
      focusBox(0);
      startCooldown(cooldownFor(active.opts));
    } catch (e) {
      if (!active) return;
      setError((e && e.message) || "I couldn't send a new code. Please try again in a moment.");
      resendBtn.disabled = false;
    }
  }

  function finish(outcome) {
    if (!active) return;
    const a = active;
    active = null;
    clearInterval(a.timer);
    root.hidden = true;
    document.body.classList.remove("code-dialog-open");
    clearBoxes(); setError(""); setInfo("");
    boxes.forEach(b => { b.disabled = false; });
    try { if (a.returnTo && typeof a.returnTo.focus === "function" && document.contains(a.returnTo)) a.returnTo.focus(); } catch (_) { /* element gone */ }
    a.resolve(outcome);
  }

  function open(opts) {
    if (!root) build();
    if (active) finish({ ok: false }); // only one window at a time
    opts = opts || {};
    return new Promise(resolve => {
      active = { opts, resolve, busy: false, returnTo: document.activeElement, timer: 0 };
      titleEl.textContent = opts.title || "Enter your code";
      textEl.textContent = "";
      textEl.append("I emailed a " + LENGTH + "-digit code to ");
      if (opts.email) { const who = document.createElement("strong"); who.textContent = opts.email; textEl.append(who); } else textEl.append("your email");
      textEl.append(". It can take a minute, and it may land in your spam folder.");
      noteEl.textContent = opts.note || "";
      noteEl.hidden = !opts.note;
      resendBtn.hidden = typeof opts.resend !== "function";
      clearBoxes(); setError(""); setInfo("");
      boxes.forEach(b => { b.disabled = false; });
      cancelBtn.disabled = closeBtn.disabled = false;
      verifyBtn.textContent = "Confirm";
      refreshLook();
      root.hidden = false;
      document.body.classList.add("code-dialog-open");
      startCooldown(cooldownFor(opts));
      focusBox(0);
    });
  }

  window.agent1102CodeDialog = {
    open, verifiedThisSession, markVerified, clearVerified,
    get isOpen() { return !!active; },
    get length() { return LENGTH; },
    get cooldownMs() { return defaultCooldownMs; },
    set cooldownMs(ms) { defaultCooldownMs = Math.max(0, Number(ms) || 0); },
    close() { finish({ ok: false }); },
  };
})();
