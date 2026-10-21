// Loads the real browser scripts (stream.js, personal.js, tables.js) into jsdom, sharing one global scope like
// the page does, and checks them.   needs:  npm i -D jsdom     run:  node test/client.test.js
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<!doctype html><body><div id="chat"></div><textarea id="input"></textarea></body>', { pretendToBeVisual: true, runScripts: "outside-only" });
const w = dom.window;
w.TextDecoder = TextDecoder; w.Blob = Blob;
const ctx = dom.getInternalVMContext();
const run = code => new vm.Script(code).runInContext(ctx);
const load = f => run(fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8"));

// the globals config.js / render.js / utils.js provide on the real page
run(`let history = []; let userToken = "tok"; const BACKEND_URL = "http://x"; let __toasts = []; function showToast(m){ __toasts.push(m); }
     window.__msgs = []; window.addMsg = function(role, text, img, idx){ const wrap = document.createElement("div"); wrap.innerHTML = '<button class="retry-btn"></button>'; window.__msgs.push({ role, text, idx, wrap }); return wrap; };
     window.__calls = [];`);
load("stream.js"); load("personal.js"); load("tables.js"); load("sendstate.js");

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; } }

// a fake fetch Response that delivers SSE text in awkward chunks (splitting events mid-line)
function sseResponse(text, chunkSize) {
  const bytes = new TextEncoder().encode(text); let pos = 0;
  const reader = { read: async () => pos >= bytes.length ? { done: true } : (pos += chunkSize, { done: false, value: bytes.slice(pos - chunkSize, Math.min(pos, bytes.length)) }) };
  return { headers: { get: () => "text/event-stream" }, body: { getReader: () => reader } };
}
const ev = o => `data: ${JSON.stringify(o)}\n\n`;

