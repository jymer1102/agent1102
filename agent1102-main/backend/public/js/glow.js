// Visual effects: (1) a glow that follows the cursor inside cards,
// (2) a soft blue glow that follows the typing caret in text boxes.
(function () {
  "use strict";

  // ---------- 1. Cursor glow inside cards ----------
  // Cards are created dynamically (code blocks, charts, quizzes...), so one
  // delegated listener on the document handles all of them.
  const CARD_SEL = ".auth-box, .modal-box, .code-block, .chart-block, .study-block, .link-card, .user .msg, header, #input-area, #sidebar";
  let cardRaf = 0, lastEvt = null;
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return; // no cursor on touch screens
    lastEvt = e;
    if (cardRaf) return;
    cardRaf = requestAnimationFrame(() => {
      cardRaf = 0;
      const t = lastEvt && lastEvt.target;
      const card = t && t.closest ? t.closest(CARD_SEL) : null;
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", (lastEvt.clientX - r.left) + "px");
      card.style.setProperty("--my", (lastEvt.clientY - r.top) + "px");
    });
  }, { passive: true });

  // ---------- 2. Caret glow in text boxes ----------
  // How it works (same idea as the "glow caret" on the portfolio site): the glow is NOT placed
  // with viewport coordinates. Instead, an invisible overlay copy of the text box sits right on
  // top of the real one, and the glow is an inline zero-width element inside that copy's text,
  // exactly at the caret position. The browser lays the text out, so the glow can't drift when
  // the phone keyboard opens, the page scrolls/zooms, autocorrect moves the caret, or a textarea
  // grows. The overlay is a sibling of the field (same scroll container), so it moves with it.
  const COPY = ["direction", "boxSizing", "borderTopWidth", "borderRightWidth", "borderBottomWidth",
    "borderLeftWidth", "borderStyle", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "fontFamily", "lineHeight",
    "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize",
    "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"];

  function isTextBox(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName !== "INPUT") return false;
    return ["text", "password", "search", "tel", "url", "email", ""].includes((el.getAttribute("type") || "").toLowerCase());
  }

  let active = null, overlay = null, inner = null, raf = 0;
  let last = { v: null, s: null, e: null, st: -1, sl: -1, geo: "", style: "" };

  function removeOverlay() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (overlay) overlay.remove();
    if (active) active.classList.remove("caret-glow-on");
    overlay = inner = active = null;
    last = { v: null, s: null, e: null, st: -1, sl: -1, geo: "", style: "" };
  }

  function attach(el) {
    removeOverlay();
    active = el;
    overlay = document.createElement("div");
    overlay.className = "caret-overlay";
    overlay.setAttribute("aria-hidden", "true");
    inner = document.createElement("div");
    inner.className = "caret-overlay-text";
    overlay.appendChild(inner);
    el.insertAdjacentElement("afterend", overlay);
    el.classList.add("caret-glow-on");
    loop();
  }

  function sync() {
    const el = active;
    if (!el || !el.isConnected || document.activeElement !== el) { removeOverlay(); return; }
    const isInput = el.tagName === "INPUT";

    // box: copied from the field so text wraps identically (re-applied only when it changes)
    const geo = el.offsetLeft + "," + el.offsetTop + "," + el.offsetWidth + "," + el.offsetHeight;
    const cs = getComputedStyle(el);
    const styleKey = COPY.map((k) => cs[k]).join("|") + (el.type || "");
    if (geo !== last.geo || styleKey !== last.style) {
      COPY.forEach((k) => { overlay.style[k] = cs[k]; });
      overlay.style.borderColor = "transparent";
      overlay.style.left = el.offsetLeft + "px";
      overlay.style.top = el.offsetTop + "px";
      overlay.style.width = el.offsetWidth + "px";
      overlay.style.height = el.offsetHeight + "px";
      overlay.style.whiteSpace = isInput ? "pre" : "pre-wrap";
      overlay.style.display = isInput ? "flex" : "block";
      overlay.style.alignItems = isInput ? "center" : "";
      inner.style.whiteSpace = isInput ? "pre" : "pre-wrap";
      inner.style.flex = isInput ? "none" : "";
      last.geo = geo; last.style = styleKey;
    }

    // caret + text: rebuilt only when the text or caret position changes
    let s = null, e = null;
    try { s = el.selectionStart; e = el.selectionEnd; } catch (_) {}
    const value = el.type === "password" ? "\u2022".repeat(el.value.length) : el.value;
    if (value !== last.v || s !== last.s || e !== last.e) {
      inner.textContent = "";
      if (s === null || s === undefined || s !== e) {
        inner.textContent = value + "\u200b";          // text selected: no glow
      } else {
        const bar = document.createElement("span");
        bar.className = "caret-overlay-bar";
        inner.append(document.createTextNode(value.slice(0, s)), bar, document.createTextNode(value.slice(s) + "\u200b"));
      }
      last.v = value; last.s = s; last.e = e;
    }

    // keep the copy scrolled exactly like the field
    if (el.scrollTop !== last.st || el.scrollLeft !== last.sl || last.v !== value) {
      overlay.scrollTop = el.scrollTop;
      overlay.scrollLeft = el.scrollLeft;
      last.st = el.scrollTop; last.sl = el.scrollLeft;
    }
    overlay.scrollTop = el.scrollTop;
    overlay.scrollLeft = el.scrollLeft;
  }

  // While a box is focused, re-check every frame. The work is skipped unless something changed,
  // and it keeps the glow glued on through keyboard animations, autocorrect and autosizing.
  function loop() {
    raf = requestAnimationFrame(() => { raf = 0; if (!active) return; sync(); if (active) loop(); });
  }

  document.addEventListener("focusin", (e) => { if (isTextBox(e.target)) attach(e.target); });
  document.addEventListener("focusout", (e) => { if (e.target === active) removeOverlay(); });
})();
