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
    if (url.pathname === "/auth/v1/user") return bearer === TOKEN ? json(200, USER) : json(401, { message: "bad jwt" });
    if (url.pathname.startsWith("/auth/v1/admin/users/") && req.method === "PUT") { const b = JSON.parse(raw); adminUpdates.push(b); USER.user_metadata = b.user_metadata || USER.user_metadata; return json(200, USER); }
    if (url.pathname === "/auth/v1/admin/users") return json(200, { users: [] });
    if (url.pathname === "/storage/v1/bucket") return json(200, {});
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
    env: { ...process.env, PORT: APP_PORT, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "service", GROQ_API_KEY: "k", GROQ_API_URL: `http://127.0.0.1:${GROQ_PORT}/v1/chat/completions`, SITE_URL: `http://127.0.0.1:${APP_PORT}`, TAVILY_API_KEY: "", BRAVE_API_KEY: "", MEMORY_EXTRACT_GAP_MS: "400" },
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

  server.kill();
  groqServer.close(); sbServer.close();
  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
  if (process.exitCode) console.log("--- server log ---\n" + serverLog.slice(-1500));
  process.exit(process.exitCode || 0);
})();
