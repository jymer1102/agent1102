// ============================================================
//  Improvement 1: long-term memory.
//
//  What it does
//    - after a chat turn that looks like it contains something durable ("I'm studying nursing", "I'm building a
//      Discord bot in Python", "remember that..."), a small model call pulls out short facts and saves them in
//      the user_memories table (supabase/memory.sql)
//    - before every reply, the most relevant memories are added to the prompt as background
//    - the user stays in control: /memory, /remember, /forget, and a switch to turn it all off
//
//  Privacy rules enforced IN CODE (not just in the prompt): secrets/ID/card numbers are never stored, memories
//  are only read with a verified token, and the table is only reachable through the server's service key.
// ============================================================
"use strict";

const MAX_PER_USER = 200;
const MAX_CONTENT = 200;
const KINDS = ["fact", "project", "preference"];

class MemoryUnavailable extends Error {}

const STOP = new Set("the and for you that with this have are was but not what when where who how why can could would should about from your yours into just like some any all out one has had they them then than there their its our been being get got make made need want please help use using thing things also very more most much many".split(" "));
const words = t => String(t || "").toLowerCase().match(/[a-z0-9+#.]{3,}/g) || [];
const keyWords = t => new Set(words(t).filter(w => !STOP.has(w)));

// Things that must never be written to memory, whatever the model says
const SENSITIVE = /(?:pass(?:word|code|phrase)|api[_ -]?key|secret|bearer|token|private key|seed phrase|\bssn\b|social security|credit card|debit card|\bcvv\b|\biban\b|routing number|account number|\b(?:\d[ -]?){13,19}\b|\b[A-Za-z0-9_\-]{32,}\b|\bsk-[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9]{10,})/i;
const looksSensitive = t => SENSITIVE.test(String(t || ""));

function cleanContent(c) {
  return String(c == null ? "" : c).replace(/\s+/g, " ").replace(/^[-*•\s]+/, "").trim().slice(0, MAX_CONTENT);
}

// How alike two memories are (0..1), so "Lives in Austin" and "Lives in Austin, Texas" don't pile up
function similarity(a, b) {
  const A = keyWords(a), B = keyWords(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) * (inter / Math.max(A.size, B.size) + 1) / 2;
}

// ---- when is it worth spending a model call? ----
const REMEMBER_CUE = /\b(?:remember|don'?t forget|keep in mind|note that|make a note)\b/i;
const FORGET_CUE = /\b(?:forget|delete|remove|erase|stop remembering)\b[^.?!\n]{0,40}\b(?:that|about|my|i|me|it)\b/i;
const SELF_FACT = /\b(?:i am|i'm|im|i work|i study|i live|i'm from|i was born|my name is|call me|i go by|my (?:job|major|degree|school|college|university|company|team|project|app|bot|startup|business|thesis|website|site|stack|goal|favorite|favourite|pronouns|timezone|dog|cat|kid|son|daughter|wife|husband|partner|boyfriend|girlfriend)|i(?:'m| am) (?:building|making|working on|learning|studying|writing|developing|creating)|i(?:'m| am) a\b|i (?:prefer|always use|usually use|use|like|love|hate|speak)|we(?:'re| are) (?:building|making|using)|for my (?:class|course|job|project|thesis))\b/i;
function memoryCues(userText) {
  const t = String(userText || "").replace(/<attached_file[^>]*>[\s\S]*?<\/attached_file>/g, " ").trim();
  return { remember: REMEMBER_CUE.test(t), forget: FORGET_CUE.test(t), text: t };
}
function worthExtracting(userText) {
  const { remember, forget, text } = memoryCues(userText);
  if (!text || text.startsWith("/") || text.length < 12 || text.length > 4000) return false;
  return remember || forget || SELF_FACT.test(text);
}

function parseJsonLoose(text) {
  const t = String(text || "").replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}

const EXTRACT_SYSTEM = [
  "You maintain a small long-term memory about one user of a chat assistant. Read the latest exchange and decide what, if anything, is worth remembering for FUTURE conversations.",
  "SAVE only durable facts the USER said about themselves: the name they want to be called, where they live or their timezone, job or field, what they study, ongoing projects and their tech stack, tools they use, goals, strong stable preferences (languages, frameworks, answer style), people or pets they mention by role, accessibility needs.",
  "DO NOT SAVE: one-off questions or tasks, anything that came from pasted files or code, things only the assistant said, guesses, temporary states (\"tired today\"), passwords, keys, tokens, ID / card / bank numbers, an exact street address or phone number, or sensitive categories (health, sexuality, religion, politics, money) UNLESS the user explicitly asked you to remember it.",
  "Write each memory as ONE short sentence about the user (\"Is studying nursing\", \"Prefers TypeScript over JavaScript\", \"Is building a Discord bot in Python\"), max 150 characters. kind is \"fact\", \"project\" or \"preference\".",
  "If the user asked to remember something, save it. If the user asked to forget something, put the ids of the matching existing memories in \"forget\". If a new fact replaces an old one (moved, changed jobs), add the new one and put the old id in \"forget\".",
  "Reply with ONLY this JSON, using empty arrays when there is nothing to do, at most 3 additions: {\"add\":[{\"kind\":\"fact\",\"content\":\"...\"}],\"forget\":[\"m1\"]}",
].join("\n");

function createMemory({ supabase, complete, model, log = console }) {
  const cache = new Map();      // userId -> { at, rows }
  const CACHE_MS = 60 * 1000;
  let unavailableUntil = 0, warned = false;
  const lastRun = new Map();    // userId -> time of the last extraction (a cost brake)
  const gapEnv = parseInt(process.env.MEMORY_EXTRACT_GAP_MS, 10);
  const EXTRACT_GAP_MS = Number.isFinite(gapEnv) ? gapEnv : 15 * 1000;

  const isMissingTable = e => e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|schema cache|could not find the table/i.test(e.message || ""));
  function fail(error) {
    if (isMissingTable(error)) {
      unavailableUntil = Date.now() + 5 * 60 * 1000;
      if (!warned) { warned = true; log.warn("WARNING: long-term memory is off because the user_memories table is missing. Run supabase/memory.sql in the Supabase SQL editor."); }
      throw new MemoryUnavailable("Memory isn't available right now.");
    }
    throw new Error(error.message || "Memory error");
  }
  function guard() { if (Date.now() < unavailableUntil) throw new MemoryUnavailable("Memory isn't available right now."); }

  async function list(userId) {
    guard();
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const { data, error } = await supabase.from("user_memories")
      .select("id, kind, content, source, created_at, updated_at")
      .eq("user_id", userId).order("created_at", { ascending: true }).limit(MAX_PER_USER + 20);
    if (error) fail(error);
    const rows = data || [];
    cache.set(userId, { at: Date.now(), rows });
    return rows;
  }
  const bust = userId => cache.delete(userId);

  // The few memories worth putting in this prompt: matches for the current message first, plus the newest and
  // the standing preferences/projects, so the assistant "knows" the user even when the message is unrelated.
  async function relevant(userId, queryText, limit = 12) {
    let rows;
    try { rows = await list(userId); } catch (_) { return []; }
    if (!rows.length) return [];
    const q = keyWords(queryText);
    const now = Date.now();
    return rows.map((m, i) => {
      const overlap = [...keyWords(m.content)].filter(w => q.has(w)).length;
      const ageDays = (now - Date.parse(m.updated_at || m.created_at || now)) / 86400000;
      const score = overlap * 3 + Math.max(0, 1.5 - ageDays / 60) + (m.kind === "preference" || m.kind === "project" ? 0.75 : 0) + i * 1e-6;
      return { m, score };
    }).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.m);
  }

  async function add(userId, content, { kind = "fact", source = "auto" } = {}) {
    content = cleanContent(content);
    if (content.length < 3) return { skipped: "empty" };
    if (looksSensitive(content)) return { skipped: "sensitive" };
    if (!KINDS.includes(kind)) kind = "fact";
    const rows = await list(userId);
    const dupe = rows.find(r => similarity(r.content, content) >= 0.8);
    const now = new Date().toISOString();
    if (dupe) {
      const { error } = await supabase.from("user_memories").update({ content, updated_at: now }).eq("id", dupe.id).eq("user_id", userId);
      if (error) fail(error);
      bust(userId);
      return { updated: dupe.id };
    }
    const { error } = await supabase.from("user_memories").insert({ user_id: userId, kind, content, source });
    if (error) fail(error);
    bust(userId);
    // stay under the cap by dropping the oldest automatic memories
    if (rows.length + 1 > MAX_PER_USER) {
      const drop = rows.filter(r => r.source !== "user").slice(0, rows.length + 1 - MAX_PER_USER).map(r => r.id);
      if (drop.length) await supabase.from("user_memories").delete().in("id", drop).eq("user_id", userId);
      bust(userId);
    }
    return { added: true };
  }

  async function remove(userId, id) {
    guard();
    const { error } = await supabase.from("user_memories").delete().eq("id", id).eq("user_id", userId);
    if (error) fail(error);
    bust(userId);
  }
  async function clear(userId) {
    guard();
    const { error } = await supabase.from("user_memories").delete().eq("user_id", userId);
    if (error) fail(error);
    bust(userId);
  }

  // Looks at one finished exchange and updates memory. Never throws: it runs in the background.
  async function extract(userId, userText, assistantText) {
    try {
      if (!worthExtracting(userText)) return { skipped: "not worth it" };
      const cue = memoryCues(userText);
      if (!cue.remember && !cue.forget && Date.now() - (lastRun.get(userId) || 0) < EXTRACT_GAP_MS) return { skipped: "too soon" };
      lastRun.set(userId, Date.now());
      if (lastRun.size > 1000) lastRun.delete(lastRun.keys().next().value);
      const rows = await list(userId);
      const ids = new Map(rows.map((r, i) => [`m${i + 1}`, r.id]));
      const existing = rows.length ? rows.map((r, i) => `[m${i + 1}] ${r.content}`).join("\n") : "(none yet)";
      const { text } = memoryCues(userText);
      const raw = await complete({
        model,
        max_tokens: 700,
        temperature: 0.1,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACT_SYSTEM },
          { role: "user", content: `EXISTING MEMORIES:\n${existing}\n\nLATEST USER MESSAGE:\n${text.slice(0, 1500)}\n\nASSISTANT REPLY (context only, never save from it):\n${String(assistantText || "").replace(/```[\s\S]*?```/g, "[code]").slice(0, 500)}` },
        ],
      });
      const out = parseJsonLoose(raw);
      if (!out || typeof out !== "object") return { skipped: "unreadable" };
      let added = 0, forgot = 0;
      for (const f of (Array.isArray(out.forget) ? out.forget : []).slice(0, 5)) {
        const id = ids.get(String(f));
        if (id) { await remove(userId, id); forgot++; }
      }
      for (const a of (Array.isArray(out.add) ? out.add : []).slice(0, 3)) {
        if (!a || typeof a.content !== "string") continue;
        const r = await add(userId, a.content, { kind: a.kind, source: "auto" });
        if (r.added || r.updated) added++;
      }
      return { added, forgot };
    } catch (e) {
      if (!(e instanceof MemoryUnavailable)) log.warn("Memory extraction failed:", e && e.message ? e.message : e);
      return { skipped: "error" };
    }
  }

  return { list, relevant, add, remove, clear, extract };
}

module.exports = { createMemory, MemoryUnavailable, worthExtracting, memoryCues, looksSensitive, similarity, cleanContent, parseJsonLoose, MAX_PER_USER };
