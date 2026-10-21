// ============================================================
//  Personal commands: /memory  /remember  /forget  /style
//  Their output is shown in the chat but is NOT added to the conversation history, so memory lists and
//  settings never get sent to the AI as if they were part of the discussion.
// ============================================================
(function () {
  "use strict";

  const NAMES = ["memory", "remember", "forget", "style"];
  const PATTERN = /^\/(memory|remember|forget|style)\b\s*([\s\S]*)$/i;

  const match = text => PATTERN.test(String(text || "").trim());
  const auth = extra => ({ "Authorization": `Bearer ${userToken}`, ...(extra || {}) });

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(`${BACKEND_URL}${path}`, {
        method,
        headers: auth(body ? { "Content-Type": "application/json" } : null),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) { throw new Error("I can't reach the server right now. Check your connection and try again."); }
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  function show(role, text) {
    const w = window.addMsg(role, text, null, history.length); // history.length: this message is not stored in history
    if (role === "ai" && w) { const retry = w.querySelector(".retry-btn"); if (retry) retry.remove(); }
    return w;
  }

  const styleTable = rows => "| Setting | Value |\n| --- | --- |\n" + rows.map(r => `| ${r[0]} | ${r[1]} |`).join("\n");
  const STYLE_HELP = "Change them with `/style concise`, `/style detailed`, `/style casual`, `/style formal`, `/style friendly`, `/style prose`, `/style bullets`, `/style beginner`, `/style expert`, `/style emoji off`, or `/style reset`. You can also just tell me, like \"from now on keep answers short\".";

  async function listMemories() {
    const d = await api("GET", "/memory");
    const head = d.enabled ? "**What I remember about you**" : "**What I remember about you** (memory is currently **off**, so I'm not using it or adding to it)";
    if (!d.memories.length) {
      return `${head}\n\nNothing yet. I pick up lasting facts as we chat (what you're studying, building, how you like answers), or you can tell me directly with \`/remember I prefer metric units\`.`;
    }
    const rows = d.memories.map((m, i) => `${i + 1}. ${m.content}${m.source === "user" ? " *(you told me)*" : ""}`);
    return `${head}\n\n${rows.join("\n")}\n\n**Manage it:** \`/forget 2\` removes one, \`/forget all\` clears everything, \`/remember <fact>\` adds one, \`/memory off\` pauses it.`;
  }

  async function forget(arg) {
    const d = await api("GET", "/memory");
    if (!d.memories.length) return "There's nothing to forget yet.";
    if (!arg) return "What should I forget? Use `/forget 2` (a number from `/memory`), `/forget all`, or `/forget` followed by a few words from the memory.";
    if (/^(all|everything)$/i.test(arg)) {
      if (!window.confirm("Delete everything I remember about you? This can't be undone.")) return "Okay, I kept everything.";
      await api("DELETE", "/memory");
      return "Done. I've forgotten everything I had saved about you.";
    }
    let target = null;
    if (/^\d+$/.test(arg)) {
      target = d.memories[parseInt(arg, 10) - 1];
      if (!target) return `There's no memory number ${arg}. Type \`/memory\` to see the list.`;
    } else {
      const q = arg.toLowerCase();
      const hits = d.memories.filter(m => m.content.toLowerCase().includes(q));
      if (!hits.length) return `I couldn't find a memory containing "${arg}". Type \`/memory\` to see the list.`;
      if (hits.length > 1) return `More than one memory matches "${arg}":\n\n${hits.map(m => `- ${m.content}`).join("\n")}\n\nUse \`/memory\` and then \`/forget <number>\` to pick one.`;
      target = hits[0];
    }
    await api("DELETE", `/memory/${encodeURIComponent(target.id)}`);
    return `Forgot: "${target.content}"`;
  }

  async function run(text, opts) {
    opts = opts || {};
    const m = String(text || "").trim().match(PATTERN);
    if (!m) return false;
    const cmd = m[1].toLowerCase(), arg = m[2].trim();
    if (!opts.skipUser) {
      show("user", text.trim());
      const box = document.getElementById("input");
      if (box) box.value = "";
    }
    try {
      if (!userToken) { show("ai", "Please sign in first so I can save things for you."); return true; }
      if (cmd === "memory") {
        if (/^(on|enable)$/i.test(arg)) { await api("POST", "/prefs", { updates: { memory: true } }); show("ai", "Memory is **on**. I'll remember lasting facts you share. See them anytime with `/memory`."); }
        else if (/^(off|disable|pause)$/i.test(arg)) { await api("POST", "/prefs", { updates: { memory: false } }); show("ai", "Memory is **off**. I won't use or add to what I've saved. Your saved memories are kept; `/forget all` deletes them."); }
        else if (/^(clear|reset|delete)$/i.test(arg)) show("ai", await forget("all"));
        else show("ai", await listMemories());
      } else if (cmd === "remember") {
        if (!arg) show("ai", "What should I remember? For example: `/remember I'm studying nursing and prefer short answers`.");
        else { await api("POST", "/memory", { content: arg }); show("ai", `Got it, I'll remember that: "${arg.slice(0, 200)}"`); }
      } else if (cmd === "forget") {
        show("ai", await forget(arg));
      } else if (cmd === "style") {
        const d = arg ? await api("POST", "/prefs", { command: arg }) : await api("GET", "/prefs");
        const head = d.notes && d.notes.length ? `Done. From now on: ${d.notes.join(", ")}.\n\n` : "**Your style settings**\n\n";
        show("ai", head + styleTable(d.rows) + "\n\n" + STYLE_HELP);
      }
    } catch (e) {
      show("ai", e.message || "Something went wrong. Please try again.");
    }
    return true;
  }

  window.agent1102Personal = { match, run, NAMES };
})();
