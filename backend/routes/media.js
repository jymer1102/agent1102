// Image creation, image editing and read-aloud audio (POST /generate-image, /edit-image, /tts).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)

module.exports = function registerMedia(ctx) {
const { app, supabaseAdmin, UserError, needUser, L } = ctx;

// --- IMAGE GENERATION ---
// Cloudflare Workers AI (FLUX.1 schnell), which has a free daily allowance. Set CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID in Render. The server makes the image, saves it in the public "chat-uploads" Supabase bucket
// and returns that URL (the same kind of URL /edit returns), so the keys never reach the browser.
// For the "isn't set up" log lines: says which of the two variables the server can see, plus the NAMES (never the
// values) of any similar-looking variables, which catches a misspelled name or stray spaces in it.
function cloudflareEnvHint() {
  const state = n => (process.env[n] || "").trim() ? "set" : "MISSING or empty";
  const similar = Object.keys(process.env).filter(k => /cloudflare|^cf_/i.test(k) && k !== "CLOUDFLARE_API_TOKEN" && k !== "CLOUDFLARE_ACCOUNT_ID");
  return `CLOUDFLARE_API_TOKEN: ${state("CLOUDFLARE_API_TOKEN")}; CLOUDFLARE_ACCOUNT_ID: ${state("CLOUDFLARE_ACCOUNT_ID")}; similar names the server can see: ${similar.length ? JSON.stringify(similar) : "none"}`;
}

// Cloudflare's image models refuse prompts their filter flags as adult content (error code 3030). Those are reported
// to the user as "blocked by the filter" instead of the generic "try again later" message.
const FILTER_MESSAGE = "That was blocked by the image filter. Try describing it in more detail, for example what it looks like, where it is and the style, and keep it family-friendly.";
function filterBlocked(status, raw) {
  return status >= 400 && status < 500 && (/\b3030\b/.test(raw) || /nsfw/i.test(raw));
}
class FilteredError extends Error {}

const CF_IMAGE_MODEL = process.env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

async function cloudflareImage(prompt) {
  const token = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  const account = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  if (!token || !account) return null;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${CF_IMAGE_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, steps: 4 }),
    signal: AbortSignal.timeout(60000),
  });
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (_) {}
  const b64 = json && json.result && json.result.image;
  if (!r.ok || !b64) {
    if (filterBlocked(r.status, raw)) throw new FilteredError(FILTER_MESSAGE);
    console.error("Cloudflare image failed:", r.status, raw.slice(0, 300)); // usually: wrong token/account ID, or today's free allowance is used up
    return null;
  }
  const buf = Buffer.from(b64, "base64");
  const mime = sniffImageMime(buf) || "image/jpeg";
  const filePath = `generated/${Date.now()}-${Math.random().toString(36).slice(2)}.${MIME_EXT[mime]}`;
  const { error: upErr } = await supabaseAdmin.storage.from(CHAT_UPLOAD_BUCKET).upload(filePath, buf, { contentType: mime, cacheControl: "31536000", upsert: false });
  if (upErr) { console.error("Couldn't save the generated image:", upErr.message); return null; }
  return supabaseAdmin.storage.from(CHAT_UPLOAD_BUCKET).getPublicUrl(filePath).data.publicUrl;
}

app.post("/generate-image", needUser, L.images, async (req, res) => {
  const { prompt } = req.body;
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "Describe the image you want and try again." });
  if (!(process.env.CLOUDFLARE_API_TOKEN || "").trim() || !(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim()) {
    console.warn("Image creation is off. " + cloudflareEnvHint());
    return res.status(503).json({ error: "Image creation isn't available right now." });
  }
  try {
    const url = await cloudflareImage(prompt.trim().slice(0, 500));
    if (!url) return res.status(502).json({ error: "I couldn't create that image right now. The free daily image limit may be used up, so please try again later." });
    res.json({ imageUrl: url });
  } catch (err) {
    if (err instanceof FilteredError) return res.status(422).json({ error: err.message });
    console.error("Cloudflare image error:", err && err.message ? err.message : err);
    res.status(500).json({ error: "I couldn't create that image. Please try again." });
  }
});

