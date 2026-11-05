// Express 4 does not look at the promise an async route handler returns, so a throw inside one
// becomes an unhandled rejection (and, with the process-level handler, a crash/restart).
// wrapAsyncRoutes(app) makes app.get/post/put/patch/delete/all forward those rejections to next(err),
// which lands in the normal error handler at the bottom of server.js. Nothing else changes.
const METHODS = ["get", "post", "put", "patch", "delete", "all"];

function wrap(fn) {
  if (typeof fn !== "function" || fn.length === 4) return fn; // leave non-functions and error handlers alone
  return function wrapped(req, res, next) {
    const out = fn.call(this, req, res, next);
    if (out && typeof out.catch === "function") out.catch(next);
    return out;
  };
}

function wrapAsyncRoutes(app) {
  for (const m of METHODS) {
    const original = app[m].bind(app);
    app[m] = function (...args) {
      if (m === "get" && args.length === 1) return original(args[0]); // app.get("setting") is a settings lookup
      const [first, ...rest] = args;
      return original(first, ...rest.flat(Infinity).map(wrap));
    };
  }
  return app;
}

module.exports = { wrapAsyncRoutes };
