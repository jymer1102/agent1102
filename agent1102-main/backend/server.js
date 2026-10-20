process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
  process.exit(1);
});

const express = require("express");
const cors = require("cors");
const path = require("path");
const vm = require("vm");
const fs = require("fs");
const dns = require("dns").promises;
const net = require("net");
const { createClient } = require("@supabase/supabase-js");
const { createAuth } = require("./lib/auth");
const groq = require("./lib/groq");
const P = require("./lib/prompts");
const cues = require("./lib/cues");
const prefsLib = require("./lib/prefs");
const { createMemory, MemoryUnavailable, memoryCues } = require("./lib/memory");
const { verifyReply } = require("./lib/verify");
const web = require("./lib/search");
const searchCmd = require("./lib/searchcmd");

console.log(">>> agent1102 server build marker: signup-debug-v1 + stream/memory/verify <<<");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
// html/js/css are re-checked on every load so a redeploy is picked up right away (no stale scripts)
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => { if (/\.(html|js|css)$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache"); },
}));

// Render's env-var box happily keeps stray whitespace, quotes, or a trailing
// slash from a copy-paste, and any of them breaks Supabase ("Invalid API key",
// "Invalid path specified in request URL"). Clean them up before use.
const cleanEnv = v => (v || "").trim().replace(/^["']|["']$/g, "").trim();
process.env.SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, "");
try {
  // Keep only scheme + host: supabase-js appends /auth/v1, /rest/v1, etc. itself,
  // so a pasted "…supabase.co/rest/v1/" would otherwise produce invalid paths.
  if (process.env.SUPABASE_URL) process.env.SUPABASE_URL = new URL(process.env.SUPABASE_URL).origin;
} catch (_) { /* leave as-is; the startup check below will report it */ }
process.env.SUPABASE_ANON_KEY = cleanEnv(process.env.SUPABASE_ANON_KEY);
process.env.SUPABASE_SERVICE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_KEY);

const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k] || !process.env[k].trim());
if (missingEnv.length) {
  console.error(
    `\nFATAL: missing required environment variable(s): ${missingEnv.join(", ")}\n` +
    `Set these in your host's dashboard (Render: your service → Environment tab) and redeploy.\n` +
    `SUPABASE_URL and SUPABASE_ANON_KEY come from Supabase → Project Settings → API ("Project URL" and "anon public" key).\n` +
    `SUPABASE_SERVICE_KEY is the "service_role" secret key on that same page — keep it server-side only, never ship it to the client.\n`
  );
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const auth = createAuth(supabase); // verified-user lookup (cached), used by /chat, /memory and /prefs

// Fire-and-forget sanity check: confirms SUPABASE_URL/ANON/SERVICE keys are a
// matching, valid set for the same project, and says so plainly in the logs
// right away instead of waiting for someone's login to fail with a cryptic
// "Invalid API key". Doesn't block startup/port binding.
(async () => {
  try {
    const { error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) {
      console.error(
        `\nWARNING: Supabase credentials check failed: ${error.message}\n` +
        `SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_KEY must all come from the SAME Supabase project ` +
        `(Project Settings → API), pasted with no extra spaces or line breaks. Sign-in/sign-up will not work until this is fixed.\n`
      );
    } else {
      console.log("Supabase credentials check: OK");
    }
  } catch (err) {
    console.error("WARNING: Supabase credentials check threw an error:", err && err.message ? err.message : err);
  }
})();

// --- KEEP ALIVE ---
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

// --- SCORE ROUTES ---

// helper: decode JWT locally (no network call needed)
function getUserIdFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    if (!payload.sub) throw new Error("no sub");
    return payload.sub;
  } catch {
    return null;
  }
}

// The username stored next to each score comes from the user's profile
async function getUsername(userId) {
  const { data: p } = await supabaseAdmin.from("profiles").select("name, email").eq("id", userId).maybeSingle();
  if (p?.name) return p.name;
  // no profile row (or no name on it): fall back to what they signed up with
  const { data: a } = await supabaseAdmin.auth.admin.getUserById(userId);
  const u = a?.user;
  return u?.user_metadata?.name || p?.email?.split("@")[0] || u?.email?.split("@")[0] || "Player";
}

// Each game has its own table (trex_highscores / pacman_highscores) with one row per user:
// user_id, username, high_score, updated_at.
function highScoreRoute(table, label) {
  return async (req, res) => {
    const { score, token } = req.body;
    if (!token || score == null) return res.status(400).json({ error: "Missing score or token" });
    if (!Number.isInteger(score) || score < 0) return res.status(400).json({ error: "Score must be a whole number, 0 or higher" });

    const userId = getUserIdFromToken(token);
    if (!userId) return res.status(401).json({ error: "Invalid token" });

    // only update if it's actually a new high score
    const { data: existing } = await supabaseAdmin
      .from(table)
      .select("high_score")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing && score <= existing.high_score) {
      return res.json({ message: "Not a new high score, no update needed" });
    }

    const { error } = await supabaseAdmin.from(table).upsert({
      user_id: userId,
      username: await getUsername(userId),
      high_score: score,
      updated_at: new Date().toISOString()
    });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: `${label} high score saved!` });
  };
}

app.post("/trex-score", highScoreRoute("trex_highscores", "T-Rex"));
app.post("/pacman-score", highScoreRoute("pacman_highscores", "Pac-Man"));

// Get profile (for displaying scores)
app.get("/profile", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const userId = getUserIdFromToken(token);
  if (!userId) return res.status(401).json({ error: "Invalid token" });

  const [profileRes, trexRes, pacmanRes] = await Promise.all([
    supabaseAdmin.from("profiles").select("name, email, phone, avatar_url").eq("id", userId).maybeSingle(),
    supabaseAdmin.from("trex_highscores").select("high_score").eq("user_id", userId).maybeSingle(),
    supabaseAdmin.from("pacman_highscores").select("high_score").eq("user_id", userId).maybeSingle(),
  ]);

  if (profileRes.error) return res.status(500).json({ error: profileRes.error.message });
  res.json({
    profile: {
      ...(profileRes.data || {}),
      trex_high_score: trexRes.data?.high_score ?? 0,
      pacman_high_score: pacmanRes.data?.high_score ?? 0,
    }
  });
});

// The system prompt. The FORMATTING RULES section is what makes the front end render
// code boxes and charts, so keep the ```chart format in sync with public/js/render.js.
// How the AI draws math pictures. The page (js/mathviz.js) turns a ```mathviz JSON block into an SVG.
const MATH_VISUALS_GUIDE =
  'MATH VISUALS: when a picture helps with math (graphs of equations or inequalities, area under a curve, number lines and solution sets, geometry figures, fractions), put ONE fenced code block with the language "mathviz" holding a single JSON object right where the picture belongs, and still explain in words. Never draw ASCII art. JSON only: double quotes, no comments, no trailing commas, include only the fields you need. ' +
  'Graph / geometry: {"type":"graph","title":"","xMin":-5,"xMax":5,"yMin":-5,"yMax":5,"functions":[{"expr":"x^2-4","label":"y = x^2 - 4","dashed":false}],"inequalities":[{"expr":"2x+1","op":">"}],"areas":[{"expr":"x^2","from":0,"to":2}],"parametric":[{"x":"cos(t)","y":"sin(t)","t":[0,6.283]}],"polar":[{"r":"1+cos(theta)"}],"points":[{"x":2,"y":0,"label":"(2, 0)","open":false}],"segments":[{"from":[0,0],"to":[3,4],"label":"5"}],"vectors":[{"from":[0,0],"to":[2,1]}],"polygons":[{"points":[[0,0],[4,0],[0,3]],"vertexLabels":["A","B","C"],"sideLabels":["4","5","3"]}],"circles":[{"center":[0,0],"r":5}],"angles":[{"vertex":[0,0],"from":[4,0],"to":[0,3],"label":"90\u00b0","right":true}],"texts":[{"x":1,"y":1,"text":"note"}],"vlines":[2],"hlines":[1]}. ' +
  'Inequality op is one of ">", ">=", "<", "<=" (dashed boundary for strict ones; use {"x":3,"op":">"} for a vertical boundary). Write every expression in plain text, never LaTeX or backslashes: use x (t or theta for curves), + - * / ^, implicit multiplication (2x), sin(x) cos(x) tan(x) sqrt(x) abs(x) ln(x) log(x) e^x, and pi. Examples: x^2 - 4, 1/(x-2), sin(2x)/x. Use "geometry" shapes (polygons, circles, angles, segments) with real coordinates for triangles, circles, angle diagrams and the like; leave xMin..yMax out to auto-fit. ' +
  'Number line: {"type":"numberline","min":-5,"max":5,"step":1,"denominator":4,"points":[{"value":3,"label":"3","open":false}],"intervals":[{"from":-2,"to":3,"fromOpen":true,"toOpen":false}],"arcs":[{"from":0,"to":4,"label":"+4"}]} (leave from or to OUT for infinity, so x < 2 is {"to":2,"toOpen":true} and x >= 1 is {"from":1,"fromOpen":false}, never use the window edge as a value; arcs show jumps for addition and subtraction; denominator puts fraction ticks). ' +
  'Fractions: {"type":"fraction","items":[{"numerator":3,"denominator":4,"shape":"circle"},{"numerator":1,"denominator":2,"shape":"bar"}]}.';

