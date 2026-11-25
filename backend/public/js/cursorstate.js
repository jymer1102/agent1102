// ============================================================
//  Cursor while the AI is answering.
//
//  chat.js switches the Send button off (disabled) for as long as a reply is on its way, and back on when it is done.
//  This watches that and marks the chat area aria-busy="true" meanwhile; the stylesheet turns that into the "working in
//  background" cursor (arrow + spinner) - the app is busy but you can still click around. See the cursor table in style.css.
// ============================================================
(function () {
  "use strict";
  document.addEventListener("DOMContentLoaded", () => {
    const send = document.getElementById("send");
    const chat = document.getElementById("chat");
    if (!send || !chat) return;
    const sync = () => { if (send.disabled) chat.setAttribute("aria-busy", "true"); else chat.removeAttribute("aria-busy"); };
    new MutationObserver(sync).observe(send, { attributes: true, attributeFilter: ["disabled"] });
    sync();
  });
})();
