// ============================================================
//  Cheap, local heuristics that run before the model is called:
//    emotionCues()   -> hints about tone (improvement 2)
//    detectDomains() / needsFreshInfo() -> expert mode + web search (improvement 6)
//    pickEffort()    -> how hard the model should think, which decides latency (improvement 4)
//    trimMessages()  -> keeps long chats inside a token budget (improvement 4)
//  These are hints, not verdicts. The model sees them as "may be wrong".
// ============================================================
"use strict";

const stripAttachments = t => String(t || "").replace(/<attached_file[^>]*>[\s\S]*?<\/attached_file>/g, " ").trim();

// ---------- emotion ----------
const SARCASM = /(?:\/s\b|\byeah,?\s+right\b|\boh,?\s+(?:great|wonderful|perfect|fantastic|sure|brilliant)\b|\bgreat,?\s+(?:just|another|now)\b|\bthanks\s+a\s+lot\b(?!\s+for)|\bsure,?\s+because\b|\bwhat\s+a\s+(?:surprise|shock)\b|\bnice\s+job\s+breaking\b|\bwow,?\s+(?:so\s+)?helpful\b)/i;
const FRUSTRATION = /(?:\b(?:still|again)\s+(?:not\s+working|broken|failing|wrong|doesn'?t\s+work|the\s+same\s+error)\b|\bugh+\b|\bwtf\b|\bffs\b|\bso\s+annoying\b|\bfed\s+up\b|\bthis\s+is\s+useless\b|\byou'?re\s+not\s+listening\b|\bi\s+(?:already|just)\s+(?:told|said|asked)\b|\bwhy\s+(?:won'?t|doesn'?t|isn'?t)\s+(?:it|this)\b.{0,30}\bwork\b|!{3,}|\?{3,})/i;
const DISTRESS = /\b(?:overwhelmed|stressed\s+out|anxious|anxiety|burn(?:ed|t)\s+out|exhausted|can'?t\s+cope|hopeless|lonely|depressed|panick(?:ing|ed)|so\s+tired\s+of|nobody\s+cares|falling\s+apart)\b/i;
const CRISIS = /\b(?:kill\s+myself|end\s+my\s+life|want\s+to\s+die|wanna\s+die|suicid(?:e|al)|self[- ]?harm|hurt\s+myself|don'?t\s+want\s+to\s+(?:live|be\s+here)|better\s+off\s+without\s+me)\b/i;
const GOOD_NEWS = /\b(?:i\s+got\s+(?:in|the\s+job|accepted|promoted)|i\s+passed|we\s+did\s+it|so\s+excited|can'?t\s+wait|just\s+got\s+engaged|it\s+worked!)\b/i;
const HUMOR = /(?:\blol\b|\blmao\b|\bhaha+\b|\bhehe+\b|😂|🤣|😅)/i;

function capsRatio(text) {
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length < 14) return 0;
  return letters.replace(/[^A-Z]/g, "").length / letters.length;
}

function emotionCues(rawText) {
  const text = stripAttachments(rawText).slice(0, 2000);
  const notes = [];
  let crisis = false;
  if (!text) return { notes, crisis };
  if (CRISIS.test(text)) {
    crisis = true;
    notes.push("The message may mention thoughts of self-harm or suicide. Respond first as a caring person: take it seriously, do not lecture or panic, and do not ignore it. Gently encourage reaching out right now to someone they trust and to a crisis line (in the US, call or text 988; elsewhere, local emergency services or findahelpline.com). Ask if they are safe. Do not refuse to talk.");
  } else if (DISTRESS.test(text)) {
    notes.push("The message sounds stressed, anxious or overwhelmed. Lead with warmth and steadiness; keep practical help gentle and short.");
  }
  if (!crisis) {
    if (SARCASM.test(text)) notes.push("The message may contain sarcasm. Read it as the opposite of its literal wording where that makes sense, and respond to the real feeling (usually annoyance) rather than the surface words.");
    if (FRUSTRATION.test(text) || capsRatio(text) >= 0.6) notes.push("The user seems frustrated. Acknowledge it in half a sentence, don't be defensive or over-apologize, and go straight to fixing the problem.");
    if (GOOD_NEWS.test(text)) notes.push("The user is sharing good news. Be genuinely glad about it before anything else.");
    if (HUMOR.test(text) && !notes.length) notes.push("The tone is joking and casual. A light touch is welcome.");
  }
  return { notes, crisis };
}

// ---------- domains + freshness ----------
const DOMAIN_PATTERNS = {
  medical: /\b(?:symptom|diagnos\w*|dosage|dose|medication|prescri\w+|side effects?|blood (?:pressure|test|sugar)|infection|surgery|chronic|cancer|diabetes|clinical|therapy|pathology|antibiotic|vaccine|mri|ecg|cholesterol)\b/i,
  legal: /\b(?:lawsuit|sue|contract|liability|copyright|trademark|patent|tenant|landlord|custody|divorce|statute|jurisdiction|gdpr|hipaa|nda|plaintiff|defendant|probate|visa|immigration law|small claims|terms of service)\b/i,
  finance: /\b(?:invest\w*|stocks?|etf|bond|mortgage|401\(?k\)?|ira\b|roth|tax(?:es)? (?:return|bracket|deduction)|capital gains|portfolio|interest rate|apr\b|inflation|crypto\w*|dividend|amortization|net present value|npv|irr\b|budget)\b/i,
  security: /\b(?:vulnerabilit\w+|exploit|cve-\d{4}|xss|csrf|sql injection|penetration test|pentest|malware|ransomware|encryption|tls|oauth|jwt|zero[- ]day|threat model|owasp|firewall|phishing)\b/i,
  engineering: /\b(?:rfc ?\d+|iso ?\d+|iec ?\d+|ieee ?\d+|nist|ansi|astm|iso\/iec|protocol|specification|standard(?:s)? (?:for|compliance)|kubernetes|terraform|architecture|latency|throughput|microservice|compiler|firmware|plc|pcb|signal processing|control system|embedded|api design|database index|consensus algorithm)\b/i,
  science: /\b(?:peer[- ]reviewed|hypothesis|p-value|meta-analysis|genome|crispr|quantum|thermodynamic\w*|spectroscop\w+|enzyme|protein folding|neural network architecture|dark matter|statistical significance|sample size|control group|arxiv|doi:)\b/i,
};
function detectDomains(rawText) {
  const text = stripAttachments(rawText).slice(0, 3000);
  return Object.keys(DOMAIN_PATTERNS).filter(k => DOMAIN_PATTERNS[k].test(text)).slice(0, 2);
}

const FRESH = /\b(?:latest|newest|current(?:ly)?|today|tonight|this (?:week|month|year)|recent(?:ly)?|as of|up[- ]to[- ]date|breaking|news|20(?:25|26)|version \d|v\d+\.\d+|release[ds]?|changelog|deprecated|price[sd]?|pricing|deadline|cve-\d{4}-\d+|who is (?:the )?(?:current|new)|is it still|does .{1,30} still)\b/i;
const NICHE_FACT = /\b(?:rfc ?\d+|iso ?\d+|iec ?\d+|ieee ?\d+|nist|standard(?:s)?\b|regulation|directive|guideline|specification|clinical trial|case law|statute|section \d|article \d)\b/i;
function needsFreshInfo(rawText, domains) {
  const text = stripAttachments(rawText).slice(0, 1500);
  if (!text || text.startsWith("/")) return false;
  if (FRESH.test(text)) return true;
  return !!(domains && domains.length && NICHE_FACT.test(text));
}

// ---------- latency ----------
// "low" thinking for quick conversational turns; "medium" (the model's default) whenever there is real work.
const HEAVY = /(?:```|\\\(|\$\$|\b(?:prove|derive|debug|optimi[sz]e|algorithm|step by step|explain why|architecture|design|compare|analy[sz]e|calculate|solve|integral|equation|refactor|implement|regex|sql|proof)\b|[=+\-*/^]\s*\d)/i;
function pickEffort({ text, hasImage, hasFiles, turns, domains }) {
  const forced = (process.env.REASONING_EFFORT || "").toLowerCase();
  if (["low", "medium", "high"].includes(forced)) return forced;
  const t = stripAttachments(text);
  if (hasImage || hasFiles) return "medium";
  if (domains && domains.length) return "medium";
  if (t.length > 350 || HEAVY.test(t)) return "medium";
  if (t.length <= 160 && (turns || 0) <= 12) return "low";
  return "medium";
}

// ---------- history budget ----------
function messageSize(m) {
  if (!m) return 0;
  if (typeof m.content === "string") return m.content.length;
  if (Array.isArray(m.content)) return m.content.reduce((n, p) => n + (p && typeof p.text === "string" ? p.text.length : p && p.type === "image_url" ? 1500 : 0), 0);
  return 0;
}
// Keeps the newest messages that fit in `budget` characters (the last message is always kept).
function trimMessages(messages, budget) {
  budget = budget || 48000;
  let used = 0, start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = messageSize(messages[i]);
    if (i < messages.length - 1 && used + size > budget) break;
    used += size; start = i;
  }
  // don't start on an assistant reply that lost its question
  while (start < messages.length - 1 && messages[start] && messages[start].role === "assistant") start++;
  return { messages: messages.slice(start), trimmed: start > 0, dropped: start };
}

module.exports = { emotionCues, detectDomains, needsFreshInfo, pickEffort, trimMessages, stripAttachments, capsRatio };
