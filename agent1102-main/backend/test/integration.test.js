// End-to-end test: starts the REAL server.js against a fake Groq and a fake Supabase, then checks the
// streaming reply, memory, style learning, the repair loop and the error paths.
//   run:  node test/integration.test.js
"use strict";
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");

const GROQ_PORT = 4101, SB_PORT = 4102, APP_PORT = 4100;
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
let chatRows = [{ id: "1700000000000", user_id: "22222222-2222-4222-8222-222222222222", title: "Someone else's chat", history: [{ role: "user", content: "private" }] }];
const TOKEN = `${b64({ alg: "HS256" })}.${b64({ sub: "11111111-1111-4111-8111-111111111111", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "a@b.c", user_metadata: { name: "Sam" } };

// ---------- fake Groq ----------
const groqCalls = [];
let groqMode = "normal";
const groqServer = http.createServer((req, res) => {
  let raw = ""; req.on("data", d => raw += d); req.on("end", () => {
    const body = JSON.parse(raw); groqCalls.push(body);
    const sys = (body.messages[0] && body.messages[0].content) || "";
    const last = body.messages[body.messages.length - 1].content;
    const lastText = typeof last === "string" ? last : "";
    if (groqMode === "aierror") { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "internal model_decommissioned xyz-secret-detail" } })); }
    if (groqMode === "ratelimit") { res.writeHead(429, { "Content-Type": "application/json", "x-ratelimit-reset-tokens": "1m5s" }); return res.end(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } })); }
    let content;
    if (/maintain a small long-term memory/.test(sys)) {
      const said = (/LATEST USER MESSAGE:\n([\s\S]*?)\n\nASSISTANT/.exec(lastText) || [])[1] || "";
      content = JSON.stringify({ add: /nursing/.test(said) ? [{ kind: "fact", content: "Is studying nursing at KU" }] : /robot/.test(said) ? [{ kind: "project", content: "Is building a robot" }] : [], forget: [] });
    }
    else if (/automatic checker found problems/.test(lastText)) content = groqMode === "unfixable" ? "```python\ndef f(x)\n    return x\n```" : "Fixed:\n```python\ndef f(x):\n    return x\n```";
    else if (/BADPY/.test(lastText)) content = "Here:\n```python\ndef f(x)\n    return x\n```";
    else content = "Hello there, friend. This streams in pieces.";
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const pieces = content.match(/.{1,8}/gs);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "thinking..." } }] })}\n\n`);
      pieces.forEach(p => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
      res.end("data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
  });
});

// ---------- fake Supabase ----------
let memories = [], adminUpdates = [], memoryTableMissing = false;
const sbServer = http.createServer((req, res) => {
  let raw = ""; req.on("data", d => raw += d); req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const bearer = (req.headers.authorization || "").split(" ")[1];
    if (url.pathname === "/auth/v1/token") return json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
    if (url.pathname === "/auth/v1/user") return bearer === TOKEN ? json(200, USER) : json(401, { message: "bad jwt" });
    if (url.pathname.startsWith("/auth/v1/admin/users/") && req.method === "GET") return json(200, USER); // getUserById: the server reads the current metadata before changing it
    if (url.pathname.startsWith("/auth/v1/admin/users/") && req.method === "PUT") { const b = JSON.parse(raw); adminUpdates.push(b); USER.user_metadata = b.user_metadata || USER.user_metadata; return json(200, USER); }
    if (url.pathname === "/auth/v1/admin/users") return json(200, { users: [] });
    if (url.pathname === "/storage/v1/bucket") return json(200, {});
    if (url.pathname === "/rest/v1/chats") {
      const match = row => [...url.searchParams].every(([k, v]) => !/^(eq|neq)\./.test(v) || (v.startsWith("eq.") ? String(row[k]) === v.slice(3) : String(row[k]) !== v.slice(4)));
      if (req.method === "GET") return json(200, chatRows.filter(match).slice(0, Number(url.searchParams.get("limit")) || 1000));
      if (req.method === "POST") { const b = JSON.parse(raw); const i = chatRows.findIndex(r => r.id === b.id); if (i >= 0) chatRows[i] = b; else chatRows.push(b); res.writeHead(201); return res.end(); } // like a table keyed on id alone
    }
    if (url.pathname === "/rest/v1/user_memories") {
      if (memoryTableMissing) return json(404, { code: "PGRST205", message: "Could not find the table 'public.user_memories' in the schema cache" });
      if (req.method === "GET") return json(200, memories);
      if (req.method === "POST") { const b = JSON.parse(raw); memories.push({ id: "m-" + (memories.length + 1) + "-" + Date.now(), source: "auto", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...b }); res.writeHead(201); return res.end(); }
      if (req.method === "PATCH") { const id = (url.searchParams.get("id") || "").replace("eq.", ""); const m = memories.find(x => x.id === id); if (m) Object.assign(m, JSON.parse(raw)); res.writeHead(204); return res.end(); }
      if (req.method === "DELETE") {
        const id = url.searchParams.get("id") || "";
        if (id.startsWith("eq.")) memories = memories.filter(m => m.id !== id.slice(3));
        else if (id.startsWith("in.")) { const ids = id.slice(4, -1).split(","); memories = memories.filter(m => !ids.includes(m.id)); }
        else memories = [];
        res.writeHead(204); return res.end();
      }
    }
    json(404, { message: "not faked: " + req.method + " " + url.pathname });
  });
});

