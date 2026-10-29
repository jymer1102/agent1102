// ============================================================
//  The Send button only lights up, and only works, when there is something to send.
//
//  One rule decides both: canSend(). chat.js asks it before sending (so clicking, pressing Enter and the
//  "/" menu all obey it), and this file asks it to light the button up or dim it.
//
//  "Something to send" = at least one real character (spaces, tabs, new lines, non-breaking spaces and
//  invisible zero-width characters don't count), OR a photo/file attached (see the switch below).
// ============================================================
(function () {
  "use strict";

  // false = a photo or file alone can be sent (nothing typed is fine)
  // true  = a photo or file alone is NOT enough: the person must also type something
  const REQUIRE_TEXT_WITH_ATTACHMENTS = false;

  const hasText = text => String(text == null ? "" : text).replace(/[\s\p{Cf}]/gu, "").length > 0;
  const canSend = (text, attachmentCount) => hasText(text) || (!REQUIRE_TEXT_WITH_ATTACHMENTS && attachmentCount > 0);

  window.agent1102SendState = { canSend, hasText, REQUIRE_TEXT_WITH_ATTACHMENTS };

  document.addEventListener("DOMContentLoaded", () => {
    const input = document.getElementById("input");
    const send = document.getElementById("send");
    const attachList = document.getElementById("attach-list");
    if (!input || !send) return;

    function update() {
      const ready = canSend(input.value, attachList ? attachList.children.length : 0);
      send.classList.toggle("send-ready", ready);
      send.setAttribute("aria-disabled", String(!ready));
    }

    // Typing fires "input", but other changes don't: dictation (mic), "Edit and resend", the "/" menu and the
    // box being emptied after a send all set .value from code. Watching the setter catches every one of them.
    const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    Object.defineProperty(input, "value", {
      configurable: true, enumerable: true,
      get() { return native.get.call(this); },
      set(v) { native.set.call(this, v); update(); },
    });
    ["input", "change", "keyup", "paste", "cut"].forEach(ev => input.addEventListener(ev, update));
    if (attachList) new MutationObserver(update).observe(attachList, { childList: true });
    update();
  });
})();
