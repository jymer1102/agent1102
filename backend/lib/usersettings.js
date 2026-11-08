// Each person's AI settings (Settings -> AI): the written preferences and their own Groq API key.
// Stored in the user_settings table (supabase/settings.sql), read and written only by the server.
"use strict";

const MAX_TEXT = 1500;

// "table doesn't exist yet" in the two ways Supabase reports it: the new table was never created with settings.sql
const tableMissing = e => !!e && (e.code === "42P01" || e.code === "PGRST205" || /relation .* does not exist|schema cache/i.test(e.message || ""));

// Plain text only, trimmed and capped: this text is shown back to the person and placed inside the AI's prompt
const keepChar = ch => { const c = ch.codePointAt(0); return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127); }; // tab, newlines and visible text; no other control characters
const cleanText = v => Array.from(String(v == null ? "" : v)).filter(keepChar).join("").trim().slice(0, MAX_TEXT);

function createUserSettings({ supabaseAdmin, box, ttlMs = 60 * 1000 }) {
  const cache = new Map(); // userId -> { at, row }  (a minute is plenty; every write clears it)
  let missing = false;     // set when the table doesn't exist, so we stop asking

  async function loadRow(userId) {
    if (missing) return { row: null, available: false };
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < ttlMs) return { row: hit.row, available: true };
    const { data, error } = await supabaseAdmin.from("user_settings")
      .select("talk_style, about_me, groq_key_enc, groq_key_last4").eq("user_id", userId).maybeSingle();
    if (error) {
      if (tableMissing(error)) { missing = true; console.warn("user_settings table not found: run supabase/settings.sql. Per-person settings are off until then."); return { row: null, available: false }; }
      throw new Error(error.message);
    }
    cache.set(userId, { at: Date.now(), row: data || null });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return { row: data || null, available: true };
  }

  // what the page and the prompt need. Never includes the key itself.
  async function load(userId) {
    try {
      const { row, available } = await loadRow(userId);
      // A saved key only counts if it can still be read. If the server's secret changed, or the value was damaged, the shared key
      // is what's really being used, so the page must not claim otherwise: it says the key needs pasting again.
      const saved = !!(row && row.groq_key_enc);
      const readable = saved && !!box && box.decrypt(row.groq_key_enc, userId) !== null;
      return {
        available, canStoreKey: !!box,
        talkStyle: (row && row.talk_style) || "", aboutMe: (row && row.about_me) || "",
        hasKey: readable, keyUnreadable: saved && !readable, last4: readable ? (row.groq_key_last4 || "") : "",
      };
    } catch (e) {
      console.warn("Loading settings failed:", e.message);
      return { available: false, canStoreKey: !!box, talkStyle: "", aboutMe: "", hasKey: false, keyUnreadable: false, last4: "" };
    }
  }

  // the person's own Groq key, or null (none saved, or it can't be decrypted: then the shared key is used)
  async function groqKey(userId) {
    if (!box) return null;
    try {
      const { row } = await loadRow(userId);
      return row && row.groq_key_enc ? box.decrypt(row.groq_key_enc, userId) : null;
    } catch (_) { return null; }
  }

  async function upsert(userId, fields) {
    if (missing) throw Object.assign(new Error("settings storage is not set up"), { notSetUp: true });
    const { error } = await supabaseAdmin.from("user_settings").upsert({ user_id: userId, ...fields, updated_at: new Date().toISOString() });
    cache.delete(userId);
    if (error) {
      if (tableMissing(error)) { missing = true; throw Object.assign(new Error("settings storage is not set up"), { notSetUp: true }); }
      throw new Error(error.message);
    }
  }

  const saveText = (userId, { talkStyle, aboutMe }) => upsert(userId, { talk_style: cleanText(talkStyle), about_me: cleanText(aboutMe) });

  async function setKey(userId, key) { // async on purpose: a refusal is always a rejected promise, never a synchronous throw
    if (!box) throw Object.assign(new Error("no encryption secret"), { noSecret: true });
    return upsert(userId, { groq_key_enc: box.encrypt(key, userId), groq_key_last4: key.slice(-4) });
  }
  const clearKey = userId => upsert(userId, { groq_key_enc: null, groq_key_last4: null });

  return { load, groqKey, saveText, setKey, clearKey, invalidate: id => cache.delete(id), MAX_TEXT, cleanText };
}

module.exports = { createUserSettings, MAX_TEXT, cleanText };
