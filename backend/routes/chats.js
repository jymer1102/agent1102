// Saved chats: list, save, rename, delete (/chats).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)

module.exports = function registerChats(ctx) {
const { app, supabase, supabaseAdmin, auth, MSG, fail, cleanChatTitle, generateChatTitle, lockedChatIds, patchUserMetadata, setChatLocked } = ctx;

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
  if (!id || !Array.isArray(history)) return res.status(400).json({ error: "I couldn't save this chat. Please try again." });
  const authHeader = req.headers.authorization;
  const token = req.body.token || (authHeader && authHeader.split(" ")[1]);
  if (!token) return res.status(401).json({ error: MSG.signIn });
  try {
    const verified = await auth.verify(token);
    if (!verified) return res.status(401).json({ error: MSG.session });
    const userId = verified.id;
    const info = await getUserInfo(userId);
    const now = new Date().toISOString();
    const row = {
      id, user_id: userId,
      username: info.username, email: info.email, phone: info.phone,
      title, history,
      created_at: now, updated_at: now,
    };
    // The person renamed this chat: whatever title the page sends (an automatic one, or a stale tab's old one) is ignored
    if (lockedChatIds(verified).includes(id)) {
      const { data: existing } = await supabaseAdmin.from("chats").select("title").eq("id", id).eq("user_id", userId).maybeSingle();
      if (existing && existing.title) row.title = existing.title;
    }
    // Chat ids are timestamps, so anyone can guess them. A save must never overwrite or take over a chat that
    // belongs to someone else (with a table keyed on id alone, the upsert below would do exactly that).
    const { data: takenBy, error: lookupError } = await supabaseAdmin.from("chats").select("user_id").eq("id", id).neq("user_id", userId).limit(1);
    if (lookupError) return fail(res, 500, MSG.generic, lookupError);
    if (takenBy && takenBy.length) return res.status(409).json({ error: "I couldn't save this chat. Please start a new chat and try again." });

    let { error } = await supabaseAdmin.from("chats").upsert(row);
    if (error && /column|schema cache/i.test(error.message)) {
      // The new columns aren't there yet (supabase/chats.sql hasn't been run). Keep chats
      // working with the old columns, and say so loudly in the logs.
      console.warn("WARNING: chats table is missing username/email/phone/updated_at. Run supabase/chats.sql in the Supabase SQL editor. Saving without them for now.");
      ({ error } = await supabaseAdmin.from("chats").upsert({ id, user_id: userId, title: row.title, history, created_at: now }));
    }
    if (error) return fail(res, 500, MSG.generic, error);
    res.json({ success: true });
  } catch (err) {
    console.error("Save chat failed:", err);
    res.status(500).json({ error: MSG.generic });
  }
});

app.get("/chats", async (req, res) => {
  const user = await auth.verify(auth.bearer(req));
  if (!user) return res.status(401).json({ error: MSG.signIn });
  const userId = user.id;
  const locked = new Set(lockedChatIds(user));
  const withLock = rows => (rows || []).map(c => ({ ...c, title_locked: locked.has(c.id) }));
  const { data, error } = await supabaseAdmin.from("chats")
    .select("id, user_id, username, email, phone, title, history, created_at")
    .eq("user_id", userId).order("created_at", { ascending: false });
  if (error) {
    // Older table without the new columns: fall back to select("*")
    const legacy = await supabaseAdmin.from("chats").select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (legacy.error) return fail(res, 500, MSG.generic, legacy.error);
    return res.json({ chats: withLock(legacy.data) });
  }
  res.json({ chats: withLock(data) });
});

// Rename a chat. { title }                    -> renamed, and the name is locked (never auto-renamed again)
//                { auto: true }               -> "back to automatic": the AI writes a title now and the titler takes over again
//                { title, locked: false }     -> sets this title but leaves the chat on automatic naming
app.patch("/chats/:id", async (req, res) => {
  const user = await auth.verify(auth.bearer(req));
  if (!user) return res.status(401).json({ error: MSG.signIn });
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
        return res.status(502).json({ error: "I couldn't write a title right now. Please try again in a moment." });
      }
      const { error } = await supabaseAdmin.from("chats").update({ title }).eq("id", id).eq("user_id", user.id);
      if (error) throw new Error(error.message);
      await setChatLocked(user.id, id, false);
      return res.json({ success: true, title, locked: false });
    } catch (e) {
      console.error("Rename chat (auto) failed:", e && e.message ? e.message : e);
      return res.status(500).json({ error: "I couldn't rename that chat. Please try again." });
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
    res.status(500).json({ error: "I couldn't rename that chat. Please try again." });
  }
});

app.delete("/chats/:id", async (req, res) => {
  const userId = await verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: MSG.signIn });
  const { error } = await supabaseAdmin.from("chats").delete().eq("id", req.params.id).eq("user_id", userId);
  if (error) return fail(res, 500, MSG.generic, error);
  const user = await auth.verify(auth.bearer(req));
  if (user && lockedChatIds(user).includes(req.params.id)) await setChatLocked(userId, req.params.id, false).catch(() => {});
  res.json({ success: true });
});

app.delete("/chats", async (req, res) => {
  const userId = await verifiedUserId(req);
  if (!userId) return res.status(401).json({ error: MSG.signIn });
  const { error } = await supabaseAdmin.from("chats").delete().eq("user_id", userId);
  if (error) return fail(res, 500, MSG.generic, error);
  await patchUserMetadata(userId, { renamed_chats: [] }).catch(() => {});
  res.json({ success: true });
});

};
