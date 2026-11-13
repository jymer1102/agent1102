process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  process.exit(1);
});

// A stray rejected promise should not take every signed-in user's stream down with it: log it and carry on.
// (Route handlers are wrapped so their rejections become a normal 500; see lib/asyncwrap.js.)
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});

const express = require("express");
const cors = require("cors");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { createAuth, isBanned } = require("./lib/auth");
const security = require("./lib/security");
const { createLimiter } = require("./lib/ratelimit");
const { wrapAsyncRoutes } = require("./lib/asyncwrap");
const { createUserMeta } = require("./lib/usermeta");
const { createSecretBox } = require("./lib/secrets");
const { createUserSettings } = require("./lib/usersettings");
const groq = require("./lib/groq");

const app = express();
wrapAsyncRoutes(app); // async route errors go to the error handler instead of becoming unhandled rejections

// Render puts one proxy in front of the app; "trust proxy" lets Express read the visitor's address through it.
// If every visitor ever shows up with the same address, set TRUST_PROXY_HOPS (the number of proxies in front).
const proxyHops = Number(process.env.TRUST_PROXY_HOPS);
app.set("trust proxy", Number.isInteger(proxyHops) && proxyHops >= 0 ? proxyHops : 1);

const siteOrigins = security.siteOrigins(); // this site + ALLOWED_ORIGINS (comma separated) may call the API from a browser
app.use(security.securityHeaders(siteOrigins));
app.use(cors(security.corsOptions(siteOrigins)));
// Sign-in, account and settings requests are tiny: a small limit stops anyone posting megabytes at them
app.use(["/auth/signup", "/auth/login", "/auth/refresh", "/auth/update", "/auth/delete", "/prefs", "/memory", "/settings"], express.json({ limit: "20kb" }));
// html/js/css are re-checked on every load so a redeploy is picked up right away (no stale scripts)
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => { if (/\.(html|js|css)$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache"); },
}));

// Render's env-var box happily keeps stray whitespace, quotes, or a trailing
// slash from a copy-paste, and any of them breaks Supabase ("Invalid API key",
// "Invalid path specified in request URL"). Clean them up before use.
const cleanEnv = v => (v || "").trim().replace(/^["']|["']$/g, "").trim();
process.env.SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL).replace(/\/+$/, "");
try {
  // Keep only scheme + host: supabase-js appends /auth/v1, /rest/v1, etc. itself,
  // so a pasted "…supabase.co/rest/v1/" would otherwise produce invalid paths.
  if (process.env.SUPABASE_URL) process.env.SUPABASE_URL = new URL(process.env.SUPABASE_URL).origin;
} catch (_) { /* leave as-is; the startup check below will report it */ }
process.env.SUPABASE_ANON_KEY = cleanEnv(process.env.SUPABASE_ANON_KEY);
process.env.SUPABASE_SERVICE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_KEY);

