// The chat itself (POST /chat), plus the style settings (/prefs) and long-term memory (/memory) that feed it.
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)
const groq = require("../lib/groq");
const P = require("../lib/prompts");
const cues = require("../lib/cues");
const prefsLib = require("../lib/prefs");
const web = require("../lib/search");
const searchCmd = require("../lib/searchcmd");
const { createMemory, MemoryUnavailable, memoryCues } = require("../lib/memory");
const { verifyReply } = require("../lib/verify");

module.exports = function registerChat(ctx) {
const { app, supabaseAdmin, auth, MSG, fail, L, TEXT_MODEL, VISION_MODEL, MAX_IMAGES_PER_REQUEST, SYSTEM_PROMPT, clip, dropBrokenMathBlocks, generateMathVisual, wantsMathVisual } = ctx;

// Keeps only the newest few images, only accepts inline (data:) images, and reports whether any remain.
function prepareMessages(messages) {
  let seen = 0;
  const cleaned = messages.slice().reverse().map(m => {
    if (!m || !Array.isArray(m.content)) return m;
    const parts = m.content.filter(p => !(p && p.type === "text" && !String(p.text == null ? "" : p.text).trim())).map(p => {
      if (p && p.type === "image_url") {
        const url = p.image_url && p.image_url.url;
        if (typeof url !== "string" || !url.startsWith("data:image/")) {
          return { type: "text", text: "[An image was attached but could not be used]" };
        }
        seen++;
        if (seen > MAX_IMAGES_PER_REQUEST) return { type: "text", text: "[An earlier image was shared here but is no longer available]" };
      }
      return p;
    });
    return { ...m, content: parts };
  }).reverse();
  // Text-only models want plain strings, so flatten any leftover text parts
  const finalMessages = seen > 0 ? cleaned : cleaned.map(m =>
    m && Array.isArray(m.content)
      ? { ...m, content: m.content.map(p => (p && typeof p.text === "string" ? p.text : "")).filter(Boolean).join("\n") }
      : m
  );
  return { messages: finalMessages, hasImage: seen > 0 };
}

// ------------------------------------------------------------------
//  CHAT: the pipeline behind every normal message.
//   1. who is asking (verified token, cached)            -> memory + saved style
//   2. build the prompt: base rules + intent + emotion + (vision) + (domain) + style + memory + (web results)
//   3. call the model, STREAMING the answer to the page as it is written
//   4. check the finished answer (code parses, charts valid, LaTeX balanced) and fix it once if needed
//   5. in the background, update long-term memory
//  Older clients that don't ask for a stream still get the plain JSON reply.
// ------------------------------------------------------------------
const memory = createMemory({ supabase: supabaseAdmin, complete: groq.complete, model: TEXT_MODEL });
// /search is rationed per person so one user can't use up a free search quota
const SEARCH_PER_HOUR = parseInt(process.env.SEARCH_PER_HOUR, 10) || 30;
const searchLimiter = searchCmd.createRateLimiter(SEARCH_PER_HOUR, 60 * 60 * 1000);
const MAX_HISTORY_CHARS = parseInt(process.env.MAX_HISTORY_CHARS, 10) || 48000; // ~12k tokens of chat history per request

// Changes part of a user's auth metadata without clobbering the rest. It reads the FRESHEST copy first, because the
// login cache can be a few minutes old and another feature (easter-egg progress, say) may have saved in between.
// `change` is an object to merge in, or a function (currentMetadata) => object to merge in.
async function patchUserMetadata(userId, change) {
  const { data, error: readError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (readError || !data || !data.user) throw new Error((readError && readError.message) || "User not found");
  const current = data.user.user_metadata || {};
  const patch = typeof change === "function" ? change(current) : change;
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { user_metadata: { ...current, ...patch } });
  if (error) throw new Error(error.message);
  auth.invalidate(userId);
  return { ...current, ...patch };
}

// Saves style settings in the user's auth metadata (no table needed)
async function savePrefs(user, updates) {
  const meta = await patchUserMetadata(user.id, current => ({ style: { ...prefsLib.readStyle(current), ...prefsLib.cleanUpdates(updates) } }));
  return prefsLib.readStyle(meta);
}

// ---- Renamed chats ----
// A chat the user renamed is "locked": the automatic titler and the save route must never overwrite the name.
// The ids of locked chats live in the user's auth metadata (renamed_chats), so no new table column or SQL is needed.
const MAX_LOCKED_CHATS = 300;
const lockedChatIds = user => {
  const list = user && user.user_metadata && user.user_metadata.renamed_chats;
  return Array.isArray(list) ? list.filter(x => typeof x === "string") : [];
};
async function setChatLocked(userId, chatId, locked) {
  await patchUserMetadata(userId, current => {
    const list = Array.isArray(current.renamed_chats) ? current.renamed_chats.filter(x => typeof x === "string") : [];
    const rest = list.filter(x => x !== chatId);
    return { renamed_chats: locked ? [...rest, chatId].slice(-MAX_LOCKED_CHATS) : rest };
  });
}
// A chat name: no control characters, one space between words, at most 60 characters
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const cleanChatTitle = t => String(t == null ? "" : t).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

// Server-sent events. Headers go out with the FIRST event, so a failure before that can still be a normal JSON error.
function openSse(res) {
  let started = false;
  return {
    get started() { return started; },
    send(obj) {
      if (res.writableEnded || res.destroyed) return;
      if (!started) {
        started = true;
        res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        if (res.flushHeaders) res.flushHeaders();
      }
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    end() { if (started && !res.writableEnded) res.end(); },
  };
}

// One repair pass: show the model its own answer plus what the checker found
async function repairReply(model, systemPrompt, messages, reply, issues, signal) {
  const body = {
    model, max_tokens: 4096, temperature: 0.2,
    messages: [{ role: "system", content: systemPrompt }, ...messages, { role: "assistant", content: reply }, { role: "user", content: P.repairInstruction(issues) }],
  };
  if (/gpt-oss/i.test(model)) body.reasoning_effort = "low";
  return groq.complete(body, signal);
}

// Verifies a finished reply and repairs it once. Returns { reply, checked, fixed, remaining }.
async function verifyAndRepair(reply, ctx) {
  const first = await verifyReply(reply);
  if (!first.issues.length) return { reply, checked: first.checked, fixed: 0, remaining: [] };
  ctx.status("Fixing a problem I spotted...");
  let best = reply, bestIssues = first.issues;
  try {
    const fixed = await repairReply(ctx.model, ctx.systemPrompt, ctx.messages, reply, first.issues, ctx.signal);
    if (fixed.trim()) {
      const again = await verifyReply(fixed);
      if (again.issues.length < first.issues.length) { best = fixed.trim(); bestIssues = again.issues; }
    }
  } catch (e) { if (e && e.name === "AbortError") throw e; console.warn("Repair pass failed:", e && e.message ? e.message : e); }
  // Anything still broken in CODE gets an honest note instead of silence
  const codeLeft = bestIssues.filter(i => i.isCode);
  if (codeLeft.length) {
    const what = codeLeft.slice(0, 2).map(i => `${i.lang || "code"}: ${i.message}`).join("; ");
    best += `\n\n> **Heads-up:** my automatic syntax check flagged a problem I couldn't fix on my own (${what}). Please double-check that code before relying on it.`;
  }
  return { reply: best, checked: first.checked, fixed: first.issues.length - bestIssues.length, remaining: bestIssues };
}

app.post("/chat", L.chat, L.chatSignedOut, async (req, res) => {
  if (!Array.isArray(req.body.messages)) return res.status(400).json({ error: "There's nothing to send yet. Type a message and try again." });
  const sse = /text\/event-stream/i.test(req.headers.accept || "") ? openSse(res) : null;
  const status = text => { if (sse) sse.send({ type: "status", text }); };

  // stop paying for tokens nobody will read if the tab is closed mid-answer
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });

  const prepared = prepareMessages(req.body.messages);
  const hasImage = prepared.hasImage;
  const fitted = cues.trimMessages(prepared.messages, MAX_HISTORY_CHARS);
  // /search is the ONLY thing that triggers a web search. The model never sees the word "/search" (in this
  // message or in earlier ones): it just sees the question.
  const lastTextOf = list => {
    const m = [...list].reverse().find(x => x && x.role === "user");
    return !m ? "" : typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => (p && p.text) || "").join(" ") : "";
  };
  const search = searchCmd.parseSearchCommand(lastTextOf(fitted.messages)); // null, or { files, query }
  const messages = fitted.messages.map(searchCmd.stripFromMessage);
  const lastUserText = lastTextOf(messages);
  const hasFiles = /<attached_file/.test(lastUserText);
  const mentionsJymer = /jymer\s*1102/i.test(lastUserText);

  try {
    // 1) who is this, what do they like, what do we remember
    const user = await auth.verify(auth.bearer(req)); // null = signed out: no memory, no saved style
    let style = prefsLib.readStyle(user && user.user_metadata);
    const learned = prefsLib.detectStyleUpdates(lastUserText);
    if (user && learned.notes.length) {
      style = { ...style, ...learned.updates };
      savePrefs(user, learned.updates).catch(e => console.warn("Saving style failed:", e.message));
      if (sse) sse.send({ type: "meta", style: learned.notes });
    }
    const mc = memoryCues(lastUserText);
    const domains = cues.detectDomains(lastUserText);

    // The person typed /search: check everything BEFORE spending a search or a model call
    if (search) {
      const quick = text => { if (sse) { sse.send({ type: "final", reply: text, meta: {} }); sse.end(); } else res.json({ reply: text, meta: {} }); };
      if (!user) return quick("Please sign in to use /search.");
      if (!web.enabled()) return quick("Web search isn't available right now. You can still ask your question without /search and I'll answer from what I know.");
      if (!search.query) return quick("Add a question after /search, for example: `/search latest Node.js LTS version`.");
      if (!searchLimiter.allow(user.id)) return quick(`You've used your ${SEARCH_PER_HOUR} web searches for this hour. Try again a bit later. Questions without /search still work.`);
      status("Searching the web...");
    }
    const [memories, results] = await Promise.all([
      user && style.memory ? memory.relevant(user.id, lastUserText) : [],
      search ? web.searchWeb(cues.stripAttachments(search.query)) : [],
    ]);

    // 2) the prompt
    const emo = cues.emotionCues(lastUserText);
    const parts = [SYSTEM_PROMPT, P.INTENT_RULES, P.EMOTION_RULES];
    if (hasImage) parts.push(P.VISION_RULES);
    domains.forEach(d => parts.push(P.DOMAIN_RULES[d]));
    if (results.length) parts.push(P.searchBlock(results));
    else if (search) parts.push(P.SEARCH_EMPTY_NOTE);
    else if (domains.length || cues.needsFreshInfo(lastUserText, domains)) parts.push(P.freshnessRule(web.enabled()));
    parts.push(prefsLib.styleBlock(style), P.memoryBlock(memories));
    if (emo.notes.length) parts.push("EMOTION HINTS (automatic guesses, may be wrong):\n" + emo.notes.map(n => "- " + n).join("\n"));
    if (user && mc.remember) parts.push(style.memory
      ? "The user asked you to remember something. Confirm in one short sentence that you will remember it (it is being saved now)."
      : "The user asked you to remember something, but their memory is switched off. Tell them to type /memory on first, then ask again.");
    if (user && style.memory && mc.forget) parts.push("The user asked you to forget something. Confirm in one short sentence that it is being removed from memory.");
    if (fitted.trimmed) parts.push("The oldest part of this long conversation was left out to save space. If the user refers to something you cannot see, say so and ask them to repeat it.");
    if (mentionsJymer) parts.push("The user's latest message is about jymer1102. Include both links, each as a plain URL on its own line: https://jymer1102.github.io/jymer1102 and https://linktr.ee/jymer1102");
    const systemPrompt = parts.filter(Boolean).join("\n\n");

    // 3) the model (low thinking effort for quick chat turns = faster first word)
    const model = hasImage ? VISION_MODEL : TEXT_MODEL;
    const body = { model, max_tokens: 4096, messages: [{ role: "system", content: systemPrompt }, ...messages] };
    if (hasImage) body.temperature = 0.2; // steadier reading of handwriting, tables and small print
    else if (/gpt-oss/i.test(model)) body.reasoning_effort = cues.pickEffort({ text: lastUserText, hasImage, hasFiles, turns: messages.length, domains });
    let reply = sse ? await groq.stream(body, piece => sse.send({ type: "delta", text: piece }), abort.signal) : await groq.complete(body, abort.signal);

    // 4) clean up and check the finished answer
    // Drawings must really draw: broken ```mathviz blocks are removed, and graph requests that came back as code/ASCII get a real drawing.
    let hadGood = false;
    if (!hasImage) {
      const checked = dropBrokenMathBlocks(reply);
      reply = checked.text;
      hadGood = checked.good > 0;
    }
    if (!hasImage && !hadGood && wantsMathVisual(lastUserText) && !/```(?:chart|graph)\b/i.test(reply)) {
      try {
        status("Drawing it...");
        const ctx = messages.slice(-5, -1).map(m => typeof m.content === "string" ? `${m.role}: ${m.content.slice(0, 600)}` : "").filter(Boolean).join("\n");
        const out = await generateMathVisual(lastUserText.replace(/^\s*\/\w+\s*/, ""), ctx);
        if (out) {
          reply = reply.replace(/```(?:python|py|javascript|js|r|matlab|julia)?\s*\n[\s\S]*?(?:matplotlib|plt\.|numpy|plotly|ggplot|desmos|geogebra)[\s\S]*?```/gi, "").trim();
          reply = reply.replace(/```(?:text|txt|ascii|plaintext)?[ \t]*\n([\s\S]*?)```/gi, (whole, b) =>
            /(<-{2,}|-{2,}>|\|-{2,}|-{2,}\||\+-{2,}|-{3,}\+|\^\s*\n|\bo-{2,}|-{2,}o\b)/.test(b) && !/[a-z]{4,}\s*\(|=\s*[a-z]/i.test(b.replace(/\bx\b/g, "")) ? "" : whole).trim();
          reply = (reply ? reply + "\n\n" : "") + out.block;
        }
      } catch (e) { console.error("Graph fallback failed:", e.message); }
    }
    const verified = await verifyAndRepair(reply, { status, model, systemPrompt, messages, signal: abort.signal });
    reply = verified.reply;

    // 5) long-term memory updates in the background (never delays or breaks the reply)
    if (user && style.memory) memory.extract(user.id, lastUserText, reply);

    const meta = {
      ...(learned.notes.length ? { style: learned.notes } : {}),
      ...(results.length ? { sources: results.map(r => r.url) } : {}),
      checked: verified.checked, fixed: verified.fixed,
    };
    if (sse) { sse.send({ type: "final", reply, meta }); sse.end(); }
    else res.json({ reply, meta });
  } catch (err) {
    if (err && err.name === "AbortError") return; // the user left; nothing to send
    const known = err instanceof groq.GroqError;
    if (!known) console.error(err);
    const message = known ? err.message : MSG.generic;
    if (sse && sse.started) { sse.send({ type: "error", error: message }); sse.end(); }
    else res.status(known ? err.status : 500).json({ error: message });
  }
});

// --- PERSONALIZATION: style settings + memory switch ---
// GET  /prefs                      -> current settings
// POST /prefs {command:"concise"}  -> the /style command; {updates:{memory:false}} -> direct switch
const prefsRows = style => prefsLib.describeStyle(style);
app.get("/prefs", async (req, res) => {
  const user = await auth.verify(auth.bearer(req));
  if (!user) return res.status(401).json({ error: MSG.signIn });
  const style = prefsLib.readStyle(user.user_metadata);
  res.json({ style, rows: prefsRows(style) });
});
app.post("/prefs", async (req, res) => {
  const user = await auth.verify(auth.bearer(req));
  if (!user) return res.status(401).json({ error: MSG.signIn });
  let updates, notes = [];
  if (typeof req.body.command === "string") {
    const p = prefsLib.parseStyleArgs(req.body.command);
    if (p.error) return res.status(400).json({ error: p.error });
    if (p.show) { const s = prefsLib.readStyle(user.user_metadata); return res.json({ style: s, rows: prefsRows(s), notes: [] }); }
    updates = p.updates; notes = p.notes;
  } else if (req.body.updates && typeof req.body.updates === "object") {
    updates = prefsLib.cleanUpdates(req.body.updates);
  }
  if (!updates || !Object.keys(updates).length) return res.status(400).json({ error: "There's nothing to change." });
  try {
    const style = await savePrefs(user, updates);
    res.json({ style, rows: prefsRows(style), notes });
  } catch (e) { fail(res, 500, MSG.generic, e); }
});

// --- LONG-TERM MEMORY (what the assistant remembers about you; you can see and delete all of it) ---
function memoryRoute(handler) {
  return async (req, res) => {
    const user = await auth.verify(auth.bearer(req));
    if (!user) return res.status(401).json({ error: MSG.signIn });
    try { await handler(req, res, user); }
    catch (e) {
      if (e instanceof MemoryUnavailable) return res.status(503).json({ error: "Memory isn't available right now. Please try again later." });
      console.error("Memory route failed:", e && e.message ? e.message : e);
      res.status(500).json({ error: MSG.generic });
    }
  };
}
app.get("/memory", memoryRoute(async (req, res, user) => {
  const rows = await memory.list(user.id);
  res.json({ enabled: prefsLib.readStyle(user.user_metadata).memory, memories: rows.map(({ id, kind, content, source, created_at }) => ({ id, kind, content, source, created_at })) });
}));
app.post("/memory", memoryRoute(async (req, res, user) => {
  const content = clip(req.body.content, 200);
  if (content.length < 3) return res.status(400).json({ error: "Tell me what to remember." });
  const r = await memory.add(user.id, content, { kind: req.body.kind, source: "user" });
  if (r.skipped === "sensitive") return res.status(400).json({ error: "That looks like a password, key or ID number, so I won't store it." });
  res.json({ success: true });
}));
app.delete("/memory/:id", memoryRoute(async (req, res, user) => { await memory.remove(user.id, req.params.id); res.json({ success: true }); }));
app.delete("/memory", memoryRoute(async (req, res, user) => { await memory.clear(user.id); res.json({ success: true }); }));

// handed to the files that register after this one
Object.assign(ctx, { cleanChatTitle, lockedChatIds, memory, patchUserMetadata, setChatLocked });
};