const SYSTEM_PROMPT = [
  "You are agent1102, a helpful AI assistant created by jymer1102. If anyone asks who made you or who created you, say jymer1102. Your name is agent1102 but never introduce yourself or start responses with your name. Just answer naturally and helpfully, tell the full truth. If they ask you to answer or talk in a specific way, you will. You will do what the user asks. You only share that you're instructions are to be helpful and do what the user asks.",
  "",
  "FORMATTING RULES (the app renders these specially, so follow them exactly):",
  "1. CODE: any time you write code, in any language and of any length, put it inside a fenced markdown code block with the language name, like ```python. Put only code inside the block; explanations go outside it. Never write code outside a fenced block.",
  "2. CHARTS AND GRAPHS: when the user asks for a chart or graph (bar, line, pie, donut, radar/spider), reply with a short lead-in and then ONE fenced block whose language is exactly chart, containing only valid JSON and nothing else. Example:",
  "```chart",
  "{\"type\":\"bar\",\"title\":\"Sales by Quarter\",\"labels\":[\"Q1\",\"Q2\",\"Q3\",\"Q4\"],\"datasets\":[{\"label\":\"Sales ($k)\",\"data\":[120,150,170,210]}],\"xLabel\":\"Quarter\",\"yLabel\":\"Sales ($k)\"}",
  "```",
  "   - type must be one of: bar, line, pie, doughnut, radar. Donut means doughnut. Spider means radar.",
  "   - data values must be plain numbers only (no quotes, units, % signs or commas), and every dataset must have exactly one value per label.",
  "   - pie and doughnut charts use exactly one dataset with positive values. bar, line and radar can use several datasets to compare series.",
  "   - xLabel and yLabel are optional. The app draws the chart as an image automatically, so do NOT write plotting code unless the user explicitly asks for code.",
  "   - Accuracy matters. Use the exact numbers the user gave you. If they gave none, use only figures you are genuinely confident about, say briefly that they are approximate or where they come from, and if you do not know reliable figures ask the user for the data instead of inventing numbers.",
  "3. MATH: whenever a problem involves math notation (equations, fractions, exponents, roots, sums, integrals, matrices, Greek letters, inequalities, etc.), write it as real math notation using LaTeX, not plain-text approximations like x^2 or sqrt(x). Use \\( ... \\) for inline math within a sentence, and $$ ... $$ on its own line for a standalone equation or a multi-step derivation. Never use a single $ for math (it is reserved for money) and never put LaTeX inside a code block unless the user specifically asked for LaTeX source code. Show step-by-step work as a sequence of $$ ... $$ blocks, one step per block, so each step is easy to read. Example: \\(a^2 + b^2 = c^2\\), or on its own line: $$\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$. For chemistry, write chemical formulas and reaction equations with \\ce{...} inside the same math delimiters, for example \\(\\ce{H2O}\\) or $$\\ce{2H2 + O2 -> 2H2O}$$; never write a chemical formula as plain text like H2O when \\ce{} is available. The app also reads math aloud when the user asks it to; it speaks the meaning of your LaTeX (\"x squared\", \"the square root of x\", and so on), so writing correct LaTeX also makes read-aloud sound right.",
  "4. TABLES: when the user asks for a table, use a normal markdown table.",
  "5. Everything else: normal markdown.",
  "6. ATTACHED FILES: the user can attach code or text files, PDFs, Word (.docx) and PowerPoint (.pptx) files, and zip archives. They appear inside <attached_file name=\"...\"> tags in the user's message. Read them carefully, refer to them by file name, and when you suggest a fix or a rewrite show the corrected code in a fenced code block. Never say you cannot open attached files; their full text is in the message. If a file was truncated, say so. A PDF's extracted text appears the same way, with \"--- Page N ---\" markers between pages; refer to page numbers when useful. A zip's contents appear as multiple attached_file blocks named \"zipname.zip/path/inside/the/zip\"; treat each as its own file but consider them together as one project when relevant, and note that non-text files inside the zip (images, binaries) were not included.",
  "7. IMAGES: the user can attach up to three images at once (including pages rendered from a scanned/image-only PDF) and you can see them. Describe and analyze each one accurately, read any text in them, and never claim you cannot see images. PAPERS AND HOMEWORK: when a photo shows a worksheet, homework, textbook page, handwritten notes or a whiteboard, read ALL of the text and every problem on it carefully (handwriting too), in order. Write math you read as LaTeX. If a word, number or symbol is hard to read, say exactly which one and give your best reading instead of silently guessing. Then do what the user asked: solve each problem step by step, explain, summarize or check their work; if they attached the photo with no message, briefly say what the paper contains and ask whether they want it solved, explained, or turned into study material with /quiz, /flashcards or /learn. When more than one image is attached, address them individually if they differ. Only say what is actually visible; if something is unclear, say so. Each attached image is one single photo/picture unless you can clearly see hard borders, gaps, or frames dividing it into separate panels \u2014 do not describe a single image as a \"four-panel collage\", \"grid\", or \"multiple photos\" just because it contains repeating or symmetric elements (tiles, windows, a 2x2-looking pattern, etc); if you are not certain it is genuinely a multi-panel collage, describe it as one image.",
  "8. IMAGE CREATION: this app can generate images. If the user wants a picture created and it was not created automatically, tell them to start their message with /image followed by a description, for example: /image a red sports car on a beach at sunset. Do not claim you cannot create images, and do not write code to make one unless they ask for code.",
  "9. IMAGE EDITING: this app can edit an existing image (either one the user attached, or the most recent image generated in the chat). If the user wants an image changed, tell them to start their message with /edit followed by a description of the change, for example: /edit make the sky purple. Do not claim you cannot edit images.",
  "10. ABOUT JYMER1102: if the user asks about jymer1102 (who they are, their site, their links, socials, projects, or how to contact them), share these two links, each as a plain URL on its own line so the app can show them as link preview cards: https://jymer1102.github.io/jymer1102 (their site) and https://linktr.ee/jymer1102 (all their links). Keep the text around them short and do not invent details about jymer1102 beyond what the links are.",
  "11. " + MATH_VISUALS_GUIDE + " If the user's message starts with /graph, /plot or /numberline, draw exactly what they describe (one mathviz block plus one or two short sentences, such as key points like intercepts or vertex).",
].join("\n");

// --- CHAT ---
// gpt-oss can't see images, so any request that contains an image goes to a vision model instead.
const TEXT_MODEL = process.env.TEXT_MODEL || "openai/gpt-oss-120b";
const VISION_MODEL = process.env.VISION_MODEL || "qwen/qwen3.8-27b";
const MAX_IMAGES_PER_REQUEST = 3; // qwen/qwen3.8-27b's hard limit is 3 images per request; older images are dropped to keep requests within that