(async () => {
  console.log("stream.js");
  await t("reads deltas/status/meta/final even when events are split across network chunks", async () => {
    const wrap = w.document.createElement("div"); w.document.body.appendChild(wrap);
    const labels = []; const thinking = { wrap, setLabel: s => labels.push(s) };
    const draft = w.agent1102Stream.createDraft(thinking);
    const stream = ev({ type: "status", text: "Searching the web..." }) + ev({ type: "delta", text: "Hel" }) + ev({ type: "delta", text: "lo ✓ wörld" }) + ev({ type: "meta", style: ["shorter answers"] }) + ev({ type: "final", reply: "Hello ✓ wörld", meta: { checked: 2 } });
    const out = await w.agent1102Stream.readReply(sseResponse(stream, 7), draft);
    assert.strictEqual(out.reply, "Hello ✓ wörld"); assert.strictEqual(JSON.stringify(out.meta.style), '["shorter answers"]'); assert.strictEqual(out.meta.checked, 2);
    assert(labels.includes("Searching the web...") && labels.includes("Writing..."));
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(wrap.querySelector(".stream-draft").textContent, "Hello ✓ wörld");
  });
  await t("a stream-time error is returned as an error, not a reply", async () => {
    const out = await w.agent1102Stream.readReply(sseResponse(ev({ type: "delta", text: "par" }) + ev({ type: "error", error: "Token limit reached... Try again in 1 minute." }), 50), null);
    assert(!out.reply && /Token limit/.test(out.error));
  });
  await t("a dropped connection (no final event) says so instead of showing a half answer", async () => {
    const out = await w.agent1102Stream.readReply(sseResponse(ev({ type: "delta", text: "par" }), 50), null);
    assert(!out.reply && /connection dropped/.test(out.error));
  });
  await t("plain-JSON servers/errors still work", async () => {
    const mk = (obj) => ({ headers: { get: () => "application/json" }, json: async () => obj });
    assert.strictEqual((await w.agent1102Stream.readReply(mk({ reply: "hi" }), null)).reply, "hi");
    assert.strictEqual((await w.agent1102Stream.readReply(mk({ error: "nope" }), null)).error, "nope");
  });
  await t("chart/drawing JSON is hidden in the live preview, normal code is shown", () => {
    const p = w.agent1102Stream.previewText;
    assert.strictEqual(p('Here:\n```chart\n{"type":"bar","labels":["a"'), "Here:\n[drawing the chart...]");
    assert(!p("```mathviz\n{...}\n```").includes("{")); assert(p("```python\nprint(1)\n```").includes("print(1)"));
  });
  await t("auth header only when signed in", () => {
    assert.strictEqual(w.agent1102Stream.headers("T").Authorization, "Bearer T"); assert(!("Authorization" in w.agent1102Stream.headers(null)));
  });

  console.log("personal.js");
  let memories = [{ id: "a1", content: "Is studying nursing at KU", source: "auto" }, { id: "b2", content: "Prefers metric units", source: "user" }];
  const calls = [];
  w.fetch = async (url, opts = {}) => {
    const p = url.replace("http://x", ""); calls.push({ method: opts.method || "GET", p, body: opts.body && JSON.parse(opts.body), auth: opts.headers && opts.headers.Authorization });
    const ok = d => ({ ok: true, json: async () => d });
    if (p === "/memory" && (!opts.method || opts.method === "GET")) return ok({ enabled: true, memories });
    if (p === "/memory" && opts.method === "POST") return ok({ success: true });
    if (p.startsWith("/memory/") && opts.method === "DELETE") { memories = memories.filter(m => m.id !== p.slice(8)); return ok({ success: true }); }
    if (p === "/prefs") return ok({ rows: [["Answer length", "concise"], ["Memory", "on"]], notes: opts.body ? ["shorter answers"] : [] });
    return { ok: false, json: async () => ({ error: "Something went wrong" }) };
  };
  const last = () => w.__msgs[w.__msgs.length - 1];
  await t("match() recognises only the personal commands", () => {
    for (const s of ["/memory", "/remember I like jazz", "/forget 2", "/style concise"]) assert(w.agent1102Personal.match(s), s);
    for (const s of ["/quiz 5", "memory", "tell me about /memory", "/memorize"]) assert(!w.agent1102Personal.match(s), s);
  });
  await t("/memory lists numbered memories with a bearer token, and is NOT added to history", async () => {
    await w.agent1102Personal.run("/memory");
    assert(/1\. Is studying nursing at KU/.test(last().text) && /2\. Prefers metric units \*\(you told me\)\*/.test(last().text));
    assert.strictEqual(calls[calls.length - 1].auth, "Bearer tok"); assert.strictEqual(run("history.length"), 0);
    assert.strictEqual(last().wrap.querySelector(".retry-btn"), null, "retry button should be removed");
  });
  await t("/forget 1 deletes the first memory by id; bad numbers and text are handled", async () => {
    await w.agent1102Personal.run("/forget 1"); assert(/Forgot: "Is studying nursing at KU"/.test(last().text)); assert.strictEqual(memories.length, 1);
    await w.agent1102Personal.run("/forget 9"); assert(/no memory number 9/.test(last().text));
    await w.agent1102Personal.run("/forget zebra"); assert(/couldn't find/.test(last().text));
    await w.agent1102Personal.run("/forget metric"); assert(/Forgot/.test(last().text)); assert.strictEqual(memories.length, 0);
    await w.agent1102Personal.run("/forget 1"); assert(/nothing to forget/.test(last().text));
  });
  await t("/forget all asks for confirmation first", async () => {
    memories = [{ id: "z", content: "x", source: "auto" }];
    w.confirm = () => false; await w.agent1102Personal.run("/forget all"); assert(/kept everything/.test(last().text)); assert.strictEqual(memories.length, 1);
    w.confirm = () => true; calls.length = 0; await w.agent1102Personal.run("/forget all"); assert(calls.some(c => c.method === "DELETE" && c.p === "/memory"));
  });
  await t("/remember, /memory off, /style send the right requests", async () => {
    calls.length = 0;
    await w.agent1102Personal.run("/remember I prefer metric units"); assert.strictEqual(JSON.stringify(calls[0].body), '{"content":"I prefer metric units"}');
    await w.agent1102Personal.run("/memory off"); assert.strictEqual(JSON.stringify(calls[1].body), '{"updates":{"memory":false}}');
    await w.agent1102Personal.run("/style concise"); assert.strictEqual(JSON.stringify(calls[2].body), '{"command":"concise"}'); assert(/shorter answers/.test(last().text) && /\| Answer length \| concise \|/.test(last().text));
  });
  await t("signed-out users are told to sign in, and server errors are shown, not thrown", async () => {
    run("userToken = null"); await w.agent1102Personal.run("/memory"); assert(/sign in/i.test(last().text));
    run('userToken = "tok"'); w.fetch = async () => ({ ok: false, json: async () => ({ error: "Memory isn't set up yet." }) });
    await w.agent1102Personal.run("/memory"); assert(/isn't set up/.test(last().text));
  });

  console.log("tables.js");
  await t("CSV: quoting, accents, and spreadsheet-formula defusing (negatives stay numbers)", () => {
    const d = w.document.createElement("div");
    d.innerHTML = '<table><tr><th>Name</th><th>Note</th></tr><tr><td>Zoë, Jr.</td><td>said "hi"</td></tr><tr><td>=SUM(A1)</td><td>-5</td></tr><tr><td>@cmd</td><td>-abc</td></tr></table>';
    assert.strictEqual(w.agent1102Tables.tableToCsv(d.firstChild), 'Name,Note\r\n"Zoë, Jr.","said ""hi"""\r\n\'=SUM(A1),-5\r\n\'@cmd,\'-abc');
  });
  await t("buttons are added once under tables in AI messages, and not for 1-row tables", async () => {
    const chat = w.document.getElementById("chat");
    chat.innerHTML = '<div class="msg-content-body"><div class="table-wrap"><table><tr><td>a</td></tr><tr><td>b</td></tr></table></div><div class="table-wrap"><table><tr><td>only</td></tr></table></div></div>';
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(chat.querySelectorAll(".msg-action-btn").length, 2);
    await new Promise(r => setTimeout(r, 50)); assert.strictEqual(chat.querySelectorAll(".msg-action-btn").length, 2, "must not duplicate");
  });

  console.log("sendstate.js");
  await t("canSend: text alone, or an attachment alone, can be sent; blank text with nothing attached cannot", async () => {
    const { canSend } = w.agent1102SendState;
    assert.strictEqual(canSend("hello", 0), true);
    assert.strictEqual(canSend("", 1), true, "a photo/file with nothing typed must send");
    assert.strictEqual(canSend("   \n\t", 2), true, "attachment + blank text must send");
    assert.strictEqual(canSend("", 0), false);
    assert.strictEqual(canSend("   \u200b\u00a0\n", 0), false, "spaces / zero-width characters alone are not a message");
    assert.strictEqual(canSend(undefined, 0), false);
  });
  await t("the Send button lights up when a file is attached with an empty box, and dims when it's removed", async () => {
    const d2 = new JSDOM('<!doctype html><body><textarea id="input"></textarea><button id="send"></button><div id="attach-list"></div></body>', { pretendToBeVisual: true, runScripts: "outside-only" });
    new vm.Script(fs.readFileSync(path.join(__dirname, "..", "public", "js", "sendstate.js"), "utf8")).runInContext(d2.getInternalVMContext());
    d2.window.document.dispatchEvent(new d2.window.Event("DOMContentLoaded"));
    const send = d2.window.document.getElementById("send"), list = d2.window.document.getElementById("attach-list");
    assert(!send.classList.contains("send-ready"), "starts dim");
    list.appendChild(d2.window.document.createElement("div"));
    await new Promise(r => setTimeout(r, 20));
    assert(send.classList.contains("send-ready"), "attachment only should light the button");
    list.innerHTML = "";
    await new Promise(r => setTimeout(r, 20));
    assert(!send.classList.contains("send-ready"), "dims again when the attachment is removed");
  });

  console.log(`\n${passed} passed`);
})();
