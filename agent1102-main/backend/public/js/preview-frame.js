// Runs inside the sandboxed "Preview" frame. The frame has no access to the real page or the saved login.
// It tells the page it is ready, then replaces itself with the HTML the page sends back.
(function () {
  "use strict";
  if (window.parent === window) return; // opened on its own, not inside the chat: nothing to show
  function onMessage(e) {
    // only the page that contains this frame may send it code; anything else is ignored and the frame keeps waiting
    if (e.source !== window.parent || !e.data || typeof e.data.html !== "string") return;
    window.removeEventListener("message", onMessage);
    document.open();
    document.write(e.data.html);
    document.close();
  }
  window.addEventListener("message", onMessage);
  window.parent.postMessage({ type: "preview-ready" }, "*");
})();
