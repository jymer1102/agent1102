// ============================================================
//  Slash commands: the list, the parser, the "/" popup menu and /help
//  Add a command here and it shows up in the popup and in /help automatically.
// ============================================================
(function () {
  "use strict";

  const COMMANDS = [
    { name: "help",       args: "",                     desc: "Show all commands",                          icon: "fa-circle-question",  group: "General" },
    { name: "learn",      args: "<topic>",              desc: "Learn a topic (or your notes / a photo of them) step by step", icon: "fa-graduation-cap", group: "Study", aliases: ["teach"] },
    { name: "quiz",       args: "[number] <topic>",     desc: "Quiz yourself on a topic, your notes, a photo of homework, or a link", icon: "fa-clipboard-question", group: "Study", aliases: ["test"] },
    { name: "flashcards", args: "[number] <topic>",     desc: "Flashcards from a topic, your notes, a photo, or a file",         icon: "fa-clone",            group: "Study", aliases: ["flashcard", "cards"] },
    { name: "graph",      args: "<function, shape or number line>", desc: "Draw a math graph, number line, geometry diagram or fractions", icon: "fa-chart-line", group: "Create", aliases: ["plot", "numberline"] },
    { name: "image",      args: "<description>",        desc: "Generate an image",                          icon: "fa-image",            group: "Create", aliases: ["imagine", "img", "draw"] },
    { name: "edit",       args: "<change>",             desc: "Edit an attached image, or the last one I made", icon: "fa-wand-magic-sparkles", group: "Create" },
    { name: "memory",     args: "",                     desc: "See what I remember about you (also: /memory on, /memory off)", icon: "fa-brain",   group: "Personal" },
    { name: "remember",   args: "<fact>",               desc: "Tell me something to remember for next time", icon: "fa-bookmark",         group: "Personal" },
    { name: "forget",     args: "<number or all>",      desc: "Remove one memory, or all of them",          icon: "fa-eraser",           group: "Personal" },
    { name: "style",      args: "[concise, casual, ...]", desc: "See or change how I answer you (length, tone, emojis, format)", icon: "fa-sliders", group: "Personal" },
  ];

  const namesOf = c => [c.name, ...(c.aliases || [])];
  function findCommand(word) {
    const w = String(word || "").toLowerCase();
    return COMMANDS.find(c => namesOf(c).includes(w)) || null;
  }

  // "/quiz 10 photosynthesis" -> { cmd, rest: "10 photosynthesis" }
  function parseCommand(text) {
    const m = String(text || "").trim().match(/^\/([a-z]+)\b\s*([\s\S]*)$/i);
    if (!m) return null;
    const cmd = findCommand(m[1]);
    return cmd ? { cmd, rest: m[2].trim() } : null;
  }

  function isHelp(text) {
    const p = parseCommand(text);
    return !!p && p.cmd.name === "help";
  }

  // "/graph y = x^2" -> { request: "y = x^2" }; "/numberline -2 < x" -> { request: "number line: -2 < x" }
  function parseGraph(text) {
    const m = String(text || "").trim().match(/^\/([a-z]+)\b\s*([\s\S]*)$/i);
    const cmd = m && findCommand(m[1]);
    if (!cmd || cmd.name !== "graph") return null;
    let request = m[2].trim();
    if (m[1].toLowerCase() === "numberline" && request) request = "number line: " + request;
    return { request };
  }

  // -> { mode: "learn"|"quiz"|"flashcards", topic, count } or null
  function parseStudy(text) {
    const p = parseCommand(text);
    if (!p || !["learn", "quiz", "flashcards"].includes(p.cmd.name)) return null;
    let topic = p.rest, count = null;
    if (p.cmd.name !== "learn") {
      const m = topic.match(/^(\d{1,2})\b(?:\s+(?:questions?|cards?|flashcards?))?(?:\s+(?:on|about|for)\b)?\s*([\s\S]*)$/i);
      if (m) { count = parseInt(m[1], 10); topic = m[2].trim(); }
    }
    topic = topic.replace(/^(?:on|about|for)\s+/i, "").trim();
    return { mode: p.cmd.name, topic, count };
  }

  function helpMarkdown() {
    const rows = COMMANDS.map(c => {
      const usage = "`/" + c.name + (c.args ? " " + c.args : "") + "`";
      const alias = c.aliases && c.aliases.length ? " (also " + c.aliases.map(a => "`/" + a + "`").join(", ") + ")" : "";
      return `| ${usage} | ${c.desc}${alias} |`;
    });
    return [
      "Here are all the commands you can use:",
      "",
      "| Command | What it does |",
      "| --- | --- |",
      ...rows,
      "",
      "**Tips**",
      "- Type `/` to see this list above the message box, then pick one.",
      "- **Study from your own material:** attach photos of homework or notes, a PDF, a Word, PowerPoint or Excel file, or a text file (up to 6 photos work with these commands), then send `/quiz`, `/flashcards` or `/learn` with no topic. You can also paste your notes right after the command, or give it a link.",
      "- **Photos of paper:** send a picture of a worksheet or notes with no command and I'll read the words and problems and help with them.",
      "- You can paste or drag files and screenshots straight into the chat.",
      "- **Memory and style:** I remember lasting facts you share (what you're studying or building) to make answers more personal. `/memory` shows them, `/forget` removes them, `/memory off` pauses it. `/style` sets how I answer, or just tell me, like \"from now on keep it short\".",
      "- **Tables:** any table I give you has Copy CSV and Download CSV buttons. Send a photo of a table and ask me to extract it.",
      "- Use `/quiz` or `/flashcards` on their own to study what we've just been talking about.",
      "- Add a number to choose the size, like `/quiz 5 the French Revolution`.",
      "- **Math visuals:** `/graph y = x^2 - 4`, `/graph number line -2 < x <= 3`, or `/graph right triangle with sides 3, 4, 5`. You can also just ask in normal chat, and `/learn` and `/quiz` use pictures for math topics.",
    ].join("\n");
  }

  /* ------------------------- the "/" popup ------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    const input = document.getElementById("input");
    const sendBtn = document.getElementById("send");
    const area = document.getElementById("input-area");
    const studyBtn = document.getElementById("study-btn");
    if (!input || !area) return;

    const menu = document.createElement("div");
    menu.id = "cmd-menu";
    menu.setAttribute("role", "listbox");
    menu.style.display = "none";
    area.appendChild(menu);

    let items = [];
    let active = 0;
    let kind = null; // "typed" (user typed "/") or "study" (study button)

    function hide() { menu.style.display = "none"; kind = null; items = []; }

    function render() {
      menu.replaceChildren();
      items.forEach((c, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cmd-item" + (i === active ? " active" : "");
        b.setAttribute("role", "option");
        const ic = document.createElement("i"); ic.className = "fa-solid " + c.icon + " cmd-icon";
        const txt = document.createElement("span"); txt.className = "cmd-text";
        const top = document.createElement("span"); top.className = "cmd-top";
        const nm = document.createElement("span"); nm.className = "cmd-name"; nm.textContent = "/" + c.name;
        top.appendChild(nm);
        if (c.args) { const ar = document.createElement("span"); ar.className = "cmd-args"; ar.textContent = c.args; top.appendChild(ar); }
        const ds = document.createElement("span"); ds.className = "cmd-desc"; ds.textContent = c.desc;
        txt.append(top, ds);
        b.append(ic, txt);
        // mousedown (not click) so the textarea never loses focus first
        b.addEventListener("mousedown", e => { e.preventDefault(); choose(c); });
        b.addEventListener("mouseenter", () => { active = i; [...menu.children].forEach((n, k) => n.classList.toggle("active", k === i)); });
        menu.appendChild(b);
      });
      menu.style.display = "flex";
    }

    function choose(c) {
      hide();
      if (!c.args) {                       // no argument needed: run it right away
        input.value = "/" + c.name;
        input.focus();
        if (sendBtn) sendBtn.click();
      } else {                             // needs a topic/description: fill it in and wait
        input.value = "/" + c.name + " ";
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }

    function refresh() {
      if (kind === "study") return;
      const m = /^\/([a-z]*)$/i.exec(input.value);
      if (!m) { hide(); return; }
      const q = m[1].toLowerCase();
      items = COMMANDS.filter(c => namesOf(c).some(n => n.startsWith(q)));
      if (!items.length) { hide(); return; }
      kind = "typed";
      if (active >= items.length) active = 0;
      render();
    }

    input.addEventListener("input", () => { if (kind === "study") hide(); active = 0; refresh(); });
    input.addEventListener("focus", refresh);
    input.addEventListener("blur", () => { if (kind === "typed") setTimeout(hide, 120); });

    // Capture phase so this runs before chat.js's Enter-to-send handler
    input.addEventListener("keydown", e => {
      if (kind !== "typed") return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        render();
      } else if (e.key === "Escape") {
        hide();
      } else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        const typed = input.value.trim().toLowerCase();
        const exact = COMMANDS.some(c => namesOf(c).some(n => typed === "/" + n));
        if (e.key === "Enter" && exact) { hide(); return; } // "/help" or "/quiz" typed in full: just send it
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(items[active]);
      }
    }, true);

    // The message box is cleared by chat.js after sending, which doesn't fire "input"
    if (sendBtn) sendBtn.addEventListener("click", () => setTimeout(refresh, 0));
    input.addEventListener("keydown", e => { if (e.key === "Enter") setTimeout(refresh, 0); });

    // Study button: shows just the study modes
    if (studyBtn) {
      studyBtn.addEventListener("click", () => {
        if (kind === "study") { hide(); return; }
        items = COMMANDS.filter(c => c.group === "Study");
        active = 0;
        kind = "study";
        render();
      });
      document.addEventListener("mousedown", e => {
        if (kind === "study" && !menu.contains(e.target) && !studyBtn.contains(e.target)) hide();
      });
    }
  });

  window.agent1102Commands = { COMMANDS, parseCommand, parseStudy, parseGraph, isHelp, helpMarkdown };
})();
