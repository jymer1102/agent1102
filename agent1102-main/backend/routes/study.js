// Study modes (/learn, /quiz, /flashcards) and math pictures (/graph). They share the AI-JSON helpers, so they live together.
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)
const path = require("path");
const vm = require("vm");
const fs = require("fs");
const groq = require("../lib/groq");

module.exports = function registerStudy(ctx) {
const { app, MSG, needUser, L, TEXT_MODEL, VISION_MODEL, MAX_IMAGES_PER_REQUEST, MATH_VISUALS_GUIDE, ROOT, decodeEntities, fetchPageHtml } = ctx;

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
    const info = groq.describeError(data, response); // logs the AI service's own wording, returns plain words
    const err = new Error(info.message);
    err.rate = info.status === 429;
    err.ai = true;
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
    const info = groq.describeError(data, response);
    const err = new Error(info.message);
    err.rate = info.status === 429;
    err.ai = true;
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

app.post("/study", needUser, L.study, async (req, res) => {
  const mode = String(req.body.mode || "");
  if (!["learn", "quiz", "flashcards"].includes(mode)) return res.status(400).json({ error: "I don't recognize that study command. Try /learn, /quiz or /flashcards." });
  let topic = clip(req.body.topic, 300);
  let material = String(req.body.material || "").slice(0, STUDY_MAX_MATERIAL);
  const context = String(req.body.context || "").slice(0, 12000);
  const images = Array.isArray(req.body.images) ? req.body.images : [];
  if (!topic && !material.trim() && !context.trim() && !images.length) return res.status(400).json({ error: "What should I study? Give me a topic or attach some notes, for example: /quiz 5 the French Revolution." });

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
    if (err.rate) return res.status(429).json({ error: err.message });
    console.error("Study prep error:", err);
    return res.status(500).json({ error: err.ai ? err.message : MSG.generic });
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
    if (err.rate) return res.status(429).json({ error: err.message });
    console.error("Study error:", err);
    res.status(500).json({ error: err.ai ? err.message : MSG.generic });
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
    const code = fs.readFileSync(path.join(ROOT, "public", "js", "mathviz.js"), "utf8");
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

app.post("/graph", needUser, L.study, async (req, res) => {
  const request = clip(req.body.request, 1000);
  const context = String(req.body.context || "").slice(0, 6000);
  if (!request && !context.trim()) return res.status(400).json({ error: "What should I draw? For example: /graph y = x^2 - 4." });
  try {
    const out = await generateMathVisual(request || "Draw the math from the conversation so far.", context);
    if (!out) return res.status(502).json({ error: "I couldn't draw that one. Try describing it a little differently, for example: y = x^2 - 4, or a number line for -2 < x <= 3." });
    res.json({ reply: (out.caption ? out.caption + "\n\n" : "") + out.block });
  } catch (err) {
    if (err.rate) return res.status(429).json({ error: err.message });
    console.error("Graph error:", err);
    res.status(500).json({ error: err.ai ? err.message : MSG.generic });
  }
});

// handed to the files that register after this one
Object.assign(ctx, { clip, groqStudy, parseJsonLoose, drawError, dropBrokenMathBlocks, generateMathVisual, wantsMathVisual });
};
