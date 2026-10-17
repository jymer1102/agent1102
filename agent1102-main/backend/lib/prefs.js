// ============================================================
//  Improvement 8: user personalization.
//  Style preferences (length, tone, emoji, format, level) + the memory on/off switch.
//  Stored in the user's Supabase auth metadata (user_metadata.style), the same trick the easter-egg
//  progress uses, so there is no table or SQL to run for this part.
// ============================================================
"use strict";

const LENGTH = ["concise", "detailed"];
const TONE = ["casual", "formal", "friendly"];
const FORMAT = ["prose", "bullets"];
const LEVEL = ["beginner", "expert"];

function readStyle(meta) {
  const s = (meta && meta.style) || {};
  return {
    length: LENGTH.includes(s.length) ? s.length : null,
    tone: TONE.includes(s.tone) ? s.tone : null,
    emoji: typeof s.emoji === "boolean" ? s.emoji : null,
    format: FORMAT.includes(s.format) ? s.format : null,
    level: LEVEL.includes(s.level) ? s.level : null,
    memory: s.memory === false ? false : true,
  };
}

// keeps only known keys with valid values
function cleanUpdates(u) {
  const out = {};
  if (u.length === null || LENGTH.includes(u.length)) if ("length" in u) out.length = u.length;
  if (u.tone === null || TONE.includes(u.tone)) if ("tone" in u) out.tone = u.tone;
  if (u.emoji === null || typeof u.emoji === "boolean") if ("emoji" in u) out.emoji = u.emoji;
  if (u.format === null || FORMAT.includes(u.format)) if ("format" in u) out.format = u.format;
  if (u.level === null || LEVEL.includes(u.level)) if ("level" in u) out.level = u.level;
  if (typeof u.memory === "boolean") out.memory = u.memory;
  return out;
}