// ---------- helpers ----------
const listen = (srv, port) => new Promise(r => srv.listen(port, "127.0.0.1", r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (p, body, { token, stream } = {}) => fetch(`http://127.0.0.1:${APP_PORT}${p}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(stream ? { Accept: "text/event-stream" } : {}) },
  body: JSON.stringify(body),
});
const call = (method, p, token) => fetch(`http://127.0.0.1:${APP_PORT}${p}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
async function readSse(res) {
  const events = []; const dec = new TextDecoder(); let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf("\n\n")) !== -1) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2); if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5))); }
  }
  return events;
}
const chat = (text, opts = {}) => post("/chat", { messages: [{ role: "user", content: text }] }, opts);
const sysOf = () => groqCalls[groqCalls.length - 1].messages[0].content;

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e && e.message)); process.exitCode = 1; } }

(async () => {
  await listen(groqServer, GROQ_PORT); await listen(sbServer, SB_PORT);
  const server = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RATE_LIMIT_SCALE: "1000", PORT: APP_PORT, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "service", GROQ_API_KEY: "k", GROQ_API_URL: `http://127.0.0.1:${GROQ_PORT}/v1/chat/completions`, SITE_URL: `http://127.0.0.1:${APP_PORT}`, TAVILY_API_KEY: "", BRAVE_API_KEY: "", MEMORY_EXTRACT_GAP_MS: "400" },
  });
  let serverLog = ""; server.stdout.on("data", d => serverLog += d); server.stderr.on("data", d => serverLog += d);
  for (let i = 0; i < 50; i++) { try { if ((await call("GET", "/ping")).ok) break; } catch (_) {} await sleep(100); }

  console.log("streaming + speed");
  await t("SSE stream: deltas add up to the final reply, reasoning text is never forwarded", async () => {
    const ev = await readSse(await chat("hi", { stream: true }));
    const text = ev.filter(e => e.type === "delta").map(e => e.text).join("");
    const fin = ev.find(e => e.type === "final");
    assert(ev.filter(e => e.type === "delta").length > 2, "expected several deltas");
    assert.strictEqual(fin.reply, text);
    assert(!text.includes("thinking..."));
  });
  await t("quick chat turn uses low reasoning effort; hard question uses medium", async () => {
    await readSse(await chat("hi", { stream: true }));
    assert.strictEqual(groqCalls[groqCalls.length - 1].reasoning_effort, "low");
    await readSse(await chat("Prove that the square root of 2 is irrational", { stream: true }));
    assert.strictEqual(groqCalls[groqCalls.length - 1].reasoning_effort, "medium");
  });
  await t("a client that doesn't ask for a stream still gets plain JSON", async () => {
    const r = await chat("hello"); const j = await r.json();
    assert(r.headers.get("content-type").includes("json")); assert(j.reply.startsWith("Hello there"));
  });
  await t("rate limit before the stream starts is a normal 429 with the right wait time", async () => {
    groqMode = "ratelimit";
    const r = await chat("hi", { stream: true }); const j = await r.json();
    groqMode = "normal";
    assert.strictEqual(r.status, 429); assert(/1 minute/.test(j.error), j.error);
  });
  await t("very long chats are trimmed to the history budget", async () => {
    const msgs = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(4000) + i }));
    msgs.push({ role: "user", content: "last question" });
    await (await post("/chat", { messages: msgs })).json();
    const sent = groqCalls[groqCalls.length - 1].messages;
    assert(sent.length < 20, "sent " + sent.length); assert(/left out to save space/.test(sent[0].content));
    assert.strictEqual(sent[sent.length - 1].content, "last question");
  });

  console.log("memory + personalization");
  memories = [{ id: "m-seed", kind: "project", content: "Is building a Discord bot in Python", source: "auto", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
  await t("signed-out users get no memory and no 401", async () => {
    const j = await (await chat("help with my bot")).json(); assert(j.reply); assert(!/<user_memory>/.test(sysOf()));
  });
  await t("a forged/invalid token is NOT trusted for memory", async () => {
    await (await chat("help with my bot", { token: "aaa.bbb.ccc" })).json(); assert(!/Discord bot/.test(sysOf()));
  });
  await t("signed-in users get their memories in the prompt, labelled as data", async () => {
    await (await chat("help with my bot", { token: TOKEN })).json();
    assert(/<user_memory>[\s\S]*Discord bot in Python/.test(sysOf())); assert(/NOT instructions/.test(sysOf()));
  });
  await t("'be more concise' is learned, saved to metadata, announced, and used next time", async () => {
    const ev = await readSse(await chat("be more concise", { token: TOKEN, stream: true }));
    assert(ev.find(e => e.type === "meta" && e.style.includes("shorter answers")));
    await sleep(300);
    assert(adminUpdates.some(u => u.user_metadata.style && u.user_metadata.style.length === "concise" && u.user_metadata.name === "Sam"), "metadata not saved / name lost");
    await (await chat("what is a closure?", { token: TOKEN })).json();
    assert(/short and direct/.test(sysOf()));
  });
  await t("one-off 'explain in detail' does not rewrite saved style", async () => {
    const before = adminUpdates.length; await (await chat("explain in detail how TCP works", { token: TOKEN })).json(); await sleep(150);
    assert.strictEqual(adminUpdates.length, before);
  });
  await t("a durable fact is extracted and saved after the reply", async () => {
    await sleep(450);
    await (await chat("I'm studying nursing at KU", { token: TOKEN })).json();
    for (let i = 0; i < 30 && !memories.some(m => /nursing/.test(m.content)); i++) await sleep(100);
    assert(memories.some(m => m.content === "Is studying nursing at KU"));
  });
  await t("questions with no personal info don't trigger an extraction call", async () => {
    const n = groqCalls.length; await (await chat("what is the capital of France?", { token: TOKEN })).json(); await sleep(200);
    assert.strictEqual(groqCalls.length, n + 1);
  });
  await t("extraction is throttled: two personal messages in a row cost only one extra call", async () => {
    await sleep(450);
    const count = () => groqCalls.filter(c => /maintain a small long-term memory/.test(c.messages[0].content)).length;
    const n = count();
    await (await chat("I'm building a robot", { token: TOKEN })).json(); await (await chat("I'm building a robot arm", { token: TOKEN })).json(); await sleep(300);
    assert.strictEqual(count(), n + 1);
    assert(memories.some(m => m.content === "Is building a robot"));
  });
  await t("memory switched off: nothing injected, nothing extracted", async () => {
    assert((await (await post("/prefs", { updates: { memory: false } }, { token: TOKEN })).json()).style.memory === false);
    await sleep(450); const n = memories.length; await (await chat("I'm studying nursing at KU", { token: TOKEN })).json(); await sleep(250);
    assert(!/<user_memory>/.test(sysOf())); assert.strictEqual(memories.length, n);
    await post("/prefs", { updates: { memory: true } }, { token: TOKEN });
  });
  await t("emotion hint is added for sarcasm/frustration and crisis gets care instructions", async () => {
    await (await chat("oh great, ANOTHER error, thanks a lot")).json(); assert(/EMOTION HINTS[\s\S]*(sarcasm|frustrated)/.test(sysOf()));
    await (await chat("i want to die")).json(); assert(/988/.test(sysOf()));
  });
  await t("/memory API: list, add, refuses secrets, delete one, clear, 401 without token", async () => {
    assert.strictEqual((await call("GET", "/memory")).status, 401);
    let j = await (await call("GET", "/memory", TOKEN)).json(); assert(j.memories.length >= 2 && j.enabled === true);
    assert((await post("/memory", { content: "Prefers metric units" }, { token: TOKEN })).ok);
    const bad = await post("/memory", { content: "my password is hunter2" }, { token: TOKEN }); assert.strictEqual(bad.status, 400);
    j = await (await call("GET", "/memory", TOKEN)).json();
    const victim = j.memories.find(m => /metric/.test(m.content)); assert(victim && victim.source === "user");
    assert((await call("DELETE", "/memory/" + victim.id, TOKEN)).ok);
    assert(!(await (await call("GET", "/memory", TOKEN)).json()).memories.some(m => /metric/.test(m.content)));
    assert((await call("DELETE", "/memory", TOKEN)).ok);
    assert.strictEqual((await (await call("GET", "/memory", TOKEN)).json()).memories.length, 0);
  });
  await t("/prefs: /style command words are parsed server-side", async () => {
    const j = await (await post("/prefs", { command: "casual no emoji" }, { token: TOKEN })).json();
    assert.strictEqual(j.style.tone, "casual"); assert.strictEqual(j.style.emoji, false);
    assert.strictEqual((await post("/prefs", { command: "banana" }, { token: TOKEN })).status, 400);
  });

  console.log("verification");
  await t("broken Python is caught, repaired once, and the user only sees the fixed answer", async () => {
    const ev = await readSse(await chat("write BADPY", { stream: true }));
    const fin = ev.find(e => e.type === "final");
    assert(ev.some(e => e.type === "status" && /Fixing/.test(e.text)));
    assert(fin.reply.includes("def f(x):")); assert(!fin.reply.includes("Heads-up")); assert.strictEqual(fin.meta.fixed, 1);
  });
  await t("if the repair can't fix it, the user gets an honest heads-up instead of silence", async () => {
    groqMode = "unfixable";
    const fin = (await readSse(await chat("write BADPY", { stream: true }))).find(e => e.type === "final");
    groqMode = "normal";
    assert(/Heads-up/.test(fin.reply), fin.reply);
  });
  await t("a reply with no code makes no repair call", async () => {
    const n = groqCalls.length; await (await chat("hello")).json(); assert.strictEqual(groqCalls.length, n + 1);
  });

  console.log("resilience");
  await t("chat keeps working when the memory table can't be read (missing table is unit-tested)", async () => {
    memoryTableMissing = true;
    const chatRes = await (await chat("hello", { token: TOKEN })).json();
    memoryTableMissing = false;
    assert(chatRes.reply);
  });

  console.log("\nattachments with no typed text; friendly errors");
  await t("a photo with no text reaches the AI with no empty text part", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const messages = [
      { role: "user", content: [{ type: "image_url", image_url: { url: png } }] },                                   // what the page sends now
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "text", text: "" }, { type: "image_url", image_url: { url: png } }] },      // an old/other client's empty text part
    ];
    const before = groqCalls.length;
    const res = await post("/chat", { messages }, { token: TOKEN, stream: true });
    const events = await readSse(res);
    assert(events.some(e => e.type === "final" || e.type === "delta"), "should get a normal reply, got " + JSON.stringify(events).slice(0, 200));
    const sent = groqCalls.slice(before).find(c => c.stream);
    assert(sent, "the chat request reached the AI");
    for (const m of sent.messages) if (Array.isArray(m.content)) for (const part of m.content) assert(!(part.type === "text" && !String(part.text).trim()), "empty text part was sent to the AI");
  });
  await t("an AI failure shows plain words and never the AI service's own wording", async () => {
    groqMode = "aierror";
    const res = await post("/chat", { messages: [{ role: "user", content: "hello" }] }, { token: TOKEN, stream: true });
    const ct = res.headers.get("content-type") || "";
    const text = ct.includes("event-stream") ? JSON.stringify(await readSse(res)) : JSON.stringify(await res.json()); // fails before streaming = JSON, after = SSE
    groqMode = "normal";
    assert(!/xyz-secret-detail|model_decommissioned|AI error/.test(text), "leaked: " + text.slice(0, 200));
    assert(/AI service had a problem/.test(text), "expected the friendly message, got: " + text.slice(0, 200));
  });
  await t("signing out of nothing: a request with no sign-in token gets a plain message", async () => {
    const r = await post("/memory", {}, {});
    const j = await r.json();
    assert.strictEqual(r.status, 401);
    assert.strictEqual(j.error, "Please sign in to continue.");
  });

  console.log("\nsigned-in checks, security headers, rate limits");
  const BASE = `http://127.0.0.1:${APP_PORT}`;
  const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  // looks like a real token for this user, but Supabase never issued it: all anyone needs to write is a name and a user id
  const FORGED = `${b64u({ alg: "HS256" })}.${b64u({ sub: USER.id, exp: Math.floor(Date.now() / 1000) + 3600 })}.not-a-real-signature`;
  const send = (method, p, { token, body, headers } = {}) => fetch(BASE + p, {
    method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

  await t("a forged token can't save a score for someone else (a real one is checked, not just read)", async () => {
    for (const game of ["pacman", "trex"]) {
      const r = await send("POST", `/${game}-score`, { body: { score: 500, token: FORGED } });
      assert.strictEqual(r.status, 401, game);
      assert.strictEqual((await r.json()).error, "Your session has expired. Please sign in again.");
    }
  });
  await t("scores must be sensible numbers", async () => {
    for (const score of [-1, 1.5, "99", 10000001, 9e15]) {
      const r = await send("POST", "/pacman-score", { body: { score, token: TOKEN } });
      assert.strictEqual(r.status, 400, "score " + score);
    }
  });
  await t("saving a chat can't take over a chat id that belongs to someone else (ids are guessable timestamps)", async () => {
    const hijack = await send("POST", "/chats", { token: TOKEN, body: { id: "1700000000000", title: "mine now", history: [{ role: "user", content: "hacked" }] } });
    assert.strictEqual(hijack.status, 409);
    assert.strictEqual((await hijack.json()).error, "I couldn't save this chat. Please start a new chat and try again.");
    assert.strictEqual(chatRows.length, 1);
    assert.strictEqual(chatRows[0].user_id, "22222222-2222-4222-8222-222222222222", "still theirs");
    assert.strictEqual(chatRows[0].title, "Someone else's chat", "unchanged");
    const own = await send("POST", "/chats", { token: TOKEN, body: { id: "1800000000000", title: "mine", history: [{ role: "user", content: "hi" }] } });
    assert.strictEqual(own.status, 200);
    const again = await send("POST", "/chats", { token: TOKEN, body: { id: "1800000000000", title: "mine", history: [{ role: "user", content: "hi again" }] } });
    assert.strictEqual(again.status, 200, "saving your own chat again still works");
    assert.strictEqual(chatRows.filter(r => r.id === "1800000000000").length, 1);
  });
  await t("a forged token can't read a profile or overwrite someone's saved chats", async () => {
    assert.strictEqual((await send("GET", "/profile", { token: FORGED })).status, 401);
    assert.strictEqual((await send("POST", "/chats", { token: FORGED, body: { id: "c1", title: "x", history: [] } })).status, 401);
    assert.strictEqual((await send("POST", "/chats", { body: { id: "c1", title: "x", history: [], token: FORGED } })).status, 401, "token in the body too");
  });
  await t("study, graph, title, images, read-aloud and link previews need a real sign-in", async () => {
    const routes = [["POST", "/study"], ["POST", "/graph"], ["POST", "/title"], ["POST", "/generate-image"], ["POST", "/edit-image"], ["POST", "/tts"], ["GET", "/link-preview?url=https://example.com"]];
    for (const [method, p] of routes) {
      const none = await send(method, p, method === "POST" ? { body: {} } : {});
      assert.strictEqual(none.status, 401, p + " with no token");
      assert.strictEqual((await none.json()).error, "Please sign in to continue.");
      const fake = await send(method, p, { token: FORGED, ...(method === "POST" ? { body: {} } : {}) });
      assert.strictEqual(fake.status, 401, p + " with a forged token");
      assert.strictEqual((await fake.json()).error, "Your session has expired. Please sign in again.");
    }
  });
  await t("...and a real sign-in gets past that check (and then fails only on its own input)", async () => {
    const link = await send("GET", "/link-preview?url=not-a-link", { token: TOKEN });
    assert.strictEqual(link.status, 400); assert.strictEqual((await link.json()).error, "That link isn't valid.");
    const title = await send("POST", "/title", { token: TOKEN, body: { messages: [] } });
    assert.notStrictEqual(title.status, 401);
  });
  await t("every response carries the browser security headers", async () => {
    const r = await fetch(BASE + "/ping");
    const csp = r.headers.get("content-security-policy") || "";
    assert(/script-src 'self' https:\/\/cdn\.jsdelivr\.net(;|$)/.test(csp), csp);
    assert(!/script-src[^;]*unsafe-inline/.test(csp));
    assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff");
    assert.strictEqual(r.headers.get("x-frame-options"), "SAMEORIGIN");
    assert(r.headers.get("referrer-policy"));
    const page = await fetch(BASE + "/");
    assert((page.headers.get("content-security-policy") || "").includes("object-src 'none'"), "the page itself is covered too");
  });
  await t("the code-preview page is served with its own sandboxed policy, and the OAuth page has no inline script", async () => {
    const pv = await fetch(BASE + "/preview-frame.html");
    assert.strictEqual(pv.status, 200);
    const csp = pv.headers.get("content-security-policy");
    assert(/sandbox allow-scripts/.test(csp) && !/allow-same-origin/.test(csp), csp);
    assert((await fetch(BASE + "/js/preview-frame.js")).status === 200);
    const cb = await (await fetch(BASE + "/auth/callback")).text();
    assert(/<script src="\/js\/oauth-callback\.js"><\/script>/.test(cb));
    assert(!/localStorage|<script>/.test(cb), "no inline script");
    assert((await fetch(BASE + "/js/oauth-callback.js")).status === 200);
  });
  await t("CORS: other websites can't read answers; this site and localhost can", async () => {
    const evil = await send("GET", "/ping", { headers: { Origin: "https://evil.example" } });
    assert.strictEqual(evil.headers.get("access-control-allow-origin"), null);
    const home = await send("GET", "/ping", { headers: { Origin: `http://127.0.0.1:${APP_PORT}` } });
    assert.strictEqual(home.headers.get("access-control-allow-origin"), `http://127.0.0.1:${APP_PORT}`);
    const dev = await send("GET", "/ping", { headers: { Origin: "http://localhost:5173" } });
    assert.strictEqual(dev.headers.get("access-control-allow-origin"), "http://localhost:5173");
  });
  await t("sign-in forms can't be sent megabytes of data", async () => {
    const r = await send("POST", "/auth/login", { body: { email: "a@b.c", password: "x".repeat(200000) } });
    assert.strictEqual(r.status, 413);
    assert.strictEqual((await r.json()).error, "That request is too large. Try something smaller.");
  });
  await t("wrong passwords: friendly message, then a lockout for that account only (production limits)", async () => {
    // a second copy of the server with the real limits (the main one runs with them relaxed so the tests above can hammer it)
    const PORT2 = APP_PORT + 10;
    const strict = spawn("node", ["server.js"], {
      cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RATE_LIMIT_SCALE: "1", PORT: PORT2, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "service", GROQ_API_KEY: "k", GROQ_API_URL: `http://127.0.0.1:${GROQ_PORT}/v1/chat/completions`, SITE_URL: `http://127.0.0.1:${PORT2}`, TAVILY_API_KEY: "", BRAVE_API_KEY: "" },
    });
    try {
      for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT2}/ping`)).ok) break; } catch (_) {} await sleep(100); }
      const login = email => fetch(`http://127.0.0.1:${PORT2}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "wrong" }) });
      const first = await login("victim@example.com");
      assert.strictEqual(first.status, 400);
      assert.strictEqual((await first.json()).error, "That email or password isn't right. Please try again.");
      for (let i = 1; i < 8; i++) assert.strictEqual((await login("victim@example.com")).status, 400, "attempt " + (i + 1));
      const locked = await login("Victim@Example.com"); // upper/lower case can't be used to dodge the limit
      assert.strictEqual(locked.status, 429);
      assert(/Too many sign-in attempts for that account\. Please try again in \d+ minutes?\./.test((await locked.json()).error));
      assert(Number(locked.headers.get("retry-after")) > 0);
      assert.strictEqual((await login("someone-else@example.com")).status, 400, "a different account is not locked");
    } finally { strict.kill(); }
  });

  server.kill();
  groqServer.close(); sbServer.close();
  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
  if (process.exitCode) console.log("--- server log ---\n" + serverLog.slice(-1500));
  process.exit(process.exitCode || 0);
})();
