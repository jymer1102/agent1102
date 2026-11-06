// Drives the REAL page (index.html + every script, see test/app-harness.js) in jsdom: easter-egg toasts, the background
// flag, /photos, the .zip download, and the theme colours in style.css.   run:  node test/app.test.js
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert"), { spawnSync } = require("child_process");
const { bootApp } = require("./app-harness");

let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e && e.message)); process.exitCode = 1; } }
// every test gets a fresh page and always closes it (the page's timers would keep Node running)
async function withApp(opts, fn) { const app = await bootApp(opts); try { await fn(app); assert.deepStrictEqual(app.errors.map(e => String(e && e.message || e)), [], "the page reported script errors"); } finally { app.close(); } }

const plain = x => JSON.parse(JSON.stringify(x)); // values made inside the page come from another JS realm; compare them as plain data
const CSS = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");

// ---- a tiny CSS reader: [{ selectors: [...], decl: { prop: value } }] (top-level and @media rules alike) ----
function cssRules(css) {
  const rules = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of flat.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
    const decl = {};
    m[2].split(";").forEach(d => { const i = d.indexOf(":"); if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s*!important$/, ""); });
    rules.push({ selectors: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean), decl });
  }
  return rules;
}
const RULES = cssRules(CSS);
const rulesFor = sel => RULES.filter(r => r.selectors.includes(sel));
const lum = hex => { const n = parseInt(hex.replace("#", "").padEnd(6, hex.length === 4 ? hex.slice(1).replace(/(.)/g, "$1$1") : "0").slice(0, 6), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// ---- an independent .zip reader (its own CRC, written differently from zip.js) so a bug in one can't hide in both ----
function slowCrc(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
function readZip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(eocd >= 0, "no end-of-zip record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, "bad directory entry");
    const flag = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    assert.strictEqual(buf.readUInt32LE(at), 0x04034b50, "bad file header for " + name);
    assert(flag & 0x800, "name not marked UTF-8: " + name);
    const data = buf.subarray(at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28) + csize);
    assert.strictEqual(method, 0); assert.strictEqual(csize, usize);
    assert.strictEqual(slowCrc(data), crc, "checksum mismatch for " + name);
    files[name] = data.toString("utf8");
    p += 46 + nlen + elen + clen;
  }
  return files;
}
const blobBytes = (w, blob) => new Promise((res, rej) => { const fr = new w.FileReader(); fr.onload = () => res(Buffer.from(fr.result)); fr.onerror = rej; fr.readAsArrayBuffer(blob); });

const IMAGES = q => ({ status: 200, json: { query: q, provider: "Wikimedia Commons", images: [
  { title: "Golden Gate", thumb: "https://upload.wikimedia.org/thumb/a.jpg", url: "https://upload.wikimedia.org/a.jpg", page: "https://commons.wikimedia.org/wiki/File:A.jpg", source: "commons.wikimedia.org" },
  { title: "Insecure", thumb: "http://insecure.example/b.jpg", url: "", page: "", source: "insecure.example" },
  { title: "Odd page link", thumb: "https://upload.wikimedia.org/thumb/c.jpg", url: "https://upload.wikimedia.org/c.jpg", page: "javascript:alert(1)", source: "example.org" },
] } });

(async () => {
  /* ------------------------------------------------------------ */
  console.log("easter eggs: toasts and the background flag");
  for (const [word, expected] of [["dinosaur", "Dino game unlocked! Click the T-Rex button anytime to play!"], ["t-rex", "Dino game unlocked! Click the T-Rex button anytime to play!"], ["pacman", "Pac-Man game unlocked! Click the Pac-Man button anytime to play!"], ["pac-man", "Pac-Man game unlocked! Click the Pac-Man button anytime to play!"]]) {
    await t(`typing "${word}" shows the plain-text toast (no emoji, no icon)`, () => withApp({}, async app => {
      await app.send(word);
      const toasts = app.toasts();
      assert.deepStrictEqual(toasts, [expected]);
      assert(!/[<>]/.test(toasts[0]) && !/\p{Extended_Pictographic}/u.test(toasts[0]), "no markup, no emoji");
    }));
  }
  await t("the background flag follows the background button, on <html> and <body>", () => withApp({}, async app => {
    const flagged = () => [app.w.document.documentElement, app.w.document.body].map(e => e.classList.contains("bg-on"));
    assert.deepStrictEqual(flagged(), [false, false]);
    const btn = [...app.w.document.querySelectorAll("#header-btns button")].find(b => b.title === "Toggle background");
    btn.click(); await app.sleep(20);
    assert.deepStrictEqual(flagged(), [true, true]); assert.strictEqual(app.$("#bg-layer").style.display, "block");
    btn.click(); await app.sleep(20);
    assert.deepStrictEqual(flagged(), [false, false]); assert.strictEqual(app.$("#bg-layer").style.display, "none");
  }));
  await t("a saved 'background on' is flagged from the first moment the page loads", () => withApp({ storage: { agent1102_easter: "true" } }, async app => {
    assert(app.w.document.body.classList.contains("bg-on") && app.w.document.documentElement.classList.contains("bg-on"));
  }));

  /* ------------------------------------------------------------ */
  console.log("colours in style.css (read from the real stylesheet)");
  await t("text highlight is the app's blue with white text, in every browser engine", () => {
    for (const sel of ["::selection", "::-moz-selection"]) {
      const r = rulesFor(sel)[0];
      assert(r, sel + " has a rule");
      assert.strictEqual(r.decl.background, "var(--accent)"); assert(/^#fff(fff)?$/i.test(r.decl.color));
    }
    const accent = /--accent:\s*(#[0-9a-f]{6})/i.exec(CSS)[1];
    const [r, g, b] = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
    assert(b > r + 60 && b > g + 40, accent + " is a blue");
    assert(contrast("#ffffff", accent) >= 4.5, "white text on the highlight is readable");
  });
  await t("light theme, background OFF: replies use the light theme's dark text", () => {
    const light = rulesFor(".light").find(r => r.decl["--text"]);
    assert(lum(light.decl["--text"]) < 0.05, "dark text: " + light.decl["--text"]);
    // nothing outside the bg-on rules turns reply text white in light mode
    RULES.filter(r => r.selectors.some(s => /^\.light(?!\.bg-on)\b/.test(s) && /\.(ai-text|msg-wrap)/.test(s)))
      .forEach(r => { ["--text", "color"].forEach(p => { if (r.decl[p] && /^#[0-9a-f]{3,6}$/i.test(r.decl[p])) assert(lum(r.decl[p]) < 0.5, r.selectors.join() + " " + p); }); });
  });
  await t("light theme, background ON: replies switch to the dark theme's white text and dark surfaces", () => {
    const on = rulesFor(".light.bg-on .msg-wrap.ai")[0];
    assert(on, "the bg-on rule exists");
    assert(lum(on.decl["--text"]) > 0.85, "white-ish text: " + on.decl["--text"]);
    assert(lum(on.decl["--text-muted"]) > 0.55, "muted text still light");
    assert(lum(on.decl["--surface"]) < 0.05 && lum(on.decl["--surface2"]) < 0.05, "surfaces are dark so white text stays readable on them");
    assert(contrast(on.decl["--text"], on.decl["--surface"]) >= 12);
    // the backdrop itself is near black, which is the whole reason for white text
    const dark = rulesFor(":root")[0].decl;
    assert(lum(dark["--text"]) > 0.7, "the dark theme also uses light text");
  });
  await t("every hard-coded light-theme colour used inside a reply has a matching background-ON override", () => {
    const parts = /\.(ai-text|msg-content-body|chart-block|chart-error-msg|study-block|math-error|mathviz-block|mv-inline|code-block|link-card)\b/;
    const needed = [];
    RULES.forEach(r => r.selectors.forEach(s => { const m = /^\.light (?!\.bg-on)(.+)$/.exec(s); if (m && parts.test(m[1])) needed.push(m[1]); }));
    assert(needed.length >= 8, "found the light rules: " + needed.join(" | "));
    needed.forEach(rest => assert(RULES.some(r => r.selectors.some(s => s === ".light.bg-on " + rest || s === ".light.bg-on .msg-wrap.ai " + rest)), "no bg-on override for: .light " + rest));
  });
  await t("the header, message box and your own bubbles are NOT given the white-text rule (they stay light surfaces)", () => {
    RULES.forEach(r => r.selectors.forEach(s => { if (/\.bg-on/.test(s)) assert(/\.(msg-wrap\.ai|ai-text|msg-content-body|chart-|study-|math-|mathviz|mv-inline|web-image)/.test(s), "bg-on rule reaches outside replies: " + s); }));
  });

  /* ------------------------------------------------------------ */
  console.log("/photos: pictures from the web");
  await t("/photos <words> shows a gallery; nothing is sent to the AI; the request is signed in and carries the search", () => withApp({ routes: { "/web-images": b => IMAGES(b.query) } }, async app => {
    await app.send("/photos golden gate bridge");
    const req = app.calls.find(c => c.path === "/web-images");
    assert.deepStrictEqual(req.body, { query: "golden gate bridge" });
    assert(/^Bearer \S+/.test(req.headers.Authorization));
    assert(!app.calls.some(c => c.path === "/chat"), "this never goes to the AI");
    assert.strictEqual(app.$("#input").value, "");
    assert([...app.w.document.querySelectorAll(".msg-wrap.user .msg-text")].some(n => n.textContent === "/photos golden gate bridge"));
    assert.strictEqual(app.$(".web-gallery-head").textContent, "Pictures from the web for \u201cgolden gate bridge\u201d");
    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 2, "the http:// picture is dropped");
    app.w.document.querySelectorAll(".web-image img").forEach(img => {
      assert(img.src.startsWith("https://")); assert.strictEqual(img.getAttribute("referrerpolicy"), "no-referrer"); assert.strictEqual(img.getAttribute("loading"), "lazy");
    });
    const links = [...app.w.document.querySelectorAll(".web-gallery a")];
    links.forEach(a => { assert.strictEqual(a.target, "_blank"); assert(/noopener/.test(a.rel)); assert(/^https:/.test(a.href), a.href); });
    assert(!app.$(".web-gallery a[href^='javascript']"), "a javascript: link is never created");
    assert(/credit and licence/.test(app.$(".web-gallery-note").textContent) && /Wikimedia Commons/.test(app.$(".web-gallery-note").textContent));
  }));
  await t("the result is saved on the chat, and a follow-up question shows the AI a plain text list (never the gallery data)", () => withApp({
    routes: { "/web-images": b => IMAGES(b.query), "/chat": () => ({ status: 500, json: { error: "not needed" } }) },
  }, async app => {
    await app.send("/photos golden gate bridge");
    const entry = app.peek("history").pop();
    assert.strictEqual(entry.role, "assistant");
    assert(entry.webImages && entry.webImages.query === "golden gate bridge");
    assert(/^Pictures from the web for "golden gate bridge" \(via Wikimedia Commons\):/.test(entry.content));
    assert(entry.content.includes("1. [Golden Gate](https://commons.wikimedia.org/wiki/File:A.jpg) (commons.wikimedia.org)"), entry.content);
    await app.sleep(100);
    const saved = app.calls.filter(c => c.path === "/chats" && c.method === "POST").pop();
    assert(saved && saved.body.history.pop().webImages.images.length === 3, "the chat is saved with its gallery data");
    await app.send("which one is the best?");
    const asked = app.calls.filter(c => c.path === "/chat").pop();
    const seen = asked.body.messages.find(m => m.role === "assistant" && /^Pictures from the web/.test(m.content));
    assert(seen, "the AI can see what was shown");
    assert.deepStrictEqual(Object.keys(seen).sort(), ["content", "role"], "only role + content go to the server");
  }));
  await t("a saved chat reopens with its gallery; without the saved data the same message is just a text list", () => withApp({}, async app => {
    const saved = IMAGES("tower").json;
    const content = app.w.agent1102Render.webImagesText(saved);
    app.w.addHistoryMsg({ role: "assistant", content, webImages: saved }, 1);
    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 2);
    app.w.document.getElementById("chat").innerHTML = "";
    app.w.addHistoryMsg({ role: "assistant", content }, 1);
    assert.strictEqual(app.w.document.querySelectorAll("#chat .web-image, #chat img").length, 0, "no pictures without the data");
    assert(/Golden Gate/.test(app.$(".ai-text").textContent));
  }));
  await t("an AI reply can NOT make the page load a picture: fake galleries and markdown images stay as text/links", () => withApp({}, async app => {
    const sneaky = '```webimages\n{"images":[{"thumb":"https://evil.example/p.png"}]}\n```\n\n![x](https://evil.example/q.png?secret=1)\n\n<img src="https://evil.example/r.png">';
    app.w.addMsg("ai", sneaky);
    assert.strictEqual(app.w.document.querySelectorAll('img[src*="evil.example"]').length, 0);
    assert.strictEqual(app.w.document.querySelectorAll(".web-gallery, .web-image").length, 0);
    // and passing gallery data through the 5th argument does not work for user messages either
    app.w.addMsg("user", "hi", null, undefined, { webImages: IMAGES("x").json });
    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 0);
  }));
  await t("/photos with nothing after it explains itself; a search with no results, a refusal and an outage each say so", () => {
    let mode = "ok";
    return withApp({ routes: { "/web-images": b => mode === "none" ? { status: 200, json: { query: b.query, images: [] } } : mode === "refuse" ? { status: 400, json: { error: "I can't search for pictures of that." } } : mode === "down" ? { status: 502, json: { error: "The picture search isn't working right now. Please try again in a moment." } } : IMAGES(b.query) } }, async app => {
      const lastAi = () => [...app.w.document.querySelectorAll(".msg-wrap.ai .ai-text")].pop().textContent;
      await app.send("/photos");
      assert(/What should I look for\? For example: \/photos golden gate bridge/.test(lastAi()));
      assert(!app.calls.some(c => c.path === "/web-images"), "no request for an empty search");
      mode = "none"; await app.send("/photos zzzz");
      assert(/couldn't find any pictures for zzzz/.test(lastAi()));
      mode = "refuse"; await app.send("/photos something");
      assert.strictEqual(lastAi().trim(), "I can't search for pictures of that.");
      mode = "down"; await app.send("/pics eiffel tower");
      assert(/isn't working right now/.test(lastAi()));
      assert.deepStrictEqual(app.calls.filter(c => c.path === "/web-images").pop().body, { query: "eiffel tower" }, "/pics is the same command");
    });
  });
  await t("Try again runs the search again and replaces the gallery", () => withApp({ routes: { "/web-images": b => IMAGES(b.query) } }, async app => {
    await app.send("/photos golden gate bridge");
    app.$(".msg-wrap.ai:last-of-type .retry-btn").click();
    await app.sleep(200);
    assert.strictEqual(app.calls.filter(c => c.path === "/web-images").length, 2);
    assert.strictEqual(app.w.document.querySelectorAll(".web-gallery-block").length, 1, "still one gallery, not two");
    assert.strictEqual(app.peek("history.length"), 3, "greeting + your command + one result");
  }));
  await t("a picture that won't load disappears; if none load, the gallery says so", () => withApp({ routes: { "/web-images": b => IMAGES(b.query) } }, async app => {
    await app.send("/photos golden gate bridge");
    const imgs = [...app.w.document.querySelectorAll(".web-image img")];
    imgs[0].dispatchEvent(new app.w.Event("error"));
    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 1);
    imgs[1].dispatchEvent(new app.w.Event("error"));
    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 0);
    assert(/None of those pictures would load/.test(app.$(".web-gallery-head").textContent));
  }));
  await t("the command is in the / menu, has aliases, /help explains it, and /image (create) is unaffected", () => withApp({}, async app => {
    const C = app.w.agent1102Commands, R = app.w.agent1102Render;
    const cmd = C.COMMANDS.find(c => c.name === "photos");
    assert(cmd && cmd.group === "Search" && cmd.aliases.includes("pics") && cmd.aliases.includes("pictures"));
    assert.deepStrictEqual(plain(C.parseWebImages("/photos golden gate bridge")), { query: "golden gate bridge" });
    assert.deepStrictEqual(plain(C.parseWebImages("/Pictures of the eiffel tower")), { query: "the eiffel tower" });
    assert.deepStrictEqual(plain(C.parseWebImages("/pics   cats  ")), { query: "cats" });
    assert.deepStrictEqual(plain(C.parseWebImages("/photos")), { query: "" });
    assert.strictEqual(C.parseWebImages("/image a cat"), null); assert.strictEqual(C.parseWebImages("show me photos of cats"), null);
    assert.strictEqual(R.parseImageRequest("/photos golden gate bridge"), null, "never mistaken for 'create an image'");
    assert(R.parseImageRequest("/image a cat"), "/image still creates pictures");
    assert(/\/photos/.test(C.helpMarkdown()));
  }));

  /* ------------------------------------------------------------ */
  console.log("download all files (.zip)");
  const SITE = [
    "Here is your site.", "", "**index.html**", "```html", "<!doctype html><title>Café</title><link rel=\"stylesheet\" href=\"style.css\">", "```", "",
    "Save this as `style.css`:", "```css", "body { color: red; }", "```", "",
    "```js title=\"src/app.js\"", "console.log('héllo ✓');", "```", "",
    "```python", "# server.py", "print('hi')", "```", "",
    "Install first:", "```bash", "npm install", "```", "",
    "```chart", "{\"type\":\"bar\"}", "```",
  ].join("\n");
  await t("a reply with several files gets a button; the .zip holds each file under a sensible name, byte for byte", () => withApp({}, async app => {
    app.w.addMsg("ai", SITE);
    const btn = app.$('button[title^="Download all"]');
    assert(btn, "the button is there"); assert.strictEqual(btn.title, "Download all 4 files (.zip)");
    btn.click();
    assert(/^agent1102-files-\d{8}-\d{6}\.zip$/.test(app.w.__lastDownload.name), app.w.__lastDownload.name);
    const files = readZip(await blobBytes(app.w, app.w.__lastBlob));
    assert.deepStrictEqual(Object.keys(files).sort(), ["index.html", "src/app.js", "server.py", "style.css"].sort());
    assert.strictEqual(files["index.html"], "<!doctype html><title>Café</title><link rel=\"stylesheet\" href=\"style.css\">\n");
    assert.strictEqual(files["src/app.js"], "console.log('héllo ✓');\n");
    assert.strictEqual(files["style.css"], "body { color: red; }\n");
    assert.strictEqual(files["server.py"], "# server.py\nprint('hi')\n");
  }));
  await t("python's own zip reader and `unzip` agree the file is valid (when they're installed)", () => withApp({}, async app => {
    app.w.addMsg("ai", SITE); app.$('button[title^="Download all"]').click();
    const file = path.join(require("os").tmpdir(), "agent1102-test-" + process.pid + ".zip");
    fs.writeFileSync(file, await blobBytes(app.w, app.w.__lastBlob));
    const py = spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))", file], { encoding: "utf8" });
    if (!py.error) { assert.strictEqual(py.status, 0, py.stderr); assert.strictEqual(py.stdout.trim(), "4"); } else console.log("       (python3 not installed: skipped)");
    const un = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
    if (!un.error) assert.strictEqual(un.status, 0, un.stdout + un.stderr); else console.log("       (unzip not installed: skipped)");
    fs.unlinkSync(file);
  }));
  await t("no button for a single file, for shell commands, or for a reply with no code", () => withApp({}, async app => {
    const has = () => !!app.$('button[title^="Download all"]');
    app.w.addMsg("ai", "```js\nconsole.log(1)\n```"); assert(!has(), "one file");
    app.w.addMsg("ai", "```js\nconsole.log(1)\n```\n\n```bash\nnpm install\n```\n\n```bash\nnpm start\n```"); assert(!has(), "one file + two commands");
    app.w.addMsg("ai", "Just words, and a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |"); assert(!has());
    app.w.addMsg("ai", "```js\na()\n```\n\n```css\nb{}\n```"); assert(has(), "two unnamed files still count");
  }));
  await t("file names: from the code block's label, its first line, or the line above it; tool names like Node.js are not file names", () => withApp({}, async app => {
    const names = md => plain(app.w.agent1102Zip.extractFiles(md, l => ({ js: "js", html: "html", css: "css", python: "py", json: "json" })[l]).map(f => f.name));
    assert.deepStrictEqual(names("```html index.html\n<p>1</p>\n```\n```js:src/a.js\nx\n```\n```index2.html\n<p>2</p>\n```"), ["index.html", "src/a.js", "index2.html"]);
    assert.deepStrictEqual(names("```css\n/* theme.css */\na{}\n```\n```html\n<!-- page.html -->\n<p>x</p>\n```\n```python\n# filename: tool.py\nx=1\n```"), ["theme.css", "page.html", "tool.py"]);
    assert.deepStrictEqual(names("### config.json\n```json\n{\"a\":1}\n```\n1. `main.js`:\n```js\nm()\n```\nFile: other.css\n```css\no{}\n```"), ["config.json", "main.js", "other.css"]);
    assert.deepStrictEqual(names("Here is a Node.js example:\n```js\nx()\n```\nand `Array.map` works:\n```js\ny()\n```"), ["file-1.js", "file-2.js"]);
    assert.deepStrictEqual(names("**a.js**\n```js\n1\n```\n```js\n2\n```"), ["a.js", "file-2.js"], "one label names only the block right under it");
    assert.deepStrictEqual(names("```js title=\"a.js\"\n1\n```\n```js title=\"a.js\"\n2\n```\n```js title=\"a.js\"\n1\n```"), ["a.js", "a-2.js"], "same name twice gets a number; an identical repeat is skipped");
    assert.deepStrictEqual(names("```text .gitignore\nnode_modules\n```\n```text .gitignore\nother\n```"), [".gitignore", ".gitignore-2"]);
    const nested = plain(app.w.agent1102Zip.extractFiles("````md\n```js\ninner()\n```\n````\n```js\nouter()\n```\n```js\nouter2()\n```", l => ({ js: "js", md: "md" })[l]));
    assert.deepStrictEqual(nested.map(f => f.name), ["file-1.md", "file-2.js", "file-3.js"], "the inner fence belongs to the markdown file, not a separate file");
    assert.strictEqual(nested[0].content, "```js\ninner()\n```\n");
  }));
  await t("file names can never escape the zip: no .., no leading /, no drive letters, no control characters", () => withApp({}, async app => {
    const names = md => plain(app.w.agent1102Zip.extractFiles(md, () => "txt").map(f => f.name));
    const out = names(['```js title="../../etc/passwd.js"', "a", "```", '```js title="/etc/cron.d/x.js"', "b", "```", '```js title="C:\\\\win\\\\evil.js"', "c", "```", '```js title="a/../../b.js"', "d", "```'"].join("\n"));
    assert(out.length >= 3, out.join());
    out.forEach(n => { assert(!n.split("/").includes(".."), n); assert(!n.startsWith("/"), n); assert(!/[:\\\u0000-\u001f]/.test(n), n); });
    assert.deepStrictEqual(out.slice(0, 2), ["etc/passwd.js", "etc/cron.d/x.js"]);
  }));

  console.log("\nicons");
  await t("history button = right-sidebar arrow icon (>), close button = left-sidebar arrow icon (<), bomb = Reicon bomb3", () => withApp({}, async app => {
    const name = sel => { const g = app.$(sel + " svg.ri-glyph"); return g && g.getAttribute("data-name"); };
    assert.strictEqual(name("#history-btn"), "sidebar-right2");
    assert.strictEqual(name("#close-sidebar"), "sidebar-left2");
    const bombs = [...app.w.document.querySelectorAll("#backpack-egg-label svg.ri-glyph")].map(g => g.getAttribute("data-name"));
    assert.deepStrictEqual(bombs, ["bomb3", "bomb3"]);
    assert.notStrictEqual(app.$("#history-btn svg.ri-glyph").innerHTML, app.$("#close-sidebar svg.ri-glyph").innerHTML, "mirror images, not the same drawing twice");
    // everything else is untouched: a normal circle-x button keeps the circle-x
    app.w.document.body.insertAdjacentHTML("beforeend", '<button id="other-x"><i class="fa-solid fa-circle-xmark"></i></button>');
    await app.sleep(20);
    assert.strictEqual(name("#other-x"), "close-circle");
  }));

  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
  process.exit(process.exitCode || 0);
})();
