// Loads the real browser scripts (stream.js, tables.js, copy.js, render.js) into jsdom, sharing one global scope like
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
load("stream.js"); load("tables.js"); load("sendstate.js");

let passed = 0;

// A fresh page with the real markdown libraries (the same pinned versions index.html loads from the CDN) and the real
// render.js / copy.js / stream.js / tables.js, for the copy and live-preview tests. `clipboard` records what was copied.
function makePage() {
  const d = new JSDOM('<!doctype html><body><div id="chat"></div><textarea id="input"></textarea></body>', { pretendToBeVisual: true, runScripts: "outside-only" });
  const w = d.window, c = d.getInternalVMContext(), go = code => new vm.Script(code).runInContext(c);
  const nm = (...p) => fs.readFileSync(path.join(__dirname, "..", "node_modules", ...p), "utf8");
  const pub = f => fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8");
  go(nm("marked", "marked.min.js")); go(nm("dompurify", "dist", "purify.min.js"));
  go("let __toasts = []; function showToast(m){ __toasts.push(m); }");
  ["render.js", "copy.js", "stream.js", "tables.js"].forEach(f => go(pub(f)));
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  const clipboard = { writes: [], texts: [], fail: false };
  w.ClipboardItem = class { constructor(items) { this.items = items; } };
  Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: {
    write: async items => { if (clipboard.fail) throw new Error("blocked"); clipboard.writes.push(items[0].items); },
    writeText: async t => { clipboard.texts.push(t); },
  } });
  const html = async i => clipboard.writes[i]["text/html"].text(), text = async i => clipboard.writes[i]["text/plain"].text();
  return { w, go, clipboard, html, text };
}
const SAMPLE = [
  "## Results", "",
  "A **quick comparison** of *three* options with `inline code` and a [link](https://example.com/a):", "",
  "| Name | Price | Note |", "|---|---|---|", "| **Alpha** | $5 | Uses \\(x^2 + y^2 = z^2\\) |", "| Beta | $7 | café & crème — 100% |", "",
  "1. First step", "2. Second step", "   - nested **bold**", "   - nested two", "",
  "> A quote", "", "```js", "const a = 1 * 2;", "```", "",
  "The formula is $$\\frac{a+b}{2} \\leq \\sqrt{x}$$ and that is it. Escaped \\*stars\\* and snake\\_case.",
].join("\n");

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

  console.log("session.js (stay signed in)");
  // a fresh browser-like page: seed(localStorage, sessionStorage) runs BEFORE session.js, like data left from earlier visits
  const sessionPage = (seedLocal, seedTab) => {
    const d = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
    for (const [k, v] of Object.entries(seedLocal || {})) d.window.localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(seedTab || {})) d.window.sessionStorage.setItem(k, v);
    new vm.Script(fs.readFileSync(path.join(__dirname, "..", "public", "js", "session.js"), "utf8")).runInContext(d.getInternalVMContext());
    return d.window;
  };
  const LOGIN = { agent1102_token: "a", agent1102_refresh_token: "r" };
  const minutesAgo = m => String(Date.now() - m * 60 * 1000);
  await t("a login saved before this feature existed (no preference stored) is kept", async () => {
    const win = sessionPage({ ...LOGIN, agent1102_last_seen: minutesAgo(600) });
    assert.strictEqual(win.localStorage.getItem("agent1102_token"), "a");
    assert.strictEqual(win.agent1102Session.stay(), true);
    win.close();
  });
  await t("'Stay signed in' ticked: the login is kept even after a long gap", async () => {
    const win = sessionPage({ ...LOGIN, agent1102_stay_signed_in: "1", agent1102_last_seen: minutesAgo(600) });
    assert.strictEqual(win.localStorage.getItem("agent1102_token"), "a");
    assert.strictEqual(win.localStorage.getItem("agent1102_refresh_token"), "r");
    win.close();
  });
  await t("unticked + browser was closed (new tab, nothing seen for a while): the login is removed", async () => {
    const win = sessionPage({ ...LOGIN, agent1102_stay_signed_in: "0", agent1102_last_seen: minutesAgo(10) });
    assert.strictEqual(win.localStorage.getItem("agent1102_token"), null);
    assert.strictEqual(win.localStorage.getItem("agent1102_refresh_token"), null);
    win.close();
  });
  await t("unticked + another tab is open (seen seconds ago): a new tab stays signed in", async () => {
    const win = sessionPage({ ...LOGIN, agent1102_stay_signed_in: "0", agent1102_last_seen: String(Date.now() - 10000) });
    assert.strictEqual(win.localStorage.getItem("agent1102_token"), "a");
    win.close();
  });
  await t("unticked + same tab reloaded after a long sleep: stays signed in", async () => {
    const win = sessionPage({ ...LOGIN, agent1102_stay_signed_in: "0", agent1102_last_seen: minutesAgo(120) }, { agent1102_tab_alive: "1" });
    assert.strictEqual(win.localStorage.getItem("agent1102_token"), "a");
    win.close();
  });
  await t("begin() stores the choice, end() removes the saved login", async () => {
    const win = sessionPage({ ...LOGIN });
    win.agent1102Session.begin(false);
    assert.strictEqual(win.agent1102Session.stay(), false);
    assert(Number(win.localStorage.getItem("agent1102_last_seen")) > Date.now() - 5000, "records when it was last seen");
    win.agent1102Session.begin(true);
    assert.strictEqual(win.agent1102Session.stay(), true);
    win.agent1102Session.end();
    assert.strictEqual(win.localStorage.getItem("agent1102_token"), null);
    assert.strictEqual(win.localStorage.getItem("agent1102_refresh_token"), null);
    win.close();
  });
  await t("blocked storage never throws (private mode / strict settings)", async () => {
    const d = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", runScripts: "outside-only" });
    Object.defineProperty(d.window, "localStorage", { get() { throw new Error("blocked"); } });
    Object.defineProperty(d.window, "sessionStorage", { get() { throw new Error("blocked"); } });
    new vm.Script(fs.readFileSync(path.join(__dirname, "..", "public", "js", "session.js"), "utf8")).runInContext(d.getInternalVMContext());
    assert.strictEqual(d.window.agent1102Session.stay(), true);
    d.window.agent1102Session.begin(false); d.window.agent1102Session.end();
    d.window.close();
  });

  console.log("preview-frame.js / oauth-callback.js");
  const publicJs = f => fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8");
  await t("code preview: asks the page for the code, then draws exactly what it is sent, and only from its parent", async () => {
    const parent = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/", runScripts: "outside-only" });
    const child = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/preview-frame.html", runScripts: "outside-only" });
    const asked = [];
    parent.window.addEventListener("message", e => asked.push(e.data));
    Object.defineProperty(child.window, "parent", { value: parent.window });
    new vm.Script(publicJs("preview-frame.js")).runInContext(child.getInternalVMContext());
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(JSON.stringify(asked), '[{"type":"preview-ready"}]', "tells the page it is ready");
    // a message from anywhere else (here: the frame itself) is ignored
    child.window.dispatchEvent(new child.window.MessageEvent("message", { data: { html: "<h1>nope</h1>" }, source: child.window }));
    assert(!/nope/.test(child.window.document.body.innerHTML), "ignores other senders");
    child.window.dispatchEvent(new child.window.MessageEvent("message", { data: { html: "<h1 id=hello>Hello preview</h1>" }, source: parent.window }));
    assert.strictEqual(child.window.document.getElementById("hello").textContent, "Hello preview");
    parent.window.close(); child.window.close();
  });
  await t("code preview: opened on its own (not inside the chat) it does nothing", async () => {
    const solo = new JSDOM("<!doctype html><body>empty</body>", { url: "http://localhost/preview-frame.html", runScripts: "outside-only" });
    new vm.Script(publicJs("preview-frame.js")).runInContext(solo.getInternalVMContext());
    solo.window.dispatchEvent(new solo.window.MessageEvent("message", { data: { html: "<b>x</b>" }, source: solo.window }));
    assert.strictEqual(solo.window.document.body.textContent, "empty");
    solo.window.close();
  });
  const oauthPage = (hash) => {
    const d = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/auth/callback" + hash, runScripts: "outside-only" });
    // jsdom can't navigate, so record where the script tried to go
    let went = null;
    d.window.eval("window.__nav = []"); 
    // (the page leaves with location.replace(...), not href=, so the address that holds the tokens isn't kept in the back button's history)
    const code = publicJs("oauth-callback.js").replace(/window\.location\.replace\(([^)]+)\)/g, "window.__nav.push($1)");
    new vm.Script(code).runInContext(d.getInternalVMContext());
    went = JSON.stringify(Array.from(d.window.__nav));
    return { storage: d.window.localStorage, went };
  };
  await t("OAuth return page: saves both tokens and goes back to the app", async () => {
    const r = oauthPage("#access_token=AAA&refresh_token=RRR&token_type=bearer");
    assert.strictEqual(r.storage.getItem("agent1102_token"), "AAA");
    assert.strictEqual(r.storage.getItem("agent1102_refresh_token"), "RRR");
    assert.strictEqual(r.went, '["/"]');
  });
  await t("OAuth return page: with no token it goes back with an error flag instead of saving anything", async () => {
    const r = oauthPage("#error=access_denied");
    assert.strictEqual(r.storage.getItem("agent1102_token"), null);
    assert.strictEqual(r.went, '["/?error=oauth_failed"]');
  });

  console.log("copy.js (copying answers and tables)");
  await t("math becomes readable text: powers, fractions, roots, Greek, chemistry, escapes", () => {
    const m = makePage().w.agent1102Copy.mathToText;
    const cases = {
      "x^2 + y^2 = z^2": "x² + y² = z²", "\\frac{a+b}{2}": "(a+b)/2", "\\frac{1}{2}": "1/2", "\\frac{x^2+1}{x-1}": "(x²+1)/(x-1)",
      "\\sqrt{x+1}": "√(x+1)", "\\sqrt{2}": "√2", "\\sqrt[3]{x}": "³√x", "\\alpha \\leq \\beta": "α ≤ β", "a \\times b": "a × b",
      "H_2O": "H₂O", "\\ce{H2O}": "H₂O", "\\ce{Fe^{3+}}": "Fe³⁺", "\\int_0^1 x\\,dx": "∫₀¹ x dx", "\\sum_{i=1}^{n} i": "∑ᵢ₌₁ⁿ i",
      "\\text{speed} = \\frac{d}{t}": "speed = d/t", "x \\text{ if } y": "x if y", "e^{-x^2}": "e^(-x²)", "x_{n+1}": "xₙ₊₁",
      "\\left( x \\right)": "( x )", "50\\% \\& 3\\$": "50% & 3$", "\\mathbb{R}": "ℝ", "\\sin x + \\cos(\\theta)": "sin x + cos(θ)",
      "\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}": "[a, b; c, d]",
    };
    for (const [tex, want] of Object.entries(cases)) assert.strictEqual(m(tex), want, tex);
  });
  await t("copied answer: plain text has no markdown symbols; tables are tab-separated; math is readable", () => {
    const { text } = makePage().w.agent1102Copy.responseClipboard(SAMPLE);
    assert.strictEqual(text, [
      "Results", "",
      "A quick comparison of three options with inline code and a link (https://example.com/a):", "",
      "Name\tPrice\tNote", "Alpha\t$5\tUses x² + y² = z²", "Beta\t$7\tcafé & crème — 100%", "",
      "1. First step", "2. Second step", "   ◦ nested bold", "   ◦ nested two", "",
      "> A quote", "", "const a = 1 * 2;", "",
      "The formula is (a+b)/2 ≤ √x and that is it. Escaped *stars* and snake_case.",
    ].join("\n"));
    assert(!/\*\*|\|---|\\\(|^#|`/m.test(text.replace("Escaped *stars*", "")), "no ** | # ` or \\( left over");
  });
  await t("copied answer: rich version is real HTML (table with borders, bold, link, list) and has no markdown symbols", () => {
    const { html } = makePage().w.agent1102Copy.responseClipboard(SAMPLE);
    assert(/<table[^>]*border="1"/.test(html) && /<th[^>]*border: 1px solid/.test(html) && /<td[^>]*>café &amp; crème — 100%<\/td>/.test(html));
    assert(/<strong>quick comparison<\/strong>/.test(html) && /<a href="https:\/\/example.com\/a">link<\/a>/.test(html) && /<ol>/.test(html) && /<ul>/.test(html));
    assert(/<td[^>]*>Uses x² \+ y² = z²<\/td>/.test(html), "math in a table cell is text, not drawn glyphs");
    assert(!/\*\*quick|\|---/.test(html) && html.startsWith('<meta charset="utf-8">'));
  });
  await t("copied answer: charts become a table, pictures are not loaded into the paste, markup in the text is not executed", () => {
    const { w } = makePage();
    const chart = '```chart\n{"type":"bar","title":"Sales","labels":["Q1","Q2"],"datasets":[{"label":"Units","data":[3,5]}]}\n```';
    const r = w.agent1102Copy.responseClipboard(chart + "\n\n![cat](https://evil.example/x.png) <img src=x onerror=alert(1)> <script>alert(1)</script>ok");
    assert(/Sales/.test(r.text) && /Q1\t3/.test(r.text) && /Q2\t5/.test(r.text), r.text);
    assert(!/<img|<script|onerror/i.test(r.html), r.html);
    assert(/cat \(https:\/\/evil.example\/x.png\)/.test(r.text));
  });
  await t("tables: cell text keeps line breaks as spaces and formulas as text, for Copy table and Copy CSV", () => {
    const { w } = makePage();
    const d = w.document.createElement("div");
    d.innerHTML = '<table><tr><th>A</th><th>B</th></tr><tr><td>line one<br>line two</td><td>area <span class="math-inline" data-tex="\\pi r^2"><span class="katex">πr2</span></span></td></tr><tr><td>say \"hi\"</td><td>tab\there</td></tr></table>';
    const table = d.firstChild;
    assert.strictEqual(w.agent1102Copy.tableTsv(table), 'A\tB\nline one line two\tarea πr²\nsay "hi"\ttab here');
    assert.strictEqual(w.agent1102Tables.tableToCsv(table), 'A,B\r\nline one line two,area πr²\r\n"say ""hi""",tab here');
    const r = w.agent1102Copy.tableClipboard(table);
    assert(/<table[^>]*border="1"/.test(r.html) && !/katex|data-tex|class=/.test(r.html) && /area πr²/.test(r.html));
    assert.strictEqual(r.text.split("\n")[1], "line one line two\tarea πr²");
  });
  await t("write(): puts rich + plain text on the clipboard together, and falls back to plain text when blocked", async () => {
    const { w, clipboard, text, html } = makePage();
    assert.strictEqual(await w.agent1102Copy.write("<b>hi</b>", "hi"), true);
    assert.strictEqual(await html(0), "<b>hi</b>"); assert.strictEqual(await text(0), "hi");
    clipboard.fail = true;
    assert.strictEqual(await w.agent1102Copy.write("<b>yo</b>", "yo"), true);
    assert.strictEqual(clipboard.texts[0], "yo", "plain text still lands when the rich copy is refused");
  });
  await t("the Copy response button copies the clean version, not the markdown", async () => {
    const { w, clipboard, text, html } = makePage();
    w.addMsg("ai", SAMPLE);
    const btn = [...w.document.querySelectorAll(".msg-action-btn")].find(b => b.title === "Copy response");
    btn.click();
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(clipboard.writes.length, 1);
    const plain = await text(0);
    assert(/Name\tPrice\tNote/.test(plain) && !/\*\*|\|---/.test(plain.replace("*stars*", "")), plain);
    assert(/<table/.test(await html(0)));
  });
  await t("tables in a finished answer get Copy table (real table), Copy CSV and Download CSV", async () => {
    const { w, clipboard, html, text } = makePage();
    w.addMsg("ai", "| Name | Note |\n|---|---|\n| **Zoë** | \\(x^2\\) |\n| Bo | ok |");
    await new Promise(r => setTimeout(r, 50));
    const labels = [...w.document.querySelectorAll(".msg-action-btn span")].map(s => s.textContent).filter(Boolean);
    assert.strictEqual(JSON.stringify(labels), '["Copy table","Copy CSV","Download CSV"]');
    [...w.document.querySelectorAll(".msg-action-btn")].find(b => /Copy table/.test(b.textContent)).click();
    await new Promise(r => setTimeout(r, 30));
    assert(/<table[^>]*border="1"/.test(await html(0)));
    assert.strictEqual(await text(0), "Name\tNote\nZoë\tx²\nBo\tok");
  });
  await t("selecting formulas and pressing Ctrl+C copies readable math instead of the drawn glyphs", () => {
    const { w } = makePage();
    const body = w.document.createElement("div"); body.className = "ai-text msg-content-body";
    body.innerHTML = '<p>Area is <span class="math-inline" data-tex="\\pi r^2"><span class="katex">πr2</span></span> exactly</p>';
    w.document.body.appendChild(body);
    w.getSelection().selectAllChildren(body);
    const set = {}; const ev = new w.Event("copy", { cancelable: true, bubbles: true });
    ev.clipboardData = { setData: (k, v) => { set[k] = v; } };
    w.document.dispatchEvent(ev);
    assert.strictEqual(set["text/plain"], "Area is πr² exactly");
    assert(ev.defaultPrevented && /πr²/.test(set["text/html"]) && !/katex/.test(set["text/html"]));
    // a selection with no formulas is left to the browser
    body.innerHTML = "<p>plain words</p>"; w.getSelection().selectAllChildren(body);
    const ev2 = new w.Event("copy", { cancelable: true, bubbles: true }); ev2.clipboardData = { setData() {} };
    w.document.dispatchEvent(ev2);
    assert(!ev2.defaultPrevented);
  });

  console.log("live preview while the answer is written");
  await t("the draft shows bold, lists, tables and math as they arrive, not ** and | marks", async () => {
    const { w } = makePage();
    const wrap = w.document.createElement("div"); w.document.body.appendChild(wrap);
    const draft = w.agent1102Stream.createDraft({ wrap, setLabel() {} });
    ["Here is **bol", "d** text\n\n| Name | Age |\n|---|---|\n| Bo", "b | 3 |\n\n- one\n- two"].forEach(p => draft.add(p));
    await new Promise(r => setTimeout(r, 250));
    const box = wrap.querySelector(".stream-draft");
    assert(box.querySelector("strong") && box.querySelector("table td") && box.querySelectorAll("li").length === 2, box.innerHTML);
    assert(!/\*\*|\|---/.test(box.textContent), box.textContent);
    assert.strictEqual(box.querySelector("td").textContent, "Bob");
    assert(box.querySelector(".table-wrap table"), "scrolls sideways like the finished message");
    assert.strictEqual(box.style.whiteSpace, "", "formatted text must not be shown pre-wrapped");
    assert.strictEqual(w.document.querySelectorAll(".msg-action-btn").length, 0, "no CSV buttons are added to a table that is still being written");
  });
  await t("the draft is repainted at a limited rate, not once per piece of text", async () => {
    const { w } = makePage();
    const wrap = w.document.createElement("div"); w.document.body.appendChild(wrap);
    let paints = 0; const orig = w.agent1102Render.renderDraft;
    w.agent1102Render.renderDraft = (...a) => { paints++; return orig(...a); };
    const draft = w.agent1102Stream.createDraft({ wrap, setLabel() {} });
    for (let i = 0; i < 40; i++) { draft.add("word" + i + " "); await new Promise(r => setTimeout(r, 5)); }
    await new Promise(r => setTimeout(r, 200));
    assert(paints >= 2 && paints <= 8, "painted " + paints + " times");
    assert(/word39/.test(wrap.querySelector(".stream-draft").textContent), "the last words still arrive");
  });
  await t("half-written endings are tidied: open **, open code block, table header still waiting for its |---| line", () => {
    const tidy = makePage().w.agent1102Render.tidyDraft;
    assert.strictEqual(tidy("a **bol"), "a **bol**");
    assert.strictEqual(tidy("a **"), "a ");
    assert.strictEqual(tidy("a `co"), "a `co`");
    assert.strictEqual(tidy("x\n```py\nprint(1) ** 2"), "x\n```py\nprint(1) ** 2\n```");
    assert.strictEqual(tidy("Intro\n\n| Name | Age |"), "Intro\n");
    assert.strictEqual(tidy("Intro\n\n| Name | Age |\n|---"), "Intro\n");
    assert.strictEqual(tidy("| Name | Age |\n|---|---|\n| Bo"), "| Name | Age |\n|---|---|\n| Bo", "a table that has started is shown");
    assert.strictEqual(tidy("| Name |\n|---|"), "| Name |\n|---|", "a one-column table is not held back");
    assert.strictEqual(tidy("a **b** c"), "a **b** c");
  });
  await t("the draft never loads pictures, and charts/drawings still show as a short label", async () => {
    const { w } = makePage();
    const wrap = w.document.createElement("div"); w.document.body.appendChild(wrap);
    const draft = w.agent1102Stream.createDraft({ wrap, setLabel() {} });
    draft.add('![cat](https://evil.example/x.png) hi\n\n```chart\n{"type":"bar"');
    await new Promise(r => setTimeout(r, 80));
    const box = wrap.querySelector(".stream-draft");
    assert(!box.querySelector("img") && /cat hi/.test(box.textContent) && /\[drawing the chart\.\.\.\]/.test(box.textContent) && !/\{"type"/.test(box.textContent));
  });

  console.log(`\n${passed} passed`);
})();