// ---- 1) things people say in normal chat ----
// Only standing instructions are saved. A one-off ("explain this in detail") must not rewrite their settings,
// so topic-bearing phrases need a "from now on / always / stop / never" cue, while bare directives ("be more
// concise", "too long") count on their own when the message is short.
const STANDING = /\b(?:always|from now on|going forward|in (?:the )?future|every time|by default|in general|stop|never|no more|don'?t (?:ever )?(?:use|add|give|write|put))\b/i;
const RULES = [
  { key: "length", value: "concise", note: "shorter answers", pure: /^(?:please\s+|pls\s+)?(?:be\s+|keep\s+(?:it\s+|things\s+|answers\s+|responses\s+|replies\s+)?)?(?:more\s+|a\s+bit\s+|a\s+little\s+)?(?:concise|brief|short(?:er)?)(?:\s+please|\s+pls)?[.!]*$|\btoo\s+(?:long|wordy|verbose)\b|\bshorter\s+(?:answers|responses|replies)\b|\bless\s+(?:wordy|verbose|rambling)\b/i, standing: /\b(?:concise|brief(?:ly)?|short(?:er)?\s+(?:answers|responses|replies)|to the point|no fluff|tl;?dr)\b/i },
  { key: "length", value: "detailed", note: "more detailed answers", pure: /^(?:please\s+|pls\s+)?(?:be\s+|give\s+)?(?:more\s+)?(?:detailed|thorough|in[- ]depth)(?:\s+answers|\s+responses)?(?:\s+please|\s+pls)?[.!]*$|\btoo\s+(?:short|brief|vague)\b|\b(?:more|longer)\s+(?:detailed\s+)?(?:answers|responses|replies)\b/i, standing: /\b(?:detailed|in detail|thorough(?:ly)?|in[- ]depth|step[- ]by[- ]step|explain (?:everything|more))\b/i },
  { key: "emoji", value: false, note: "no emojis", pure: /\b(?:no|without|stop\s+(?:using|with)(?:\s+the)?|don'?t\s+(?:use|add|put)(?:\s+any)?)\s+emojis?\b/i },
  { key: "emoji", value: true, note: "emojis are welcome", pure: /\b(?:use|add|include)\s+(?:some\s+|more\s+)?emojis?\b/i, needsStanding: true },
  { key: "tone", value: "casual", note: "a casual tone", pure: /\b(?:talk|speak|write|respond|reply|be|sound)\s+(?:to me\s+)?(?:more\s+)?(?:casual(?:ly)?|relaxed|chill|conversational)\b|\blike a friend\b/i },
  { key: "tone", value: "formal", note: "a formal tone", pure: /\b(?:talk|speak|write|respond|reply|be|sound)\s+(?:to me\s+)?(?:more\s+)?(?:formal(?:ly)?|professional(?:ly)?)\b/i },
  { key: "tone", value: "friendly", note: "a warmer tone", pure: /\b(?:be|sound|talk|speak)\s+(?:more\s+)?(?:friendl(?:y|ier)|warm(?:er)?|encouraging)\b/i },
  { key: "format", value: "prose", note: "plain paragraphs instead of bullet lists", pure: /\b(?:stop|don'?t|do not|no|never|without|avoid)\s+(?:using\s+|use\s+|with\s+|the\s+|any\s+|so many\s+)*(?:bullet\s?points?|bullets|lists?|headings?|headers?)\b/i },
  { key: "format", value: "bullets", note: "bullet points and lists", pure: /\b(?:use|give me|prefer|answer in|format (?:it )?(?:as|with))\s+(?:more\s+)?(?:bullet\s?points?|bullets|lists?)\b/i, needsStanding: true },
];

function detectStyleUpdates(rawText) {
  const text = String(rawText || "").replace(/<attached_file[^>]*>[\s\S]*?<\/attached_file>/g, " ").trim();
  if (!text || text.length > 300 || text.startsWith("/")) return { updates: {}, notes: [] };
  const standing = STANDING.test(text);
  const updates = {}, notes = [];
  for (const r of RULES) {
    if (r.key in updates) continue;
    const bare = r.pure.test(text) && (text.length <= 80 || standing) && (!r.needsStanding || standing);
    const withStanding = !!(r.standing && standing && r.standing.test(text) && !/\bin (?:a )?(?:sentence|word|line|paragraph)\b/i.test(text));
    if (bare || withStanding) { updates[r.key] = r.value; notes.push(r.note); }
  }
  return { updates, notes };
}

// ---- 2) the explicit /style command ----
function parseStyleArgs(args) {
  const a = String(args || "").toLowerCase().trim();
  if (!a) return { show: true, updates: {}, notes: [] };
  if (/^(?:reset|clear|default|defaults)$/.test(a)) return { updates: { length: null, tone: null, emoji: null, format: null, level: null }, notes: ["everything back to default"] };
  const updates = {}, notes = [];
  const set = (k, v, n) => { updates[k] = v; notes.push(n); };
  for (const w of a.split(/[\s,]+/).filter(Boolean)) {
    if (["concise", "brief", "short"].includes(w)) set("length", "concise", "shorter answers");
    else if (["detailed", "thorough", "long", "indepth", "in-depth"].includes(w)) set("length", "detailed", "more detailed answers");
    else if (["casual", "relaxed"].includes(w)) set("tone", "casual", "a casual tone");
    else if (["formal", "professional"].includes(w)) set("tone", "formal", "a formal tone");
    else if (["friendly", "warm"].includes(w)) set("tone", "friendly", "a warmer tone");
    else if (["prose", "paragraphs", "plain"].includes(w)) set("format", "prose", "plain paragraphs instead of bullet lists");
    else if (["bullets", "bullet", "lists"].includes(w)) set("format", "bullets", "bullet points and lists");
    else if (["beginner", "simple", "eli5"].includes(w)) set("level", "beginner", "beginner-friendly explanations");
    else if (["expert", "advanced", "technical"].includes(w)) set("level", "expert", "expert-level, technical explanations");
    else if (["noemoji", "no-emoji", "noemojis"].includes(w)) set("emoji", false, "no emojis");
    else if (["emoji", "emojis"].includes(w)) set("emoji", !/\b(?:off|no|false)\b/.test(a), /\b(?:off|no|false)\b/.test(a) ? "no emojis" : "emojis are welcome");
  }
  if (/\bno\s+emojis?\b/.test(a) || /\bemojis?\s+(?:off|no|false)\b/.test(a)) set("emoji", false, "no emojis");
  if (!notes.length) return { error: "I didn't recognize that. Try: concise, detailed, casual, formal, friendly, prose, bullets, beginner, expert, emoji on, emoji off, or reset." };
  return { updates, notes: [...new Set(notes)] };
}

// ---- 3) what the model is told ----
function styleBlock(style) {
  const lines = [];
  if (style.length === "concise") lines.push("Keep answers short and direct: lead with the answer, skip preamble and recaps, and only add detail the question needs.");
  if (style.length === "detailed") lines.push("Give thorough, detailed answers with reasoning, examples and edge cases.");
  if (style.tone === "casual") lines.push("Use a relaxed, conversational tone, like a smart friend.");
  if (style.tone === "formal") lines.push("Use a formal, professional tone.");
  if (style.tone === "friendly") lines.push("Use a warm, encouraging tone.");
  if (style.emoji === false) lines.push("Do not use emojis.");
  if (style.emoji === true) lines.push("Emojis are welcome in moderation.");
  if (style.format === "prose") lines.push("Write in plain paragraphs. Avoid bullet lists and headings unless the user asks for them (code blocks and tables the user asked for are still fine).");
  if (style.format === "bullets") lines.push("Prefer bullet points and short lists where they help.");
  if (style.level === "beginner") lines.push("Assume the user is new to the topic: define jargon, use simple examples, avoid skipping steps.");
  if (style.level === "expert") lines.push("Assume the user is experienced: skip the basics, use correct technical terms, go straight to the substance.");
  if (!lines.length) return "";
  return "THIS USER'S SAVED STYLE PREFERENCES (follow them unless the user asks for something different in the current message):\n" + lines.map(l => "- " + l).join("\n");
}

function describeStyle(style) {
  const rows = [
    ["Answer length", style.length || "default"],
    ["Tone", style.tone || "default"],
    ["Emojis", style.emoji === null ? "default" : style.emoji ? "welcome" : "off"],
    ["Format", style.format === "prose" ? "plain paragraphs" : style.format === "bullets" ? "bullets and lists" : "default"],
    ["Level", style.level || "default"],
    ["Memory", style.memory ? "on" : "off"],
  ];
  return rows;
}

module.exports = { readStyle, cleanUpdates, detectStyleUpdates, parseStyleArgs, styleBlock, describeStyle };
