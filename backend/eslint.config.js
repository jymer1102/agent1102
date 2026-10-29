// Lints the server side (server.js, lib/, routes/, scripts/). It catches typos and variables that don't exist,
// which is exactly the mistake that is easy to make when code is moved between files.   run:  npm run lint
const js = require("@eslint/js");

const nodeGlobals = Object.fromEntries([
  "require", "module", "exports", "process", "console", "__dirname", "__filename", "Buffer", "setTimeout", "clearTimeout",
  "setInterval", "clearInterval", "setImmediate", "URL", "URLSearchParams", "fetch", "AbortController", "AbortSignal",
  "TextDecoder", "TextEncoder", "Blob", "FormData", "Headers", "Request", "Response", "structuredClone", "queueMicrotask",
].map(n => [n, "readonly"]));

module.exports = [
  { ignores: ["node_modules/**", "public/**", "test/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: nodeGlobals },
    rules: {
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
