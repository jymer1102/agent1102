// Fast unit tests for the pure logic.   run:  node test/unit.test.js
"use strict";
const assert = require("assert");
const cues = require("../lib/cues");
const prefs = require("../lib/prefs");
const verify = require("../lib/verify");
const mem = require("../lib/memory");
const groq = require("../lib/groq");

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); } }

// A test for something that is knowingly not done: it still RUNS, but is reported as "todo" and does not fail the build.
// If it ever passes, it says so, and `known(...)` should be changed back to `t(...)`.
async function known(name, reason, fn) {
  try { await fn(); passed++; console.log("  ok   " + name + "\n       (this now passes: change known(...) back to t(...))"); }
  catch (e) { console.log("  todo " + name + "\n       (known, not counted as a failure: " + reason + ")"); }
}

(async () => {
  console.log("emotion / domain / effort / trimming");
  await t("sarcasm, frustration, caps, distress, crisis, good news are flagged; neutral text is not", () => {
    assert(cues.emotionCues("oh great, another error. thanks a lot").notes.length);
    assert(cues.emotionCues("WHY IS THIS STILL NOT WORKING").notes.length);
    assert(cues.emotionCues("I'm so overwhelmed with finals").notes.length);
    assert(cues.emotionCues("I want to die").crisis);
    assert(cues.emotionCues("I got the job!").notes.length);
    assert.strictEqual(cues.emotionCues("what is 2+2").notes.length, 0);
    assert.strictEqual(cues.emotionCues("thanks a lot for the help yesterday").notes.length, 0);
  });
  await t("attached files can't trigger emotion hints", () => {
    assert.strictEqual(cues.emotionCues('<attached_file name="a.txt">ugh wtf I want to die</attached_file>').notes.length, 0);
  });
  await t("domains and freshness", () => {
    assert.deepStrictEqual(cues.detectDomains("mitigate CVE-2024-1234 xss"), ["security"]);
    assert(cues.needsFreshInfo("what's the latest node version", []));
    assert(cues.needsFreshInfo("what does RFC 9110 say about caching", ["engineering"]));
    assert(!cues.needsFreshInfo("what is a monad", []));
    assert(!cues.needsFreshInfo("/quiz latest news", []));
  });
  await t("effort: low for chit-chat, medium for work", () => {
    assert.strictEqual(cues.pickEffort({ text: "hi", turns: 1 }), "low");
    assert.strictEqual(cues.pickEffort({ text: "debug this", turns: 1 }), "medium");
    assert.strictEqual(cues.pickEffort({ text: "hi", hasImage: true }), "medium");
  });
  await t("trimMessages keeps the newest, always keeps the last, never starts on an assistant turn", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(100) }));
    const r = cues.trimMessages(msgs, 350);
    assert(r.trimmed && r.messages.length < 10 && r.messages[0].role === "user" && r.messages.at(-1) === msgs.at(-1));
    assert.strictEqual(cues.trimMessages([{ role: "user", content: "x".repeat(9999) }], 10).messages.length, 1);
  });

  console.log("personalization");
  await t("standing style instructions are learned; one-offs are not", () => {
    const u = s => prefs.detectStyleUpdates(s).updates;
    assert.deepStrictEqual(u("be more concise"), { length: "concise" });
    assert.deepStrictEqual(u("from now on explain things in detail"), { length: "detailed" });
    assert.deepStrictEqual(u("don't use bullet points, always"), { format: "prose" });
    assert.deepStrictEqual(u("always use bullet points"), { format: "bullets" });
    assert.deepStrictEqual(u("stop using emojis"), { emoji: false });
    assert.deepStrictEqual(u("talk more casually"), { tone: "casual" });
    for (const s of ["explain in detail how TCP works", "give me a short summary of WW2", "what is a list in python", "use emojis"]) assert.deepStrictEqual(u(s), {}, s);
  });
  await t("long pasted text and slash commands never change settings", () => {
    assert.deepStrictEqual(prefs.detectStyleUpdates("always be concise ".repeat(30)).updates, {});
    assert.deepStrictEqual(prefs.detectStyleUpdates("/style concise").updates, {});
  });
  await t("/style parsing, reset, bad input; readStyle ignores junk", () => {
    assert.deepStrictEqual(prefs.parseStyleArgs("concise casual").updates, { length: "concise", tone: "casual" });
    assert.strictEqual(prefs.parseStyleArgs("emoji off").updates.emoji, false);
    assert.strictEqual(prefs.parseStyleArgs("reset").updates.length, null);
    assert(prefs.parseStyleArgs("banana").error);
    assert.deepStrictEqual(prefs.readStyle({ style: { length: "evil", tone: "formal", memory: false } }), { length: null, tone: "formal", emoji: null, format: null, level: null, memory: false });
    assert.deepStrictEqual(prefs.cleanUpdates({ length: "evil", hacker: 1, memory: false }), { memory: false });
  });

  console.log("verification");
  const bad = async (code) => (await verify.verifyReply(code)).issues.length;
  await t("code that parses passes (ESM, top-level await, JSX, REPL, magics, illustrative JSON)", async () => {
    for (const c of ["```js\nconst a=1;await x();\n```", "```js\nimport {a,\n b} from 'x';\nexport default function f(){}\n```", "```js\nfunction A(){ return (<div>hi</div>) }\n```",
      "```python\n>>> 1+1\n```", "```python\n%matplotlib inline\nimport numpy\n```", "```python\n    def m(self):\n        return 1\n```", "```json\n{\"a\": 1, // note\n\"b\": ...}\n```", "Costs $5 and $10."]) assert.strictEqual(await bad(c), 0, c);
  });
  await t("real errors are caught (JS, Python, shell, JSON, chart, LaTeX)", async () => {
    for (const c of ["```javascript\nfunction f( {\n return 1;\n}\n```", "```python\ndef f(x)\n  return x\n```", "```bash\nif [ -f x ]; then echo hi\n```", "```json\n{\"a\":[1,2,]}\n```",
      "```chart\n{\"type\":\"bar\",\"labels\":[\"a\",\"b\",\"c\"],\"datasets\":[{\"data\":[1,2]}]}\n```", "```chart\n{\"type\":\"pie\",\"labels\":[\"a\"],\"datasets\":[{\"data\":[\"abc\"]}]}\n```",
      "Solve \\(x^2 + 1 = 0 and more", "so \\(\\frac{a}{b\\)"]) assert.strictEqual(await bad(c), 1, c);
  });
  await t("chart rules match the page: aliases and chart.js-style specs are accepted", async () => {
    assert.strictEqual(await bad("```chart\n{\"type\":\"donut\",\"labels\":[\"a\",\"b\"],\"datasets\":[{\"data\":[\"10%\",\"5\"]}]}\n```"), 0);
    assert.strictEqual(await bad("```chart\n{\"type\":\"bar\",\"data\":{\"labels\":[\"a\"],\"datasets\":[{\"data\":[1]}]}}\n```"), 0);
  });

  console.log("memory");
  await t("secrets are never stored; near-duplicates are recognised", () => {
    for (const s of ["my password is hunter2", "card 4111 1111 1111 1111", "key gsk_abcdefghijklmnop", "ssn 123-45-6789"]) assert(mem.looksSensitive(s), s);
    assert(!mem.looksSensitive("Is studying nursing at KU"));
    assert(mem.similarity("Lives in Austin", "Lives in Austin, Texas") >= 0.8);
    assert(mem.similarity("Likes jazz", "Is learning Rust") < 0.3);
  });
  await t("extraction is only attempted for messages that look durable", () => {
    assert(mem.worthExtracting("I'm building a Discord bot in Python"));
    assert(mem.worthExtracting("remember that I prefer metric units"));
    assert(mem.worthExtracting("forget that I like jazz"));
    assert(!mem.worthExtracting("what is the capital of France?"));
    assert(!mem.worthExtracting("/quiz 5 history"));
    assert(!mem.worthExtracting('<attached_file name="a">I am a robot, my name is X</attached_file>'));
  });
  await t("missing table: list throws MemoryUnavailable, relevant() quietly returns [], and it retries later", async () => {
    let calls = 0;
    const q = { select() { return q; }, eq() { return q; }, order() { return q; }, limit() { calls++; return Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table" } }); } };
    const m = mem.createMemory({ supabase: { from: () => q }, complete: async () => "{}", model: "x", log: { warn() {} } });
    await assert.rejects(() => m.list("u"), mem.MemoryUnavailable);
    assert.deepStrictEqual(await m.relevant("u", "hello"), []);
    assert.strictEqual(calls, 1, "should not hammer the database while it's missing");
  });
  await t("relevant(): matching memories first, capped", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: "m" + i, kind: "fact", content: i === 17 ? "Is building a Discord bot in Python" : "Fact number " + i, created_at: new Date(2020, 0, 1 + i).toISOString(), updated_at: new Date(2020, 0, 1 + i).toISOString() }));
    const q = { select() { return q; }, eq() { return q; }, order() { return q; }, limit() { return Promise.resolve({ data: rows, error: null }); } };
    const m = mem.createMemory({ supabase: { from: () => q }, complete: async () => "{}", model: "x" });
    const r = await m.relevant("u", "help me debug my discord bot", 5);
    assert.strictEqual(r.length, 5); assert.strictEqual(r[0].id, "m17");
  });

  console.log("groq helper");
  await t("reset-time parsing", () => {
    assert.strictEqual(groq.parseResetSeconds("1m23.4s"), 84); assert.strictEqual(groq.parseResetSeconds("7.66s"), 8); assert.strictEqual(groq.parseResetSeconds(null), 60);
  });

  console.log("reset-password script");
  const rp = require("../scripts/reset-password.js");
  // a fake Supabase admin with 450 users, served 200 at a time like the real one
  const fakeAdmin = (updates, failUpdate) => {
    const all = Array.from({ length: 450 }, (_, i) => ({ id: "id" + i, email: `user${i}@example.com` }));
    all[300].email = "Sam.Smith@Example.com";
    return { auth: { admin: {
      listUsers: async ({ page, perPage }) => ({ data: { users: all.slice((page - 1) * perPage, page * perPage) }, error: null }),
      updateUserById: async (id, body) => { updates.push({ id, body }); return { error: failUpdate ? { message: "Password should be at least 6 characters." } : null }; },
    } } };
  };
  await t("finds a user on a later page, ignoring upper/lower case, and sets the password they were given", async () => {
    const updates = [];
    const r = await rp.resetPassword(fakeAdmin(updates), "  sam.smith@example.com ", "Chosen-Pass-1");
    assert.deepStrictEqual(updates, [{ id: "id300", body: { password: "Chosen-Pass-1" } }]);
    assert.strictEqual(r.generated, false);
    assert.strictEqual(r.password, "Chosen-Pass-1");
  });
  await t("with no password given it makes a random one and says so", async () => {
    const updates = [];
    const a = await rp.resetPassword(fakeAdmin(updates), "user5@example.com");
    const b = await rp.resetPassword(fakeAdmin(updates), "user5@example.com");
    assert.strictEqual(a.generated, true);
    assert(/^[A-Za-z2-9]{14}$/.test(a.password) && !/[0OIl1]/.test(a.password), "14 characters, no look-alikes: " + a.password);
    assert.notStrictEqual(a.password, b.password);
    assert.strictEqual(updates[0].body.password, a.password);
  });
  await t("a wrong email, a missing email and a Supabase refusal each give a plain message", async () => {
    await assert.rejects(rp.resetPassword(fakeAdmin([]), "nobody@example.com"), /No account found for nobody@example.com/);
    await assert.rejects(rp.resetPassword(fakeAdmin([]), undefined), /Give the person's email/);
    await assert.rejects(rp.resetPassword(fakeAdmin([], true), "user1@example.com", "abc"), /Supabase refused the change: Password should be at least 6/);
  });

  console.log("rate limiter");
  const { createLimiter, waitText } = require("../lib/ratelimit");
  // runs a limiter against a fake request/response and says what happened
  const hit = async (limiter, req = {}) => {
    const out = { passed: false, status: null, body: null, headers: {}, finish: null };
    const res = {
      statusCode: 200,
      set(k, v) { out.headers[k] = v; return res; },
      status(c) { res.statusCode = c; out.status = c; return res; },
      json(b) { out.body = b; return res; },
      on(ev, fn) { if (ev === "finish") out.finish = fn; },
    };
    await limiter(req, res, () => { out.passed = true; });
    return out;
  };
  await t("allows up to the limit, then answers 429 with a plain message and a wait time", async () => {
    const lim = createLimiter({ windowMs: 60000, max: 3, key: () => "k", message: w => `Slow down. Try again in ${w}.` });
    for (let i = 0; i < 3; i++) assert((await hit(lim)).passed, "request " + (i + 1));
    const blocked = await hit(lim);
    assert(!blocked.passed); assert.strictEqual(blocked.status, 429);
    assert(/Try again in (\d+ seconds?|1 minute)\./.test(blocked.body.error), blocked.body.error);
    assert(Number(blocked.headers["Retry-After"]) > 0);
  });
  await t("each key is counted separately, and a missing key is never limited", async () => {
    const lim = createLimiter({ windowMs: 60000, max: 1, key: r => r.who, message: "no" });
    assert((await hit(lim, { who: "a" })).passed); assert(!(await hit(lim, { who: "a" })).passed);
    assert((await hit(lim, { who: "b" })).passed, "another person is unaffected");
    assert((await hit(lim, {})).passed && (await hit(lim, {})).passed, "no key = no limit");
  });
  await t("the count starts again after the window", async () => {
    const lim = createLimiter({ windowMs: 40, max: 1, key: () => "k", message: "no" });
    assert((await hit(lim)).passed); assert(!(await hit(lim)).passed);
    await new Promise(r => setTimeout(r, 60));
    assert((await hit(lim)).passed);
  });
  await t("skipSuccessful: good sign-ins don't count, failed ones do", async () => {
    const lim = createLimiter({ windowMs: 60000, max: 2, key: () => "k", message: "no", skipSuccessful: true });
    for (let i = 0; i < 5; i++) { const r = await hit(lim); assert(r.passed, "good attempt " + i); r.finish(); } // statusCode stays 200
    const failures = [];
    for (let i = 0; i < 3; i++) { const r = await hit(lim); failures.push(r.passed); }
    assert.deepStrictEqual(failures, [true, true, false], "the third failure in a row is blocked");
  });
  await t("a key function that throws doesn't take the route down", async () => {
    const lim = createLimiter({ windowMs: 1000, max: 1, key: () => { throw new Error("boom"); }, message: "no" });
    assert((await hit(lim)).passed);
  });
  await t("wait times read naturally", () => {
    assert.strictEqual(waitText(1), "1 second"); assert.strictEqual(waitText(45), "45 seconds");
    assert.strictEqual(waitText(60), "1 minute"); assert.strictEqual(waitText(61), "2 minutes");
  });

  console.log("security settings");
  const sec = require("../lib/security");
  const origins = sec.parseOrigins("https://agent1102.onrender.com/x?y=1, https://mine.example , not a url");
  await t("origins are cleaned up to scheme + host and junk is ignored", () => {
    assert.deepStrictEqual([...origins], ["https://agent1102.onrender.com", "https://mine.example"]);
  });
  await t("CORS: our own sites, localhost and no-Origin requests are allowed; other websites are not", async () => {
    const ask = o => new Promise(resolve => sec.corsOptions(origins).origin(o, (e, ok) => resolve(ok)));
    assert.strictEqual(await ask("https://mine.example"), true);
    assert.strictEqual(await ask("http://localhost:3000"), true);
    assert.strictEqual(await ask(undefined), true);
    assert.strictEqual(await ask("https://evil.example"), false);
    assert.strictEqual(await ask("https://agent1102.onrender.com.evil.example"), false);
  });
  await t("the page policy: scripts only from us + jsDelivr, no inline scripts or handlers, no plugins", () => {
    const csp = sec.appCsp(origins);
    const dir = name => (csp.split("; ").find(d => d.startsWith(name + " ")) || "");
    assert.strictEqual(dir("script-src"), "script-src 'self' https://cdn.jsdelivr.net");
    assert(!/unsafe-inline|unsafe-eval/.test(dir("script-src")));
    assert.strictEqual(dir("script-src-attr"), "script-src-attr 'none'");
    assert(/object-src 'none'/.test(csp) && /frame-ancestors 'self'/.test(csp) && /base-uri 'self'/.test(csp));
    assert(/connect-src 'self' https:\/\/agent1102\.onrender\.com https:\/\/mine\.example/.test(csp), dir("connect-src"));
  });
  await t("the code-preview page gets its own, looser policy that is still sandboxed", () => {
    assert(/'unsafe-inline'/.test(sec.PREVIEW_CSP) && /sandbox allow-scripts/.test(sec.PREVIEW_CSP));
    assert(!/allow-same-origin/.test(sec.PREVIEW_CSP), "the preview must never share the site's origin");
    const sent = {};
    sec.securityHeaders(origins)({ path: sec.PREVIEW_PATH, secure: true }, { setHeader: (k, v) => { sent[k] = v; } }, () => {});
    assert.strictEqual(sent["Content-Security-Policy"], sec.PREVIEW_CSP);
    assert.strictEqual(sent["X-Content-Type-Options"], "nosniff");
    assert(/max-age=/.test(sent["Strict-Transport-Security"]));
    const plain = {};
    sec.securityHeaders(origins)({ path: "/", secure: false }, { setHeader: (k, v) => { plain[k] = v; } }, () => {});
    assert.strictEqual(plain["Content-Security-Policy"], sec.appCsp(origins));
    assert(!("Strict-Transport-Security" in plain), "no HSTS over plain http");
  });

  console.log("finding pictures on the web (lib/imagesearch.js)");
  const http = require("http");
  const img = require("../lib/imagesearch");
  // one fake server stands in for Brave, Tavily and Wikimedia Commons; `seen` records what was asked of it
  const seen = [];
  let behaviour = {};
  const fake = http.createServer((req, res) => {
    let raw = ""; req.on("data", d => raw += d); req.on("end", () => {
      const url = new URL(req.url, "http://x");
      seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const mode = behaviour[url.pathname];
      if (mode === "error") { res.writeHead(500); return res.end("nope"); }
      if (mode === "empty") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(url.pathname === "/brave" ? '{"results":[]}' : url.pathname === "/tavily" ? '{"images":[]}' : '{"query":{"pages":[]}}'); }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (url.pathname === "/brave") return res.end(JSON.stringify({ results: [
        { title: "Bridge <b>one</b>", thumbnail: { src: "https://imgs.search.brave.com/t1" }, properties: { url: "https://site.example/full1.jpg" }, url: "https://site.example/page1", source: "site.example" },
        { title: "Insecure", thumbnail: { src: "http://imgs.search.brave.com/t2" }, properties: { url: "http://site.example/full2.jpg" }, url: "http://site.example/page2", source: "site.example" },
        { title: "Dup", thumbnail: { src: "https://imgs.search.brave.com/t1" }, properties: { url: "https://site.example/full1.jpg" }, url: "https://site.example/page1", source: "site.example" },
        { title: "No thumb", properties: { url: "https://site.example/full3.jpg" } },
      ] }));
      if (url.pathname === "/tavily") return res.end(JSON.stringify({ images: ["https://cdn.example/a.jpg", { url: "https://cdn.example/b.jpg", description: "A described picture" }, { url: "javascript:alert(1)" }] }));
      res.end(JSON.stringify({ query: { pages: [
        { title: "File:Second_best.png", index: 2, imageinfo: [{ mime: "image/png", url: "https://upload.wikimedia.org/s.png", thumburl: "https://upload.wikimedia.org/thumb/s.png", descriptionurl: "https://commons.wikimedia.org/wiki/File:Second_best.png" }] },
        { title: "File:Best.jpg", index: 1, imageinfo: [{ mime: "image/jpeg", url: "https://upload.wikimedia.org/b.jpg", thumburl: "https://upload.wikimedia.org/thumb/b.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Best.jpg" }] },
        { title: "File:Scan.pdf", index: 3, imageinfo: [{ mime: "application/pdf", url: "https://upload.wikimedia.org/x.pdf" }] },
        { title: "File:Clip.ogv", index: 4, imageinfo: [{ mime: "video/ogg", url: "https://upload.wikimedia.org/x.ogv" }] },
      ] } }));
    });
  });
  await new Promise(r => fake.listen(4193, "127.0.0.1", r));
  Object.assign(process.env, { BRAVE_IMAGES_URL: "http://127.0.0.1:4193/brave", TAVILY_API_URL: "http://127.0.0.1:4193/tavily", COMMONS_API_URL: "http://127.0.0.1:4193/commons", BRAVE_API_KEY: "", TAVILY_API_KEY: "" });
  const reset = (b = {}) => { seen.length = 0; behaviour = b; };

  await t("with no keys it uses Wikimedia Commons: best match first, only real pictures, a polite User-Agent, nice titles", async () => {
    reset();
    const r = await img.searchImages("commons only one");
    assert.strictEqual(r.provider, "commons"); assert.strictEqual(r.label, "Wikimedia Commons");
    assert.deepStrictEqual(r.images.map(i => i.title), ["Best", "Second best"], "pdf and video are left out, sorted by rank, File: and extension removed");
    assert.strictEqual(r.images[0].thumb, "https://upload.wikimedia.org/thumb/b.jpg");
    assert.strictEqual(r.images[0].url, "https://upload.wikimedia.org/b.jpg");
    assert.strictEqual(r.images[0].page, "https://commons.wikimedia.org/wiki/File:Best.jpg");
    assert.strictEqual(r.images[0].source, "commons.wikimedia.org");
    assert(/filetype:bitmap commons only one/.test(seen[0].query.gsrsearch));
    assert(/agent1102/.test(seen[0].headers["user-agent"]), "Wikimedia asks every client to identify itself");
  });
  await t("with a Brave key it asks Brave first, with strict safe-search, and uses Brave's proxied thumbnails", async () => {
    reset(); process.env.BRAVE_API_KEY = "brave-key";
    const r = await img.searchImages("brave first one");
    process.env.BRAVE_API_KEY = "";
    assert.strictEqual(r.provider, "brave");
    assert.strictEqual(seen.length, 1, "no need to ask anyone else");
    assert.strictEqual(seen[0].headers["x-subscription-token"], "brave-key");
    assert.strictEqual(seen[0].query.safesearch, "strict");
    assert.strictEqual(r.images.length, 1, "http:// pictures, repeats and entries without a thumbnail are dropped");
    assert.deepStrictEqual(r.images[0], { title: "Bridge one", thumb: "https://imgs.search.brave.com/t1", url: "https://site.example/full1.jpg", page: "https://site.example/page1", source: "site.example" }, "HTML tags are removed from titles");
  });
  await t("Tavily's two image shapes both work, and a javascript: address is never passed on", async () => {
    reset(); process.env.TAVILY_API_KEY = "tav-key";
    const r = await img.searchImages("tavily shapes one");
    process.env.TAVILY_API_KEY = "";
    assert.strictEqual(r.provider, "tavily");
    assert.strictEqual(seen[0].body.include_images, true); assert.strictEqual(seen[0].body.include_image_descriptions, true);
    assert.strictEqual(seen[0].headers.authorization, "Bearer tav-key");
    assert.deepStrictEqual(r.images.map(i => [i.title, i.thumb]), [["", "https://cdn.example/a.jpg"], ["A described picture", "https://cdn.example/b.jpg"]]);
    assert.strictEqual(r.images[0].source, "cdn.example");
  });
  await t("a provider that fails, or finds nothing, hands over to the next one (Brave -> Tavily -> Commons)", async () => {
    reset({ "/brave": "error", "/tavily": "empty" }); Object.assign(process.env, { BRAVE_API_KEY: "k", TAVILY_API_KEY: "k" });
    const r = await img.searchImages("fallback chain one");
    Object.assign(process.env, { BRAVE_API_KEY: "", TAVILY_API_KEY: "" });
    assert.strictEqual(r.provider, "commons");
    assert.deepStrictEqual(seen.map(s => s.path), ["/brave", "/tavily", "/commons"]);
    assert.strictEqual(r.failed, false);
  });
  await t("nothing found is not an error, but every provider failing is", async () => {
    reset({ "/commons": "empty" });
    const none = await img.searchImages("nothing here one");
    assert.deepStrictEqual([none.images.length, none.failed], [0, false]);
    reset({ "/commons": "error" });
    const broken = await img.searchImages("everything broken one");
    assert.deepStrictEqual([broken.images.length, broken.failed], [0, true]);
  });
  await t("the same search twice is answered from memory; a failure is never remembered", async () => {
    reset(); await img.searchImages("cache me please"); await img.searchImages("Cache me   please");
    assert.strictEqual(seen.length, 1);
    reset({ "/commons": "error" }); await img.searchImages("flaky one"); reset(); const ok = await img.searchImages("flaky one");
    assert.strictEqual(ok.images.length, 2, "the next try asks again");
  });
  await known("too-short or blocked searches are refused before anything is sent", "the image-search block list is empty on purpose, so this check can't pass yet", async () => {
    reset();
    assert.deepStrictEqual((await img.searchImages(" a ")).images, []);
    assert.strictEqual(seen.length, 0);
    ["nude photos", "NSFW pics", "porn", "hentai art", "xxx"].forEach(q => assert(img.isBlockedQuery(q), q));
    ["golden gate bridge", "renaissance painting", "assess the damage", "Essex"].forEach(q => assert(!img.isBlockedQuery(q), q));
  });
  await t("normalize keeps only https, removes repeats, caps the count, and falls back to the thumbnail for the full-size link", () => {
    const out = img.normalize([
      { thumb: "https://a/1.jpg" }, { thumb: "https://a/1.jpg" }, { thumb: "ftp://a/2.jpg" }, { thumb: "not a url" },
      { thumb: "https://a/3.jpg", full: "http://a/3-big.jpg", page: "javascript:x" }, { thumb: "https://a/4.jpg" },
    ], 3);
    assert.deepStrictEqual(out.map(i => i.thumb), ["https://a/1.jpg", "https://a/3.jpg", "https://a/4.jpg"]);
    assert.strictEqual(out[1].url, "https://a/3.jpg"); assert.strictEqual(out[1].page, "");
  });
  fake.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