// Keeps only the newest few images, only accepts inline (data:) images, and reports whether any remain.
function prepareMessages(messages) {
  let seen = 0;
  const cleaned = messages.slice().reverse().map(m => {
    if (!m || !Array.isArray(m.content)) return m;
    const parts = m.content.map(p => {
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

app.post("/chat", async (req, res) => {
  if (!Array.isArray(req.body.messages)) return res.status(400).json({ error: "No messages provided" });
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
      if (!web.enabled()) return quick("Web search isn't turned on for this site yet (the site owner needs to add a search API key). You can still ask your question without /search and I'll answer from what I know.");
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
    const message = known ? err.message : "Something went wrong";
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
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const style = prefsLib.readStyle(user.user_metadata);
  res.json({ style, rows: prefsRows(style) });
});
app.post("/prefs", async (req, res) => {
  const user = await auth.verify(auth.bearer(req));
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  let updates, notes = [];
  if (typeof req.body.command === "string") {
    const p = prefsLib.parseStyleArgs(req.body.command);
    if (p.error) return res.status(400).json({ error: p.error });
    if (p.show) { const s = prefsLib.readStyle(user.user_metadata); return res.json({ style: s, rows: prefsRows(s), notes: [] }); }
    updates = p.updates; notes = p.notes;
  } else if (req.body.updates && typeof req.body.updates === "object") {
    updates = prefsLib.cleanUpdates(req.body.updates);
  }
  if (!updates || !Object.keys(updates).length) return res.status(400).json({ error: "Nothing to change" });
  try {
    const style = await savePrefs(user, updates);
    res.json({ style, rows: prefsRows(style), notes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- LONG-TERM MEMORY (what the assistant remembers about you; you can see and delete all of it) ---
function memoryRoute(handler) {
  return async (req, res) => {
    const user = await auth.verify(auth.bearer(req));
    if (!user) return res.status(401).json({ error: "Unauthorized" });
    try { await handler(req, res, user); }
    catch (e) {
      if (e instanceof MemoryUnavailable) return res.status(503).json({ error: e.message });
      console.error("Memory route failed:", e && e.message ? e.message : e);
      res.status(500).json({ error: "Something went wrong" });
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

// --- STUDY MODES (/learn, /quiz, /flashcards) ---
// learn      -> a step-by-step markdown lesson
// quiz       -> multiple-choice questions, returned as a ```quiz JSON block the page turns into an interactive quiz
// flashcards -> front/back cards, returned as a ```flashcards JSON block the page turns into flip cards
// The JSON is validated here so the page never has to draw a broken quiz.
const STUDY_MAX_MATERIAL = 40000;

async function groqStudy(system, user, { json, maxTokens }) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: TEXT_MODEL,
      max_tokens: maxTokens,
      temperature: json ? 0.4 : 0.6,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const data = await response.json();
  if (!data.choices || !data.choices[0]) {
    const err = new Error(data.error && data.error.message ? `AI error: ${String(data.error.message).slice(0, 300)}` : "No response from AI");
    err.rate = data.error && data.error.code === "rate_limit_exceeded";
    throw err;
  }
  return String(data.choices[0].message.content || "");
}

function parseJsonLoose(text) {
  const t = String(text || "").replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}
const clip = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);

// A math picture attached to a quiz question / flashcard: keep it only if it is a plain object of reasonable size
const VISUAL_TYPES = ["graph", "geometry", "numberline", "fraction"];
function cleanVisual(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (!VISUAL_TYPES.includes(String(v.type || "").toLowerCase().replace(/[\s_-]/g, ""))) return null;
  try { if (JSON.stringify(v).length > 4000) return null; } catch (_) { return null; }
  return drawError(v) ? null : v;
}
function cleanQuiz(raw, want) {
  const list = raw && Array.isArray(raw.questions) ? raw.questions : [];
  const questions = [];
  for (const q of list) {
    const text = clip(q && (q.question || q.q), 400);
    const opts = Array.isArray(q && q.options) ? q.options.map(o => clip(o, 200).replace(/^[A-Da-d][).:]\s+/, "")).filter(Boolean) : [];
    if (!text || opts.length < 2 || opts.length > 6) continue;
    let ans = Number.isInteger(q.answer) ? q.answer : Number.isInteger(q.correct) ? q.correct : -1;
    if (ans < 0 && typeof q.answer === "string") {
      const L = q.answer.trim().toUpperCase();
      ans = /^[A-F]$/.test(L) ? L.charCodeAt(0) - 65 : opts.findIndex(o => o.toLowerCase() === q.answer.trim().toLowerCase());
    }
    if (ans < 0 || ans >= opts.length) continue;
    const visual = cleanVisual(q.visual);
    questions.push({ question: text, options: opts, answer: ans, explanation: clip(q.explanation, 500), ...(visual ? { visual } : {}) });
    if (questions.length >= want) break;
  }
  return questions.length ? { title: clip(raw.title, 80), questions } : null;
}
function cleanCards(raw, want) {
  const list = raw && Array.isArray(raw.cards) ? raw.cards : [];
  const cards = [];
  for (const c of list) {
    const front = clip(c && (c.front || c.term || c.q), 300);
    const back = clip(c && (c.back || c.definition || c.a), 600);
    if (front && back) {
      const fv = cleanVisual(c.frontVisual), bv = cleanVisual(c.backVisual);
      cards.push({ front, back, ...(fv ? { frontVisual: fv } : {}), ...(bv ? { backVisual: bv } : {}) });
    }
    if (cards.length >= want) break;
  }
  return cards.length ? { title: clip(raw.title, 80), cards } : null;
}


// Reads text out of photos/scans of paper (homework, notes, textbook pages) with the vision model.
const MAX_STUDY_PHOTOS = 6; // read in batches of 3 (the vision model's per-request limit)

async function transcribeChunk(list, start) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 3500,
      temperature: 0.1,
      messages: [{
        role: "user",
        content: [
          ...list.map(url => ({ type: "image_url", image_url: { url } })),
          { type: "text", text: "Transcribe everything written or printed on these page photos, in reading order, image by image (start each with 'Image N:'). Copy all text exactly, including handwriting. Number every problem or question as it appears. Write math as LaTeX inside \\( ... \\). Copy any table as a markdown table with every row and column. Describe any diagram or graph briefly in [square brackets]. Write [word?] after a handwritten word or digit you are unsure of. Mark words you truly cannot read as [illegible]. Do NOT solve anything and do NOT add commentary." + ` Number the images starting at Image ${start}.` },
        ],
      }],
    }),
  });
  const data = await response.json();
  if (!data.choices || !data.choices[0]) {
    const err = new Error(data.error && data.error.message ? `AI error: ${String(data.error.message).slice(0, 300)}` : "I couldn't read the image");
    err.rate = data.error && data.error.code === "rate_limit_exceeded";
    throw err;
  }
  return String(data.choices[0].message.content || "").trim();
}

async function transcribeImages(images) {
  const list = (Array.isArray(images) ? images : []).filter(u => typeof u === "string" && u.startsWith("data:image/")).slice(0, MAX_STUDY_PHOTOS);
  const parts = [];
  for (let i = 0; i < list.length; i += MAX_IMAGES_PER_REQUEST) {
    parts.push(await transcribeChunk(list.slice(i, i + MAX_IMAGES_PER_REQUEST), i + 1));
  }
  return parts.join("\n\n");
}

// Turns a web page into plain readable text (for "/quiz https://...")
function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|aside)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

app.post("/study", async (req, res) => {
  const mode = String(req.body.mode || "");
  if (!["learn", "quiz", "flashcards"].includes(mode)) return res.status(400).json({ error: "Unknown study mode" });
  let topic = clip(req.body.topic, 300);
  let material = String(req.body.material || "").slice(0, STUDY_MAX_MATERIAL);
  const context = String(req.body.context || "").slice(0, 12000);
  const images = Array.isArray(req.body.images) ? req.body.images : [];
  if (!topic && !material.trim() && !context.trim() && !images.length) return res.status(400).json({ error: "Nothing to study yet" });

  try {
    // A link as the topic: read that page and study it
    if (/^https?:\/\/\S+$/i.test(topic) && !material.trim()) {
      try {
        const { html } = await fetchPageHtml(new URL(topic));
        const text = htmlToText(html).slice(0, STUDY_MAX_MATERIAL);
        if (text.length > 200) { material = `--- ${topic} ---\n${text}`; topic = ""; }
        else return res.status(422).json({ error: "I couldn't read any text on that page. Try pasting the text instead." });
      } catch (_) {
        return res.status(422).json({ error: "I couldn't open that link. Try pasting the text instead." });
      }
    }
    // Photos of paper: read the words and problems off them first
    if (images.length) {
      const seen = await transcribeImages(images);
      if (seen.replace(/\W/g, "").length < 15) return res.status(422).json({ error: "I couldn't find readable text in that photo. Try a sharper, well-lit picture with the whole page in frame." });
      material = (material ? material + "\n\n" : "") + "--- Text read from the photo(s) ---\n" + seen;
      material = material.slice(0, STUDY_MAX_MATERIAL);
    }
  } catch (err) {
    if (err.rate) return res.status(429).json({ error: "Token limit reached. Please try again in a minute." });
    console.error("Study prep error:", err);
    return res.status(500).json({ error: err.message && /^AI error/.test(err.message) ? err.message : "Something went wrong" });
  }
  const count = Math.max(1, Math.min(parseInt(req.body.count, 10) || (mode === "quiz" ? 8 : 12), mode === "quiz" ? 20 : 40));

  const source =
    (material.trim() ? `STUDY MATERIAL (base everything on this):\n${material}\n\n` : "") +
    (topic ? `TOPIC: ${topic}\n\n` : "") +
    (!material.trim() && !topic ? `CONVERSATION SO FAR (study what it covered):\n${context}\n\n` : "");

  try {
    if (mode === "learn") {
      const md = await groqStudy(
        "You are a patient, friendly tutor. Teach the topic as a short lesson a curious student can follow. Use this structure with markdown headings: '## The big idea' (2-3 sentences, plain language), '## Key concepts' (3-5 bullets, each one short with a concrete example), '## Worked example' (one step-by-step example), '## Common mistakes' (2-3 bullets). Then end with '## Check yourself' containing 2 short questions and one line telling the student to reply with their answers so you can give feedback. Use $$...$$ for math if needed. If study material is provided, teach from it; if it is homework or a worksheet of problems, teach the concepts needed to solve them and include one of its problems as the worked example. Write math as LaTeX inside \\( ... \\) or $$ ... $$. Keep the whole lesson under 450 words. Do not use emojis. " + MATH_VISUALS_GUIDE + " For math topics, include one or two mathviz pictures (for example the graph, number line, or diagram being taught) inside the lesson; skip pictures for non-math topics.",
        source, { json: false, maxTokens: 1800 });
      return res.json({ reply: dropBrokenMathBlocks(md.trim()).text });
    }

    if (mode === "quiz") {
      const raw = await groqStudy(
        `You write multiple-choice quizzes. Reply with ONLY a JSON object: {"title": string, "questions": [{"question": string, "options": [4 strings], "answer": index 0-3 of the correct option, "explanation": one or two sentences on why it is correct}]}. Write exactly ${count} questions. Exactly one option is correct, the wrong options must be plausible, and the correct answer must vary in position. Do not put letters like "A)" in the options. Mix easy and harder questions. If study material is provided, only ask about what it contains. If the material is homework or a worksheet of problems, write questions that test the same skills and concepts (you may reuse or vary the problems); write math as LaTeX inside \\( ... \\). For math questions that depend on a picture (reading a graph, a number line, a geometry figure), you may add a "visual" field to that question holding a mathviz JSON object as described here; the question must be answerable from that picture, and most questions need no visual. ${MATH_VISUALS_GUIDE}`,
        source, { json: true, maxTokens: 4000 });
      const quiz = cleanQuiz(parseJsonLoose(raw), count);
      if (!quiz) return res.status(502).json({ error: "I couldn't build a quiz from that. Try again or give me a more specific topic." });
      if (!quiz.title) quiz.title = topic || "Quiz";
      return res.json({ reply: "Here's your quiz. Pick an answer for each question.\n\n```quiz\n" + JSON.stringify(quiz) + "\n```" });
    }

    const raw = await groqStudy(
      `You write study flashcards. Reply with ONLY a JSON object: {"title": string, "cards": [{"front": string, "back": string}]}. Write exactly ${count} cards. The front is a short term, question or prompt; the back is a clear answer in one or two sentences. Each card covers one idea, no duplicates. If study material is provided, only use what it contains. For math cards you may add "frontVisual" or "backVisual" holding a mathviz JSON object described here (for example a graph on the front, or a labelled diagram on the back); most cards need none. ${MATH_VISUALS_GUIDE}`,
      source, { json: true, maxTokens: 4000 });
    const deck = cleanCards(parseJsonLoose(raw), count);
    if (!deck) return res.status(502).json({ error: "I couldn't build flashcards from that. Try again or give me a more specific topic." });
    if (!deck.title) deck.title = topic || "Flashcards";
    res.json({ reply: "Here are your flashcards. Tap a card to flip it.\n\n```flashcards\n" + JSON.stringify(deck) + "\n```" });
  } catch (err) {
    if (err.rate) return res.status(429).json({ error: "Token limit reached. Please try again in a minute." });
    console.error("Study error:", err);
    res.status(500).json({ error: err.message && /^AI error/.test(err.message) ? err.message : "Something went wrong" });
  }
});

// --- MATH PICTURES (/graph, and a safety net for graph requests in normal chat) ---
// The chat model sometimes answers "graph y = x^2" with Python/ASCII instead of the ```mathviz block the page can draw.
// This asks the model for ONLY the drawing JSON, validates it, and returns a block the page turns into a real graph.
function visualKind(v) {
  const t = String(v.type || "").toLowerCase().replace(/[\s_-]/g, "");
  if (["numberline", "number"].includes(t)) return "numberline";
  if (["fraction", "fractions", "fractionmodel"].includes(t)) return "fraction";
  if (["graph", "plane", "function", "functions", "geometry", "coordinateplane", "cartesian", "polar", "parametric", "diagram", "mathviz", ""].includes(t)) {
    if (!t) {
      if (Array.isArray(v.items)) return "fraction";
      if (Array.isArray(v.intervals) || Array.isArray(v.arcs) || (Array.isArray(v.points) && v.points.some(p => p && p.value != null))) return "numberline";
    }
    return "graph";
  }
  return null;
}
const VISUAL_CONTENT_KEYS = ["functions", "inequalities", "areas", "parametric", "polar", "points", "segments", "vectors", "polygons", "circles", "angles", "texts", "vlines", "hlines", "intervals", "arcs", "items"];
function validMathVisual(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const kind = visualKind(v);
  if (!kind) return null;
  if (kind === "fraction" ? !(Array.isArray(v.items) && v.items.length) && v.numerator == null : !VISUAL_CONTENT_KEYS.some(k => Array.isArray(v[k]) && v[k].length)) return null;
  try { if (JSON.stringify(v).length > 12000) return null; } catch (_) { return null; }
  const out = { ...v, type: kind };
  if (kind === "numberline" && Array.isArray(out.intervals)) {
    // "x < 2" drawn as from:-5 (the window edge) should run off to infinity with an arrow, not start with a dot
    const lo = Number(out.min), hi = Number(out.max);
    out.intervals = out.intervals.map(iv => {
      if (!iv || typeof iv !== "object") return iv;
      const c = { ...iv };
      if (Number.isFinite(lo) && c.from != null && Number(c.from) <= lo) { delete c.from; delete c.fromOpen; }
      if (Number.isFinite(hi) && c.to != null && Number(c.to) >= hi) { delete c.to; delete c.toOpen; }
      return c;
    });
  }
  return out;
}
// Runs the SAME renderer the page uses (public/js/mathviz.js) inside a sandbox, so a drawing is only
// accepted when it really draws. If the AI wrote an expression the renderer can't read, we find out here
// (and can ask the AI to fix it) instead of the user seeing an error box.
let mathvizModule = null;
function getMathviz() {
  if (mathvizModule !== null) return mathvizModule;
  try {
    const code = fs.readFileSync(path.join(__dirname, "public", "js", "mathviz.js"), "utf8");
    const classList = { contains: () => false, add() {}, remove() {} };
    const node = () => ({ style: {}, classList, appendChild() {}, append() {}, addEventListener() {}, setAttribute() {}, querySelector: () => null });
    const sandbox = { console, Math, document: { body: { classList }, documentElement: { classList }, createElement: node } };
    sandbox.window = sandbox;
    vm.runInNewContext(code, sandbox, { timeout: 3000 });
    mathvizModule = sandbox.agent1102MathViz && sandbox.agent1102MathViz._svgFor ? sandbox.agent1102MathViz : false;
  } catch (e) {
    console.error("mathviz checker unavailable:", e.message);
    mathvizModule = false;
  }
  return mathvizModule;
}
// -> null when the spec draws fine (or the checker isn't available), otherwise a short reason
function drawError(spec) {
  const mv = getMathviz();
  if (!mv) return null;
  try { const out = mv._svgFor(spec); return out && out.svg && out.svg.length > 200 ? null : "it drew nothing"; }
  catch (e) { return e && e.message ? e.message : "it could not be drawn"; }
}
// Keeps good ```mathviz blocks in an AI reply and removes the ones that can't be drawn
function dropBrokenMathBlocks(text) {
  let broken = 0, good = 0;
  const out = String(text).replace(/```(?:mathviz|mathgraph|math-visual)[^\n]*\n([\s\S]*?)```/gi, (whole, body) => {
    const mv = getMathviz();
    let spec = null;
    try { spec = mv ? mv.parseLoose(body) : JSON.parse(body); } catch (_) {}
    if (spec && typeof spec === "object" && !Array.isArray(spec) && !drawError(spec)) { good++; return whole; }
    broken++; return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, broken, good };
}

async function generateMathVisual(request, context) {
  const system =
    "You turn a math request into a drawing for a chat app. Reply with ONLY one JSON object (no code fences, no text around it) in this format. " + MATH_VISUALS_GUIDE +
    ' Also add a "caption" field: one or two short sentences saying what the picture shows and its key features (intercepts, vertex, asymptotes, solution set, side lengths). Pick xMin, xMax, yMin, yMax so every key feature is visible. Draw everything the user asked for in ONE picture. Always include at least one of: functions, inequalities, areas, parametric, polar, points, segments, polygons, circles, angles, intervals, arcs or items.';
  const user = (context ? `CONVERSATION SO FAR (for references like "that equation"):\n${context}\n\n` : "") + `REQUEST: ${request}`;
  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await groqStudy(system, user + feedback, { json: true, maxTokens: 2500 });
    const obj = parseJsonLoose(raw);
    const spec = validMathVisual(obj);
    if (!spec) { feedback = "\n\nYour last reply was not a usable drawing. Reply with ONLY one JSON object that has at least one of: functions, inequalities, areas, points, segments, polygons, circles, intervals, items."; continue; }
    const caption = clip(spec.caption, 400);
    delete spec.caption;
    const bad = drawError(spec);
    if (bad) { feedback = `\n\nYour last drawing failed: ${bad}. Write every expression in plain text such as x^2 - 4, sin(x), sqrt(x), 1/(x-2), abs(x), e^x (no LaTeX, no backslashes, no y = prefix) and reply with ONLY the corrected JSON object.`; continue; }
    return { caption, block: "```mathviz\n" + JSON.stringify(spec) + "\n```" };
  }
  return null;
}
const wantsMathVisual = t => {
  t = String(t || "");
  if (/^\s*\/(graph|plot|numberline)\b/i.test(t)) return true;
  // they want to write/run plotting code or a spreadsheet chart, not see a picture
  if (/\b(python|matplotlib|numpy|javascript|code|script|excel|google sheets|tikz|latex|desmos|geogebra|ggplot|r language)\b/i.test(t)) return false;
  if (/\bnumber\s?lines?\b/i.test(t)) return true;
  if (/\b(bar|pie|scatter|histogram)\s+(graph|chart|plot)\b/i.test(t)) return false; // data charts use the chart block
  if (/\b(graph|plot|sketch)\b/i.test(t) &&
      /(\b[xy]\b|\b\d|\bsin|\bcos|\btan|\blog|\bln\b|sqrt|function|equation|inequalit|parabola|\bline\b|curve|circle|ellipse|hyperbola|slope|intercept|vertex|asymptote|quadratic|linear|exponential|cubic|absolute value|points?\b)/i.test(t)) return true;
  return /\b(draw|sketch|show|illustrate|diagram|visuali[sz]e)\b[^.?!\n]{0,60}\b(triangle|polygon|angle|fractions?|parabola|unit circle|vector|rectangle|square)\b/i.test(t);
};

app.post("/graph", async (req, res) => {
  const request = clip(req.body.request, 1000);
  const context = String(req.body.context || "").slice(0, 6000);
  if (!request && !context.trim()) return res.status(400).json({ error: "Tell me what to draw" });
  try {
    const out = await generateMathVisual(request || "Draw the math from the conversation so far.", context);
    if (!out) return res.status(502).json({ error: "I couldn't draw that one. Try describing it a little differently, for example: y = x^2 - 4, or a number line for -2 < x <= 3." });
    res.json({ reply: (out.caption ? out.caption + "\n\n" : "") + out.block });
  } catch (err) {
    if (err.rate) return res.status(429).json({ error: "Token limit reached. Please try again in a minute." });
    console.error("Graph error:", err);
    res.status(500).json({ error: err.message && /^AI error/.test(err.message) ? err.message : "Something went wrong" });
  }
});

// --- CHAT TITLE (auto-summarize the conversation for the sidebar) ---
// One AI-written title for a conversation. Used by the /title route (automatic titles while chatting) and by
// "rename -> leave empty" (PATCH /chats/:id { auto: true }), so both produce exactly the same kind of title.
// Throws an Error with .status (400 nothing to summarize, 429 rate limited, 500 anything else).
async function generateChatTitle(messages) {
  // Compact, text-only transcript: strip attached_file blocks/images down to short
  // markers and cap each turn's length so the summarizer call stays small and cheap.
  const transcript = messages.slice(-40).map(m => {
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) text = m.content.filter(p => p && p.type === "text").map(p => p.text).join(" ");
    text = text.replace(/<attached_file[^>]*>[\s\S]*?<\/attached_file>/g, "[attached file]").trim().slice(0, 800);
    if (!text) return null;
    return `${m.role === "user" ? "User" : "Assistant"}: ${text}`;
  }).filter(Boolean).join("\n");

  if (!transcript.trim()) { const e = new Error("Nothing to summarize"); e.status = 400; throw e; }

  let content;
  try {
    content = await groq.complete({
      model: TEXT_MODEL,
      // gpt-oss is a reasoning model: a tiny max_tokens gets eaten by reasoning and
      // returns an empty title, so leave headroom and keep reasoning low.
      max_tokens: 400,
      reasoning_effort: "low",
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content: "You write the title for a chat conversation: a one-line AI overview of what the whole chat is about. Read the whole conversation (what the user wanted and what was covered or answered) and reply with ONLY a specific, informative overview of 5-10 words, in sentence case (for example: \"Debugging a Node.js login bug and fixing token expiry\"). Cover the overall arc, not just the first message. Do not use quotes, a trailing period, or a prefix like \"Title:\" \u2014 reply with just the title text itself.",
        },
        { role: "user", content: transcript },
      ],
    });
  } catch (err) {
    if (err instanceof groq.GroqError) { const e = new Error(err.message); e.status = err.status === 429 ? 429 : 500; throw e; }
    throw err;
  }
  const title = String(content || "").replace(/^["'\s]+|["'\s.]+$/g, "").replace(/\s+/g, " ").slice(0, 90);
  if (!title) { console.warn("Title generation returned empty content"); const e = new Error("No title generated"); e.status = 500; throw e; }
  return title;
}

app.post("/title", async (req, res) => {
  if (!Array.isArray(req.body.messages) || !req.body.messages.length) {
    return res.status(400).json({ error: "No messages provided" });
  }
  try {
    res.json({ title: await generateChatTitle(req.body.messages) });
  } catch (err) {
    if (err.status === 400 || err.status === 429) return res.status(err.status).json({ error: err.message });
    if (err.status === 500) return res.status(500).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Title generation failed" });
  }
});

// --- LINK PREVIEW (title / description / image for the cards under AI replies) ---
// Fetches the page server-side (the browser can't, CORS) and reads its Open Graph tags.
// SSRF-safe: http(s) only, public IPs only (re-checked on every redirect), small body, short timeout.
const LINK_PREVIEW_TTL = 6 * 60 * 60 * 1000;
const linkPreviewCache = new Map();
// Sites that block bots: show a good card anyway.
const KNOWN_PREVIEWS = {
  "jymer1102.github.io": { title: "jymer1102", description: "jymer1102's website.", image: "/images/jymer1102_horizontal_banner.png", siteName: "jymer1102.github.io" },
  "linktr.ee": { title: "jymer1102 | Linktree", description: "All of jymer1102's links in one place.", image: "/images/jymer1102_horizontal_banner.png", siteName: "Linktree" },
};

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return m ? isPrivateIp(m[1]) : false;
  }
  return true;
}
async function assertPublicUrl(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  if (u.username || u.password) throw new Error("credentials in url");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error("private address"); return; }
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error("private address");
}
async function fetchPageHtml(startUrl) {
  let u = startUrl;
  for (let i = 0; i < 4; i++) {
    await assertPublicUrl(u);
    const r = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; agent1102LinkPreview/1.0)", "Accept": "text/html,application/xhtml+xml" },
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { u = new URL(r.headers.get("location"), u); continue; }
    if (!r.ok) throw new Error("status " + r.status);
    if (!/text\/html|application\/xhtml/i.test(r.headers.get("content-type") || "")) throw new Error("not html");
    // read at most ~512KB
    const reader = r.body.getReader();
    const chunks = []; let total = 0;
    while (total < 512 * 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
    try { await reader.cancel(); } catch (_) {}
    return { html: Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8"), finalUrl: u };
  }
  throw new Error("too many redirects");
}
const decodeEntities = t => String(t || "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
function metaContent(html, keys) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const key of keys) {
    for (const tag of tags) {
      const name = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
      if (!name || name[1].toLowerCase() !== key) continue;
      const c = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
      const val = c && (c[2] ?? c[3]);
      if (val && val.trim()) return decodeEntities(val).trim();
    }
  }
  return "";
}
function parsePreview(html, finalUrl) {
  const head = html.slice(0, 400 * 1024);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const title = metaContent(head, ["og:title", "twitter:title"]) || decodeEntities(titleTag ? titleTag[1] : "").replace(/\s+/g, " ").trim();
  const description = metaContent(head, ["og:description", "twitter:description", "description"]);
  let image = metaContent(head, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  if (image) { try { const iu = new URL(image, finalUrl); image = /^https?:$/.test(iu.protocol) ? iu.href : ""; } catch (_) { image = ""; } }
  const siteName = metaContent(head, ["og:site_name"]) || finalUrl.hostname.replace(/^www\./, "");
  return { title: title.slice(0, 160), description: description.slice(0, 240), image, siteName: siteName.slice(0, 80) };
}
app.get("/link-preview", async (req, res) => {
  let u;
  try { u = new URL(String(req.query.url || "")); } catch (_) { return res.status(400).json({ error: "Invalid url" }); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return res.status(400).json({ error: "Invalid url" });
  const key = u.href;
  const hit = linkPreviewCache.get(key);
  if (hit && Date.now() - hit.at < LINK_PREVIEW_TTL) return res.json(hit.data);
  const host = u.hostname.replace(/^www\./, "");
  let data;
  try {
    const { html, finalUrl } = await fetchPageHtml(u);
    data = parsePreview(html, finalUrl);
  } catch (err) {
    data = { title: "", description: "", image: "", siteName: host };
  }
  const known = KNOWN_PREVIEWS[host];
  if (known && (host !== "linktr.ee" || /^\/jymer1102\/?$/i.test(u.pathname)) && (host !== "jymer1102.github.io" || /^\/jymer1102\/?$/i.test(u.pathname) || u.pathname === "/")) {
    data = { title: data.title || known.title, description: data.description || known.description, image: data.image || known.image, siteName: data.siteName || known.siteName };
  }
  linkPreviewCache.set(key, { at: Date.now(), data });
  if (linkPreviewCache.size > 500) linkPreviewCache.delete(linkPreviewCache.keys().next().value);
  res.set("Cache-Control", "public, max-age=3600").json(data);
});

// --- IMAGE GENERATION ---
app.post("/generate-image", async (req, res) => {
  const { prompt } = req.body;
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "No prompt provided" });
  try {
    // encodeURIComponent leaves ! ' ( ) * alone; encode them too so the URL can't break markdown
    const encoded = encodeURIComponent(prompt.trim().slice(0, 500)).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    const seed = Math.floor(Math.random() * 1e9); // new seed = a fresh image every time
    const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=768&height=768&nologo=true&seed=${seed}`;
    res.json({ imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Image generation failed" });
  }
});

// --- IMAGE EDITING ("/edit") ---
// Runs on the server because Pollinations' image-edit endpoint needs an API
// key (set POLLINATIONS_API_KEY in Render; get one at enter.pollinations.ai)
// and that key must never reach the browser. Flow: get the source image bytes
// (an attached photo, or the previously generated image), send them plus the
// prompt to Pollinations, save the result in the public "chat-uploads"
// Supabase Storage bucket, and return that URL for the chat to display.
// EDIT_MODEL (default "kontext") can be changed without touching code.
const CHAT_UPLOAD_BUCKET = "chat-uploads";
const EDIT_MAX_BYTES = 10 * 1024 * 1024;

// Create the bucket on startup if it isn't there yet (no manual dashboard step).
(async () => {
  try {
    const { error } = await supabaseAdmin.storage.createBucket(CHAT_UPLOAD_BUCKET, { public: true, fileSizeLimit: EDIT_MAX_BYTES });
    if (error && !/already exists|duplicate/i.test(error.message)) {
      console.warn(`WARNING: couldn't create the "${CHAT_UPLOAD_BUCKET}" storage bucket (/edit needs it): ${error.message}`);
    }
  } catch (err) {
    console.warn("WARNING: storage bucket check failed:", err && err.message ? err.message : err);
  }
})();

function sniffImageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}
const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function loadEditSource({ imageUrl, imageBase64 }) {
  let buf;
  if (typeof imageBase64 === "string" && imageBase64) {
    const m = /^data:image\/(?:jpeg|png|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(imageBase64);
    if (!m) throw new Error("Attached image isn't a supported format (JPG, PNG, or WEBP).");
    buf = Buffer.from(m[1], "base64");
  } else {
    let u;
    try { u = new URL(imageUrl); } catch (_) { throw new Error("Invalid image URL."); }
    const ownHost = new URL(process.env.SUPABASE_URL).hostname;
    const okHost = u.protocol === "https:" && (u.hostname === "image.pollinations.ai" || u.hostname === "media.pollinations.ai" || u.hostname === "gen.pollinations.ai" || u.hostname === ownHost);
    if (!okHost) throw new Error("I can only edit images from this chat.");
    const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`Couldn't load the image to edit (${r.status}).`);
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (buf.length > EDIT_MAX_BYTES) throw new Error(`Image is too large. Max ${EDIT_MAX_BYTES / 1024 / 1024}MB.`);
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error("That doesn't look like a JPG, PNG, or WEBP image.");
  return { buf, mime };
}

app.post("/edit-image", async (req, res) => {
  const { prompt, imageUrl, imageBase64 } = req.body;
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "No prompt provided" });
  if (typeof imageUrl !== "string" && typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "No image provided to edit" });
  }
  const key = (process.env.POLLINATIONS_API_KEY || "").trim();
  if (!key) {
    return res.status(503).json({ error: "Image editing isn't set up yet: the server needs a POLLINATIONS_API_KEY (free at enter.pollinations.ai)." });
  }
  try {
    const src = await loadEditSource({ imageUrl, imageBase64 });

    const form = new FormData();
    form.append("image", new Blob([src.buf], { type: src.mime }), `image.${MIME_EXT[src.mime]}`);
    form.append("prompt", prompt.trim().slice(0, 500));
    form.append("model", process.env.EDIT_MODEL || "kontext");
    const r = await fetch("https://gen.pollinations.ai/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const raw = await r.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (_) {}
    if (!r.ok) {
      const detail = (json && (json.error && (json.error.message || json.error))) || raw.slice(0, 200);
      console.error("Pollinations edit failed:", r.status, raw.slice(0, 500));
      return res.status(502).json({ error: `Image edit service error (${r.status}). ${typeof detail === "string" ? detail.slice(0, 160) : ""}`.trim() });
    }

    const item = json && Array.isArray(json.data) ? json.data[0] : null;
    let out;
    if (item && item.b64_json) out = Buffer.from(item.b64_json, "base64");
    else if (item && item.url) {
      const ir = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
      if (!ir.ok) throw new Error("Couldn't download the edited image.");
      out = Buffer.from(await ir.arrayBuffer());
    } else {
      console.error("Unexpected edit response:", raw.slice(0, 500));
      return res.status(502).json({ error: "The image edit service returned no image." });
    }

    const mime = sniffImageMime(out) || "image/png";
    const filePath = `edits/${Date.now()}-${Math.random().toString(36).slice(2)}.${MIME_EXT[mime]}`;
    const { error: upErr } = await supabaseAdmin.storage.from(CHAT_UPLOAD_BUCKET).upload(filePath, out, { contentType: mime, cacheControl: "31536000", upsert: false });
    if (upErr) throw new Error("Couldn't save the edited image: " + upErr.message);
    const publicUrl = supabaseAdmin.storage.from(CHAT_UPLOAD_BUCKET).getPublicUrl(filePath).data.publicUrl;
    res.json({ imageUrl: publicUrl });
  } catch (err) {
    console.error("Image edit failed:", err);
    res.status(500).json({ error: (err && err.message) || "Image editing failed" });
  }
});

