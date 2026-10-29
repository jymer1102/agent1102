// ============================================================
//  Groq chat-completions helper: normal calls AND streaming.
//  GROQ_API_URL can be set to point at a different OpenAI-compatible endpoint (also used by the tests).
// ============================================================
"use strict";

const GROQ_URL = () => process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions";
const headers = () => ({ "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` });

// "1m23.4s" / "7.66s" / "850ms" / "60" -> whole seconds (the old code read "1m23s" as 1)
function parseResetSeconds(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return 60;
  let total = 0, matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = parseFloat(m[1]);
    total += m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : m[2] === "ms" ? n / 1000 : n;
  }
  if (!matched) { const n = parseFloat(s); total = Number.isFinite(n) ? n : 60; }
  return Math.max(1, Math.ceil(total));
}

const AI_PROBLEM = "The AI service had a problem. Please try again in a moment.";
const AI_NO_REPLY = "The AI didn't send a reply. Please try again.";

function rateLimitText(resetSeconds) {
  const mins = Math.floor(resetSeconds / 60), secs = resetSeconds % 60;
  const t = mins > 0 ? `${mins} minute${mins !== 1 ? "s" : ""}` : `${secs} second${secs !== 1 ? "s" : ""}`;
  return `I've hit my usage limit for now. Please try again in ${t}.`;
}

// Turns a failed Groq reply into { status, message } for the client
function describeError(data, response) {
  const err = data && data.error;
  if (err && err.code === "rate_limit_exceeded") {
    return { status: 429, message: rateLimitText(parseResetSeconds(response && response.headers.get("x-ratelimit-reset-tokens"))) };
  }
  // the AI service's own wording is for the server log, not for the person chatting
  console.error("Groq error:", JSON.stringify(err || data));
  return { status: 500, message: err && err.message ? AI_PROBLEM : AI_NO_REPLY };
}

class GroqError extends Error {
  constructor(info) { super(info.message); this.status = info.status; this.rate = info.status === 429; }
}

// One normal (non-streaming) call -> the reply text
async function complete(body, signal) {
  const response = await fetch(GROQ_URL(), { method: "POST", headers: headers(), body: JSON.stringify(body), signal });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!data || !data.choices || !data.choices[0]) throw new GroqError(describeError(data, response));
  return String(data.choices[0].message.content || "");
}

// Streaming call: onDelta(text) fires for every piece of the answer as it arrives (reasoning text is never
// forwarded). Resolves with the full text. Throws GroqError if Groq refuses before sending anything.
async function stream(body, onDelta, signal) {
  const response = await fetch(GROQ_URL(), { method: "POST", headers: headers(), body: JSON.stringify({ ...body, stream: true }), signal });
  if (!response.ok || !response.body) {
    let data = null;
    try { data = await response.json(); } catch (_) {}
    throw new GroqError(describeError(data, response));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", full = "";
  const handleLine = line => {
    line = line.trim();
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let evt; try { evt = JSON.parse(payload); } catch (_) { return; }
    if (evt.error) throw new GroqError(describeError(evt, null));
    const piece = evt.choices && evt.choices[0] && evt.choices[0].delta && evt.choices[0].delta.content;
    if (piece) { full += piece; if (onDelta) onDelta(piece); }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  if (buf) handleLine(buf);
  if (!full.trim()) throw new GroqError({ status: 500, message: AI_NO_REPLY });
  return full;
}

module.exports = { complete, stream, GroqError, parseResetSeconds, rateLimitText, describeError, AI_PROBLEM, AI_NO_REPLY };