// --- IMAGE EDITING ("/edit") ---
// Runs on the server so the Cloudflare token never reaches the browser. Flow: get the
// source image bytes (an attached photo, or the previously generated image), send them
// plus the prompt to Cloudflare, save the result in the public "chat-uploads"
// Supabase Storage bucket, and return that URL for the chat to display.
// CF_EDIT_MODEL / CF_EDIT_FIELD can be changed without touching code.
const CHAT_UPLOAD_BUCKET = "chat-uploads";
const EDIT_MAX_BYTES = 10 * 1024 * 1024;

// Create the bucket on startup if it isn't there yet (no manual dashboard step).
(async () => {
  try {
    const { error } = await supabaseAdmin.storage.createBucket(CHAT_UPLOAD_BUCKET, { public: true, fileSizeLimit: EDIT_MAX_BYTES });
    if (error && !/already exists|duplicate/i.test(error.message)) {
      console.warn(`WARNING: couldn't create the "${CHAT_UPLOAD_BUCKET}" storage bucket (/edit needs it): ${error.message}`);
    }
  } catch (err) {
    console.warn("WARNING: storage bucket check failed:", err && err.message ? err.message : err);
  }
})();

function sniffImageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}
const MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function loadEditSource({ imageUrl, imageBase64 }) {
  let buf;
  if (typeof imageBase64 === "string" && imageBase64) {
    const m = /^data:image\/(?:jpeg|png|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(imageBase64);
    if (!m) throw new UserError("That image isn't a supported type. Please use a JPG, PNG or WEBP image.");
    buf = Buffer.from(m[1], "base64");
  } else {
    let u;
    try { u = new URL(imageUrl); } catch (_) { throw new UserError("I couldn't find that image to edit. Attach it again and try again."); }
    const ownHost = new URL(process.env.SUPABASE_URL).hostname;
    const okHost = u.protocol === "https:" && (u.hostname === "image.pollinations.ai" || u.hostname === "media.pollinations.ai" || u.hostname === "gen.pollinations.ai" || u.hostname === ownHost);
    if (!okHost) throw new UserError("I can only edit images from this chat.");
    const r = await fetch(u, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new UserError("I couldn't load that image to edit it. Attach it again and try again.");
    buf = Buffer.from(await r.arrayBuffer());
  }
  if (buf.length > EDIT_MAX_BYTES) throw new UserError(`That image is too large. Images can be up to ${EDIT_MAX_BYTES / 1024 / 1024} MB.`);
  const mime = sniffImageMime(buf);
  if (!mime) throw new UserError("That file doesn't look like a JPG, PNG or WEBP image.");
  return { buf, mime };
}

// Editing uses Cloudflare Workers AI (FLUX.2 klein, free daily allowance; same CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID as /image). cloudflareEdit returns image bytes, or null if it didn't work.
const CF_EDIT_MODEL = process.env.CF_EDIT_MODEL || "@cf/black-forest-labs/flux-2-klein-4b";
const CF_EDIT_FIELD = process.env.CF_EDIT_FIELD || "input_image_0"; // name of the multipart field that carries the picture

async function cloudflareEdit(prompt, src) {
  const token = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
  const account = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  if (!token || !account) return null;
  const form = new FormData();
  form.append("prompt", prompt);
  form.append(CF_EDIT_FIELD, new Blob([src.buf], { type: src.mime }), `image.${MIME_EXT[src.mime]}`);
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${CF_EDIT_MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  const type = r.headers.get("content-type") || "";
  if (r.ok && /^image\//i.test(type)) return Buffer.from(await r.arrayBuffer());
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (_) {}
  const b64 = json && ((json.result && json.result.image) || json.image);
  if (!r.ok || !b64) {
    if (filterBlocked(r.status, raw)) throw new FilteredError(FILTER_MESSAGE);
    console.error("Cloudflare edit failed:", r.status, raw.slice(0, 300)); // usually: wrong token/account ID, or today's free allowance is used up
    return null;
  }
  return Buffer.from(b64, "base64");
}

app.post("/edit-image", needUser, L.images, async (req, res) => {
  const { prompt, imageUrl, imageBase64 } = req.body;
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "Describe the image you want and try again." });
  if (typeof imageUrl !== "string" && typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "Attach an image to edit, or create one first with /image." });
  }
  if (!(process.env.CLOUDFLARE_API_TOKEN || "").trim() || !(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim()) {
    console.warn("Image editing is off. " + cloudflareEnvHint());
    return res.status(503).json({ error: "Image editing isn't available right now." });
  }
  try {
    const src = await loadEditSource({ imageUrl, imageBase64 });
    const text = prompt.trim().slice(0, 500);

    let out = null;
    try { out = await cloudflareEdit(text, src); }
    catch (err) {
      if (err instanceof FilteredError) return res.status(422).json({ error: err.message });
      console.error("Cloudflare edit error:", err && err.message ? err.message : err);
    }
    if (!out) return res.status(502).json({ error: "I couldn't edit that image right now. The free daily image limit may be used up, so please try again later." });

    const mime = sniffImageMime(out) || "image/png";
    const filePath = `edits/${Date.now()}-${Math.random().toString(36).slice(2)}.${MIME_EXT[mime]}`;
    const { error: upErr } = await supabaseAdmin.storage.from(CHAT_UPLOAD_BUCKET).upload(filePath, out, { contentType: mime, cacheControl: "31536000", upsert: false });
    if (upErr) throw new Error("Couldn't save the edited image: " + upErr.message);
    const publicUrl = supabaseAdmin.storage.from(CHAT_UPLOAD_BUCKET).getPublicUrl(filePath).data.publicUrl;
    res.json({ imageUrl: publicUrl });
  } catch (err) {
    console.error("Image edit failed:", err);
    res.status(500).json({ error: err instanceof UserError ? err.message : "I couldn't edit that image. Please try again." });
  }
});

// --- READ ALOUD (real audio, so it plays even with the phone's mute switch on) ---
// Uses ElevenLabs (an API key is required: set ELEVENLABS_API_KEY). If it isn't
// configured, the client automatically falls back to the browser's own voice.
const TTS_VOICE_ID = process.env.TTS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // "Rachel", one of ElevenLabs' default voices
const TTS_MODEL = process.env.TTS_MODEL || "eleven_flash_v2_5"; // low-latency model; good fit for a chat reply
app.post("/tts", needUser, L.tts, async (req, res) => {
  const { text } = req.body;
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "There's nothing to read aloud." });
  if (!process.env.ELEVENLABS_API_KEY) {
    // Not a user-facing failure: the client treats this as "not set up yet" and
    // quietly uses the browser's built-in voice instead.
    return res.status(501).json({ error: "tts_not_configured" });
  }
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${TTS_VOICE_ID}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
      },
      // 3,000 characters keeps a single request comfortably inside ElevenLabs' limits;
      // the client already sends replies in smaller chunks anyway.
      body: JSON.stringify({ text: text.slice(0, 3000), model_id: TTS_MODEL }),
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).detail?.message || ""; } catch (_) {}
      if (response.status === 401) { console.error("ElevenLabs: invalid API key"); return res.status(501).json({ error: "tts_not_configured" }); }
      if (response.status === 429) return res.status(429).json({ error: "Read-aloud has used up its monthly quota. It'll fall back to your device's own voice for now." });
      console.error("ElevenLabs error:", response.status, detail);
      return res.status(500).json({ error: "I couldn't read this aloud." });
    }
    res.setHeader("Content-Type", "audio/mpeg");
    const buf = Buffer.from(await response.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "I couldn't read this aloud." });
  }
});

};