// --- READ ALOUD (real audio, so it plays even with the phone's mute switch on) ---
// Uses ElevenLabs (an API key is required: set ELEVENLABS_API_KEY). If it isn't
// configured, the client automatically falls back to the browser's own voice.
const TTS_VOICE_ID = process.env.TTS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel", one of ElevenLabs' default voices
const TTS_MODEL = process.env.TTS_MODEL || "eleven_flash_v2_5"; // low-latency model; good fit for a chat reply
app.post("/tts", async (req, res) => {
  const { text } = req.body;
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "No text provided" });
  if (!process.env.ELEVENLABS_API_KEY) {
    // Not a user-facing failure: the client treats this as "not set up yet" and
    // quietly uses the browser's built-in voice instead.
    return res.status(501).json({ error: "tts_not_configured" });
  }
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${TTS_VOICE_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
      },
      // 3,000 characters keeps a single request comfortably inside ElevenLabs' limits;
      // the client already sends replies in smaller chunks anyway.
      body: JSON.stringify({ text: text.slice(0, 3000), model_id: TTS_MODEL }),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).detail?.message || ""; } catch (_) {}
      if (response.status === 401) { console.error("ElevenLabs: invalid API key"); return res.status(501).json({ error: "tts_not_configured" }); }
      if (response.status === 429) return res.status(429).json({ error: "Read-aloud has used up its monthly quota. It'll fall back to your device's own voice for now." });
      console.error("ElevenLabs error:", response.status, detail);
      return res.status(500).json({ error: "Couldn't generate audio" });
    }
    res.setHeader("Content-Type", "audio/mpeg");
    const buf = Buffer.from(await response.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't generate audio" });
  }
});

