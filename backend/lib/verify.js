// ============================================================
//  Improvement 7: error handling. Checks an AI reply BEFORE the user sees it.
//
//  What is checked
//    - JavaScript / Node code: does it parse?          (vm.Script compile only)
//    - Python code: does it parse?                      (python3 ast.parse, if python3 is installed)
//    - Shell scripts: do they parse?                    (bash -n)
//    - JSON blocks: is it valid JSON?
//    - ```chart blocks: the same rules the page enforces (so the user never sees the "chart error" box)
//    - LaTeX: unbalanced \( \) / $$ / braces
//
//  Code is only ever PARSED, never run. Running model-written code on the server would be unsafe, and a
//  syntax check catches the most common "this doesn't even start" bugs without that risk. It cannot prove the
//  logic is right, and the reply text says so when it matters.
// ============================================================
"use strict";

const vm = require("vm");
const { spawn } = require("child_process");

const MAX_CODE = 30000;
const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

function extractBlocks(text) {
  const blocks = [];
  let m;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(String(text || "")))) {
    const lang = m[1].trim().split(/\s+/)[0].toLowerCase();
    blocks.push({ lang, code: m[2] });
  }
  return blocks;
}

// ---------- JavaScript ----------
const JS_LANGS = new Set(["js", "javascript", "node", "nodejs", "mjs", "cjs"]);
function checkJs(code) {
  if (/<\/?[A-Za-z][\w.]*(\s[^>]*)?\/?>/.test(code) && /return\s*\(?\s*</.test(code)) return null; // JSX: not plain JS
  let src = code.replace(/^#!.*\n/, "")
    .replace(/^\s*import\s+[^;]*?from\s*['"][^'"]+['"];?[ \t]*$/gm, "")
    .replace(/^\s*import\s*['"][^'"]+['"];?[ \t]*$/gm, "")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^\s*export\s+(?=(?:const|let|var|function|class|async)\b)/gm, "")
    .replace(/^\s*export\s*\{[^}]*\};?[ \t]*$/gm, "");
  try {
    new vm.Script(`(async function () {\n${src}\n})`, { filename: "snippet.js" }); // compiles only, never runs
    return null;
  } catch (e) {
    const line = /snippet\.js:(\d+)/.exec(String(e.stack || ""));
    return `${e.message}${line ? ` (around line ${Math.max(1, Number(line[1]) - 1)})` : ""}`;
  }
}

