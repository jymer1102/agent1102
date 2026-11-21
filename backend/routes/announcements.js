// What every signed-in person sees from the admin: the notifications that are on right now (GET /announcements) and the x that hides one (POST /announcements/:id/dismiss).
"use strict";
const { isUuid } = require("../lib/admin");

module.exports = function registerAnnouncements(ctx) {
  const { app, supabaseAdmin, needUser, fail } = ctx;

  app.get("/announcements", needUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from("announcements").select("id, message, created_at, expires_at")
      .lte("starts_at", now).gt("expires_at", now).order("created_at", { ascending: false }).limit(10);
    // supabase/admin.sql not run yet (or any other problem): nothing to show, and the chat keeps working
    if (error || !data || !data.length) return res.json({ announcements: [] });
    const { data: gone } = await supabaseAdmin.from("announcement_dismissals").select("announcement_id").eq("user_id", req.user.id).in("announcement_id", data.map(a => a.id));
    const dismissed = new Set((gone || []).map(d => d.announcement_id));
    res.json({ announcements: data.filter(a => !dismissed.has(a.id)) });
  });

  app.post("/announcements/:id/dismiss", needUser, async (req, res) => {
    if (!isUuid(req.params.id)) return res.status(400).json({ error: "That isn't a valid notification." });
    const { error } = await supabaseAdmin.from("announcement_dismissals").upsert({ announcement_id: req.params.id, user_id: req.user.id }, { onConflict: "announcement_id,user_id" });
    if (error && !/does not exist|schema cache|foreign key/i.test(error.message || "")) return fail(res, 500, "I couldn't hide that. Please try again.", error);
    res.json({ ok: true });
  });
};