// --- AUTH ---
app.post("/auth/refresh", async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(401).json({ error: "Missing refresh token" });
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error) {
    // 401 = Supabase rejected the token (expired, already used, revoked): the saved login is dead and the
    // user has to sign in again. Anything else (network blip, Supabase 5xx, rate limit) is temporary, so
    // answer 503 and the client keeps the saved login and retries later instead of signing the user out.
    const rejected = error.status >= 400 && error.status < 500 && error.status !== 429;
    return res.status(rejected ? 401 : 503).json({ error: error.message });
  }
  res.json({ session: data.session });
});

app.post("/auth/update", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const { name, email, password } = req.body;
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData.user) {
    return res.status(401).json({ error: "Unauthorized — token may be expired. Try logging out and back in." });
  }
  const user = userData.user;
  const updates = {};
  if (email) updates.email = email;
  if (password) updates.password = password;
  if (name) updates.data = { ...user.user_metadata, name };
  const { data, error } = await supabaseAdmin.auth.admin.updateUserById(user.id, updates);
  if (error) return res.status(500).json({ error: error.message });

  // keep profiles table in sync
  if (name || email) {
    await supabaseAdmin.from("profiles").upsert({
      id: user.id,
      ...(name && { name }),
      ...(email && { email }),
      updated_at: new Date().toISOString()
    });
  }

  // keep the username on the score tables in sync too
  if (name) {
    await Promise.all(["trex_highscores", "pacman_highscores"].map(table =>
      supabaseAdmin.from(table).update({ username: name }).eq("user_id", user.id)
    ));
  }
  // and the identity columns on saved chats (ignore errors if the columns aren't added yet)
  if (name || email) {
    await supabaseAdmin.from("chats").update({ ...(name && { username: name }), ...(email && { email }) }).eq("user_id", user.id).then(() => {}, () => {});
  }

  res.json({ success: true, user: data.user });
});

