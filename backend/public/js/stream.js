// ============================================================
//  Live answers (speed). The server streams the reply as it is written; this shows it growing inside the
//  "Thinking..." placeholder, then chat.js swaps in the fully rendered message (code boxes, charts, math)
//  when the server says it is done and has checked it. Also works with servers that reply with plain JSON.
// ============================================================
(function () {
  "use strict";

  function headers(token) {
    const h = { "Content-Type": "application/json", "Accept": "text/event-stream, application/json" };
    if (token) h["Authorization"] = "Bearer " + token;
    return h;
  }

  // Charts, drawings and quizzes arrive as raw JSON: show a short label instead of the JSON while they stream in
  function previewText(text) {
    return String(text).replace(/```(chart|chartjs|chart\.js|chart-json|mathviz|mathgraph|math-visual|quiz|flashcards)[^\n]*\n[\s\S]*?(?:```|$)/gi,
      (_, lang) => /^chart/i.test(lang) ? "[drawing the chart...]" : /^(quiz|flashcards)$/i.test(lang) ? "[building it...]" : "[drawing...]");
  }

  // A live-text area under the spinner of a "Thinking..." placeholder (the object addThinking() returns)
  function createDraft(thinking) {
    const box = document.createElement("div");
    box.className = "ai-text stream-draft";
    box.style.cssText = "white-space:pre-wrap;word-break:break-word;margin-top:0.35rem;display:none;";
    thinking.wrap.appendChild(box);
    const chat = document.getElementById("chat");
    let text = "", queued = false, started = false;
    function paint() {
      queued = false;
      if (!box.isConnected) return;
      const nearBottom = chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140 : false;
      box.textContent = previewText(text);
      box.style.display = "block";
      if (nearBottom && chat) chat.scrollTop = chat.scrollHeight;
    }
    return {
      add(piece) {
        if (!started) { started = true; thinking.setLabel("Writing..."); }
        text += piece;
        if (!queued) { queued = true; requestAnimationFrame(paint); }
      },
      status(label) { if (label) thinking.setLabel(label); },
    };
  }

  // Reads the server's reply, whichever way it comes.  -> { reply, error, meta }
  async function readReply(res, draft) {
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/event-stream") || !res.body) {
      const data = await res.json();
      return { reply: data.reply || null, error: data.error || null, meta: data.meta || null };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", reply = null, error = null, meta = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split("\n").find(l => l.startsWith("data:"));
        if (!line) continue;
        let evt; try { evt = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
        if (evt.type === "delta") draft && draft.add(evt.text || "");
        else if (evt.type === "status") draft && draft.status(evt.text);
        else if (evt.type === "meta") meta = { ...(meta || {}), ...evt };
        else if (evt.type === "final") { reply = evt.reply; meta = { ...(meta || {}), ...(evt.meta || {}) }; }
        else if (evt.type === "error") error = evt.error || "Something went wrong. Please try again.";
      }
    }
    if (!reply && !error) error = "The connection dropped before I finished. Please try again.";
    return { reply, error, meta };
  }

  window.agent1102Stream = { headers, createDraft, readReply, previewText };
})();
