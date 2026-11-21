// Admin tools (/admin/*): see accounts, read what people are asking, ask the AI about them, suspend or unban, send notifications to everyone.
// Every route here needs a signed-in ADMIN (see isAdmin in lib/admin.js), and what an admin looks at or does is written to the admin_audit table.
"use strict";
const groq = require("../lib/groq");
const { toE164, withPlus } = require("../lib/phone");
const A = require("../lib/admin");

module.exports = function registerAdmin(ctx) {
  const { app, supabaseAdmin, auth, needUser, isAdmin, fail, L, TEXT_MODEL } = ctx;

  const needAdmin = (req, res, next) => isAdmin(req.user) ? next() : res.status(403).json({ error: "Only the site owner can do that." });
  const guard = [needUser, needAdmin, L.admin];

  // a table that supabase/admin.sql would have made but hasn't been made yet
  const tableMissing = e => !!e && (["42P01", "PGRST205", "PGRST204"].includes(String(e.code || "")) || /does not exist|schema cache|could not find the table/i.test(String(e.message || "")));
  const NEEDS_SQL = "The admin tables aren't set up yet. Run supabase/admin.sql in the Supabase SQL editor, then try again.";

  async function audit(req, action, target, detail) {
    try {
      const { error } = await supabaseAdmin.from("admin_audit").insert({ admin_id: req.user.id, admin_email: req.user.email || null, action, target_user_id: target || null, detail: detail || {} });
      if (error && !tableMissing(error)) console.warn("Admin audit not saved:", error.message);
    } catch (e) { console.warn("Admin audit not saved:", e && e.message ? e.message : e); }
  }

  // ---------- accounts ----------
  let usersCache = { at: 0, list: null };
  async function allUsers(fresh) {
    if (!fresh && usersCache.list && Date.now() - usersCache.at < 20000) return usersCache.list;
    const out = [];
    for (let page = 1; page <= 20; page++) { // up to 4000 accounts
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(error.message);
      const users = (data && data.users) || [];
      out.push(...users);
      if (users.length < 200) break;
    }
    usersCache = { at: Date.now(), list: out };
    return out;
  }
  const displayName = u => {
    const m = (u && u.user_metadata) || {};
    return String(m.name || m.full_name || m.user_name || (u && u.email ? u.email.split("@")[0] : "") || "").trim();
  };
  function summarize(u) {
    const m = u.user_metadata || {};
    return {
      id: u.id, email: u.email || null, name: displayName(u),
      phone: withPlus(u.phone) || m.phone || null, phone_in_auth: !!u.phone,
      provider: (u.app_metadata && u.app_metadata.provider) || "email",
      created_at: u.created_at || null, last_sign_in_at: u.last_sign_in_at || null,
      admin: isAdmin(u), ...A.banStatus(u),
    };
  }
  async function findUser(id) {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(id);
    return error || !data || !data.user ? null : data.user;
  }

  // newest chats first. select("*") so an older table without every column still answers; ordered by updated_at when it exists.
  async function recentChats(userId, limit) {
    for (const order of ["updated_at", "created_at"]) {
      let q = supabaseAdmin.from("chats").select("*").order(order, { ascending: false }).limit(limit);
      if (userId) q = q.eq("user_id", userId);
      const { data, error } = await q;
      if (!error) return data || [];
    }
    return [];
  }

  app.get("/admin/me", needUser, (req, res) => res.json({ admin: isAdmin(req.user) })); // not an error for everyone else: the page just hides the button

  app.get("/admin/users", ...guard, async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase().slice(0, 100);
    let users;
    try { users = (await allUsers(req.query.fresh === "1")).map(summarize); } catch (e) { return fail(res, 500, "I couldn't load the accounts. Please try again.", e); }
    const total = users.length;
    if (q) users = users.filter(u => [u.email, u.name, u.phone, u.id].some(v => String(v || "").toLowerCase().includes(q)));
    users.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ users: users.slice(0, 200), total, shown: Math.min(users.length, 200) });
  });

  app.get("/admin/users/:id", ...guard, async (req, res) => {
    const id = req.params.id;
    if (!A.isUuid(id)) return res.status(400).json({ error: "That isn't a valid account id." });
    const user = await findUser(id);
    if (!user) return res.status(404).json({ error: "I couldn't find that account." });
    const chats = await recentChats(id, 200);
    const { data: memories } = await supabaseAdmin.from("user_memories").select("id, kind, content, created_at").eq("user_id", id).order("created_at", { ascending: true }).limit(100);
    const { data: profile } = await supabaseAdmin.from("profiles").select("name, email, phone, avatar_url").eq("id", id).maybeSingle();
    await audit(req, "view_user", id, {});
    res.json({
      user: summarize(user), profile: profile || null,
      chats: chats.map(c => {
        const history = Array.isArray(c.history) ? c.history : [];
        const first = history.find(m => m && m.role === "user");
        return { id: c.id, title: c.title || "Untitled", author: c.author || null, created_at: c.created_at, updated_at: c.updated_at || null, messages: history.length, preview: first ? A.messageText(first).slice(0, 140) : "" };
      }),
      memories: memories || [],
    });
  });

  app.get("/admin/users/:id/chats/:chatId", ...guard, async (req, res) => {
    const id = req.params.id;
    if (!A.isUuid(id)) return res.status(400).json({ error: "That isn't a valid account id." });
    const { data, error } = await supabaseAdmin.from("chats").select("*").eq("user_id", id).eq("id", String(req.params.chatId)).maybeSingle();
    if (error) return fail(res, 500, "I couldn't load that chat. Please try again.", error);
    if (!data) return res.status(404).json({ error: "I couldn't find that chat." });
    await audit(req, "view_chat", id, { chat: data.id });
    const history = Array.isArray(data.history) ? data.history : [];
    res.json({ chat: { id: data.id, title: data.title || "Untitled", author: data.author || null, created_at: data.created_at, messages: history.map(m => ({ role: m && m.role === "user" ? "user" : "assistant", text: A.messageText(m).slice(0, 8000) })).filter(m => m.text) } });
  });

  // ---------- suspend / unban ----------
  app.post("/admin/users/:id/suspend", ...guard, async (req, res) => {
    const id = req.params.id;
    if (!A.isUuid(id)) return res.status(400).json({ error: "That isn't a valid account id." });
    if (id === req.user.id) return res.status(400).json({ error: "You can't suspend your own account." });
    const sus = A.parseSuspension(req.body);
    if (!sus) return res.status(400).json({ error: "Choose how long the suspension lasts." });
    const target = await findUser(id);
    if (!target) return res.status(404).json({ error: "I couldn't find that account." });
    if (isAdmin(target)) return res.status(400).json({ error: "Admins can't be suspended from here." });
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: `${sus.hours}h` });
    if (error) return fail(res, 500, "I couldn't suspend that account. Please try again.", error);
    // the very next thing that person's page asks the server is turned away and signs them out (server.js), so forget what was cached about them
    auth.invalidate(id); usersCache.at = 0;
    const reason = typeof (req.body || {}).reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
    await audit(req, sus.permanent ? "ban" : "suspend", id, { hours: sus.hours, permanent: sus.permanent, reason });
    res.json({ ok: true, ...A.banStatus(data && data.user ? data.user : { banned_until: new Date(Date.now() + sus.hours * 3600 * 1000).toISOString() }) });
  });

  app.post("/admin/users/:id/unban", ...guard, async (req, res) => {
    const id = req.params.id;
    if (!A.isUuid(id)) return res.status(400).json({ error: "That isn't a valid account id." });
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, { ban_duration: "none" });
    if (error) return fail(res, 500, "I couldn't lift that suspension. Please try again.", error);
    auth.invalidate(id); usersCache.at = 0;
    await audit(req, "unban", id, {});
    res.json({ ok: true, status: "active", banned_until: null });
  });

  // ---------- notifications to everyone ----------
  app.get("/admin/announcements", ...guard, async (req, res) => {
    const { data, error } = await supabaseAdmin.from("announcements").select("id, message, created_at, starts_at, expires_at").order("created_at", { ascending: false }).limit(50);
    if (error) return tableMissing(error) ? res.status(503).json({ error: NEEDS_SQL, needsSql: true }) : fail(res, 500, "I couldn't load the notifications. Please try again.", error);
    const now = Date.now();
    res.json({ announcements: (data || []).map(a => ({ ...a, active: Date.parse(a.starts_at) <= now && Date.parse(a.expires_at) > now })) });
  });

  app.post("/admin/announcements", ...guard, async (req, res) => {
    const body = req.body || {};
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "Type the message to show." });
    if (message.length > 500) return res.status(400).json({ error: "Keep the message to 500 characters or fewer." });
    const hours = A.parseDuration(body);
    if (!hours) return res.status(400).json({ error: "Choose how long the message should show (from 1 hour up to a year)." });
    const now = Date.now();
    const { data, error } = await supabaseAdmin.from("announcements").insert({ message, created_by: req.user.id, starts_at: new Date(now).toISOString(), expires_at: new Date(now + hours * 3600 * 1000).toISOString() }).select("id, message, created_at, starts_at, expires_at").single();
    if (error) return tableMissing(error) ? res.status(503).json({ error: NEEDS_SQL, needsSql: true }) : fail(res, 500, "I couldn't send that notification. Please try again.", error);
    await audit(req, "announce", null, { id: data.id, hours, message: message.slice(0, 200) });
    res.json({ announcement: { ...data, active: true } });
  });

  app.delete("/admin/announcements/:id", ...guard, async (req, res) => {
    if (!A.isUuid(req.params.id)) return res.status(400).json({ error: "That isn't a valid notification." });
    const { error } = await supabaseAdmin.from("announcements").delete().eq("id", req.params.id);
    if (error) return fail(res, 500, "I couldn't remove that notification. Please try again.", error);
    await audit(req, "remove_announcement", null, { id: req.params.id });
    res.json({ ok: true });
  });

  // ---------- ask the AI about users ----------
  const ASK_MAX_CHARS = Number(process.env.ADMIN_ASK_MAX_CHARS) || 14000;
  const askLimiter = L.adminAsk;
  app.post("/admin/ask", needUser, needAdmin, askLimiter, async (req, res) => {
    const body = req.body || {};
    const question = typeof body.question === "string" ? body.question.trim().slice(0, 1000) : "";
    if (!question) return res.status(400).json({ error: "Type your question first." });
    const userId = body.userId ? String(body.userId) : "";
    if (userId && !A.isUuid(userId)) return res.status(400).json({ error: "That isn't a valid account id." });
    let users, chats;
    try {
      users = (await allUsers()).map(summarize);
      if (userId) users = users.filter(u => u.id === userId);
      if (userId && !users.length) return res.status(404).json({ error: "I couldn't find that account." });
      chats = await recentChats(userId || null, userId ? 40 : 80);
    } catch (e) { return fail(res, 500, "I couldn't load the data to answer that. Please try again.", e); }
    const context = A.buildAskContext({ users, chats, maxChars: ASK_MAX_CHARS });
    try {
      const answer = await groq.complete({
        model: TEXT_MODEL, max_tokens: 1200, reasoning_effort: "low", temperature: 0.2,
        messages: [
          { role: "system", content: A.ASK_SYSTEM },
          { role: "user", content: `<data>\n${context.text}\n</data>\n\nQuestion from the owner${userId ? " (about the one account listed above)" : ""}: ${question}` },
        ],
      });
      await audit(req, "ask_ai", userId || null, { question: question.slice(0, 300) });
      res.json({ answer: String(answer || "").trim() || "The AI didn't write an answer. Please try again.", chatsRead: context.chatsIncluded, chatsTotal: context.chatsTotal, truncated: context.truncated });
    } catch (e) {
      if (e instanceof groq.GroqError) return res.status(e.status === 429 ? 429 : 502).json({ error: e.message });
      return fail(res, 500, "I couldn't get an answer right now. Please try again.", e);
    }
  });

  // ---------- activity log ----------
  app.get("/admin/audit", ...guard, async (req, res) => {
    const { data, error } = await supabaseAdmin.from("admin_audit").select("id, admin_email, action, target_user_id, detail, created_at").order("created_at", { ascending: false }).limit(60);
    if (error) return tableMissing(error) ? res.status(503).json({ error: NEEDS_SQL, needsSql: true }) : fail(res, 500, "I couldn't load the activity log. Please try again.", error);
    const users = new Map((await allUsers().catch(() => [])).map(u => [u.id, u.email || displayName(u)]));
    res.json({ entries: (data || []).map(r => ({ ...r, target: r.target_user_id ? (users.get(r.target_user_id) || r.target_user_id.slice(0, 8)) : null })) });
  });

  // ---------- setup check, and the two clean-ups it can offer ----------
  const BLANK_AUTHOR = "author.is.null,author.eq.";
  app.get("/admin/health", ...guard, async (req, res) => {
    const checks = [];
    const authorProbe = await supabaseAdmin.from("chats").select("author").limit(1);
    if (authorProbe.error) {
      checks.push({ id: "author", ok: false, label: "Chats record who wrote them", detail: "The chats table has no author column yet. Run supabase/schema.sql in the Supabase SQL editor." });
    } else {
      const { count } = await supabaseAdmin.from("chats").select("id", { count: "exact", head: true }).or(BLANK_AUTHOR);
      checks.push(count ? { id: "author", ok: false, label: "Chats record who wrote them", detail: `${count} saved chat(s) have no author yet.`, fix: "backfill-authors", fixLabel: "Fill in authors" }
        : { id: "author", ok: true, label: "Chats record who wrote them", detail: "Every saved chat has an author." });
    }
    let missingPhones = 0, withPhone = 0;
    try {
      for (const u of await allUsers(true)) {
        if (u.phone) { withPhone++; continue; }
        if (toE164(u.user_metadata && u.user_metadata.phone)) missingPhones++;
      }
    } catch (_) { /* the account list failing is reported below by the other checks */ }
    checks.push(missingPhones ? { id: "phones", ok: false, label: "Phone numbers are saved on the account", detail: `${missingPhones} account(s) gave a phone number that is not in Authentication -> Users yet.`, fix: "sync-phones", fixLabel: "Save them now" }
      : { id: "phones", ok: true, label: "Phone numbers are saved on the account", detail: `${withPhone} account(s) have a phone number saved.` });
    for (const table of ["announcements", "announcement_dismissals", "admin_audit"]) {
      const { error } = await supabaseAdmin.from(table).select("*", { head: true, count: "exact" }).limit(1);
      checks.push({ id: table, ok: !error, label: `Table ${table}`, detail: error ? "Missing. Run supabase/admin.sql in the Supabase SQL editor." : "Ready." });
    }
    const len = Number(process.env.EMAIL_CODE_LENGTH);
    const codeLength = Number.isInteger(len) && len >= 6 && len <= 10 ? len : 6;
    checks.push({ id: "codes", ok: true, label: "Emailed code length", detail: `The app expects ${codeLength}-digit codes. In Supabase, Authentication -> Sign In / Providers -> Email -> Email OTP Length must be ${codeLength} too.` });
    res.json({ checks });
  });

  app.post("/admin/backfill-authors", ...guard, async (req, res) => {
    const { data: rows, error } = await supabaseAdmin.from("chats").select("user_id").or(BLANK_AUTHOR).limit(5000);
    if (error) return res.status(400).json({ error: "The chats table has no author column yet. Run supabase/schema.sql first." });
    const ids = [...new Set((rows || []).map(r => r.user_id))];
    const names = new Map((await allUsers(true)).map(u => [u.id, displayName(u)]));
    let users = 0, chats = 0;
    for (const id of ids) {
      const name = names.get(id);
      if (!name) continue;
      const { data } = await supabaseAdmin.from("chats").update({ author: name }).eq("user_id", id).or(BLANK_AUTHOR).select("id");
      if (data && data.length) { users++; chats += data.length; }
    }
    await audit(req, "backfill_authors", null, { users, chats });
    res.json({ ok: true, users, chats });
  });

  // Copies the phone number typed at sign-up (user_metadata.phone) into the account's real phone column, and says why when Supabase refuses one.
  app.post("/admin/sync-phones", ...guard, async (req, res) => {
    let updated = 0, skipped = 0, tried = 0;
    const failed = [];
    for (const u of await allUsers(true)) {
      if (u.phone) continue;
      const e164 = toE164(u.user_metadata && u.user_metadata.phone);
      if (!e164) { skipped++; continue; }
      if (++tried > 500) break;
      const { error } = await supabaseAdmin.auth.admin.updateUserById(u.id, { phone: e164 });
      if (error) { failed.push({ email: u.email || u.id.slice(0, 8), reason: String(error.message || "refused").slice(0, 140) }); continue; }
      updated++;
      await supabaseAdmin.from("profiles").upsert({ id: u.id, phone: e164, updated_at: new Date().toISOString() }).then(() => {}, () => {});
    }
    usersCache.at = 0;
    await audit(req, "sync_phones", null, { updated, failed: failed.length });
    res.json({ ok: true, updated, skipped, failed });
  });
};