// --- EASTER EGG PROGRESS ---
// Which easter eggs an account has unlocked (and whether the background is switched on) is saved in the
// user's Supabase auth metadata (user_metadata.easter_eggs), so it follows them to any device or browser.
// This needs no table or SQL migration.
function readEggs(meta) {
  const e = (meta && meta.easter_eggs) || {};
  return {
    background_unlocked: e.background_unlocked === true,
    background_on: typeof e.background_on === "boolean" ? e.background_on : null, // null = never set
    dino: e.dino === true,
    pacman: e.pacman === true,
  };
}

async function eggUser(req) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data?.user ? null : data.user;
}

app.get("/easter-eggs", async (req, res) => {
  const user = await eggUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  res.json({ eggs: readEggs(user.user_metadata) });
});

app.post("/easter-eggs", async (req, res) => {
  const user = await eggUser(req);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const current = readEggs(user.user_metadata);
  const incoming = req.body?.eggs || {};
  const merged = {
    // once found, always found: unlocks can be added but never taken away
    background_unlocked: current.background_unlocked || incoming.background_unlocked === true,
    dino: current.dino || incoming.dino === true,
    pacman: current.pacman || incoming.pacman === true,
    // the on/off switch is a preference, so the latest value wins
    background_on: typeof incoming.background_on === "boolean" ? incoming.background_on : current.background_on,
  };
  if (JSON.stringify(merged) !== JSON.stringify(current)) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      user_metadata: { ...user.user_metadata, easter_eggs: merged },
    });
    if (error) return res.status(500).json({ error: error.message });
  }
  res.json({ eggs: merged });
});

// --- AVATARS ---
// Profile pictures live in the public "avatars" Supabase Storage bucket, stored exactly as
// uploaded (no resizing or re-encoding). The public URL is saved in profiles.avatar_url, which
// is what every device reads after signing in.
const AVATAR_BUCKET = "avatars";
const AVATAR_MAX_BYTES = 10 * 1024 * 1024; // keep in sync with the bucket's file_size_limit
const AVATAR_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

// Don't trust the Content-Type header, check the file's real magic bytes.
function sniffImageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// Delete a user's stored avatar files (all of them, or all except `keep`).
async function removeUserAvatars(userId, keep) {
  const { data: files } = await supabaseAdmin.storage.from(AVATAR_BUCKET).list(userId, { limit: 100 });
  const stale = (files || []).map(f => `${userId}/${f.name}`).filter(p => p !== keep);
  if (stale.length) await supabaseAdmin.storage.from(AVATAR_BUCKET).remove(stale);
}

// The client POSTs the raw image file as the body (Content-Type: image/jpeg | png | webp).
app.post("/auth/avatar",
  express.raw({ type: Object.keys(AVATAR_TYPES), limit: AVATAR_MAX_BYTES }),
  async (req, res) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const { data: userData, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !userData.user) {
      return res.status(401).json({ error: "Unauthorized — token may be expired. Try logging out and back in." });
    }
    const userId = userData.user.id;

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: "Send the image file as the request body (JPG, PNG, or WEBP)." });
    }
    const contentType = sniffImageType(req.body);
    if (!contentType) return res.status(400).json({ error: "Only JPG, PNG, and WEBP images are allowed." });

    // A new filename per upload means the CDN/browser never serves a stale picture.
    const filePath = `${userId}/avatar-${Date.now()}.${AVATAR_TYPES[contentType]}`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(AVATAR_BUCKET)
      .upload(filePath, req.body, { contentType, cacheControl: "31536000", upsert: false });
    if (uploadErr) return res.status(500).json({ error: uploadErr.message });

    const avatar_url = supabaseAdmin.storage.from(AVATAR_BUCKET).getPublicUrl(filePath).data.publicUrl;
    const { error: dbErr } = await supabaseAdmin
      .from("profiles")
      .upsert({ id: userId, avatar_url, updated_at: new Date().toISOString() });
    if (dbErr) {
      await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([filePath]);
      return res.status(500).json({ error: dbErr.message });
    }

    // Only one picture per user is kept, so storage doesn't grow with every change.
    removeUserAvatars(userId, filePath).catch(err => console.warn("Avatar cleanup failed:", err.message));
    res.json({ success: true, avatar_url });
  }
);

