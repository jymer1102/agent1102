// Settings -> AI: the person's written preferences and their own Groq API key.
//   GET    /settings           what's saved (never the key itself: only whether there is one, and its last 4 characters)
//   POST   /settings/ai        save "how to talk to me" + "what to know about me"
//   POST   /settings/groq-key  check the key with Groq, then save it (encrypted)
//   DELETE /settings/groq-key  go back to the shared key
"use strict";

module.exports = function (ctx) {
  const { app, needUser, userSettings, MSG, fail, L } = ctx;
  const MAX = userSettings.MAX_TEXT;
  const NOT_SET_UP = "Saving settings isn't set up on this server yet. The site owner needs to run supabase/settings.sql once.";

  // Groq keys look like gsk_ followed by letters and digits
  const KEY_SHAPE = /^gsk_[A-Za-z0-9_-]{20,200}$/;

  // Asks Groq itself whether the key works (a cheap "list models" request, nothing is generated or billed)
  async function checkWithGroq(key) {
    const base = (process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions").replace(/\/chat\/completions\/?$/, "");
    try {
      const r = await fetch(base + "/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
      if (r.ok) return "ok";
      if (r.status === 401 || r.status === 403) return "rejected";
      return "unavailable";
    } catch (_) { return "unavailable"; }
  }

  const send = (res, s) => res.json({
    available: s.available, canStoreKey: s.canStoreKey,
    talkStyle: s.talkStyle, aboutMe: s.aboutMe, maxChars: MAX,
    groq: { hasKey: s.hasKey, unreadable: !!s.keyUnreadable, last4: s.last4 },
  });

  app.get("/settings", needUser, async (req, res) => {
    send(res, await userSettings.load(req.user.id));
  });

  app.post("/settings/ai", needUser, L.settings, async (req, res) => {
    const { talkStyle, aboutMe } = req.body || {};
    if ((talkStyle != null && typeof talkStyle !== "string") || (aboutMe != null && typeof aboutMe !== "string")) {
      return res.status(400).json({ error: "Those preferences don't look right. Please check them and try again." });
    }
    if (String(talkStyle || "").length > MAX || String(aboutMe || "").length > MAX) {
      return res.status(400).json({ error: `Each box can hold up to ${MAX} characters. Please shorten it a little.` });
    }
    try {
      await userSettings.saveText(req.user.id, { talkStyle, aboutMe });
    } catch (e) {
      if (e.notSetUp) return res.status(503).json({ error: NOT_SET_UP });
      return fail(res, 500, MSG.generic, e);
    }
    send(res, await userSettings.load(req.user.id));
  });

  app.post("/settings/groq-key", needUser, L.settings, async (req, res) => {
    const key = typeof (req.body || {}).key === "string" ? req.body.key.trim() : "";
    if (!KEY_SHAPE.test(key)) {
      return res.status(400).json({ error: "That doesn't look like a Groq API key. They start with gsk_. Copy the whole key from console.groq.com/keys and paste it here." });
    }
    const verdict = await checkWithGroq(key);
    if (verdict === "rejected") return res.status(400).json({ error: "Groq didn't accept that key. Check that you copied all of it and that it hasn't been deleted." });
    if (verdict !== "ok") return res.status(503).json({ error: "I couldn't check that key with Groq right now. Please try again in a moment." });
    try {
      await userSettings.setKey(req.user.id, key);
    } catch (e) {
      if (e.notSetUp) return res.status(503).json({ error: NOT_SET_UP });
      if (e.noSecret) return res.status(503).json({ error: "Saving a key isn't set up on this server yet. The site owner needs to set KEY_ENCRYPTION_SECRET." });
      return fail(res, 500, MSG.generic, e); // (the key is never part of what's logged)
    }
    send(res, await userSettings.load(req.user.id));
  });

  app.delete("/settings/groq-key", needUser, L.settings, async (req, res) => {
    try {
      await userSettings.clearKey(req.user.id);
    } catch (e) {
      if (e.notSetUp) return res.status(503).json({ error: NOT_SET_UP });
      return fail(res, 500, MSG.generic, e);
    }
    send(res, await userSettings.load(req.user.id));
  });
};
