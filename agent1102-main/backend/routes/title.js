// Automatic chat titles for the sidebar (POST /title).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)
const groq = require("../lib/groq");

module.exports = function registerTitle(ctx) {
const { app, needUser, L, TEXT_MODEL } = ctx;

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

app.post("/title", needUser, L.title, async (req, res) => {
  if (!Array.isArray(req.body.messages) || !req.body.messages.length) {
    return res.status(400).json({ error: "There's nothing to send yet. Type a message and try again." });
  }
  try {
    res.json({ title: await generateChatTitle(req.body.messages) });
  } catch (err) {
    if (err.status === 429) return res.status(429).json({ error: err.message });
    if (err.status === 400) return res.status(400).json({ error: "There's nothing to title yet." });
    console.error(err);
    res.status(500).json({ error: "I couldn't write a title for this chat." });
  }
});

// handed to the files that register after this one
Object.assign(ctx, { generateChatTitle });
};