const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY"];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k] || !process.env[k].trim());
if (missingEnv.length) {
  console.error(
    `\nFATAL: missing required environment variable(s): ${missingEnv.join(", ")}\n` +
    `Set these in your host's dashboard (Render: your service → Environment tab) and redeploy.\n` +
    `SUPABASE_URL and SUPABASE_ANON_KEY come from Supabase → Project Settings → API ("Project URL" and "anon public" key).\n` +
    `SUPABASE_SERVICE_KEY is the "service_role" secret key on that same page — keep it server-side only, never ship it to the client.\n`
  );
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const auth = createAuth(supabase, { ttlMs: Number(process.env.AUTH_CACHE_MS) || undefined }); // (AUTH_CACHE_MS only lets tests shorten how long a sign-in is remembered) // verified-user lookup (cached), used by /chat, /memory and /prefs

// ============================================================
//  Messages people see
//  Every { error } sent to the browser is written for the person using the app: what happened and what to
//  try next. Technical detail (database / AI / service messages, setup instructions for the site owner) goes
//  to the server log instead, never to the screen.
// ============================================================
const MSG = {
  generic: "Something went wrong on our end. Please try again.",
  signIn: "Please sign in to continue.",
  session: "Your session has expired. Please sign in again.",
  tooLarge: "That request is too large. Try something smaller.",
  badRequest: "I couldn't read that request. Please try again.",
  // shown at sign-in, after a Discord/GitHub sign-in, and when someone is banned while signed in (the page signs them out)
  banned: "This account has been banned or suspended, so it can't be used right now. If you think this is a mistake, please contact the site owner.",
};
// Logs the real problem (when there is one) and answers with a message that is safe to show
function fail(res, status, message, err) {
  if (err) console.error(`Request failed (${status}):`, err && err.message ? err.message : err);
  return res.status(status).json({ error: message });
}
// An Error whose message is already written for the person, so it may be shown as it is
class UserError extends Error {}

// Supabase's sign-in / sign-up / account errors in plain words (the original text goes to the log)
function friendlyAuthError(error, fallback) {
  const code = String((error && error.code) || "").toLowerCase();
  const text = String((error && error.message) || "");
  const has = re => re.test(text);
  if (code === "user_banned" || has(/user is banned|\bbanned\b/i)) return MSG.banned;
  if (code === "invalid_credentials" || has(/invalid login credentials/i)) return "That email or password isn't right. Please try again.";
  if (code === "email_not_confirmed" || has(/email not confirmed/i)) return "Please confirm your email first. Check your inbox for the confirmation link.";
  if (code === "user_already_exists" || code === "email_exists" || has(/already (been )?registered|already exists/i)) return "An account with that email already exists. Try signing in instead.";
  if (code === "weak_password" || has(/password should be at least|password is too|weak password/i)) {
    const min = /at least (\d+) characters/i.exec(text);
    return min ? `Your password needs to be at least ${min[1]} characters.` : "That password is too weak. Please choose a longer one.";
  }
  if (code === "same_password" || has(/different from the old password/i)) return "Your new password must be different from your current one.";
  if (code === "reauthentication_needed" || has(/requires reauthentication/i)) return "For your security I need to email you a confirmation code first. Tap \"Send confirmation code\", then enter the code.";
  if (code === "reauthentication_not_valid" || code === "otp_expired" || has(/nonce|token has expired or is invalid|otp.*expired/i)) return "That code isn't right, or it has expired. Check your newest email, or ask for a new code.";
  if (code === "email_address_not_authorized" || has(/not authorized/i)) return "I can't send email to that address right now. Please try a different one, or try again later.";
  if (code === "email_address_invalid" || has(/unable to validate email|invalid format|email address .* is invalid/i)) return "That email address doesn't look right. Please check it and try again.";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit" || (error && error.status === 429) || has(/rate limit|for security purposes/i)) return "Too many attempts. Please wait a minute and try again.";
  if (code === "signup_disabled" || has(/signups? (not allowed|are disabled)/i)) return "New sign-ups are turned off right now.";
  if (error) console.warn("Auth error shown as a generic message:", code || "(no code)", text);
  return fallback;
}

// Fire-and-forget sanity check: confirms SUPABASE_URL/ANON/SERVICE keys are a
// matching, valid set for the same project, and says so plainly in the logs
// right away instead of waiting for someone's login to fail with a cryptic
// "Invalid API key". Doesn't block startup/port binding.
(async () => {
  try {
    const { error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) {
      console.error(
        `\nWARNING: Supabase credentials check failed: ${error.message}\n` +
        `SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_KEY must all come from the SAME Supabase project ` +
        `(Project Settings → API), pasted with no extra spaces or line breaks. Sign-in/sign-up will not work until this is fixed.\n`
      );
    } else {
      console.log("Supabase credentials check: OK");
    }
  } catch (err) {
    console.error("WARNING: Supabase credentials check threw an error:", err && err.message ? err.message : err);
  }
})();

// --- KEEP ALIVE ---
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

// --- WHO IS ASKING, AND HOW OFTEN ---

// ============================================================
//  Who is asking, and how often
//  A token is only believed after Supabase has vouched for it (auth.verify, cached for a few minutes).
//  Decoding a token without checking it proves nothing: anyone can write a token that names someone else.
// ============================================================
const needUser = async (req, res, next) => {
  const token = auth.bearer(req);
  const user = await auth.verify(token);
  if (!user) return res.status(401).json({ error: token ? MSG.session : MSG.signIn });
  req.user = user;
  next();
};

// limiter keys: an address, a verified person, or the email typed into a sign-in form
const ipKey = req => "ip:" + (req.ip || "unknown");
const personKey = req => (req.user ? "u:" + req.user.id : ipKey(req)); // after needUser
const emailKey = req => {
  const e = String((req.body && req.body.email) || "").trim().toLowerCase().slice(0, 254);
  return e ? "email:" + e : null;
};
const signedInKey = async req => { const u = await auth.verify(auth.bearer(req)); return u ? "u:" + u.id : null; };
const signedOutKey = async req => { const u = await auth.verify(auth.bearer(req)); return u ? null : ipKey(req); };
const MIN = 60 * 1000;
const slowDown = what => wait => `${what} Please try again in ${wait}.`;
const L = {
  everything: createLimiter({ windowMs: MIN, max: 600, key: ipKey, message: slowDown("Too many requests right now.") }),
  loginEmail: createLimiter({ windowMs: 15 * MIN, max: 8, key: emailKey, skipSuccessful: true, message: slowDown("Too many sign-in attempts for that account.") }),
  loginIp: createLimiter({ windowMs: 15 * MIN, max: 40, key: ipKey, skipSuccessful: true, message: slowDown("Too many sign-in attempts.") }),
  signupIp: createLimiter({ windowMs: 60 * MIN, max: 10, key: ipKey, message: slowDown("Too many sign-up attempts.") }),
  signupEmail: createLimiter({ windowMs: 60 * MIN, max: 5, key: emailKey, message: slowDown("Too many sign-up attempts for that email.") }),
  // emails Supabase sends for someone who isn't signed in (reset link, resend confirmation): per address, and per person asking
  emailIp: createLimiter({ windowMs: 60 * MIN, max: 12, key: ipKey, message: slowDown("Too many email requests from here. Please try again later.") }),
  emailAddr: createLimiter({ windowMs: 60 * MIN, max: 4, key: emailKey, message: slowDown("Too many emails to that address. Please wait before asking again.") }),
  // emails and codes for someone who IS signed in (change email, send code), and tries at entering a code
  emailPerson: createLimiter({ windowMs: 60 * MIN, max: 8, key: personKey, message: slowDown("Too many emails requested. Please wait a while before trying again.") }),
  // typing the 6-digit code from a sign-up / reset email (not signed in): per address, and per person asking
  codeIp: createLimiter({ windowMs: 15 * MIN, max: 40, key: ipKey, message: slowDown("Too many code attempts from here.") }),
  codeEmail: createLimiter({ windowMs: 15 * MIN, max: 10, key: emailKey, message: slowDown("Too many tries for that account.") }),
  codeTries: createLimiter({ windowMs: 15 * MIN, max: 10, key: personKey, message: slowDown("Too many tries. Please wait a few minutes.") }),
  refresh: createLimiter({ windowMs: 15 * MIN, max: 120, key: ipKey, message: slowDown("Too many requests.") }),
  scores: createLimiter({ windowMs: 10 * MIN, max: 60, key: ipKey, message: slowDown("Too many scores sent.") }),
  chat: createLimiter({ windowMs: MIN, max: 30, key: signedInKey, message: slowDown("You're sending messages very quickly.") }),
  chatSignedOut: createLimiter({ windowMs: 10 * MIN, max: 10, key: signedOutKey, message: slowDown("Please sign in to keep chatting.") }),
  study: createLimiter({ windowMs: 10 * MIN, max: 20, key: personKey, message: slowDown("You've made a lot of study requests.") }),
  images: createLimiter({ windowMs: 10 * MIN, max: 10, key: personKey, message: slowDown("You've made a lot of image requests.") }),
  webImages: createLimiter({ windowMs: 10 * MIN, max: 20, key: personKey, message: slowDown("You've searched for a lot of pictures.") }),
  title: createLimiter({ windowMs: MIN, max: 30, key: personKey, message: slowDown("Too many requests.") }),
  tts: createLimiter({ windowMs: MIN, max: 60, key: personKey, message: slowDown("Too many read-aloud requests.") }),
  settings: createLimiter({ windowMs: 10 * MIN, max: 30, key: personKey, message: slowDown("You've changed your settings a lot. Please wait a few minutes.") }),
  linkPreview: createLimiter({ windowMs: MIN, max: 90, key: personKey, message: slowDown("Too many link previews.") }),
};
app.use(L.everything); // a generous per-address backstop for every API route (the page's own files are served before this)
// The large body parsers come AFTER the limiter, so an address that is being throttled can't keep making the server
// read and parse 10 MB bodies. (The small /auth, /prefs and /memory parser near the top still goes first.)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// ============================================================
//  Banned / suspended people
//  Supabase stops a banned person signing in or refreshing, but a sign-in they already hold keeps working for up to an hour
//  (and Supabase's own endpoints still accept it). So every request that carries a sign-in is checked here, before any route
//  runs: a banned or suspended account gets a 403 with code "user_banned", and the page signs the person out at once.
//  auth.verify is cached for a minute and routes ask for the same user anyway, so this adds no extra calls to Supabase.
// ============================================================
const lastRevoke = new Map(); // user id -> when their Supabase sessions were last ended
function revokeSessions(user, token) {
  const now = Date.now();
  if (now - (lastRevoke.get(user.id) || 0) < 10 * 60 * 1000) return;
  lastRevoke.set(user.id, now);
  if (lastRevoke.size > 1000) lastRevoke.delete(lastRevoke.keys().next().value);
  // best effort: ends every session and refresh token this person has, so no other device keeps going. (Supabase still lets a banned token call /logout.)
  Promise.resolve().then(() => supabaseAdmin.auth.admin.signOut(token, "global")).catch(e => console.warn("Ending a banned user's sessions failed:", e && e.message ? e.message : e));
}
app.use(async (req, res, next) => {
  const token = auth.bearer(req) || (req.body && typeof req.body.token === "string" ? req.body.token : null);
  if (!token) return next();
  let user;
  try { user = await auth.verify(token); } catch (_) { return next(); } // can't tell: the route's own check decides
  if (!user || !isBanned(user)) return next();
  revokeSessions(user, token);
  res.status(403).json({ error: MSG.banned, code: "user_banned" });
});


// ============================================================
//  The features. Each lives in its own file in routes/ and receives `ctx` (the shared pieces above).
//  Order matters where one file uses another's helpers: link previews -> study -> titles -> chat -> the rest.
// ============================================================
const ROOT = __dirname;
const { TEXT_MODEL, VISION_MODEL, MAX_IMAGES_PER_REQUEST } = require("./lib/models");
const { SYSTEM_PROMPT, MATH_VISUALS_GUIDE } = require("./lib/system-prompt");
// This site's own address (SITE_URL may hold several comma-separated ones: the first is the main one). Every link in the emails
// Supabase sends (confirm sign-up, reset password, confirm email change) is told to come back to <this>/auth/callback.
const siteUrl = () => String(process.env.SITE_URL || "https://agent1102.onrender.com").split(",")[0].trim().replace(/\/+$/, "");
const userMeta = createUserMeta({ supabaseAdmin, auth });
// People can store their own Groq key. It is encrypted with a key derived from KEY_ENCRYPTION_SECRET, or else from the service key.
const secretBox = createSecretBox(process.env.KEY_ENCRYPTION_SECRET || process.env.SUPABASE_SERVICE_KEY);
const userSettings = createUserSettings({ supabaseAdmin, box: secretBox, ttlMs: Number(process.env.SETTINGS_CACHE_MS) || 60 * 1000 }); // (the cache is cleared whenever the person saves a change; the env variable only lets tests shorten it)
const ctx = {
  app, supabase, supabaseAdmin, auth, isBanned, userMeta, userSettings, siteUrl, MSG, fail, UserError, friendlyAuthError, needUser, L,
  TEXT_MODEL, VISION_MODEL, MAX_IMAGES_PER_REQUEST, SYSTEM_PROMPT, MATH_VISUALS_GUIDE, ROOT,
};
// Requests that call the AI run with the person's own Groq key if they saved one (otherwise the shared key, as before).
app.use(["/chat", "/study", "/graph", "/title"], async (req, res, next) => {
  let key = null;
  try {
    const user = await auth.verify(auth.bearer(req));
    key = user ? await userSettings.groqKey(user.id) : null;
  } catch (_) { /* can't look it up: use the shared key */ }
  if (key) return groq.runWithKey(key, next);
  next();
});
require("./routes/linkpreview")(ctx);
require("./routes/study")(ctx);
require("./routes/title")(ctx);
require("./routes/chat")(ctx);
require("./routes/media")(ctx);
require("./routes/webimages")(ctx);
require("./routes/auth")(ctx);
require("./routes/eggs")(ctx);
require("./routes/scores")(ctx);
require("./routes/settings")(ctx);
require("./routes/authemail")(ctx);
require("./routes/chats")(ctx);

// --- ERROR HANDLER ---
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    const msg = req.path === "/auth/avatar"
      ? `That picture is too big. Profile pictures can be up to ${ctx.AVATAR_MAX_BYTES / 1024 / 1024} MB.`
      : MSG.tooLarge;
    return res.status(413).json({ error: msg });
  }
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: MSG.badRequest });
  console.error(err);
  if (res.headersSent) return res.end(); // e.g. a stream that already started: just close it
  res.status(err.status || 500).json({ error: MSG.generic });
});