// ---------- helpers that run a parser in a child process ----------
function runParser(cmd, args, input, timeoutMs = 4000) {
  return new Promise(resolve => {
    let out = "", done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    let child;
    try { child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }); } catch (_) { return finish({ missing: true }); }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} finish({ timeout: true }); }, timeoutMs);
    child.on("error", e => { clearTimeout(timer); finish(e.code === "ENOENT" ? { missing: true } : { error: e.message }); });
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { out += d; });
    child.on("close", code => { clearTimeout(timer); finish({ code, out: out.trim() }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// ---------- Python ----------
const PY_LANGS = new Set(["python", "py", "python3", "py3"]);
const PY_SCRIPT = [
  "import ast, sys, textwrap",
  "src = sys.stdin.read()",
  "src = '\\n'.join('pass' if l.lstrip().startswith(('%', '!')) else l for l in src.split('\\n'))",
  "try:",
  "    ast.parse(textwrap.dedent(src))",
  "except SyntaxError as e:",
  "    print('%s (line %s)' % (e.msg, e.lineno)); sys.exit(1)",
].join("\n");
let pythonOk = null;
async function checkPython(code) {
  if (pythonOk === false) return null;
  if (/^\s*>>>/m.test(code) || /^\s*\$ /m.test(code)) return null; // REPL transcript or shell prompt, not a script
  const r = await runParser("python3", ["-c", PY_SCRIPT], code);
  if (r.missing) { pythonOk = false; return null; }
  pythonOk = true;
  if (r.timeout || r.error) return null;
  return r.code === 0 ? null : (r.out || "syntax error").split("\n").pop();
}

// ---------- shell ----------
const SH_LANGS = new Set(["bash", "sh", "shell", "zsh"]);
let bashOk = null;
async function checkShell(code) {
  if (bashOk === false) return null;
  if (/^\s*PS\d?>|^\s*C:\\/m.test(code)) return null;
  const r = await runParser("bash", ["-n"], code); // -n = parse only, runs nothing
  if (r.missing) { bashOk = false; return null; }
  bashOk = true;
  if (r.timeout || r.error) return null;
  return r.code === 0 ? null : (r.out || "syntax error").replace(/^bash: /gm, "").split("\n")[0].replace(/^line \d+: /, "");
}

// ---------- JSON ----------
function checkJson(code) {
  if (/\/\/|\/\*|\.\.\.|<[a-z_ -]+>/i.test(code)) return null; // comments / placeholders: clearly an illustration, not data
  try { JSON.parse(code); return null; } catch (e) { return e.message; }
}

// ---------- charts (same rules as normalizeChartSpec in public/js/render.js) ----------
const CHART_LANGS = new Set(["chart", "chartjs", "chart.js", "chart-json"]);
const CHART_TYPES = { bar: 1, column: 1, line: 1, pie: 1, doughnut: 1, donut: 1, radar: 1, spider: 1, web: 1 };
const toNumber = v => typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[,$%\s]/g, "")) : NaN;
function checkChart(code) {
  let raw;
  try { raw = JSON.parse(code); } catch (_) { return "the chart data isn't valid JSON"; }
  if (!raw || typeof raw !== "object") return "the chart data isn't an object";
  if (raw.data && !Array.isArray(raw.data) && Array.isArray(raw.data.labels)) raw = { ...raw, labels: raw.data.labels, datasets: raw.data.datasets };
  if (!Array.isArray(raw.datasets) && Array.isArray(raw.data)) raw = { ...raw, datasets: [{ data: raw.data }] };
  const typeKey = String(raw.type || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(chart|graph)$/, "");
  if (!CHART_TYPES[typeKey]) return `unsupported chart type "${raw.type}" (use bar, line, pie, doughnut or radar)`;
  if (!Array.isArray(raw.labels) || !raw.labels.length) return "there are no labels";
  if (!Array.isArray(raw.datasets) || !raw.datasets.length) return "there is no data";
  if (raw.labels.length > 60) return "too many labels (max 60)";
  const circular = ["pie", "doughnut", "donut"].includes(typeKey);
  const sets = circular ? raw.datasets.slice(0, 1) : raw.datasets.slice(0, 10);
  for (let i = 0; i < sets.length; i++) {
    const values = Array.isArray(sets[i]) ? sets[i] : sets[i] && sets[i].data;
    if (!Array.isArray(values)) return `dataset ${i + 1} has no data array`;
    if (values.length !== raw.labels.length) return `dataset ${i + 1} has ${values.length} values but there are ${raw.labels.length} labels`;
    const nums = values.map(toNumber);
    const bad = nums.findIndex(n => !Number.isFinite(n));
    if (bad !== -1) return `"${values[bad]}" (${raw.labels[bad]}) is not a number`;
    if (circular && nums.some(n => n < 0)) return "pie and donut charts can't have negative values";
    if (circular && nums.reduce((a, b) => a + b, 0) <= 0) return "all values are zero";
  }
  return null;
}

// ---------- LaTeX ----------
function checkLatex(text) {
  const prose = String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  if (!/\\\(|\\\[|\$\$|\\frac|\\sqrt|\\sum|\\int/.test(prose)) return null;
  const problems = [];
  const open = (prose.match(/\\\(/g) || []).length, close = (prose.match(/\\\)/g) || []).length;
  if (open !== close) problems.push(`${open} \\( openings but ${close} \\) closings`);
  if ((prose.match(/\$\$/g) || []).length % 2) problems.push("an unclosed $$ block");
  const segs = [...prose.matchAll(/\\\(([\s\S]*?)\\\)|\$\$([\s\S]*?)\$\$/g)].map(m => m[1] || m[2] || "");
  for (const s of segs) {
    const clean = s.replace(/\\[{}]/g, "");
    const depth = (clean.match(/\{/g) || []).length - (clean.match(/\}/g) || []).length;
    if (depth !== 0) { problems.push(`unbalanced braces in \`${s.trim().slice(0, 50)}\``); break; }
    if (/\\frac\s*\{[^{}]*\}\s*(?![{\\])\S/.test(s) && !/\\frac\s*\{[^{}]*\}\s*\{/.test(s)) { problems.push(`\\frac missing its second {…} in \`${s.trim().slice(0, 50)}\``); break; }
  }
  return problems.length ? problems.join("; ") : null;
}

// ---------- everything ----------
async function verifyReply(text) {
  const issues = [];
  let checked = 0;
  for (const b of extractBlocks(text)) {
    const code = b.code;
    if (!code.trim() || code.length > MAX_CODE) continue;
    let msg = null, kind = null;
    if (JS_LANGS.has(b.lang)) { checked++; msg = checkJs(code); kind = "JavaScript syntax error"; }
    else if (PY_LANGS.has(b.lang)) { checked++; msg = await checkPython(code); kind = "Python syntax error"; }
    else if (SH_LANGS.has(b.lang)) { checked++; msg = await checkShell(code); kind = "Shell script syntax error"; }
    else if (b.lang === "json") { checked++; msg = checkJson(code); kind = "Invalid JSON"; }
    else if (CHART_LANGS.has(b.lang)) { checked++; msg = checkChart(code); kind = "Chart data problem"; }
    if (msg) issues.push({ kind, lang: b.lang, message: String(msg).replace(/\s+/g, " ").slice(0, 160), isCode: kind !== "Chart data problem" });
  }
  const tex = checkLatex(text);
  if (tex) issues.push({ kind: "LaTeX problem", lang: "", message: tex, isCode: false });
  return { issues, checked };
}

module.exports = { verifyReply, extractBlocks, checkJs, checkPython, checkShell, checkJson, checkChart, checkLatex };
