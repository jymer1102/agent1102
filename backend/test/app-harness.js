// Boots the REAL page in jsdom: index.html's markup plus every script it lists, in the same order, with the
// browser pieces jsdom lacks stubbed and `fetch` replaced by a fake. Lets tests drive the actual UI
// (type a command, press send, click a button) instead of testing stand-ins.
//   const app = await bootApp({ routes: { "/web-images": (body) => ({ status: 200, json: {...} }) } });
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM, VirtualConsole } = require("jsdom");

const PUBLIC = path.join(__dirname, "..", "public");
const NM = (...p) => fs.readFileSync(path.join(__dirname, "..", "node_modules", ...p), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
// a token that looks like a real, unexpired sign-in (the page reads its expiry)
const fakeToken = () => `${b64({ alg: "HS256" })}.${b64({ sub: "11111111-1111-4111-8111-111111111111", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

async function bootApp({ routes = {}, storage = {}, light = false } = {}) {
  let html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="(js\/[^"?]+)(?:\?[^"]*)?"><\/script>/g)].map(m => m[1]);
  html = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "");

  // the page's own console.log chatter is dropped; real script errors are collected and the tests fail on them
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", e => errors.push(e));
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole });
  const w = dom.window;
  const calls = [];
  w.__calls = calls;

  // ---- browser pieces jsdom doesn't have ----
  w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
  w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], addEventListener() {}, onvoiceschanged: null };
  w.SpeechSynthesisUtterance = class {};
  w.open = () => null;
  w.HTMLCanvasElement.prototype.getContext = () => null;
  w.URL.createObjectURL = blob => { w.__lastBlob = blob; return "blob:test"; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () { w.__lastDownload = { name: this.download, href: this.href }; };

  // ---- fake network ----
  const defaults = {
    "/ping": () => ({ status: 200, json: { ok: true } }),
    "/profile": () => ({ status: 200, json: { name: "Sam", email: "a@b.c" } }),
    "/chats": () => ({ status: 200, json: { chats: [], success: true } }),
    "/title": () => ({ status: 200, json: { title: "Test chat" } }),
    "/easter-eggs": () => ({ status: 200, json: {} }),
    "/auth/refresh": () => ({ status: 401, json: { error: "no" } }),
  };
  w.fetch = async (url, opts = {}) => {
    const p = new URL(String(url), "http://localhost/").pathname;
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch (_) { body = opts.body; }
    calls.push({ path: p, method: opts.method || "GET", body, headers: opts.headers || {} });
    const handler = routes[p] || defaults[p];
    const r = handler ? await handler(body, opts) : { status: 404, json: { error: "not faked: " + p } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.json, text: async () => JSON.stringify(r.json), body: null };
  };

  // ---- storage the page expects ----
  Object.entries({ agent1102_token: fakeToken(), ...storage }).forEach(([k, v]) => w.localStorage.setItem(k, v));
  if (light) w.localStorage.setItem("agent1102_theme", "light");

  const ctx = dom.getInternalVMContext();
  const run = (code, file) => new vm.Script(code, { filename: file }).runInContext(ctx);
  run(NM("marked", "marked.min.js"), "marked.js");
  run(NM("dompurify", "dist", "purify.min.js"), "purify.js");
  w.addEventListener("error", e => errors.push(e.error || e.message));
  for (const s of scripts) {
    try { run(fs.readFileSync(path.join(PUBLIC, s), "utf8"), s); }
    catch (e) { errors.push(new Error(s + ": " + e.message)); }
  }
  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
  w.dispatchEvent(new w.Event("load"));
  await sleep(30);

  const $ = sel => w.document.querySelector(sel);
  return {
    w, calls, errors, $, sleep,
    // evaluates code inside the page (so top-level `let` variables like `history` are reachable); returns plain JSON data
    peek: code => { const v = run(code); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
    // types into the message box and presses Send
    async send(text) { $("#input").value = text; $("#input").dispatchEvent(new w.Event("input", { bubbles: true })); $("#send").click(); await sleep(120); },
    // the HTML of every toast currently showing (showToast puts them on <body> with z-index 9999)
    toasts: () => [...w.document.querySelectorAll("body > div")].filter(d => d.style.zIndex === "9999").map(d => d.innerHTML),
    // the page keeps timers running (keep-alive pings, animations): closing the window stops them so Node can exit
    close: () => w.close(),
  };
}

module.exports = { bootApp };