// --- START, SELF KEEP-ALIVE, SHUTDOWN ---
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Render's free tier sleeps an idle service, so the app pings its own public address now and then.
// Only the FIRST address of SITE_URL is used (it may be a comma-separated list), the ping has a timeout, and it
// stays off on a laptop or in tests unless SITE_URL is set, so a local run never pokes the live site.
const firstOrigin = v => String(v || "").split(",")[0].trim().replace(/\/+$/, "");
const SELF_URL = process.env.SELF_PING === "off" ? "" : firstOrigin(process.env.RENDER_EXTERNAL_URL || process.env.SITE_URL || (process.env.RENDER ? "https://agent1102.onrender.com" : ""));
function selfPing() {
  fetch(`${SELF_URL}/ping`, { signal: AbortSignal.timeout(10000) })
    .then((res) => console.log(`Self-ping OK (${res.status})`))
    .catch((err) => console.warn("Self-ping failed:", err.message));
}
const pingTimer = SELF_URL ? setInterval(selfPing, 5 * 60 * 1000) : null;
if (pingTimer) pingTimer.unref();

// On a deploy Render sends SIGTERM: stop taking new requests and give streams that are mid-answer a moment to finish.
process.on("SIGTERM", () => {
  console.log("SIGTERM received: shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 25000).unref();
});
