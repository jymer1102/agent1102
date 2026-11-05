// Fast tests for the safety helpers: private-address detection, the sign-in cache, per-user metadata changes,
// and the async-route wrapper.   run:  node test/hardening.test.js
"use strict";
const assert = require("assert");
const http = require("http");
const express = require("express");
const { isPrivateIp, safeFetch, makeGuardedLookup } = require("../lib/ssrf");
const { createAuth } = require("../lib/auth");
const { createUserMeta } = require("../lib/usermeta");
const { wrapAsyncRoutes } = require("../lib/asyncwrap");

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("private addresses (lib/ssrf.js)");
  await t("every private, loopback, link-local, metadata and reserved IPv4 range is refused", () => {
    for (const ip of ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.9.9.9", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255"]) assert(isPrivateIp(ip), ip);
  });
  await t("IPv4-mapped IPv6 is judged by its IPv4 address, in dotted AND hex form (the original bypass)", () => {
    for (const ip of ["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:a00:5", "::ffff:c0a8:101", "::FFFF:7F00:1"]) assert(isPrivateIp(ip), ip);
    assert(!isPrivateIp("::ffff:808:808"), "a mapped PUBLIC address is fine (8.8.8.8)");
  });
  await t("other IPv6 ranges that can reach internal hosts are refused", () => {
    for (const ip of ["::", "::1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "fc00::1", "fd12::1", "fe80::1", "febf::1", "ff02::1", "fe80::1%eth0", "not an ip", ""]) assert(isPrivateIp(ip), ip);
  });
  await t("ordinary public addresses are allowed", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e"]) assert(!isPrivateIp(ip), ip);
  });
  await t("safeFetch refuses private targets before connecting: literals, mapped forms, and names that resolve to loopback", async () => {
    let hits = 0;
    const srv = http.createServer((q, r) => { hits++; r.end("secret"); });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    try {
      for (const host of ["127.0.0.1", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::1]", "localhost"]) {
        await assert.rejects(() => safeFetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(3000) }), host);
      }
      assert.strictEqual(hits, 0, "the internal server must not have been contacted");
      // and the guarded lookup lets an allowed address through (so it isn't simply blocking everything)
      const { Agent, fetch: uf } = require("undici");
      const ok = await uf(`http://localhost:${port}/`, { dispatcher: new Agent({ connect: { lookup: makeGuardedLookup(() => false) } }) });
      assert.strictEqual(await ok.text(), "secret");
    } finally { srv.close(); }
  });

  console.log("\nsign-in cache (lib/auth.js)");
  const fakeSupabase = (mode, counter) => ({ auth: { getUser: async () => {
    counter.n++; await sleep(5);
    if (mode.v === "invalid") return { data: { user: null }, error: { status: 401 } };
    if (mode.v === "down") return { data: { user: null }, error: { status: 502 } };
    if (mode.v === "throw") throw new Error("ECONNRESET");
    return { data: { user: { id: "u1" } }, error: null };
  } } });
  await t("simultaneous checks of one token make one upstream call", async () => {
    const c = { n: 0 }, a = createAuth(fakeSupabase({ v: "ok" }, c));
    await Promise.all([a.verify("a.b.c"), a.verify("a.b.c"), a.verify("a.b.c")]);
    assert.strictEqual(c.n, 1);
  });
  await t("a token Supabase has refused is remembered briefly, so junk can't cause a call per request", async () => {
    const c = { n: 0 }, a = createAuth(fakeSupabase({ v: "invalid" }, c));
    for (let i = 0; i < 10; i++) assert.strictEqual(await a.verify("junk"), null);
    assert.strictEqual(c.n, 1);
  });
  await t("an outage or network error is never remembered: the person is fine as soon as Supabase is back", async () => {
    for (const bad of ["down", "throw"]) {
      const c = { n: 0 }, mode = { v: bad }, a = createAuth(fakeSupabase(mode, c));
      assert.strictEqual(await a.verify("t.t.t"), null);
      mode.v = "ok";
      assert.strictEqual((await a.verify("t.t.t")).id, "u1", bad);
    }
  });
  await t("a good token is cached, and invalidate() makes the next check ask again", async () => {
    const c = { n: 0 }, a = createAuth(fakeSupabase({ v: "ok" }, c));
    await a.verify("g.g.g"); await a.verify("g.g.g"); assert.strictEqual(c.n, 1);
    a.invalidate("u1"); await a.verify("g.g.g"); assert.strictEqual(c.n, 2);
  });

  console.log("\nper-user metadata changes (lib/usermeta.js)");
  const fakeAdmin = () => {
    let meta = { name: "A" };
    return { get meta() { return meta; }, auth: { admin: {
      getUserById: async () => { const snap = { ...meta }; await sleep(10); return { data: { user: { user_metadata: snap } } }; },
      updateUserById: async (id, { user_metadata }) => { await sleep(10); meta = user_metadata; return { error: null }; },
    } } };
  };
  await t("changes made at the same moment are all kept (read-modify-write no longer overwrites)", async () => {
    const f = fakeAdmin(), um = createUserMeta({ supabaseAdmin: { auth: f.auth }, auth: { invalidate() {} } });
    await Promise.all([um.patch("u", { style: { concise: true } }), um.patch("u", () => ({ easter_eggs: { dino: true } })), um.patch("u", { prefs: 1 })]);
    assert.deepStrictEqual(f.meta, { name: "A", style: { concise: true }, easter_eggs: { dino: true }, prefs: 1 });
  });
  await t("a failed change does not block the ones queued after it", async () => {
    const f = fakeAdmin(); let failNext = true; const real = f.auth.admin.updateUserById;
    f.auth.admin.updateUserById = async (...a) => { if (failNext) { failNext = false; return { error: { message: "boom" } }; } return real(...a); };
    const um = createUserMeta({ supabaseAdmin: { auth: f.auth }, auth: { invalidate() {} } });
    const first = um.patch("u", { a: 1 }), second = um.patch("u", { b: 2 });
    await assert.rejects(first, /boom/);
    await second;
    assert.deepStrictEqual(f.meta, { name: "A", b: 2 });
  });

  console.log("\nasync route errors (lib/asyncwrap.js)");
  await t("an async route that throws gets a normal error response instead of hanging; normal routes and settings still work", async () => {
    const app = express(); wrapAsyncRoutes(app);
    app.get("/boom", async () => { throw new Error("blip"); });
    app.post("/ok", async (req, res) => res.json({ ok: true }));
    app.get("/trust", (req, res) => res.json({ v: app.get("trust proxy") }));
    app.use((err, req, res, next) => res.status(500).json({ error: "generic" }));
    const srv = app.listen(0); const base = "http://127.0.0.1:" + srv.address().port;
    try {
      const r = await fetch(base + "/boom", { signal: AbortSignal.timeout(2000) });
      assert.strictEqual(r.status, 500);
      assert.deepStrictEqual(await (await fetch(base + "/ok", { method: "POST" })).json(), { ok: true });
      assert.strictEqual((await (await fetch(base + "/trust")).json()).v, false);
    } finally { srv.close(); }
  });

  console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
  process.exit(failed ? 1 : 0);
})();