app.delete("/auth/delete", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData.user) return res.status(401).json({ error: "Unauthorized" });
  const userId = userData.user.id;
  await supabaseAdmin.from("chats").delete().eq("user_id", userId);
  await supabaseAdmin.from("user_memories").delete().eq("user_id", userId).then(() => {}, () => {}); // ignore if memory.sql was never run
  await removeUserAvatars(userId).catch(err => console.warn("Avatar cleanup failed:", err.message));
  await supabaseAdmin.from("profiles").delete().eq("id", userId);
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get("/auth/oauth/:provider", async (req, res) => {
  const { provider } = req.params;
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${process.env.SITE_URL || "https://agent1102.onrender.com"}/auth/callback` }
  });
  if (error) return res.status(400).json({ error: error.message });
  res.redirect(data.url);
});

app.get("/auth/callback", (req, res) => {
  res.send(`
    <script>
      const hash = window.location.hash;
      const params = new URLSearchParams(hash.replace('#', ''));
      const token = params.get('access_token');
      const refresh = params.get('refresh_token');
      if (token) {
        localStorage.setItem('agent1102_token', token);
        // without this the OAuth login would end when the access token expires (about an hour)
        if (refresh) localStorage.setItem('agent1102_refresh_token', refresh);
        window.location.href = '/';
      } else {
        window.location.href = '/?error=oauth_failed';
      }
    </script>
  `);
});

app.post("/auth/signup", async (req, res) => {
  const { email, password, name, phone } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  try {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { name, phone } }
    });
    if (error) {
      console.log(`SIGNUP ERROR MESSAGE: ${error.message} (status ${error.status})`);
      return res.status(400).json({ error: error.message });
    }
    // If "Confirm email" is enabled in Supabase's Auth settings (the default for
    // new projects), signUp succeeds but issues no session until the user clicks
    // the confirmation link in their email — data.session is null in that case.
    // Tell the client explicitly instead of letting it crash on session.access_token.
    if (!data.session) {
      return res.json({ user: data.user, session: null, needsConfirmation: true });
    }
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    console.error("Signup failed:", err);
    res.status(500).json({ error: "Signup failed. Check server logs for details." });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.log(`LOGIN ERROR MESSAGE: ${error.message} (status ${error.status})`);
      return res.status(400).json({ error: error.message });
    }
    res.json({ user: data.user, session: data.session });
  } catch (err) {
    console.error("Login failed:", err);
    res.status(500).json({ error: "Login failed. Check server logs for details." });
  }
});

// --- CHATS ---
// One row per conversation. Every row carries the owner's uid (user_id), username, email and phone,
// plus the FULL conversation in `history` (jsonb). Run supabase/chats.sql once to add the columns
// and lock the table down with Row Level Security. All access goes through the service key here,
// always filtered by the user id taken from the verified token.
async function getUserInfo(userId) {
  const { data: p } = await supabaseAdmin.from("profiles").select("name, email, phone").eq("id", userId).maybeSingle();
  let u = null;
  if (!p?.name || !p?.email || !p?.phone) {
    const { data: a } = await supabaseAdmin.auth.admin.getUserById(userId);
    u = a?.user || null;
  }
  const email = p?.email || u?.email || null;
  return {
    username: p?.name || u?.user_metadata?.name || u?.user_metadata?.full_name || email?.split("@")[0] || "Player",
    email,
    phone: p?.phone || u?.phone || u?.user_metadata?.phone || null,
  };
}

async function verifiedUserId(req) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data?.user ? null : data.user.id;
}

app.post("/chats", async (req, res) => {
  const { id, title, history } = req.body;
  if (!id || !Array.isArray(history)) return res.status(400).json({ error: "Missing chat id or history" });
  const authHeader = req.headers.authorization;
  const token = req.body.token || (authHeader && authHeader.split(" ")[1]);
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const userId = getUserIdFromToken(token);
    if (!userId) return res.status(401).json({ error: "Invalid token" });
    const info = await getUserInfo(userId);
    const now = new Date().toISOString();
    const row = {
      id, user_id: userId,
      username: info.username, email: info.email, phone: info.phone,
      title, history,
      created_at: now, updated_at: now,
    };
    // The person renamed this chat: whatever title the page sends (an automatic one, or a stale tab's old one) is ignored
    const verified = await auth.verify(token);
    if (verified && verified.id === userId && lockedChatIds(verified).includes(id)) {
      const { data: existing } = await supabaseAdmin.from("chats").select("title").eq("id", id).eq("user_id", userId).maybeSingle();
      if (existing && existing.title) row.title = existing.title;
    }
    let { error } = await supabaseAdmin.from("chats").upsert(row);
    if (error && /column|schema cache/i.test(error.message)) {
      // The new columns aren't there yet (supabase/chats.sql hasn't been run). Keep chats
      // working with the old columns, and say so loudly in the logs.
      console.warn("WARNING: chats table is missing username/email/phone/updated_at. Run supabase/chats.sql in the Supabase SQL editor. Saving without them for now.");
      ({ error } = await supabaseAdmin.from("chats").upsert({ id, user_id: userId, title: row.title, history, created_at: now }));
    }
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    console.error("Save chat failed:", err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.get("/chats", async (req, res) => {
  const user = await auth.verify(auth.bearer(req));
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const userId = user.id;
  const locked = new Set(lockedChatIds(user));
  const withLock = rows => (rows || []).map(c => ({ ...c, title_locked: locked.has(c.id) }));
  const { data, error } = await supabaseAdmin.from("chats")
    .select("id, user_id, username, email, phone, title, history, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false });
  if (error) {
    // Older table without the new columns: fall back to select("*")
    const legacy = await supabaseAdmin.from("chats").select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (legacy.error) return res.status(500).json({ error: legacy.error.message });
    return res.json({ chats: withLock(legacy.data) });
  }
  res.json({ chats: withLock(data) });
});

// Rename a chat. { title }                    -> renamed, and the name is locked (never auto-renamed again)
//                { auto: true }               -> "back to automatic": the AI writes a title now and the titler takes over again
//                { title, locked: false }     -> sets this title but leaves the chat on automatic naming
app.patch("/chats/:id", async (req, res) => {
  const user = await auth.verify(auth.bearer(req));
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  const id = String(req.params.id || "");

  // { auto: true }: the person left the name empty, so the AI writes one (from the saved conversation) and the
  // chat goes back to automatic naming. If the AI can't, NOTHING changes: the name and its lock stay as they were.
  if (req.body.auto === true) {
    try {
      const { data: row, error: readError } = await supabaseAdmin.from("chats").select("history").eq("id", id).eq("user_id", user.id).maybeSingle();
      if (readError) throw new Error(readError.message);
      if (!row) return res.status(404).json({ error: "Chat not found." });
      let title;
      try { title = await generateChatTitle(Array.isArray(row.history) ? row.history : []); }
      catch (e) {
        if (e.status === 429) return res.status(429).json({ error: e.message });
        console.warn("Auto title for rename failed:", e && e.message ? e.message : e);
        return res.status(502).json({ error: "Couldn't write a title right now. Try again in a moment." });
      }
      const { error } = await supabaseAdmin.from("chats").update({ title }).eq("id", id).eq("user_id", user.id);
      if (error) throw new Error(error.message);
      await setChatLocked(user.id, id, false);
      return res.json({ success: true, title, locked: false });
    } catch (e) {
      console.error("Rename chat (auto) failed:", e && e.message ? e.message : e);
      return res.status(500).json({ error: "Couldn't rename the chat." });
    }
  }

  if (typeof req.body.title !== "string") return res.status(400).json({ error: "Give the chat a name." });
  const title = cleanChatTitle(req.body.title);
  if (!title) return res.status(400).json({ error: "Give the chat a name." });
  const locked = req.body.locked !== false;
  try {
    await setChatLocked(user.id, id, locked);
    const { data, error } = await supabaseAdmin.from("chats").update({ title }).eq("id", id).eq("user_id", user.id).select("id");
    if (error) throw new Error(error.message);
    if (!data || !data.length) {
      if (locked) await setChatLocked(user.id, id, false).catch(() => {}); // no such chat: don't leave a stray lock behind
      return res.status(404).json({ error: "Chat not found." });
    }
    res.json({ success: true, title, locked });
  } catch (e) {
    console.error("Rename chat failed:", e && e.message ? e.message : e);
    res.status(500).json({ error: "Couldn't rename the chat." });
  }
});

app.delete("/chats/:id", async (req, res) => {
  const userId = await verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const { error } = await supabaseAdmin.from("chats").delete().eq("id", req.params.id).eq("user_id", userId);
  if (error) return res.status(500).json({ error: error.message });
  const user = await auth.verify(auth.bearer(req));
  if (user && lockedChatIds(user).includes(req.params.id)) await setChatLocked(userId, req.params.id, false).catch(() => {});
  res.json({ success: true });
});

app.delete("/chats", async (req, res) => {
  const userId = await verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const { error } = await supabaseAdmin.from("chats").delete().eq("user_id", userId);
  if (error) return res.status(500).json({ error: error.message });
  await patchUserMetadata(userId, { renamed_chats: [] }).catch(() => {});
  res.json({ success: true });
});

// --- ERROR HANDLER ---
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    const msg = req.path === "/auth/avatar"
      ? `File too big! Max ${AVATAR_MAX_BYTES / 1024 / 1024}MB.`
      : "Request too large.";
    return res.status(413).json({ error: msg });
  }
  console.error(err);
  res.status(err.status || 500).json({ error: "Something went wrong" });
});

// --- SELF KEEP-ALIVE ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const SELF_URL = process.env.SITE_URL || "https://agent1102.onrender.com";
function selfPing() {
  fetch(`${SELF_URL}/ping`)
    .then((res) => console.log(`Self-ping OK (${res.status})`))
    .catch((err) => console.warn("Self-ping failed:", err.message));
}
setInterval(selfPing, 5 * 60 * 1000);
