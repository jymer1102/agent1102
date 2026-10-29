// ============================================================
//  Browser security settings: which sites may call the API (CORS), and the response headers that tell the
//  browser what a page is allowed to load or do (Content-Security-Policy and friends).
//
//  The page loads scripts only from its own server and cdn.jsdelivr.net, has no inline scripts and no inline
//  event handlers, so scripts that someone manages to inject into the page are blocked instead of run.
// ============================================================
"use strict";

const PREVIEW_PATH = "/preview-frame.html";
const LOCAL_DEV = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// "https://a.com, https://b.com/path" -> Set { "https://a.com", "https://b.com" }
function parseOrigins(...values) {
  const out = new Set();
  for (const value of values) {
    for (const part of String(value || "").split(",")) {
      const v = part.trim();
      if (!v) continue;
      try { out.add(new URL(v).origin); } catch (_) { /* ignore anything that isn't a URL */ }
    }
  }
  return out;
}

// Sites allowed to call the API from a browser: this site itself, plus anything listed in ALLOWED_ORIGINS
function siteOrigins(env = process.env) {
  return parseOrigins(env.SITE_URL, "https://agent1102.onrender.com", env.ALLOWED_ORIGINS);
}

// Requests with no Origin header (same-site page loads, curl, the keep-alive ping) are always fine.
// localhost is allowed so the page can be developed on a computer against the live server.
function corsOptions(origins) {
  return { origin: (origin, cb) => cb(null, !origin || origins.has(origin) || LOCAL_DEV.test(origin)) };
}

function appCsp(origins) {
  const list = [...origins].join(" ");
  return [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "font-src 'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${list} https://cdn.jsdelivr.net`.replace(/\s+/g, " "),
    "worker-src 'self' blob: https://cdn.jsdelivr.net",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

// The code "Preview" button shows AI-written HTML (with its own scripts and styles) inside a sandboxed frame.
// That frame is its own tiny page with a permissive policy; the iframe's sandbox attribute plus the sandbox
// directive below keep it from touching the real page or the saved login.
const PREVIEW_CSP = "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; sandbox allow-scripts allow-forms allow-modals allow-popups; frame-ancestors 'self'";

function securityHeaders(origins) {
  const csp = appCsp(origins);
  return function (req, res, next) {
    res.setHeader("Content-Security-Policy", req.path === PREVIEW_PATH ? PREVIEW_CSP : csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=(), microphone=(self)");
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=15552000"); // 180 days, https only
    next();
  };
}

module.exports = { parseOrigins, siteOrigins, corsOptions, appCsp, securityHeaders, PREVIEW_CSP, PREVIEW_PATH };
