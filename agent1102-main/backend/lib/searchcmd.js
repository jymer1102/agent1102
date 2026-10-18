// ============================================================
//  The /search command.
//  Web search ONLY happens when the person types  /search <question>.  Nothing else triggers it, so the free
//  search quota is only spent when someone asks for it.
//
//  Attached files travel in front of the typed text inside the same message, so "/search" is looked for after
//  any <attached_file> blocks. The model never sees the word "/search": it just sees the question.
// ============================================================
"use strict";

const CLOSE = "</attached_file>";

// "<attached_file>..</attached_file> /search who won" -> [ "<attached_file>..</attached_file>", " /search who won" ]
function splitFiles(text) {
  let pos = 0;
  for (;;) {
    const rest = text.slice(pos);
    if (!/^\s*<attached_file\b/.test(rest)) break;
    const end = rest.indexOf(CLOSE);
    if (end === -1) break;
    pos += end + CLOSE.length;
  }
  return [text.slice(0, pos), text.slice(pos)];
}

// -> null when it isn't a /search message, else { files, query }  (query is "" for a bare "/search")
function parseSearchCommand(text) {
  const [files, typed] = splitFiles(String(text == null ? "" : text));
  const m = /^\s*\/search(?:\s+([\s\S]*))?$/i.exec(typed);
  return m ? { files, query: (m[1] || "").trim() } : null;
}

function stripSearchCommand(text) {
  const p = parseSearchCommand(text);
  return p ? p.files + (p.files && p.query ? "\n\n" : "") + p.query : text;
}

// The same chat message without the "/search" word (works for plain text and for text + image messages)
function stripFromMessage(m) {
  if (!m || m.role !== "user") return m;
  if (typeof m.content === "string") return { ...m, content: stripSearchCommand(m.content) };
  if (Array.isArray(m.content)) {
    let done = false;
    return { ...m, content: m.content.map(part => {
      if (!done && part && part.type === "text" && typeof part.text === "string") { done = true; return { ...part, text: stripSearchCommand(part.text) }; }
      return part;
    }) };
  }
  return m;
}

// "At most `limit` searches per person per window", kept in memory (resets if the server restarts)
function createRateLimiter(limit, windowMs) {
  const hits = new Map();
  return {
    limit,
    allow(id, now = Date.now()) {
      const recent = (hits.get(id) || []).filter(t => now - t < windowMs);
      if (recent.length >= limit) { hits.set(id, recent); return false; }
      recent.push(now);
      hits.set(id, recent);
      if (hits.size > 5000) hits.delete(hits.keys().next().value);
      return true;
    },
  };
}

module.exports = { parseSearchCommand, stripSearchCommand, stripFromMessage, createRateLimiter, splitFiles };
