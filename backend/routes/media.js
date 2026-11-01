// Image creation, image editing and read-aloud audio (POST /generate-image, /edit-image, /tts).
// (The code below is moved unchanged from the old single-file server.js; shared things arrive through `ctx`.)

module.exports = function registerMedia(ctx) {
const { app, supabaseAdmin, UserError, needUser, L } = ctx;

// --- IMAGE GENERATION ---
// Preferred: Cloudflare Workers AI (FLUX.1 schnell), which has a free daily allowance. Set CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID in Render. The server makes the image, saves it in the public "chat-uploads" Supabase bucket
// and returns that URL (the same kind of URL /edit returns), so the keys never reach the browser.
// If Cloudflare isn't set up, or its free allowance for the day is used up, it falls back to the anonymous
// Pollinations link the app used before, so /image keeps working either way.
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
  try {
    const text = prompt.trim().slice(0, 500);
    try {
      const url = await cloudflareImage(text);
      if (url) return res.json({ imageUrl: url });
    } catch (err) {
      console.error("Cloudflare image error:", err && err.message ? err.message : err);
    }
    // fallback: anonymous Pollinations link (the browser loads it directly)
    // encodeURIComponent leaves ! ' ( ) * alone; encode them too so the URL can't break markdown
    const encoded = encodeURIComponent(text).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    const seed = Math.floor(Math.random() * 1e9); // new seed = a fresh image every time
    const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=768&height=768&nologo=true&seed=${seed}`;
    res.json({ imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "I couldn't create that image. Please try again." });
  }
});

// --- IMAGE EDITING ("/edit") ---
// Runs on the server because Pollinations' image-edit endpoint needs an API
// key (set POLLINATIONS_API_KEY in Render; get one at enter.pollinations.ai)
// and that key must never reach the browser. Flow: get the source image bytes
// (an attached photo, or the previously generated image), send them plus the
// prompt to Pollinations, save the result in the public "chat-uploads"
// Supabase Storage bucket, and return that URL for the chat to display.
// EDIT_MODEL (default "kontext") can be changed without touching code.
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

app.post("/edit-image", needUser, L.images, async (req, res) => {
  const { prompt, imageUrl, imageBase64 } = req.body;
  if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "Describe the image you want and try again." });
  if (typeof imageUrl !== "string" && typeof imageBase64 !== "string") {
    return res.status(400).json({ error: "Attach an image to edit, or create one first with /image." });
  }
  const key = (process.env.POLLINATIONS_API_KEY || "").trim();
  if (!key) {
    console.warn("Image editing is off: set POLLINATIONS_API_KEY (free at enter.pollinations.ai).");
    return res.status(503).json({ error: "Image editing isn't available right now." });
  }
  try {
    const src = await loadEditSource({ imageUrl, imageBase64 });

    const form = new FormData();
    form.append("image", new Blob([src.buf], { type: src.mime }), `image.${MIME_EXT[src.mime]}`);
    form.append("prompt", prompt.trim().slice(0, 500));
    form.append("model", process.env.EDIT_MODEL || "kontext");
    const r = await fetch("https://gen.pollinations.ai/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(120000),
    });
    const raw = await r.text();
    let json = null;
    try { json = JSON.parse(raw); } catch (_) {}
    if (!r.ok) {
      const detail = (json && (json.error && (json.error.message || json.error))) || raw.slice(0, 200);
      console.error("Pollinations edit failed:", r.status, raw.slice(0, 500));
      console.error("Pollinations edit detail:", typeof detail === "string" ? detail.slice(0, 160) : "");
      return res.status(502).json({ error: "The image editor had a problem. Please try again in a moment." });
    }

    const item = json && Array.isArray(json.data) ? json.data[0] : null;
    let out;
    if (item && item.b64_json) out = Buffer.from(item.b64_json, "base64");
    else if (item && item.url) {
      const ir = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
      if (!ir.ok) throw new Error("Couldn't download the edited image.");
      out = Buffer.from(await ir.arrayBuffer());
    } else {
      console.error("Unexpected edit response:", raw.slice(0, 500));
      return res.status(502).json({ error: "The image editor didn't return a picture. Please try again." });
    }

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
