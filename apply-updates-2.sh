#!/usr/bin/env bash
# Applies BOTH updates to agent1102 (safe to run whatever state the repo is in):
#   update 1 - clean copy of answers/tables, live formatted replies while streaming
#   update 2 - .zip download of all code files in a reply, plain easter-egg toasts, blue text highlight,
#              white reply text over the background picture in light mode, /photos (pictures from the web)
# Update 1 is skipped if you already have it. Anything already applied is skipped. If something doesn't fit
# your files, nothing is changed.
# Usage (from anywhere inside the repo):   bash apply-updates-2.sh
# It does NOT commit anything; review with `git diff`, then commit when you're happy.
set -euo pipefail

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ] || [ ! -d "$ROOT/backend/public/js" ]; then
  echo "Run this inside the agent1102 repo (couldn't find backend/public/js)." >&2
  exit 1
fi
cd "$ROOT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
extract() { awk -v m="$1" '$0 == m { f = 1; next } /^__PATCH_[0-9]+__$/ { f = 0 } f' "$0" > "$2"; }
extract __PATCH_1__ "$TMP/1.patch"
extract __PATCH_2__ "$TMP/2.patch"

applied_now_1=0
apply_one() { # number, label
  local p="$TMP/$1.patch"
  if git apply -R --check "$p" >/dev/null 2>&1; then say "$2: already applied, skipping"; return 0; fi
  if git apply --check "$p" 2>"$TMP/err"; then
    say "Applying $2"
    git apply --whitespace=nowarn "$p"
    [ "$1" = 1 ] && applied_now_1=1
    return 0
  fi
  echo "$2 doesn't apply cleanly (these files differ from the version it was made for):" >&2
  cat "$TMP/err" >&2
  if [ "$applied_now_1" = 1 ]; then git apply -R "$TMP/1.patch"; echo "Rolled back update 1 as well." >&2; fi
  echo "Nothing was changed." >&2
  exit 1
}

# Update 2 can only be there if update 1 is, so check it first: if it is, there's nothing to do.
if git apply -R --check "$TMP/2.patch" >/dev/null 2>&1; then
  say "Both updates are already applied. Nothing to change."
else
  apply_one 1 "update 1 (copying + live reply formatting)"
  apply_one 2 "update 2 (zip download, toasts, colours, /photos)"
fi
git status --short

say "Installing dependencies (marked + dompurify are used by the tests)"
(cd backend && npm install --no-audit --no-fund --no-package-lock)

say "Lint"
(cd backend && npm run lint)

say "Tests"
(cd backend && npm test)

say "Done. Review with 'git diff', then commit. Hard-refresh the browser (Ctrl+Shift+R) to load the new scripts."
exit 0
__PATCH_1__
diff --git a/backend/package.json b/backend/package.json
index d4e8045..d5f320e 100644
--- a/backend/package.json
+++ b/backend/package.json
@@ -17,7 +17,9 @@
   },
   "devDependencies": {
     "@eslint/js": "^10.0.1",
+    "dompurify": "3.2.4",
     "eslint": "^10.13.0",
-    "jsdom": "^30.1.3"
+    "jsdom": "^30.1.3",
+    "marked": "12.0.2"
   }
 }
diff --git a/backend/public/index.html b/backend/public/index.html
index ed0214f..6327ac1 100644
--- a/backend/public/index.html
+++ b/backend/public/index.html
@@ -158,10 +158,11 @@
 <script src="js/session.js?v=20261021a"></script>
 <script src="js/config.js?v=20261021a"></script>
 <script src="js/utils.js?v=20261017a"></script>
-<script src="js/render.js?v=20261021b"></script>
+<script src="js/render.js?v=20261029a"></script>
+<script src="js/copy.js?v=20261029a"></script>
 <script src="js/mathviz.js?v=20261020a"></script>
 <script src="js/study.js?v=20261020a"></script>
-<script src="js/stream.js?v=20261020a"></script>
+<script src="js/stream.js?v=20261029a"></script>
 <script src="js/commands.js?v=20261018c"></script>
 <script src="js/personal.js?v=20261020a"></script>
 <script src="js/auth.js?v=20261021a"></script>
@@ -169,7 +170,7 @@
 <script src="js/ui.js?v=20261021b"></script>
 <script src="js/sendstate.js?v=20261020a"></script>
 <script src="js/chat.js?v=20261021b"></script>
-<script src="js/tables.js?v=20261020a"></script>
+<script src="js/tables.js?v=20261029a"></script>
 <script src="js/easter-eggs.js?v=20261017a"></script>
 <script src="js/glow.js?v=20261018d"></script>
 </body>
diff --git a/backend/public/js/copy.js b/backend/public/js/copy.js
new file mode 100644
index 0000000..eda531c
--- /dev/null
+++ b/backend/public/js/copy.js
@@ -0,0 +1,365 @@
+// ============================================================
+//  Copying answers and tables the way people expect.
+//  The reply is markdown underneath (**bold**, | tables |, `code`, \(math\)), but nobody wants those symbols
+//  on their clipboard. Copying now puts TWO versions there and the place you paste picks the best one:
+//    - rich text (real bold, headings, lists, links and real tables)  -> Word, Google Docs, Gmail, Notion, Excel
+//    - clean plain text (no ** | # ` marks, tables as tab-separated columns, math as readable symbols) -> everything else
+// ============================================================
+(function () {
+  "use strict";
+
+  /* ---------------------------------------------------------- */
+  /*  Math -> readable text (x^2 -> x², \frac{a}{b} -> a/b)      */
+  /* ---------------------------------------------------------- */
+  const zip = (from, to) => Object.fromEntries([...from].map((c, i) => [c, [...to][i]]));
+  const SUP = { ...zip("0123456789+-=()abcdefghijklmnoprstuvwxyz", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ"), "−": "⁻" };
+  const SUB = { ...zip("0123456789+-=()aehijklmnoprstuvx", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"), "−": "₋" };
+
+  const SYMBOLS = {
+    // Greek
+    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
+    iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
+    phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
+    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
+    // operators and relations (padded so "a \times b" stays "a × b")
+    times: " × ", cdot: " · ", div: " ÷ ", pm: " ± ", mp: " ∓ ", ast: " ∗ ",
+    leq: " ≤ ", le: " ≤ ", geq: " ≥ ", ge: " ≥ ", neq: " ≠ ", ne: " ≠ ", approx: " ≈ ", equiv: " ≡ ", sim: " ∼ ", propto: " ∝ ",
+    ll: " ≪ ", gg: " ≫ ", cong: " ≅ ",
+    rightarrow: " → ", to: " → ", leftarrow: " ← ", leftrightarrow: " ↔ ", Rightarrow: " ⇒ ", Leftarrow: " ⇐ ",
+    Leftrightarrow: " ⇔ ", implies: " ⇒ ", iff: " ⇔ ", mapsto: " ↦ ", uparrow: "↑", downarrow: "↓",
+    in: " ∈ ", notin: " ∉ ", subset: " ⊂ ", subseteq: " ⊆ ", supset: " ⊃ ", supseteq: " ⊇ ", cup: " ∪ ", cap: " ∩ ",
+    forall: "∀", exists: "∃", neg: "¬", land: " ∧ ", lor: " ∨ ", wedge: " ∧ ", vee: " ∨ ",
+    // big symbols and misc
+    infty: "∞", partial: "∂", nabla: "∇", emptyset: "∅", varnothing: "∅", sum: "∑", prod: "∏", int: "∫", iint: "∬", oint: "∮",
+    sqrt: "√", degree: "°", circ: "∘", angle: "∠", perp: " ⊥ ", parallel: " ∥ ", therefore: "∴", because: "∵", hbar: "ħ", ell: "ℓ",
+    cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱", prime: "′", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
+    // spacing commands
+    quad: " ", qquad: " ", displaystyle: "", textstyle: "", left: "", right: "", big: "", Big: "", bigg: "", Bigg: "",
+    langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lbrace: "{", rbrace: "}",
+  };
+  const FUNCS = "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln lg exp lim limsup liminf max min sup inf det dim gcd lcm mod deg arg ker Pr".split(" ");
+  const BLACKBOARD = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", H: "ℍ" };
+  const TEXT_WRAPPERS = ["text", "textbf", "textit", "textrm", "mbox"]; // words: kept exactly as written, spaces included
+  const WRAPPERS = ["mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "boldsymbol", "operatorname", "vec", "hat", "bar", "tilde",
+    "overline", "underline", "overrightarrow", "boxed", "cancel", "dot", "ddot"];
+  const ESCAPES = { "\\{": "\uE000", "\\}": "\uE001", "\\&": "\uE002", "\\%": "\uE003", "\\$": "\uE004", "\\#": "\uE005", "\\_": "\uE006" };
+  const ESCAPED_BACK = { "\uE000": "{", "\uE001": "}", "\uE002": "&", "\uE003": "%", "\uE004": "$", "\uE005": "#", "\uE006": "_" };
+
+  function matchBrace(s, open) {
+    let depth = 0;
+    for (let k = open; k < s.length; k++) {
+      if (s[k] === "\\") { k++; continue; }
+      if (s[k] === "{") depth++;
+      else if (s[k] === "}" && --depth === 0) return k;
+    }
+    return -1;
+  }
+
+  // One LaTeX argument starting at s[i]: {group}, \command or a single character -> [text, indexAfter]
+  function readArg(s, i) {
+    while (s[i] === " ") i++;
+    if (s[i] === "{") {
+      const end = matchBrace(s, i);
+      return end < 0 ? [s.slice(i + 1), s.length] : [s.slice(i + 1, end), end + 1];
+    }
+    if (s[i] === "\\") { const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i)); return m ? [m[0], i + m[0].length] : ["", i + 1]; }
+    return [s[i] || "", i + 1];
+  }
+
+  function replaceCmd(s, name, argc, build) {
+    const re = new RegExp("\\\\" + name + "(?![A-Za-z])", "g");
+    let out = "", last = 0, m;
+    while ((m = re.exec(s))) {
+      let i = m.index + m[0].length;
+      const args = [];
+      for (let k = 0; k < argc; k++) { const [a, next] = readArg(s, i); args.push(a); i = next; }
+      out += s.slice(last, m.index) + build(...args);
+      last = i;
+      re.lastIndex = i;
+    }
+    return out + s.slice(last);
+  }
+
+  const word = x => /^[\p{L}\p{N}.]+$/u.test(x);
+  const wrap = x => word(x) ? x : "(" + x + ")";
+
+  function scripts(s) {
+    let out = "";
+    for (let i = 0; i < s.length;) {
+      const ch = s[i];
+      if (ch !== "^" && ch !== "_") { out += ch; i++; continue; }
+      const [raw, next] = readArg(s, i + 1);
+      const arg = scripts(raw).trim();
+      const map = ch === "^" ? SUP : SUB;
+      const mapped = [...arg].map(c => map[c]);
+      out += arg && mapped.every(Boolean) ? mapped.join("") : ch + (arg.length > 1 ? "(" + arg + ")" : arg);
+      i = next;
+    }
+    return out;
+  }
+
+  function chemistry(s) {
+    return s.replace(/([A-Za-z)\]])(\d+)/g, (_, a, d) => a + [...d].map(c => SUB[c]).join(""))
+      .replace(/<=>|<->/g, " ⇌ ").replace(/->/g, " → ");
+  }
+
+  function mathToText(tex) {
+    let s = String(tex == null ? "" : tex);
+    // escaped characters survive the cleanup below
+    s = s.replace(/\\[{}&%$#_]/g, m => ESCAPES[m]);
+    // matrices and aligned lines
+    s = s.replace(/\\begin\{[pbvBV]?matrix\}([\s\S]*?)\\end\{[pbvBV]?matrix\}/g, (_, body) => "[" + body.replace(/\\\\/g, "; ").replace(/&/g, ", ").trim() + "]");
+    s = s.replace(/\\begin\{[a-z*]+\}/g, "").replace(/\\end\{[a-z*]+\}/g, "").replace(/\\\\/g, "\n").replace(/&/g, " ");
+    // commands that take arguments
+    ["frac", "dfrac", "tfrac"].forEach(name => {
+      s = replaceCmd(s, name, 2, (a, b) => wrap(mathToText(a)) + "/" + wrap(mathToText(b)));
+    });
+    s = s.replace(/\\sqrt\[([^\]]+)\]/g, (_, n) => "\\root{" + n + "}");
+    s = replaceCmd(s, "root", 2, (n, x) => { const N = mathToText(n), X = mathToText(x); const sup = [...N].map(c => SUP[c]); return (sup.every(Boolean) ? sup.join("") : "^(" + N + ")") + "√" + wrap(X); });
+    s = replaceCmd(s, "sqrt", 1, x => { const X = mathToText(x); return "√" + (word(X) ? X : "(" + X + ")"); });
+    s = replaceCmd(s, "ce", 1, x => chemistry(mathToText(x)));
+    s = replaceCmd(s, "mathbb", 1, x => [...x].map(c => BLACKBOARD[c] || c).join(""));
+    TEXT_WRAPPERS.forEach(w => { s = replaceCmd(s, w, 1, x => x); });
+    WRAPPERS.forEach(w => { s = replaceCmd(s, w, 1, x => mathToText(x)); });
+    // symbols, then function names, then whatever commands are left
+    s = s.replace(/\\([A-Za-z]+) ?/g, (whole, name) => Object.prototype.hasOwnProperty.call(SYMBOLS, name) ? SYMBOLS[name] : whole);
+    s = s.replace(new RegExp("\\\\(" + FUNCS.join("|") + ")(?![A-Za-z])", "g"), "$1");
+    s = s.replace(/\\[,;:!> ]/g, " ").replace(/\\([A-Za-z]+)/g, "$1");
+    s = scripts(s);
+    s = s.replace(/[{}]/g, "").replace(/[\uE000-\uE006]/g, c => ESCAPED_BACK[c]);
+    return s.replace(/[ \t]+/g, " ").replace(/ ([,;])/g, "$1").replace(/ ?\n ?/g, "\n").trim();
+  }
+
+  /* ---------------------------------------------------------- */
+  /*  Rendered DOM -> plain text                                 */
+  /* ---------------------------------------------------------- */
+  const BLOCK = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TABLE", "HR", "SECTION",
+    "ARTICLE", "FIGURE", "DL", "DT", "DD", "THEAD", "TBODY", "TFOOT", "TR"]);
+  const supText = s => { const m = [...s].map(c => SUP[c]); return s && m.every(Boolean) ? m.join("") : "^(" + s + ")"; };
+  const subText = s => { const m = [...s].map(c => SUB[c]); return s && m.every(Boolean) ? m.join("") : "_(" + s + ")"; };
+
+  function inlineOf(nodes) {
+    let out = "";
+    for (const c of nodes) {
+      if (c.nodeType === 3) { out += c.nodeValue.replace(/\s+/g, " "); continue; }
+      if (c.nodeType !== 1) continue;
+      const t = c.tagName;
+      if (c.hasAttribute("data-tex")) out += mathToText(c.getAttribute("data-tex"));
+      else if (t === "BR") out += "\n";
+      else if (t === "A") {
+        const label = inlineOf(c.childNodes), href = c.getAttribute("href") || "";
+        const bare = href.replace(/^mailto:/i, "");
+        out += !href || label.trim() === href || label.trim() === bare ? label : `${label} (${href})`;
+      } else if (t === "IMG") {
+        const alt = c.getAttribute("alt") || "", src = c.getAttribute("src") || "";
+        out += alt && src ? `${alt} (${src})` : alt || src;
+      } else if (t === "INPUT") out += c.hasAttribute("checked") || c.checked ? "[x] " : "[ ] ";
+      else if (t === "SUP") out += supText(inlineOf(c.childNodes).trim());
+      else if (t === "SUB") out += subText(inlineOf(c.childNodes).trim());
+      else if (t === "TD" || t === "TH") out += inlineOf(c.childNodes).trim() + "\t"; // stray cells from a partial selection
+      else out += inlineOf(c.childNodes);
+    }
+    return out;
+  }
+
+  // The text of one table cell on one line (line breaks and tabs inside a cell become spaces)
+  function cellText(node) {
+    return inlineOf(node.childNodes).replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
+  }
+
+  function tableRows(table) {
+    return [...table.querySelectorAll("tr")].map(tr => [...tr.children].filter(c => c.tagName === "TD" || c.tagName === "TH").map(cellText));
+  }
+
+  // Tab-separated columns: pastes into a spreadsheet as real cells and still reads fine as plain text
+  function tableTsv(table) {
+    return tableRows(table).map(row => row.map(v => /^"/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join("\t")).join("\n");
+  }
+
+  function listText(list, depth) {
+    const ordered = list.tagName === "OL";
+    let n = parseInt(list.getAttribute("start"), 10);
+    if (!Number.isFinite(n)) n = 1;
+    return [...list.children].filter(li => li.tagName === "LI").map(li => {
+      const marker = ordered ? (n++) + ". " : depth % 2 ? "◦ " : "• ";
+      const pad = " ".repeat(marker.length);
+      const body = blocks(li, depth + 1).join("\n");
+      return marker + body.split("\n").map((line, i) => i && line ? pad + line : line).join("\n");
+    }).join("\n");
+  }
+
+  function blocks(parent, depth) {
+    const out = [];
+    let run = [];
+    const flush = () => {
+      if (!run.length) return;
+      const s = inlineOf(run).replace(/[ \t]*\n[ \t]*/g, "\n").trim();
+      if (s) out.push(s);
+      run = [];
+    };
+    for (const c of parent.childNodes) {
+      if (c.nodeType !== 1 || !BLOCK.has(c.tagName)) { run.push(c); continue; }
+      flush();
+      const t = c.tagName;
+      if (t === "UL" || t === "OL") out.push(listText(c, depth));
+      else if (t === "PRE") out.push(c.textContent.replace(/\n+$/, ""));
+      else if (t === "TABLE") out.push(tableTsv(c));
+      else if (t === "HR") out.push("────────");
+      else if (t === "BLOCKQUOTE") out.push(blocks(c, depth).join("\n\n").split("\n").map(l => l ? "> " + l : ">").join("\n"));
+      else out.push(...blocks(c, depth));
+    }
+    flush();
+    return out;
+  }
+
+  function domToText(root) {
+    return blocks(root, 0).join("\n\n").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
+  }
+
+  /* ---------------------------------------------------------- */
+  /*  Markdown -> clean DOM (the same markdown library the chat  */
+  /*  uses, but with no buttons, charts or preview cards)        */
+  /* ---------------------------------------------------------- */
+  function replaceMath(root) {
+    root.querySelectorAll("[data-tex]").forEach(n => n.replaceWith(document.createTextNode(mathToText(n.getAttribute("data-tex")))));
+  }
+
+  function restoreMath(root, mathList) {
+    if (!mathList.length) return;
+    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
+    const hits = [];
+    let node;
+    while ((node = walker.nextNode())) if (/\uE010MATH\d+\uE011/.test(node.nodeValue)) hits.push(node);
+    hits.forEach(n => {
+      n.nodeValue = n.nodeValue.replace(/\uE010MATH(\d+)\uE011/g, (whole, i) => mathList[+i] ? mathToText(mathList[+i].tex) : "");
+    });
+  }
+
+  function renderClean(md) {
+    const R = window.agent1102Render;
+    if (!R || typeof marked === "undefined" || typeof DOMPurify === "undefined") return null;
+    const { text, math } = R.extractMath(R.responseToText(md));
+    let html;
+    try { html = marked.parse(text, { gfm: true, breaks: true }); } catch (_) { return null; }
+    const box = document.createElement("div");
+    box.innerHTML = DOMPurify.sanitize(html);
+    restoreMath(box, math);
+    // pictures are never pulled into a paste; keep what they say and where they are
+    box.querySelectorAll("img").forEach(img => {
+      const alt = img.getAttribute("alt") || "", src = img.getAttribute("src") || "";
+      img.replaceWith(document.createTextNode(alt && /^https?:/i.test(src) ? `${alt} (${src})` : alt || (/^https?:/i.test(src) ? src : "")));
+    });
+    return box;
+  }
+
+  /* ---------------------------------------------------------- */
+  /*  Rich-text version: add the borders/fonts Word, Docs and    */
+  /*  Outlook need, because they ignore the page's stylesheet    */
+  /* ---------------------------------------------------------- */
+  function styleForPaste(root) {
+    const tables = root.tagName === "TABLE" ? [root] : [...root.querySelectorAll("table")];
+    tables.forEach(table => {
+      table.setAttribute("border", "1");
+      table.setAttribute("cellspacing", "0");
+      table.setAttribute("cellpadding", "6");
+      table.style.cssText = "border-collapse:collapse;";
+      table.querySelectorAll("th, td").forEach(c => {
+        c.style.cssText = "border:1px solid #bfbfbf;padding:4px 8px;text-align:left;vertical-align:top;" + (c.tagName === "TH" ? "background:#f2f2f2;font-weight:bold;" : "");
+      });
+    });
+    root.querySelectorAll("pre").forEach(p => { p.style.cssText = "font-family:Consolas,'Courier New',monospace;white-space:pre-wrap;background:#f6f6f6;padding:8px;"; });
+    root.querySelectorAll("code").forEach(c => { if (!c.closest("pre")) c.style.cssText = "font-family:Consolas,'Courier New',monospace;"; });
+  }
+
+  const page = inner => '<meta charset="utf-8">' + inner;
+
+  function responseClipboard(md) {
+    const box = renderClean(md);
+    if (!box) { const R = window.agent1102Render; return { html: null, text: R ? R.responseToText(md) : String(md) }; }
+    const text = domToText(box);
+    styleForPaste(box);
+    return { html: page(box.innerHTML), text };
+  }
+
+  // A table that is already on the page (its math is KaTeX markup, which would paste as garbage, so it becomes text)
+  function tableClipboard(table) {
+    const clone = table.cloneNode(true);
+    replaceMath(clone);
+    clone.querySelectorAll("*").forEach(n => { n.removeAttribute("class"); n.removeAttribute("style"); });
+    const text = tableTsv(clone);
+    styleForPaste(clone);
+    return { html: page(clone.outerHTML), text };
+  }
+
+  /* ---------------------------------------------------------- */
+  /*  Writing to the clipboard                                   */
+  /* ---------------------------------------------------------- */
+  async function write(html, text) {
+    // Everything above is synchronous, so Safari still counts this as part of the click
+    if (html && navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
+      try {
+        await navigator.clipboard.write([new ClipboardItem({
+          "text/html": new Blob([html], { type: "text/html" }),
+          "text/plain": new Blob([text], { type: "text/plain" }),
+        })]);
+        return true;
+      } catch (_) { /* fall through */ }
+    }
+    if (html) {
+      let ta;
+      const onCopy = e => { e.clipboardData.setData("text/html", html); e.clipboardData.setData("text/plain", text); e.preventDefault(); };
+      try {
+        ta = document.createElement("textarea");
+        ta.value = text;
+        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
+        document.body.appendChild(ta);
+        ta.select();
+        document.addEventListener("copy", onCopy, true);
+        if (document.execCommand("copy")) return true;
+      } catch (_) { /* fall through */ }
+      finally { document.removeEventListener("copy", onCopy, true); if (ta) ta.remove(); }
+    }
+    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
+    try {
+      const ta = document.createElement("textarea");
+      ta.value = text;
+      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
+      document.body.appendChild(ta);
+      ta.select();
+      const ok = document.execCommand("copy");
+      ta.remove();
+      return ok;
+    } catch (_) { return false; }
+  }
+
+  const copyResponse = md => { const r = responseClipboard(md); return write(r.html, r.text); };
+  const copyTable = table => { const r = tableClipboard(table); return write(r.html, r.text); };
+
+  /* ---------------------------------------------------------- */
+  /*  Ctrl+C / Cmd+C on selected text in an answer: formulas are */
+  /*  drawn as styled glyphs, which copy as "x2+1". Hand over    */
+  /*  the readable version instead. Everything else is left to   */
+  /*  the browser.                                               */
+  /* ---------------------------------------------------------- */
+  document.addEventListener("copy", e => {
+    try {
+      const sel = window.getSelection();
+      if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
+      const range = sel.getRangeAt(0);
+      const anc = range.commonAncestorContainer;
+      const host = anc.nodeType === 1 ? anc : anc.parentElement;
+      if (!host || !host.closest(".msg-content-body")) return;
+      const box = document.createElement("div");
+      box.appendChild(range.cloneContents());
+      if (!box.querySelector("[data-tex]")) return;
+      const text = domToText(box);
+      replaceMath(box);
+      styleForPaste(box);
+      e.clipboardData.setData("text/html", page(box.innerHTML));
+      e.clipboardData.setData("text/plain", text);
+      e.preventDefault();
+    } catch (_) { /* never block a normal copy */ }
+  });
+
+  window.agent1102Copy = { mathToText, domToText, cellText, tableTsv, responseClipboard, tableClipboard, write, copyResponse, copyTable };
+})();
diff --git a/backend/public/js/render.js b/backend/public/js/render.js
index 09c4728..f22972e 100644
--- a/backend/public/js/render.js
+++ b/backend/public/js/render.js
@@ -791,6 +791,7 @@
   // a small inline error rather than breaking the whole message.
   function renderMathSpan(tex, display) {
     const span = el("span", display ? "math-display" : "math-inline");
+    span.setAttribute("data-tex", tex); // copy.js reads this to copy "x²" instead of the drawn glyphs
     if (typeof katex === "undefined") { span.textContent = display ? `$$${tex}$$` : `\\(${tex}\\)`; return span; }
     try {
       const html = katex.renderToString(tex, { throwOnError: true, displayMode: display, output: "html", strict: "ignore", maxSize: 500, maxExpand: 1000 });
@@ -947,6 +948,58 @@
     charts.forEach(entry => drawChart(entry, true));
   }
 
+  /* ---------------------------------------------------------- */
+  /*  Live preview while an answer is still being written        */
+  /*  Same markdown, math and tables as the finished message, but */
+  /*  none of the heavy parts (charts, code boxes, link cards),   */
+  /*  which are built once when the answer is complete.           */
+  /* ---------------------------------------------------------- */
+  // The unfinished end of a half-written answer, tidied so the preview doesn't flash raw symbols:
+  // an open code fence is closed, a dangling ** or ` is closed, and a table whose header has
+  // arrived but whose "|---|---|" line hasn't is held back for a moment instead of shown as pipes.
+  function tidyDraft(md) {
+    const s = String(md);
+    const fences = s.match(/^ {0,3}(?:`{3,}|~{3,})/gm) || [];
+    if (fences.length % 2) return s + "\n```"; // inside a code block everything is literal
+
+    // a table that is still arriving: its header line is there but the |---|---| line is missing or cut short
+    const lines = s.split("\n");
+    let end = lines.length;
+    while (end > 0 && !lines[end - 1].trim()) end--;
+    let start = end;
+    while (start > 0 && /^\s*\|/.test(lines[start - 1])) start--;
+    const columns = line => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;
+    const rows = end - start;
+    if (rows === 1) return lines.slice(0, start).join("\n");
+    if (rows === 2 && /^[\s|:-]+$/.test(lines[end - 1]) && columns(lines[end - 1]) < columns(lines[start])) return lines.slice(0, start).join("\n");
+
+    // an unfinished **bold** or `code` at the very end
+    const cut = s.lastIndexOf("\n") + 1;
+    let tail = s.slice(cut);
+    if ((tail.match(/\*\*/g) || []).length % 2) tail = /\*\*\s*$/.test(tail) ? tail.replace(/\*\*\s*$/, "") : tail + "**";
+    if ((tail.match(/`/g) || []).length % 2) tail = /`$/.test(tail) ? tail.slice(0, -1) : tail + "`";
+    return s.slice(0, cut) + tail;
+  }
+
+  // Fills `target` with the formatted draft. Returns false when the libraries aren't there (caller shows plain text).
+  function renderDraft(target, markdown) {
+    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") return false;
+    const { text, math } = extractMath(tidyDraft(markdown == null ? "" : markdown));
+    let html;
+    try { html = marked.parse(text, { gfm: true, breaks: true }); } catch (_) { return false; }
+    target.innerHTML = DOMPurify.sanitize(html);
+    renderMathIn(target, math);
+    // nothing is fetched while writing (privacy): a picture is shown as its description until the answer is finished
+    target.querySelectorAll("img").forEach(img => img.replaceWith(document.createTextNode(img.getAttribute("alt") || "")));
+    target.querySelectorAll("table").forEach(table => {
+      const wrap = el("div", "table-wrap");
+      table.replaceWith(wrap);
+      wrap.appendChild(table);
+    });
+    target.querySelectorAll("a[href]").forEach(a => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
+    return true;
+  }
+
   /* ---------------------------------------------------------- */
   /*  Plain-text version of a response (for copy / download)     */
   /* ---------------------------------------------------------- */
@@ -1535,7 +1588,9 @@
 
       ttsButton.addEventListener("click", () => toggleTTS(ttsButton, speakableText(content)));
       copyBtn.addEventListener("click", async () => {
-        if (await copyText(responseToText(content))) flash(copyBtn, "fa-copy", "", "");
+        // Rich text + clean plain text (no ** | # marks). Falls back to the markdown text if copy.js isn't there.
+        const ok = window.agent1102Copy ? await window.agent1102Copy.copyResponse(content) : await copyText(responseToText(content));
+        if (ok) flash(copyBtn, "fa-copy", "", "");
         else toast("I couldn't copy that. Your browser blocked it.");
       });
       dlBtn.addEventListener("click", () => {
@@ -1593,6 +1648,6 @@
   window.agent1102Render = {
     normalizeChartSpec, responseToText, chunkText, parseImageRequest, parseImageEditRequest,
     parseAttachedFiles, historyTitle, escapeHtml, mathToSpeech, speakableText, extractMath, fileChipIcon,
-    buildLinkCard,
+    buildLinkCard, renderDraft, tidyDraft,
   };
 })();
diff --git a/backend/public/js/stream.js b/backend/public/js/stream.js
index c33015c..912d3ac 100644
--- a/backend/public/js/stream.js
+++ b/backend/public/js/stream.js
@@ -18,27 +18,42 @@
       (_, lang) => /^chart/i.test(lang) ? "[drawing the chart...]" : /^(quiz|flashcards)$/i.test(lang) ? "[building it...]" : "[drawing...]");
   }
 
-  // A live-text area under the spinner of a "Thinking..." placeholder (the object addThinking() returns)
+  // A live-text area under the spinner of a "Thinking..." placeholder (the object addThinking() returns).
+  // The text is shown formatted as it arrives (bold, lists, tables, math). If the formatting code isn't loaded it
+  // falls back to plain text. Repainting is limited to about 10 times a second so long answers stay smooth.
+  const PAINT_EVERY_MS = 100;
   function createDraft(thinking) {
     const box = document.createElement("div");
-    box.className = "ai-text stream-draft";
-    box.style.cssText = "white-space:pre-wrap;word-break:break-word;margin-top:0.35rem;display:none;";
+    box.className = "ai-text msg-content-body stream-draft";
+    box.style.cssText = "word-break:break-word;margin-top:0.35rem;display:none;";
     thinking.wrap.appendChild(box);
     const chat = document.getElementById("chat");
-    let text = "", queued = false, started = false;
+    let text = "", queued = false, started = false, lastPaint = 0;
     function paint() {
       queued = false;
       if (!box.isConnected) return;
+      lastPaint = Date.now();
       const nearBottom = chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight < 140 : false;
-      box.textContent = previewText(text);
+      const shown = previewText(text);
+      const R = window.agent1102Render;
+      let formatted = false;
+      if (R && R.renderDraft) { try { formatted = R.renderDraft(box, shown); } catch (_) { formatted = false; } }
+      if (!formatted) { box.style.whiteSpace = "pre-wrap"; box.textContent = shown; }
+      else box.style.whiteSpace = "";
       box.style.display = "block";
       if (nearBottom && chat) chat.scrollTop = chat.scrollHeight;
     }
+    function schedule() {
+      if (queued) return;
+      queued = true;
+      const wait = Math.max(0, PAINT_EVERY_MS - (Date.now() - lastPaint));
+      if (wait) setTimeout(() => requestAnimationFrame(paint), wait); else requestAnimationFrame(paint);
+    }
     return {
       add(piece) {
         if (!started) { started = true; thinking.setLabel("Writing..."); }
         text += piece;
-        if (!queued) { queued = true; requestAnimationFrame(paint); }
+        schedule();
       },
       status(label) { if (label) thinking.setLabel(label); },
     };
diff --git a/backend/public/js/tables.js b/backend/public/js/tables.js
index 9a9a08f..5d436c9 100644
--- a/backend/public/js/tables.js
+++ b/backend/public/js/tables.js
@@ -1,5 +1,6 @@
 // ============================================================
-//  Tables in answers (including tables read out of photos and scans) get "Copy CSV" and "Download CSV".
+//  Tables in answers (including tables read out of photos and scans) get "Copy table", "Copy CSV" and "Download CSV".
+//  "Copy table" pastes as a real table into Word / Docs / Excel / Sheets; the CSV buttons are for data files.
 // ============================================================
 (function () {
   "use strict";
@@ -8,8 +9,11 @@
   const safe = v => (/^[=@]/.test(v) || /^[+\-][^\d.\s]/.test(v)) ? "'" + v : v;
   const cell = v => { v = safe(String(v).replace(/\s+/g, " ").trim()); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
 
+  // What a cell reads as: formulas become text like x² (not the drawn glyphs) and line breaks become spaces
+  const textOf = td => window.agent1102Copy ? window.agent1102Copy.cellText(td) : td.textContent;
+
   function tableToCsv(table) {
-    return [...table.querySelectorAll("tr")].map(tr => [...tr.children].map(td => cell(td.textContent)).join(",")).join("\r\n");
+    return [...table.querySelectorAll("tr")].map(tr => [...tr.children].map(td => cell(textOf(td))).join(",")).join("\r\n");
   }
 
   function button(icon, label, onClick) {
@@ -24,12 +28,16 @@
   }
 
   function enhance(root) {
-    root.querySelectorAll(".msg-content-body .table-wrap:not([data-csv])").forEach(wrap => {
+    root.querySelectorAll(".msg-content-body:not(.stream-draft) .table-wrap:not([data-csv])").forEach(wrap => {
       wrap.setAttribute("data-csv", "1");
       const table = wrap.querySelector("table");
       if (!table || table.rows.length < 2) return;
       const bar = document.createElement("div");
       bar.style.cssText = "display:flex;gap:0.25rem;margin:-0.4rem 0 0.6rem;";
+      if (window.agent1102Copy) bar.appendChild(button("fa-table", "Copy table", async b => {
+        if (await window.agent1102Copy.copyTable(table)) { b.classList.add("copied"); setTimeout(() => b.classList.remove("copied"), 1200); }
+        else if (typeof showToast === "function") showToast("I couldn't copy that. Your browser blocked it.");
+      }));
       bar.appendChild(button("fa-copy", "Copy CSV", async b => {
         try { await navigator.clipboard.writeText(tableToCsv(table)); b.classList.add("copied"); setTimeout(() => b.classList.remove("copied"), 1200); }
         catch (_) { if (typeof showToast === "function") showToast("I couldn't copy that. Your browser blocked it."); }
diff --git a/backend/test/client.test.js b/backend/test/client.test.js
index 8571fc3..03e26d7 100644
--- a/backend/test/client.test.js
+++ b/backend/test/client.test.js
@@ -1,4 +1,4 @@
-// Loads the real browser scripts (stream.js, personal.js, tables.js) into jsdom, sharing one global scope like
+// Loads the real browser scripts (stream.js, personal.js, tables.js, copy.js, render.js) into jsdom, sharing one global scope like
 // the page does, and checks them.   needs:  npm i -D jsdom     run:  node test/client.test.js
 "use strict";
 const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
@@ -18,6 +18,36 @@ run(`let history = []; let userToken = "tok"; const BACKEND_URL = "http://x"; le
 load("stream.js"); load("personal.js"); load("tables.js"); load("sendstate.js");
 
 let passed = 0;
+
+// A fresh page with the real markdown libraries (the same pinned versions index.html loads from the CDN) and the real
+// render.js / copy.js / stream.js / tables.js, for the copy and live-preview tests. `clipboard` records what was copied.
+function makePage() {
+  const d = new JSDOM('<!doctype html><body><div id="chat"></div><textarea id="input"></textarea></body>', { pretendToBeVisual: true, runScripts: "outside-only" });
+  const w = d.window, c = d.getInternalVMContext(), go = code => new vm.Script(code).runInContext(c);
+  const nm = (...p) => fs.readFileSync(path.join(__dirname, "..", "node_modules", ...p), "utf8");
+  const pub = f => fs.readFileSync(path.join(__dirname, "..", "public", "js", f), "utf8");
+  go(nm("marked", "marked.min.js")); go(nm("dompurify", "dist", "purify.min.js"));
+  go("let __toasts = []; function showToast(m){ __toasts.push(m); }");
+  ["render.js", "copy.js", "stream.js", "tables.js"].forEach(f => go(pub(f)));
+  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
+  const clipboard = { writes: [], texts: [], fail: false };
+  w.ClipboardItem = class { constructor(items) { this.items = items; } };
+  Object.defineProperty(w.navigator, "clipboard", { configurable: true, value: {
+    write: async items => { if (clipboard.fail) throw new Error("blocked"); clipboard.writes.push(items[0].items); },
+    writeText: async t => { clipboard.texts.push(t); },
+  } });
+  const html = async i => clipboard.writes[i]["text/html"].text(), text = async i => clipboard.writes[i]["text/plain"].text();
+  return { w, go, clipboard, html, text };
+}
+const SAMPLE = [
+  "## Results", "",
+  "A **quick comparison** of *three* options with `inline code` and a [link](https://example.com/a):", "",
+  "| Name | Price | Note |", "|---|---|---|", "| **Alpha** | $5 | Uses \\(x^2 + y^2 = z^2\\) |", "| Beta | $7 | café & crème — 100% |", "",
+  "1. First step", "2. Second step", "   - nested **bold**", "   - nested two", "",
+  "> A quote", "", "```js", "const a = 1 * 2;", "```", "",
+  "The formula is $$\\frac{a+b}{2} \\leq \\sqrt{x}$$ and that is it. Escaped \\*stars\\* and snake\\_case.",
+].join("\n");
+
 async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; } }
 
 // a fake fetch Response that delivers SSE text in awkward chunks (splitting events mid-line)
@@ -256,5 +286,152 @@ const ev = o => `data: ${JSON.stringify(o)}\n\n`;
     assert.strictEqual(r.went, '["/?error=oauth_failed"]');
   });
 
+  console.log("copy.js (copying answers and tables)");
+  await t("math becomes readable text: powers, fractions, roots, Greek, chemistry, escapes", () => {
+    const m = makePage().w.agent1102Copy.mathToText;
+    const cases = {
+      "x^2 + y^2 = z^2": "x² + y² = z²", "\\frac{a+b}{2}": "(a+b)/2", "\\frac{1}{2}": "1/2", "\\frac{x^2+1}{x-1}": "(x²+1)/(x-1)",
+      "\\sqrt{x+1}": "√(x+1)", "\\sqrt{2}": "√2", "\\sqrt[3]{x}": "³√x", "\\alpha \\leq \\beta": "α ≤ β", "a \\times b": "a × b",
+      "H_2O": "H₂O", "\\ce{H2O}": "H₂O", "\\ce{Fe^{3+}}": "Fe³⁺", "\\int_0^1 x\\,dx": "∫₀¹ x dx", "\\sum_{i=1}^{n} i": "∑ᵢ₌₁ⁿ i",
+      "\\text{speed} = \\frac{d}{t}": "speed = d/t", "x \\text{ if } y": "x if y", "e^{-x^2}": "e^(-x²)", "x_{n+1}": "xₙ₊₁",
+      "\\left( x \\right)": "( x )", "50\\% \\& 3\\$": "50% & 3$", "\\mathbb{R}": "ℝ", "\\sin x + \\cos(\\theta)": "sin x + cos(θ)",
+      "\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}": "[a, b; c, d]",
+    };
+    for (const [tex, want] of Object.entries(cases)) assert.strictEqual(m(tex), want, tex);
+  });
+  await t("copied answer: plain text has no markdown symbols; tables are tab-separated; math is readable", () => {
+    const { text } = makePage().w.agent1102Copy.responseClipboard(SAMPLE);
+    assert.strictEqual(text, [
+      "Results", "",
+      "A quick comparison of three options with inline code and a link (https://example.com/a):", "",
+      "Name\tPrice\tNote", "Alpha\t$5\tUses x² + y² = z²", "Beta\t$7\tcafé & crème — 100%", "",
+      "1. First step", "2. Second step", "   ◦ nested bold", "   ◦ nested two", "",
+      "> A quote", "", "const a = 1 * 2;", "",
+      "The formula is (a+b)/2 ≤ √x and that is it. Escaped *stars* and snake_case.",
+    ].join("\n"));
+    assert(!/\*\*|\|---|\\\(|^#|`/m.test(text.replace("Escaped *stars*", "")), "no ** | # ` or \\( left over");
+  });
+  await t("copied answer: rich version is real HTML (table with borders, bold, link, list) and has no markdown symbols", () => {
+    const { html } = makePage().w.agent1102Copy.responseClipboard(SAMPLE);
+    assert(/<table[^>]*border="1"/.test(html) && /<th[^>]*border: 1px solid/.test(html) && /<td[^>]*>café &amp; crème — 100%<\/td>/.test(html));
+    assert(/<strong>quick comparison<\/strong>/.test(html) && /<a href="https:\/\/example.com\/a">link<\/a>/.test(html) && /<ol>/.test(html) && /<ul>/.test(html));
+    assert(/<td[^>]*>Uses x² \+ y² = z²<\/td>/.test(html), "math in a table cell is text, not drawn glyphs");
+    assert(!/\*\*quick|\|---/.test(html) && html.startsWith('<meta charset="utf-8">'));
+  });
+  await t("copied answer: charts become a table, pictures are not loaded into the paste, markup in the text is not executed", () => {
+    const { w } = makePage();
+    const chart = '```chart\n{"type":"bar","title":"Sales","labels":["Q1","Q2"],"datasets":[{"label":"Units","data":[3,5]}]}\n```';
+    const r = w.agent1102Copy.responseClipboard(chart + "\n\n![cat](https://evil.example/x.png) <img src=x onerror=alert(1)> <script>alert(1)</script>ok");
+    assert(/Sales/.test(r.text) && /Q1\t3/.test(r.text) && /Q2\t5/.test(r.text), r.text);
+    assert(!/<img|<script|onerror/i.test(r.html), r.html);
+    assert(/cat \(https:\/\/evil.example\/x.png\)/.test(r.text));
+  });
+  await t("tables: cell text keeps line breaks as spaces and formulas as text, for Copy table and Copy CSV", () => {
+    const { w } = makePage();
+    const d = w.document.createElement("div");
+    d.innerHTML = '<table><tr><th>A</th><th>B</th></tr><tr><td>line one<br>line two</td><td>area <span class="math-inline" data-tex="\\pi r^2"><span class="katex">πr2</span></span></td></tr><tr><td>say \"hi\"</td><td>tab\there</td></tr></table>';
+    const table = d.firstChild;
+    assert.strictEqual(w.agent1102Copy.tableTsv(table), 'A\tB\nline one line two\tarea πr²\nsay "hi"\ttab here');
+    assert.strictEqual(w.agent1102Tables.tableToCsv(table), 'A,B\r\nline one line two,area πr²\r\n"say ""hi""",tab here');
+    const r = w.agent1102Copy.tableClipboard(table);
+    assert(/<table[^>]*border="1"/.test(r.html) && !/katex|data-tex|class=/.test(r.html) && /area πr²/.test(r.html));
+    assert.strictEqual(r.text.split("\n")[1], "line one line two\tarea πr²");
+  });
+  await t("write(): puts rich + plain text on the clipboard together, and falls back to plain text when blocked", async () => {
+    const { w, clipboard, text, html } = makePage();
+    assert.strictEqual(await w.agent1102Copy.write("<b>hi</b>", "hi"), true);
+    assert.strictEqual(await html(0), "<b>hi</b>"); assert.strictEqual(await text(0), "hi");
+    clipboard.fail = true;
+    assert.strictEqual(await w.agent1102Copy.write("<b>yo</b>", "yo"), true);
+    assert.strictEqual(clipboard.texts[0], "yo", "plain text still lands when the rich copy is refused");
+  });
+  await t("the Copy response button copies the clean version, not the markdown", async () => {
+    const { w, clipboard, text, html } = makePage();
+    w.addMsg("ai", SAMPLE);
+    const btn = [...w.document.querySelectorAll(".msg-action-btn")].find(b => b.title === "Copy response");
+    btn.click();
+    await new Promise(r => setTimeout(r, 30));
+    assert.strictEqual(clipboard.writes.length, 1);
+    const plain = await text(0);
+    assert(/Name\tPrice\tNote/.test(plain) && !/\*\*|\|---/.test(plain.replace("*stars*", "")), plain);
+    assert(/<table/.test(await html(0)));
+  });
+  await t("tables in a finished answer get Copy table (real table), Copy CSV and Download CSV", async () => {
+    const { w, clipboard, html, text } = makePage();
+    w.addMsg("ai", "| Name | Note |\n|---|---|\n| **Zoë** | \\(x^2\\) |\n| Bo | ok |");
+    await new Promise(r => setTimeout(r, 50));
+    const labels = [...w.document.querySelectorAll(".msg-action-btn span")].map(s => s.textContent).filter(Boolean);
+    assert.strictEqual(JSON.stringify(labels), '["Copy table","Copy CSV","Download CSV"]');
+    [...w.document.querySelectorAll(".msg-action-btn")].find(b => /Copy table/.test(b.textContent)).click();
+    await new Promise(r => setTimeout(r, 30));
+    assert(/<table[^>]*border="1"/.test(await html(0)));
+    assert.strictEqual(await text(0), "Name\tNote\nZoë\tx²\nBo\tok");
+  });
+  await t("selecting formulas and pressing Ctrl+C copies readable math instead of the drawn glyphs", () => {
+    const { w } = makePage();
+    const body = w.document.createElement("div"); body.className = "ai-text msg-content-body";
+    body.innerHTML = '<p>Area is <span class="math-inline" data-tex="\\pi r^2"><span class="katex">πr2</span></span> exactly</p>';
+    w.document.body.appendChild(body);
+    w.getSelection().selectAllChildren(body);
+    const set = {}; const ev = new w.Event("copy", { cancelable: true, bubbles: true });
+    ev.clipboardData = { setData: (k, v) => { set[k] = v; } };
+    w.document.dispatchEvent(ev);
+    assert.strictEqual(set["text/plain"], "Area is πr² exactly");
+    assert(ev.defaultPrevented && /πr²/.test(set["text/html"]) && !/katex/.test(set["text/html"]));
+    // a selection with no formulas is left to the browser
+    body.innerHTML = "<p>plain words</p>"; w.getSelection().selectAllChildren(body);
+    const ev2 = new w.Event("copy", { cancelable: true, bubbles: true }); ev2.clipboardData = { setData() {} };
+    w.document.dispatchEvent(ev2);
+    assert(!ev2.defaultPrevented);
+  });
+
+  console.log("live preview while the answer is written");
+  await t("the draft shows bold, lists, tables and math as they arrive, not ** and | marks", async () => {
+    const { w } = makePage();
+    const wrap = w.document.createElement("div"); w.document.body.appendChild(wrap);
+    const draft = w.agent1102Stream.createDraft({ wrap, setLabel() {} });
+    ["Here is **bol", "d** text\n\n| Name | Age |\n|---|---|\n| Bo", "b | 3 |\n\n- one\n- two"].forEach(p => draft.add(p));
+    await new Promise(r => setTimeout(r, 250));
+    const box = wrap.querySelector(".stream-draft");
+    assert(box.querySelector("strong") && box.querySelector("table td") && box.querySelectorAll("li").length === 2, box.innerHTML);
+    assert(!/\*\*|\|---/.test(box.textContent), box.textContent);
+    assert.strictEqual(box.querySelector("td").textContent, "Bob");
+    assert(box.querySelector(".table-wrap table"), "scrolls sideways like the finished message");
+    assert.strictEqual(box.style.whiteSpace, "", "formatted text must not be shown pre-wrapped");
+    assert.strictEqual(w.document.querySelectorAll(".msg-action-btn").length, 0, "no CSV buttons are added to a table that is still being written");
+  });
+  await t("the draft is repainted at a limited rate, not once per piece of text", async () => {
+    const { w } = makePage();
+    const wrap = w.document.createElement("div"); w.document.body.appendChild(wrap);
+    let paints = 0; const orig = w.agent1102Render.renderDraft;
+    w.agent1102Render.renderDraft = (...a) => { paints++; return orig(...a); };
+    const draft = w.agent1102Stream.createDraft({ wrap, setLabel() {} });
+    for (let i = 0; i < 40; i++) { draft.add("word" + i + " "); await new Promise(r => setTimeout(r, 5)); }
+    await new Promise(r => setTimeout(r, 200));
+    assert(paints >= 2 && paints <= 8, "painted " + paints + " times");
+    assert(/word39/.test(wrap.querySelector(".stream-draft").textContent), "the last words still arrive");
+  });
+  await t("half-written endings are tidied: open **, open code block, table header still waiting for its |---| line", () => {
+    const tidy = makePage().w.agent1102Render.tidyDraft;
+    assert.strictEqual(tidy("a **bol"), "a **bol**");
+    assert.strictEqual(tidy("a **"), "a ");
+    assert.strictEqual(tidy("a `co"), "a `co`");
+    assert.strictEqual(tidy("x\n```py\nprint(1) ** 2"), "x\n```py\nprint(1) ** 2\n```");
+    assert.strictEqual(tidy("Intro\n\n| Name | Age |"), "Intro\n");
+    assert.strictEqual(tidy("Intro\n\n| Name | Age |\n|---"), "Intro\n");
+    assert.strictEqual(tidy("| Name | Age |\n|---|---|\n| Bo"), "| Name | Age |\n|---|---|\n| Bo", "a table that has started is shown");
+    assert.strictEqual(tidy("| Name |\n|---|"), "| Name |\n|---|", "a one-column table is not held back");
+    assert.strictEqual(tidy("a **b** c"), "a **b** c");
+  });
+  await t("the draft never loads pictures, and charts/drawings still show as a short label", async () => {
+    const { w } = makePage();
+    const wrap = w.document.createElement("div"); w.document.body.appendChild(wrap);
+    const draft = w.agent1102Stream.createDraft({ wrap, setLabel() {} });
+    draft.add('![cat](https://evil.example/x.png) hi\n\n```chart\n{"type":"bar"');
+    await new Promise(r => setTimeout(r, 80));
+    const box = wrap.querySelector(".stream-draft");
+    assert(!box.querySelector("img") && /cat hi/.test(box.textContent) && /\[drawing the chart\.\.\.\]/.test(box.textContent) && !/\{"type"/.test(box.textContent));
+  });
+
   console.log(`\n${passed} passed`);
 })();
__PATCH_2__
diff --git a/backend/lib/imagesearch.js b/backend/lib/imagesearch.js
new file mode 100644
index 0000000..55f828c
--- /dev/null
+++ b/backend/lib/imagesearch.js
@@ -0,0 +1,141 @@
+// ============================================================
+//  Finding pictures on the web (the /photos command). This FINDS existing pictures; /image makes new ones.
+//
+//  It works with no setup at all (Wikimedia Commons needs no key). If you have a key for a bigger index, set
+//  ONE or BOTH of these in your host's environment and they are tried first:
+//    BRAVE_API_KEY    Brave Search's image search (https://brave.com/search/api). Strict safe-search is always on, and
+//                     the thumbnails are served through Brave's own proxy, so the person's browser never contacts the
+//                     websites the pictures came from.
+//    TAVILY_API_KEY   Tavily's image results (https://tavily.com)
+//  The order is Brave, then Tavily, then Wikimedia Commons. A provider that fails or finds nothing hands over to
+//  the next one.
+//
+//  The server only calls the fixed API URLs below. It never downloads the pictures themselves, so there is no
+//  server-side-request-forgery risk. Only https picture addresses are passed on to the browser.
+// ============================================================
+"use strict";
+
+const clean = (t, n) => String(t == null ? "" : t).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
+const httpsUrl = u => { try { const p = new URL(String(u)); return p.protocol === "https:" ? p.href : ""; } catch (_) { return ""; } };
+const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; } };
+
+// The *_URL overrides exist only so the automated tests can point at a fake server
+const BRAVE_URL = () => process.env.BRAVE_IMAGES_URL || "https://api.search.brave.com/res/v1/images/search";
+const TAVILY_URL = () => process.env.TAVILY_API_URL || "https://api.tavily.com/search";
+const COMMONS_URL = () => process.env.COMMONS_API_URL || "https://commons.wikimedia.org/w/api.php";
+
+// Only Brave has a safe-search switch, so this is a small safety net in front of all of them
+const BLOCKED_QUERY = /\b(porn\w*|nude[sd]?|naked|nsfw|hentai|xxx|erotic\w*|fetish\w*|gore|beheading)\b/i;
+const isBlockedQuery = q => BLOCKED_QUERY.test(String(q || ""));
+
+async function viaBrave(query, max, signal) {
+  const url = `${BRAVE_URL()}?q=${encodeURIComponent(query)}&count=${Math.min(max * 2, 40)}&safesearch=strict`;
+  const r = await fetch(url, { headers: { "Accept": "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY }, signal });
+  if (!r.ok) throw new Error(`Brave ${r.status}`);
+  const j = await r.json();
+  return (j.results || []).map(x => ({
+    title: x.title,
+    thumb: x.thumbnail && x.thumbnail.src,
+    full: x.properties && x.properties.url,
+    page: x.url,
+    source: x.source,
+  }));
+}
+
+async function viaTavily(query, max, signal) {
+  const r = await fetch(TAVILY_URL(), {
+    method: "POST",
+    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.TAVILY_API_KEY}` },
+    body: JSON.stringify({ query, max_results: 5, search_depth: "basic", include_answer: false, include_images: true, include_image_descriptions: true }),
+    signal,
+  });
+  if (!r.ok) throw new Error(`Tavily ${r.status}`);
+  const j = await r.json();
+  // each image is either a bare address or { url, description }
+  return (j.images || []).map(x => typeof x === "string" ? { thumb: x, full: x } : { title: x.description, thumb: x.url, full: x.url });
+}
+
+async function viaCommons(query, max, signal) {
+  const params = new URLSearchParams({
+    action: "query", format: "json", formatversion: "2", generator: "search",
+    gsrsearch: "filetype:bitmap " + query, gsrnamespace: "6", gsrlimit: String(Math.min(max * 2, 30)),
+    prop: "imageinfo", iiprop: "url|mime", iiurlwidth: "640",
+  });
+  const r = await fetch(`${COMMONS_URL()}?${params}`, {
+    headers: { "Accept": "application/json", "User-Agent": `agent1102-image-search/1.0 (${process.env.SITE_URL || "https://agent1102.onrender.com"})` },
+    signal,
+  });
+  if (!r.ok) throw new Error(`Commons ${r.status}`);
+  const j = await r.json();
+  const pages = (j.query && j.query.pages) || [];
+  return pages
+    .filter(p => p && p.imageinfo && p.imageinfo[0] && /^image\/(jpeg|png|webp|gif)$/.test(p.imageinfo[0].mime || ""))
+    .sort((a, b) => (a.index || 0) - (b.index || 0))
+    .map(p => {
+      const ii = p.imageinfo[0];
+      return {
+        title: String(p.title || "").replace(/^File:/i, "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " "),
+        thumb: ii.thumburl || ii.url, full: ii.url, page: ii.descriptionurl, source: "commons.wikimedia.org",
+      };
+    });
+}
+
+const PROVIDERS = {
+  brave:   { label: "Brave Search",      enabled: () => !!process.env.BRAVE_API_KEY,  run: viaBrave },
+  tavily:  { label: "Tavily",            enabled: () => !!process.env.TAVILY_API_KEY, run: viaTavily },
+  commons: { label: "Wikimedia Commons", enabled: () => true,                         run: viaCommons },
+};
+const ORDER = ["brave", "tavily", "commons"];
+
+// Whatever a provider gave back -> the same small shape, https only, no repeats
+function normalize(raw, max) {
+  const seen = new Set();
+  const out = [];
+  for (const x of raw) {
+    const thumb = httpsUrl(x.thumb);
+    if (!thumb || seen.has(thumb)) continue;
+    seen.add(thumb);
+    const page = httpsUrl(x.page);
+    const url = httpsUrl(x.full) || thumb;
+    out.push({
+      title: clean(x.title, 160),
+      thumb, url, page,
+      source: clean(x.source, 80) || hostOf(page) || hostOf(url),
+    });
+    if (out.length >= max) break;
+  }
+  return out;
+}
+
+const cache = new Map();
+const CACHE_MS = 10 * 60 * 1000;
+
+// -> { provider, label, images: [{ title, thumb, url, page, source }], failed }
+//    failed is true when every provider that was tried had a problem (as opposed to "nothing found")
+async function searchImages(query, { max = 12, timeoutMs = 7000 } = {}) {
+  query = clean(query, 200);
+  if (query.length < 2) return { provider: null, label: "", images: [], failed: false };
+
+  const order = ORDER.filter(n => PROVIDERS[n].enabled());
+  const key = order.join(",") + "|" + query.toLowerCase();
+  const hit = cache.get(key);
+  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
+
+  let errors = 0;
+  for (const name of order) {
+    try {
+      const images = normalize(await PROVIDERS[name].run(query, max, AbortSignal.timeout(timeoutMs)), max);
+      if (!images.length) continue;
+      const result = { provider: name, label: PROVIDERS[name].label, images, failed: false };
+      cache.set(key, { at: Date.now(), result });
+      if (cache.size > 200) cache.delete(cache.keys().next().value);
+      return result;
+    } catch (e) {
+      errors++;
+      console.warn(`Image search (${name}) failed:`, e && e.message ? e.message : e, e && e.cause ? "(" + (e.cause.code || e.cause.message) + ")" : "");
+    }
+  }
+  return { provider: null, label: "", images: [], failed: errors > 0 && errors === order.length };
+}
+
+module.exports = { searchImages, isBlockedQuery, normalize, PROVIDERS };
diff --git a/backend/public/index.html b/backend/public/index.html
index 6327ac1..86746fa 100644
--- a/backend/public/index.html
+++ b/backend/public/index.html
@@ -45,7 +45,7 @@
 
   <link rel="preload" as="image" href="images/cursor/custom-j-cursor.png" />
   <link rel="preload" as="image" href="images/cursor/custom-j-cursor-pointer.png" />
-  <link rel="stylesheet" href="style.css?v=20261021a" />
+  <link rel="stylesheet" href="style.css?v=20261030a" />
 </head>
 
 <body>
@@ -158,20 +158,21 @@
 <script src="js/session.js?v=20261021a"></script>
 <script src="js/config.js?v=20261021a"></script>
 <script src="js/utils.js?v=20261017a"></script>
-<script src="js/render.js?v=20261029a"></script>
+<script src="js/render.js?v=20261030a"></script>
 <script src="js/copy.js?v=20261029a"></script>
+<script src="js/zip.js?v=20261030a"></script>
 <script src="js/mathviz.js?v=20261020a"></script>
 <script src="js/study.js?v=20261020a"></script>
 <script src="js/stream.js?v=20261029a"></script>
-<script src="js/commands.js?v=20261018c"></script>
+<script src="js/commands.js?v=20261030a"></script>
 <script src="js/personal.js?v=20261020a"></script>
 <script src="js/auth.js?v=20261021a"></script>
 <script src="js/profile.js?v=20261020a"></script>
 <script src="js/ui.js?v=20261021b"></script>
 <script src="js/sendstate.js?v=20261020a"></script>
-<script src="js/chat.js?v=20261021b"></script>
+<script src="js/chat.js?v=20261030a"></script>
 <script src="js/tables.js?v=20261029a"></script>
-<script src="js/easter-eggs.js?v=20261017a"></script>
+<script src="js/easter-eggs.js?v=20261030a"></script>
 <script src="js/glow.js?v=20261018d"></script>
 </body>
 </html>
diff --git a/backend/public/js/chat.js b/backend/public/js/chat.js
index f4ccfdf..584d8a6 100644
--- a/backend/public/js/chat.js
+++ b/backend/public/js/chat.js
@@ -582,6 +582,7 @@ document.addEventListener("DOMContentLoaded", () => {
   function messagesForServer() {
     return history.map(m => {
       if (m.role === "assistant" && typeof m.content === "string") {
+        if (m.webImages) return { role: "assistant", content: m.content }; // /photos result: the model reads the text list, not our gallery data
         if (m.content === agent1102Commands.helpMarkdown()) return { role: "assistant", content: "[agent1102 showed the list of slash commands]" };
         // quizzes / flashcards travel as plain text so follow-ups like "explain question 3" work
         if (/```(?:quiz|flashcards)\b/i.test(m.content)) return { role: "assistant", content: agent1102Render.responseToText(m.content) };
@@ -632,6 +633,47 @@ document.addEventListener("DOMContentLoaded", () => {
     }
   }
 
+  // /photos <what to find>: pictures from the web (found, not created). Shown as a gallery of thumbnails.
+  // The gallery data is kept on the history entry (not in the text), so only this code can ever make a gallery.
+  async function runWebImages(typed, query, opts) {
+    opts = opts || {};
+    if (!opts.skipUser) {
+      addMsg("user", typed);
+      history.push({ role: "user", content: typed });
+      input.value = "";
+    }
+    const say = text => {
+      addMsg("ai", text);
+      history.push({ role: "assistant", content: text });
+      if (typeof saveCurrentChat === "function") saveCurrentChat();
+    };
+
+    if (!query) { say("What should I look for? For example: **/photos golden gate bridge**"); return; }
+
+    const thinking = addThinking("Searching the web for pictures...");
+    try {
+      const res = await fetch(`${BACKEND_URL}/web-images`, {
+        method: "POST",
+        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${userToken}` },
+        body: JSON.stringify({ query }),
+      });
+      const data = await res.json().catch(() => ({}));
+      thinking.wrap.remove();
+      if (!res.ok || data.error) { addMsg("ai", data.error || "I couldn't search for pictures. Please try again."); return; }
+      const images = Array.isArray(data.images) ? data.images : [];
+      if (!images.length) { say(`I couldn't find any pictures for **${query.replace(/[*_`]/g, "")}**. Try different words.`); return; }
+
+      const webImages = { query: data.query || query, provider: data.provider || "", images };
+      const content = agent1102Render.webImagesText(webImages);
+      addMsg("ai", content, null, undefined, { webImages });
+      history.push({ role: "assistant", content, webImages });
+      if (typeof saveCurrentChat === "function") saveCurrentChat();
+    } catch {
+      thinking.text.classList.remove("thinking");
+      thinking.text.textContent = SERVER_UNREACHABLE;
+    }
+  }
+
   // Finds the most recent image the AI generated or edited in this chat, so
   // "/edit ..." with nothing attached knows what to edit.
   const GENERATED_IMG_URL = /!\[[^\]]*\]\((https:\/\/(?:image\.pollinations\.ai\/|[^)\/]+\/storage\/v1\/object\/public\/chat-uploads\/)[^)]*)\)/g;
@@ -930,6 +972,8 @@ document.addEventListener("DOMContentLoaded", () => {
       }
 
       if (!hasImg && !/<attached_file/.test(text)) {
+        const photoReq = agent1102Commands.parseWebImages(text);
+        if (photoReq) { await runWebImages(text, photoReq.query, { skipUser: true }); return; }
         const editReq = agent1102Render.parseImageEditRequest(text);
         if (editReq) { await editImage(text, editReq.prompt, null, { skipUser: true }); return; }
         const imgReq = agent1102Render.parseImageRequest(text);
@@ -973,6 +1017,12 @@ document.addEventListener("DOMContentLoaded", () => {
         return;
       }
 
+      // 1a) /photos: find existing pictures on the web
+      if (!hasImage && !files.length) {
+        const photoReq = agent1102Commands.parseWebImages(typed);
+        if (photoReq) { await runWebImages(typed, photoReq.query); return; }
+      }
+
       // 1) Is the user asking for an image to be created or an existing one edited?
       if (!hasImage && !files.length) {
         const editReq = agent1102Render.parseImageEditRequest(typed);
diff --git a/backend/public/js/commands.js b/backend/public/js/commands.js
index 031008e..383bceb 100644
--- a/backend/public/js/commands.js
+++ b/backend/public/js/commands.js
@@ -13,7 +13,8 @@
     { name: "graph",      args: "<function, shape or number line>", desc: "Draw a math graph, number line, geometry diagram or fractions", icon: "fa-chart-line", group: "Create", aliases: ["plot", "numberline"] },
     { name: "image",      args: "<description>",        desc: "Generate an image",                          icon: "fa-image",            group: "Create", aliases: ["imagine", "img", "draw"] },
     { name: "edit",       args: "<change>",             desc: "Edit an attached image, or the last one I made", icon: "fa-wand-magic-sparkles", group: "Create" },
-    { name: "search",     args: "<question>",          desc: "Search the web and answer with sources (the only time I look things up online)", icon: "fa-magnifying-glass", group: "Search" },
+    { name: "search",     args: "<question>",          desc: "Search the web and answer with sources (I only go online for /search and /photos)", icon: "fa-magnifying-glass", group: "Search" },
+    { name: "photos",     args: "<what to find>",      desc: "Find pictures on the web (use /image to create a new one)", icon: "fa-images", group: "Search", aliases: ["photo", "pics", "pictures", "webimages"] },
     { name: "memory",     args: "",                     desc: "See what I remember about you (also: /memory on, /memory off)", icon: "fa-brain",   group: "Personal" },
     { name: "remember",   args: "<fact>",               desc: "Tell me something to remember for next time", icon: "fa-bookmark",         group: "Personal" },
     { name: "forget",     args: "<number or all>",      desc: "Remove one memory, or all of them",          icon: "fa-eraser",           group: "Personal" },
@@ -39,6 +40,13 @@
     return !!p && p.cmd.name === "help";
   }
 
+  // "/photos golden gate bridge" -> { query: "golden gate bridge" }; a bare "/photos" -> { query: "" }
+  function parseWebImages(text) {
+    const p = parseCommand(text);
+    if (!p || p.cmd.name !== "photos") return null;
+    return { query: p.rest.replace(/^(?:of|for|about)\s+/i, "").trim() };
+  }
+
   // "/graph y = x^2" -> { request: "y = x^2" }; "/numberline -2 < x" -> { request: "number line: -2 < x" }
   function parseGraph(text) {
     const m = String(text || "").trim().match(/^\/([a-z]+)\b\s*([\s\S]*)$/i);
@@ -81,6 +89,7 @@
       "- **Photos of paper:** send a picture of a worksheet or notes with no command and I'll read the words and problems and help with them.",
       "- You can paste or drag files and screenshots straight into the chat.",
       "- **Web search:** I only search the internet when you start a message with `/search`, like `/search latest Node.js version`. I'll answer with sources.",
+      "- **Pictures from the web:** `/photos golden gate bridge` finds existing pictures and shows them as a gallery. Each one links to its own page, so check the credit and licence before you reuse it. (`/image` is different: it creates a brand-new picture.)",
       "- **Memory and style:** I remember lasting facts you share (what you're studying or building) to make answers more personal. `/memory` shows them, `/forget` removes them, `/memory off` pauses it. `/style` sets how I answer, or just tell me, like \"from now on keep it short\".",
       "- **Tables:** any table I give you has Copy CSV and Download CSV buttons. Send a photo of a table and ask me to extract it.",
       "- Use `/quiz` or `/flashcards` on their own to study what we've just been talking about.",
@@ -184,5 +193,5 @@
     input.addEventListener("keydown", e => { if (e.key === "Enter") setTimeout(refresh, 0); });
   });
 
-  window.agent1102Commands = { COMMANDS, parseCommand, parseStudy, parseGraph, isHelp, helpMarkdown };
+  window.agent1102Commands = { COMMANDS, parseCommand, parseStudy, parseGraph, parseWebImages, isHelp, helpMarkdown };
 })();
diff --git a/backend/public/js/easter-eggs.js b/backend/public/js/easter-eggs.js
index 492a303..b3eca4b 100644
--- a/backend/public/js/easter-eggs.js
+++ b/backend/public/js/easter-eggs.js
@@ -15,6 +15,9 @@
   const bgLayer = document.getElementById("bg-layer"); // blurred in style.css (--bg-blur)
 
   function applyEaster() {
+    // style.css reads this: in light mode the reply text turns white while the (dark) picture is behind it
+    document.documentElement.classList.toggle("bg-on", !!easterActive);
+    document.body.classList.toggle("bg-on", !!easterActive);
     if (easterActive) {
       const img = portraitQuery.matches ? BG_VERTICAL : BG_HORIZONTAL;
       bgLayer.style.backgroundImage = `url('${img}')`;
@@ -139,7 +142,7 @@
     localStorage.setItem("agent1102_dino","true"); 
     dinoBtn.style.display = "block"; 
     pushEggs(); 
-    showToast("🦖 Dino game unlocked! Click the T-Rex button anytime to play!"); 
+    showToast("Dino game unlocked! Click the T-Rex button anytime to play!"); 
   }
 
   if ((val === "pac-man" || val === "pacman") && !pacmanUnlocked) { 
@@ -148,7 +151,7 @@
     localStorage.setItem("agent1102_pacman","true"); 
     pacmanBtn.style.display = "block"; 
     pushEggs(); 
-    showToast('<i class="fa-solid fa-ghost"></i> Pac-Man game unlocked! Click the Pac-Man button anytime to play!'); 
+    showToast("Pac-Man game unlocked! Click the Pac-Man button anytime to play!"); 
   }
 
   if (val === "allahu akbar") { 
diff --git a/backend/public/js/render.js b/backend/public/js/render.js
index f22972e..b0221b8 100644
--- a/backend/public/js/render.js
+++ b/backend/public/js/render.js
@@ -416,8 +416,12 @@
     return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
   }
 
+  // Light theme, except while the background picture is on: charts then sit on the dark picture,
+  // so they use the dark-theme colours (the same rule style.css applies to the reply text).
+  const chartLight = () => document.body.classList.contains("light") && !document.body.classList.contains("bg-on");
+
   function themeColors() {
-    const light = document.body.classList.contains("light");
+    const light = chartLight();
     return light
       ? { light, text: "#1f1f1f", muted: "#666666", grid: "rgba(0,0,0,0.10)", edge: "#ffffff", bg: "#ffffff" }
       : { light, text: "#ececec", muted: "#a3a3a3", grid: "rgba(255,255,255,0.12)", edge: "#171717", bg: "#171717" };
@@ -559,9 +563,9 @@
   }
 
   // Re-draw charts when the light/dark theme is toggled so text stays readable
-  let lastLight = document.body.classList.contains("light");
+  let lastLight = chartLight();
   new MutationObserver(() => {
-    const light = document.body.classList.contains("light");
+    const light = chartLight();
     if (light === lastLight) return;
     lastLight = light;
     liveCharts.forEach(entry => {
@@ -696,6 +700,92 @@
     return card;
   }
 
+  /* ---------------------------------------------------------- */
+  /*  Pictures from the web (/photos)                            */
+  /*  Built only from data that chat.js put on the message       */
+  /*  itself, never from reply text, so an AI reply (or anything */
+  /*  it was told to repeat) can't make the browser load a       */
+  /*  picture from an address of its choosing.                   */
+  /* ---------------------------------------------------------- */
+  function httpsOnly(u) {
+    try { const p = new URL(String(u)); return p.protocol === "https:" ? p.href : ""; } catch (_) { return ""; }
+  }
+
+  function cleanWebImages(data) {
+    if (!data || !Array.isArray(data.images)) return null;
+    const images = data.images.slice(0, 24).map(x => x && typeof x === "object" ? {
+      title: String(x.title || "").slice(0, 200), thumb: httpsOnly(x.thumb), url: httpsOnly(x.url), page: httpsOnly(x.page), source: String(x.source || "").slice(0, 80),
+    } : null).filter(x => x && x.thumb);
+    return images.length ? { query: String(data.query || "").slice(0, 200), provider: String(data.provider || "").slice(0, 60), images } : null;
+  }
+
+  // The same pictures as plain markdown: what gets copied, downloaded as .md and shown to the AI for follow-up questions
+  function webImagesText(data) {
+    const d = cleanWebImages(data);
+    if (!d) return "";
+    const md = u => u.replace(/\(/g, "%28").replace(/\)/g, "%29");
+    const lines = d.images.map((x, i) => {
+      const label = (x.title || x.source || "Picture").replace(/[\[\]\r\n]+/g, " ").trim();
+      const link = x.page || x.url;
+      return `${i + 1}. [${label}](${md(link)})` + (x.source ? ` (${x.source})` : "");
+    });
+    return `Pictures from the web for "${d.query.replace(/["\r\n]+/g, " ")}"${d.provider ? ` (via ${d.provider})` : ""}:\n\n${lines.join("\n")}`;
+  }
+
+  function buildWebImages(data) {
+    const d = cleanWebImages(data);
+    if (!d) return null;
+    const block = el("div", "web-gallery-block");
+    const head = el("div", "web-gallery-head");
+    head.textContent = `Pictures from the web for \u201c${d.query}\u201d`;
+    const grid = el("div", "web-gallery");
+
+    d.images.forEach(x => {
+      const card = el("figure", "web-image");
+      const link = el("a", "web-image-link");
+      link.href = x.url || x.thumb;
+      link.target = "_blank";
+      link.rel = "noopener noreferrer";
+      link.title = "Open the full picture";
+      const img = el("img");
+      img.alt = x.title || d.query;
+      img.setAttribute("loading", "lazy");
+      img.setAttribute("decoding", "async");
+      img.setAttribute("referrerpolicy", "no-referrer"); // don't tell the picture's host which site is showing it
+      img.addEventListener("error", () => {
+        card.remove();
+        if (!grid.children.length) { grid.remove(); head.textContent = "None of those pictures would load. Try /photos again, or different words."; }
+      });
+      img.src = x.thumb;
+      link.appendChild(img);
+
+      const cap = el("figcaption");
+      const title = el("span", "web-image-title");
+      title.textContent = x.title || x.source || "Picture";
+      cap.appendChild(title);
+      if (x.page) {
+        const src = el("a", "web-image-source");
+        src.href = x.page;
+        src.target = "_blank";
+        src.rel = "noopener noreferrer";
+        src.textContent = x.source || "Source";
+        src.title = "Open the page this picture is from";
+        cap.appendChild(src);
+      } else if (x.source) {
+        const src = el("span", "web-image-source");
+        src.textContent = x.source;
+        cap.appendChild(src);
+      }
+      card.append(link, cap);
+      grid.appendChild(card);
+    });
+
+    const note = el("div", "web-gallery-note");
+    note.textContent = "These pictures belong to their owners. Open the source to see the credit and licence." + (d.provider ? ` Found with ${d.provider}.` : "");
+    block.append(head, grid, note);
+    return block;
+  }
+
   /* ---------------------------------------------------------- */
   /*  Link preview cards                                         */
   /*  Any external link the AI shares (or a standalone link on   */
@@ -1490,7 +1580,7 @@
   /* ---------------------------------------------------------- */
   /*  Public API                                                 */
   /* ---------------------------------------------------------- */
-  window.addMsg = function addMsg(role, text, imgSrc, index) {
+  window.addMsg = function addMsg(role, text, imgSrc, index, extra) {
     const chat = document.getElementById("chat");
     const isUser = role === "user";
     const content = String(text == null ? "" : text);
@@ -1579,14 +1669,18 @@
     } else {
       const body = el("div", "ai-text msg-content-body");
       wrap.appendChild(body);
-      renderInto(body, content);
+      // A /photos result is drawn as a gallery from data on the message; everything else is markdown
+      const gallery = extra && extra.webImages ? buildWebImages(extra.webImages) : null;
+      if (gallery) body.appendChild(gallery); else renderInto(body, content);
 
       const actions = el("div", "msg-actions");
       const ttsButton = makeBtn("msg-action-btn", "fa-volume-high", "", "Read aloud");
       const copyBtn = makeBtn("msg-action-btn", "fa-copy", "", "Copy response");
       const dlBtn = makeBtn("msg-action-btn", "fa-download", "", "Download response");
 
-      ttsButton.addEventListener("click", () => toggleTTS(ttsButton, speakableText(content)));
+      // (a list of picture links isn't worth reading aloud, so a gallery is announced in one sentence)
+      const spoken = gallery ? `Here are ${gallery.querySelectorAll(".web-image").length} pictures from the web for ${extra.webImages.query}.` : speakableText(content);
+      ttsButton.addEventListener("click", () => toggleTTS(ttsButton, spoken));
       copyBtn.addEventListener("click", async () => {
         // Rich text + clean plain text (no ** | # marks). Falls back to the markdown text if copy.js isn't there.
         const ok = window.agent1102Copy ? await window.agent1102Copy.copyResponse(content) : await copyText(responseToText(content));
@@ -1600,6 +1694,18 @@
 
       actions.append(ttsButton, copyBtn, dlBtn);
 
+      // Two or more code files in this reply: offer them all in one .zip (zip.js finds and names the files)
+      const zipApi = window.agent1102Zip;
+      const codeFiles = zipApi ? zipApi.extractFiles(content, lang => FILE_EXT[lang]) : [];
+      if (codeFiles.length >= 2) {
+        const zipBtn = makeBtn("msg-action-btn", "fa-file-zipper", "", `Download all ${codeFiles.length} files (.zip)`);
+        zipBtn.addEventListener("click", () => {
+          downloadFile(`agent1102-files-${timestamp()}.zip`, zipApi.toBlob(codeFiles));
+          flash(zipBtn, "fa-file-zipper", "", "");
+        });
+        actions.appendChild(zipBtn);
+      }
+
       // "Try again": only when a user message came before this reply (not the greeting).
       // Drops this reply (and anything after it) and asks for a fresh one.
       const hasUserBefore = typeof history !== "undefined" && Array.isArray(history) && msgIndex != null &&
@@ -1624,7 +1730,7 @@
   // Re-draws one saved history entry (text, image + text, attached files, generated images)
   window.addHistoryMsg = function addHistoryMsg(m, index) {
     if (!m || m.role === "system") return null;
-    if (typeof m.content === "string") return window.addMsg(m.role, m.content, null, index);
+    if (typeof m.content === "string") return window.addMsg(m.role, m.content, null, index, m.webImages ? { webImages: m.webImages } : undefined);
     if (Array.isArray(m.content)) {
       const urls = m.content
         .filter(p => p && p.type === "image_url" && p.image_url && typeof p.image_url.url === "string" && p.image_url.url.startsWith("data:image/"))
@@ -1648,6 +1754,6 @@
   window.agent1102Render = {
     normalizeChartSpec, responseToText, chunkText, parseImageRequest, parseImageEditRequest,
     parseAttachedFiles, historyTitle, escapeHtml, mathToSpeech, speakableText, extractMath, fileChipIcon,
-    buildLinkCard, renderDraft, tidyDraft,
+    buildLinkCard, renderDraft, tidyDraft, webImagesText, buildWebImages,
   };
 })();
diff --git a/backend/public/js/zip.js b/backend/public/js/zip.js
new file mode 100644
index 0000000..9083c4d
--- /dev/null
+++ b/backend/public/js/zip.js
@@ -0,0 +1,233 @@
+// ============================================================
+//  "Download all files (.zip)" for a reply that contains several code files.
+//    extractFiles(markdown)  finds every code block that is really a file and gives it a sensible name
+//    makeZip(files)          builds the .zip itself (no library: it works offline and loads nothing from a CDN)
+//  render.js shows the button under a reply when two or more files are found.
+// ============================================================
+(function () {
+  "use strict";
+
+  /* ---------------------------------------------------------- */
+  /*  The .zip file                                              */
+  /*  Files are stored uncompressed: code is small, and a plain  */
+  /*  stored zip opens everywhere (Windows, macOS, Linux, phones) */
+  /* ---------------------------------------------------------- */
+  const CRC_TABLE = (() => {
+    const t = new Uint32Array(256);
+    for (let n = 0; n < 256; n++) {
+      let c = n;
+      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
+      t[n] = c >>> 0;
+    }
+    return t;
+  })();
+
+  function crc32(bytes) {
+    let c = 0xffffffff;
+    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
+    return (c ^ 0xffffffff) >>> 0;
+  }
+
+  function dosStamp(d) {
+    return {
+      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
+      date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
+    };
+  }
+
+  // files: [{ name, content }] (content is a string or a Uint8Array)  ->  Uint8Array holding the .zip
+  function makeZip(files, now) {
+    const enc = new TextEncoder();
+    const { time, date } = dosStamp(now || new Date());
+    const parts = [], central = [];
+    let offset = 0;
+
+    files.forEach(f => {
+      const name = enc.encode(f.name);
+      const data = typeof f.content === "string" ? enc.encode(f.content) : f.content;
+      const crc = crc32(data);
+
+      const local = new Uint8Array(30 + name.length);
+      const lv = new DataView(local.buffer);
+      lv.setUint32(0, 0x04034b50, true);   // local file header
+      lv.setUint16(4, 20, true);           // version needed
+      lv.setUint16(6, 0x0800, true);       // flag: the name is UTF-8 (accents, other alphabets)
+      lv.setUint16(8, 0, true);            // method 0 = stored
+      lv.setUint16(10, time, true);
+      lv.setUint16(12, date, true);
+      lv.setUint32(14, crc, true);
+      lv.setUint32(18, data.length, true); // compressed size
+      lv.setUint32(22, data.length, true); // size
+      lv.setUint16(26, name.length, true);
+      local.set(name, 30);
+      parts.push(local, data);
+
+      const cen = new Uint8Array(46 + name.length);
+      const cv = new DataView(cen.buffer);
+      cv.setUint32(0, 0x02014b50, true);   // central directory entry
+      cv.setUint16(4, 20, true);           // version made by
+      cv.setUint16(6, 20, true);           // version needed
+      cv.setUint16(8, 0x0800, true);
+      cv.setUint16(10, 0, true);
+      cv.setUint16(12, time, true);
+      cv.setUint16(14, date, true);
+      cv.setUint32(16, crc, true);
+      cv.setUint32(20, data.length, true);
+      cv.setUint32(24, data.length, true);
+      cv.setUint16(28, name.length, true);
+      cv.setUint32(42, offset, true);      // where this file's local header starts
+      cen.set(name, 46);
+      central.push(cen);
+
+      offset += local.length + data.length;
+    });
+
+    const cdSize = central.reduce((n, c) => n + c.length, 0);
+    const end = new Uint8Array(22);
+    const ev = new DataView(end.buffer);
+    ev.setUint32(0, 0x06054b50, true);     // end of central directory
+    ev.setUint16(8, files.length, true);
+    ev.setUint16(10, files.length, true);
+    ev.setUint32(12, cdSize, true);
+    ev.setUint32(16, offset, true);
+
+    const all = [...parts, ...central, end];
+    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
+    let at = 0;
+    all.forEach(p => { out.set(p, at); at += p.length; });
+    return out;
+  }
+
+  const toBlob = (files, now) => new Blob([makeZip(files, now)], { type: "application/zip" });
+
+  /* ---------------------------------------------------------- */
+  /*  Finding the files in a reply                               */
+  /* ---------------------------------------------------------- */
+  // Languages that are drawings / study widgets in this app, never files
+  const WIDGET_LANGS = new Set(["chart", "chartjs", "chart.js", "chart-json", "mathviz", "mathgraph", "math-visual", "quiz", "flashcards",
+    "graph", "plot", "geometry", "numberline", "math", "desmos"]);
+  // Blocks like these are usually something to read or a command to run, so they are only a file when they are named
+  const UNNAMED_SKIP = new Set(["", "text", "plaintext", "txt", "console", "output", "log", "terminal", "diff", "patch", "bash", "sh", "shell",
+    "zsh", "fish", "powershell", "ps1", "bat", "batch", "cmd", "shell-session", "sh-session"]);
+
+  const EXTS = "html|htm|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|txt|py|java|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|sh|bat|ps1|sql|" +
+    "yml|yaml|xml|toml|ini|cfg|conf|env|csv|tsv|svg|vue|svelte|lua|dart|r|pl|scala|hs|gradle|properties|lock";
+  const BARE = "Dockerfile|Makefile|Procfile|Gemfile|Rakefile|\\.gitignore|\\.dockerignore|\\.env(?:\\.[\\w-]+)?|\\.eslintrc|\\.prettierrc|\\.babelrc|\\.npmrc";
+  const NAME = "(?:[\\w@.-]+/)*(?:[\\w@][\\w@.-]*\\.(?:" + EXTS + ")|" + BARE + ")";
+  const NAME_ONLY = new RegExp("^" + NAME + "$", "i");
+  // "Node.js", "Vue.js"... are names of tools, not files
+  const FRAMEWORK = /^(?:node|next|nuxt|vue|react|express|d3|p5|three|chart|angular|ember|backbone|socket|alpine|anime|moment|lodash|deno)\.js$/i;
+  const isName = s => NAME_ONLY.test(s) && !FRAMEWORK.test(s);
+
+  // "```js title="app.js"", "```js:app.js", "```index.html", "```js app.js"  ->  { lang, name }
+  function parseInfo(info) {
+    let lang = "", name = "";
+    if (!info) return { lang, name };
+    const attr = /(?:^|\s)(?:title|filename|file|name|path)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i.exec(info);
+    if (attr) name = attr[1] || attr[2] || attr[3];
+    const toks = info.replace(/^\{|\}$/g, "").split(/\s+/).filter(Boolean);
+    const first = toks[0] || "";
+    const colon = /^([\w+#.-]+):(\S.*)$/.exec(first);
+    if (colon) { lang = colon[1]; if (!name && isName(colon[2])) name = colon[2]; }
+    else if (isName(first)) { if (!name) name = first; lang = first.split(".").pop(); }
+    else lang = first.replace(/[{},]/g, "");
+    if (!name) {
+      for (const t of toks.slice(1)) {
+        const c = t.replace(/^["'{]+|["'},:]+$/g, "");
+        if (isName(c)) { name = c; break; }
+      }
+    }
+    return { lang: lang.toLowerCase(), name };
+  }
+
+  // A first line like  // app.js   # server.py   <!-- index.html -->   /* style.css */   /  "filename: app.js"
+  function nameFromFirstLine(code) {
+    const first = (String(code).split("\n")[0] || "").trim();
+    const m = /^(?:\/\/|#|--|;|%|<!--|\/\*)\s*(?:file(?:name)?\s*:\s*)?(\S+?)\s*(?:-->|\*\/)?$/i.exec(first);
+    return m && isName(m[1]) ? m[1] : "";
+  }
+
+  // The line just above the code block: "index.html", "**index.html**", "### index.html", "1. index.html:",
+  // "File: index.html" or a short sentence ending in a colon with the file name in `code` or **bold**
+  function nameFromLine(line) {
+    const text = String(line || "").trim();
+    if (!text) return "";
+    const bare = text.replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/, "").replace(/[*_`]/g, "")
+      .replace(/^(?:file(?:name)?|path)\s*:\s*/i, "").replace(/\s*[:：]\s*$/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
+    if (isName(bare)) return bare;
+    if (text.length <= 120 && /[:：]\s*$/.test(text)) {
+      const re = new RegExp("(?:`|\\*\\*|__)(" + NAME + ")(?:`|\\*\\*|__)", "gi");
+      let m, found = "";
+      while ((m = re.exec(text))) if (!FRAMEWORK.test(m[1])) found = m[1];
+      return found;
+    }
+    return "";
+  }
+
+  // Keeps a path inside the zip: no "..", no leading slash, no odd characters
+  function cleanPath(p) {
+    return String(p).replace(/\\/g, "/").split("/")
+      .map(seg => seg.trim()).filter(seg => seg && seg !== "." && seg !== "..")
+      .map(seg => seg.replace(/[^\w@.\- ]+/g, "_").replace(/^\.{2,}/, "_").slice(0, 100))
+      .filter(Boolean).join("/").slice(0, 200);
+  }
+
+  const MAX_FILES = 100;
+
+  // "app.js" + 2 -> "app-2.js";  "src/app.js" -> "src/app-2.js";  ".gitignore" -> ".gitignore-2"
+  function withSuffix(name, n) {
+    const slash = name.lastIndexOf("/") + 1, base = name.slice(slash), dot = base.lastIndexOf(".");
+    return dot > 0 ? name.slice(0, slash) + base.slice(0, dot) + "-" + n + base.slice(dot) : name + "-" + n;
+  }
+
+  // -> [{ name, content, lang }]  (extFor: language -> file extension, used when a block has no name)
+  function extractFiles(md, extFor) {
+    const lines = String(md == null ? "" : md).split(/\r?\n/);
+    const out = [];
+    const used = new Map(); // lower-case name -> how many times
+    let lastText = "";      // the last line of text above the next code block
+
+    for (let i = 0; i < lines.length && out.length < MAX_FILES; i++) {
+      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
+      if (!open || (open[1][0] === "`" && open[2].includes("`"))) { if (lines[i].trim()) lastText = lines[i]; continue; }
+      const fence = open[1];
+      const close = new RegExp("^ {0,3}" + (fence[0] === "`" ? "`" : "~") + "{" + fence.length + ",}\\s*$");
+      const body = [];
+      let j = i + 1;
+      for (; j < lines.length && !close.test(lines[j]); j++) body.push(lines[j]);
+      const code = body.join("\n").replace(/\s+$/, "");
+      const above = lastText;
+      lastText = "";
+      i = j;
+      if (!code.trim()) continue;
+
+      const { lang, name: infoName } = parseInfo(open[2].trim());
+      if (WIDGET_LANGS.has(lang)) continue;
+      const mathviz = window.agent1102MathViz;
+      if (mathviz && ["", "json"].includes(lang) && mathviz.looksLikeSpec(code)) continue; // a drawing, not a file
+
+      let name = infoName || nameFromFirstLine(code) || nameFromLine(above);
+      if (!name) {
+        const ext = extFor ? extFor(lang) : "";
+        if (UNNAMED_SKIP.has(lang) || !ext) continue;
+        name = "file-" + (out.length + 1) + "." + ext;
+      }
+      name = cleanPath(name);
+      if (!name) continue;
+
+      const key = name.toLowerCase();
+      if (used.has(key)) {
+        if (out.some(f => f.name.toLowerCase() === key && f.content === code + "\n")) continue; // the same file shown twice
+        const n = used.get(key) + 1;
+        used.set(key, n);
+        name = withSuffix(name, n);
+        used.set(name.toLowerCase(), 1);
+      } else used.set(key, 1);
+
+      out.push({ name, content: code + "\n", lang });
+    }
+    return out;
+  }
+
+  window.agent1102Zip = { crc32, makeZip, toBlob, extractFiles, parseInfo, nameFromLine, nameFromFirstLine, cleanPath };
+})();
diff --git a/backend/public/style.css b/backend/public/style.css
index 33cd20f..116e6d6 100644
--- a/backend/public/style.css
+++ b/backend/public/style.css
@@ -709,3 +709,47 @@ header[data-touch-glow], #input-area[data-touch-glow], #sidebar[data-touch-glow]
 .history-item-naming { flex:1; padding:0.6rem 0.4rem; font-size:0.9rem; font-style:italic; color:var(--text-muted); animation:namingPulse 1.2s ease-in-out infinite; }
 @keyframes namingPulse { 0%, 100% { opacity:0.45; } 50% { opacity:1; } }
 @media (prefers-reduced-motion: reduce) { .history-item-naming { animation:none; } }
+
+/* ============================================================
+   TEXT SELECTION: the app's blue with white text
+   (nothing set this before, so each browser's own default highlight was used)
+   ============================================================ */
+::selection { background:var(--accent); color:#ffffff; }
+::-moz-selection { background:var(--accent); color:#ffffff; }
+/* the title is gradient-filled (transparent text), so its fill has to be set for the highlighted part to show */
+#header-title::selection, .header-title::selection, .auth-box h1::selection { background:var(--accent); color:#ffffff; -webkit-text-fill-color:#ffffff; }
+
+/* ============================================================
+   LIGHT THEME + BACKGROUND PICTURE
+   Replies have no bubble, so their text sits straight on the picture. The picture is almost black, so while it
+   is on, a reply uses the dark theme's colours (white text). With the picture off, nothing here applies and the
+   light theme's dark text is used. The header, message box, sidebar and your own message bubbles are solid
+   surfaces, so they keep the light theme either way.
+   js/easter-eggs.js puts the "bg-on" class on <html> and <body> while the picture is showing.
+   ============================================================ */
+.light.bg-on .msg-wrap.ai {
+  --text:#f7f7f7; --text-muted:#c9c9d1; --border:rgba(255,255,255,0.14);
+  --raised:#111116; --surface:#131318; --surface2:#17171d; --ai-bg:#17171d; --accent-bright:#4FA9FF;
+}
+/* the few places that hard-code a light-theme colour (found by searching for ".light" above) */
+.light.bg-on .ai-text a { color:#6ea8ff; }
+.light.bg-on .msg-content-body th, .light.bg-on .msg-content-body td { border-color:rgba(255,255,255,0.14); }
+.light.bg-on .msg-content-body th { background:rgba(255,255,255,0.06); }
+.light.bg-on .chart-block, .light.bg-on .study-block { background:rgba(255,255,255,0.04); border-color:rgba(255,255,255,0.14); }
+.light.bg-on .chart-error-msg, .light.bg-on .math-error { color:#ff6b6d; }
+.light.bg-on .mathviz-block, .light.bg-on .mv-inline { --mv-halo:rgba(15,15,15,0.85); --mv-legend:rgba(15,15,15,0.75); --mv-hole:#1a1a1a; }
+
+/* ============================================================
+   Pictures from the web (/photos)
+   ============================================================ */
+.web-gallery-block { margin:0.25rem 0 0.5rem; max-width:760px; }
+.web-gallery-head { font-weight:600; margin:0 0 0.6rem; }
+.web-gallery { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:0.6rem; }
+.web-image { margin:0; display:flex; flex-direction:column; border-radius:12px; overflow:hidden; background:var(--surface); border:1px solid var(--border); }
+.web-image-link { display:block; aspect-ratio:4 / 3; background:rgba(127,127,127,0.16); }
+.web-image-link img { display:block; width:100%; height:100%; object-fit:cover; }
+.web-image figcaption { display:flex; flex-direction:column; gap:0.15rem; padding:0.4rem 0.55rem 0.5rem; font-size:0.78rem; line-height:1.3; }
+.web-image-title { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; color:var(--text); }
+.ai-text .web-image-source, .light.bg-on .ai-text .web-image-source { color:var(--text-muted); font-size:0.72rem; text-decoration:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
+.ai-text a.web-image-source:hover { color:var(--accent-bright); text-decoration:underline; }
+.web-gallery-note { margin-top:0.55rem; font-size:0.75rem; color:var(--text-muted); }
diff --git a/backend/routes/webimages.js b/backend/routes/webimages.js
new file mode 100644
index 0000000..1b18b22
--- /dev/null
+++ b/backend/routes/webimages.js
@@ -0,0 +1,23 @@
+// Finding pictures on the web (POST /web-images).  The /photos command in the chat uses this.
+// The search itself is in lib/imagesearch.js. This route only checks the request and shapes the answer.
+// (The code below receives the shared pieces through `ctx`, like every file in routes/.)
+
+module.exports = function registerWebImages(ctx) {
+const { app, needUser, L } = ctx;
+const { searchImages, isBlockedQuery } = require("../lib/imagesearch");
+
+app.post("/web-images", needUser, L.webImages, async (req, res) => {
+  const query = typeof req.body.query === "string" ? req.body.query.replace(/\s+/g, " ").trim().slice(0, 200) : "";
+  if (query.length < 2) return res.status(400).json({ error: "What should I look for? For example: /photos golden gate bridge" });
+  if (isBlockedQuery(query)) return res.status(400).json({ error: "I can't search for pictures of that." });
+  try {
+    const found = await searchImages(query, { max: 12 });
+    if (found.failed) return res.status(502).json({ error: "The picture search isn't working right now. Please try again in a moment." });
+    res.json({ query, provider: found.label, images: found.images });
+  } catch (err) {
+    console.error("Web image search failed:", err);
+    res.status(500).json({ error: "I couldn't search for pictures. Please try again." });
+  }
+});
+
+};
diff --git a/backend/server.js b/backend/server.js
index 37313cf..0bd602e 100644
--- a/backend/server.js
+++ b/backend/server.js
@@ -179,6 +179,7 @@ const L = {
   chatSignedOut: createLimiter({ windowMs: 10 * MIN, max: 10, key: signedOutKey, message: slowDown("Please sign in to keep chatting.") }),
   study: createLimiter({ windowMs: 10 * MIN, max: 20, key: personKey, message: slowDown("You've made a lot of study requests.") }),
   images: createLimiter({ windowMs: 10 * MIN, max: 10, key: personKey, message: slowDown("You've made a lot of image requests.") }),
+  webImages: createLimiter({ windowMs: 10 * MIN, max: 20, key: personKey, message: slowDown("You've searched for a lot of pictures.") }),
   title: createLimiter({ windowMs: MIN, max: 30, key: personKey, message: slowDown("Too many requests.") }),
   tts: createLimiter({ windowMs: MIN, max: 60, key: personKey, message: slowDown("Too many read-aloud requests.") }),
   linkPreview: createLimiter({ windowMs: MIN, max: 90, key: personKey, message: slowDown("Too many link previews.") }),
@@ -202,6 +203,7 @@ require("./routes/study")(ctx);
 require("./routes/title")(ctx);
 require("./routes/chat")(ctx);
 require("./routes/media")(ctx);
+require("./routes/webimages")(ctx);
 require("./routes/auth")(ctx);
 require("./routes/eggs")(ctx);
 require("./routes/scores")(ctx);
diff --git a/backend/test/app-harness.js b/backend/test/app-harness.js
new file mode 100644
index 0000000..7580bd3
--- /dev/null
+++ b/backend/test/app-harness.js
@@ -0,0 +1,96 @@
+// Boots the REAL page in jsdom: index.html's markup plus every script it lists, in the same order, with the
+// browser pieces jsdom lacks stubbed and `fetch` replaced by a fake. Lets tests drive the actual UI
+// (type a command, press send, click a button) instead of testing stand-ins.
+//   const app = await bootApp({ routes: { "/web-images": (body) => ({ status: 200, json: {...} }) } });
+"use strict";
+const fs = require("fs");
+const path = require("path");
+const vm = require("vm");
+const { JSDOM, VirtualConsole } = require("jsdom");
+
+const PUBLIC = path.join(__dirname, "..", "public");
+const NM = (...p) => fs.readFileSync(path.join(__dirname, "..", "node_modules", ...p), "utf8");
+const sleep = ms => new Promise(r => setTimeout(r, ms));
+const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
+// a token that looks like a real, unexpired sign-in (the page reads its expiry)
+const fakeToken = () => `${b64({ alg: "HS256" })}.${b64({ sub: "11111111-1111-4111-8111-111111111111", exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
+
+async function bootApp({ routes = {}, storage = {}, light = false } = {}) {
+  let html = fs.readFileSync(path.join(PUBLIC, "index.html"), "utf8");
+  const scripts = [...html.matchAll(/<script src="(js\/[^"?]+)(?:\?[^"]*)?"><\/script>/g)].map(m => m[1]);
+  html = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<link[^>]*>/g, "");
+
+  // the page's own console.log chatter is dropped; real script errors are collected and the tests fail on them
+  const errors = [];
+  const virtualConsole = new VirtualConsole();
+  virtualConsole.on("jsdomError", e => errors.push(e));
+  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole });
+  const w = dom.window;
+  const calls = [];
+  w.__calls = calls;
+
+  // ---- browser pieces jsdom doesn't have ----
+  w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
+  w.scrollTo = () => {};
+  w.HTMLElement.prototype.scrollIntoView = function () {};
+  w.IntersectionObserver = w.IntersectionObserver || class { observe() {} unobserve() {} disconnect() {} };
+  w.ResizeObserver = w.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
+  w.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [], addEventListener() {}, onvoiceschanged: null };
+  w.SpeechSynthesisUtterance = class {};
+  w.open = () => null;
+  w.HTMLCanvasElement.prototype.getContext = () => null;
+  w.URL.createObjectURL = blob => { w.__lastBlob = blob; return "blob:test"; };
+  w.URL.revokeObjectURL = () => {};
+  w.HTMLAnchorElement.prototype.click = function () { w.__lastDownload = { name: this.download, href: this.href }; };
+
+  // ---- fake network ----
+  const defaults = {
+    "/ping": () => ({ status: 200, json: { ok: true } }),
+    "/profile": () => ({ status: 200, json: { name: "Sam", email: "a@b.c" } }),
+    "/chats": () => ({ status: 200, json: { chats: [], success: true } }),
+    "/title": () => ({ status: 200, json: { title: "Test chat" } }),
+    "/easter-eggs": () => ({ status: 200, json: {} }),
+    "/auth/refresh": () => ({ status: 401, json: { error: "no" } }),
+  };
+  w.fetch = async (url, opts = {}) => {
+    const p = new URL(String(url), "http://localhost/").pathname;
+    let body = null;
+    try { body = opts.body ? JSON.parse(opts.body) : null; } catch (_) { body = opts.body; }
+    calls.push({ path: p, method: opts.method || "GET", body, headers: opts.headers || {} });
+    const handler = routes[p] || defaults[p];
+    const r = handler ? await handler(body, opts) : { status: 404, json: { error: "not faked: " + p } };
+    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, json: async () => r.json, text: async () => JSON.stringify(r.json), body: null };
+  };
+
+  // ---- storage the page expects ----
+  Object.entries({ agent1102_token: fakeToken(), ...storage }).forEach(([k, v]) => w.localStorage.setItem(k, v));
+  if (light) w.localStorage.setItem("agent1102_theme", "light");
+
+  const ctx = dom.getInternalVMContext();
+  const run = (code, file) => new vm.Script(code, { filename: file }).runInContext(ctx);
+  run(NM("marked", "marked.min.js"), "marked.js");
+  run(NM("dompurify", "dist", "purify.min.js"), "purify.js");
+  w.addEventListener("error", e => errors.push(e.error || e.message));
+  for (const s of scripts) {
+    try { run(fs.readFileSync(path.join(PUBLIC, s), "utf8"), s); }
+    catch (e) { errors.push(new Error(s + ": " + e.message)); }
+  }
+  w.document.dispatchEvent(new w.Event("DOMContentLoaded"));
+  w.dispatchEvent(new w.Event("load"));
+  await sleep(30);
+
+  const $ = sel => w.document.querySelector(sel);
+  return {
+    w, calls, errors, $, sleep,
+    // evaluates code inside the page (so top-level `let` variables like `history` are reachable); returns plain JSON data
+    peek: code => { const v = run(code); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
+    // types into the message box and presses Send
+    async send(text) { $("#input").value = text; $("#input").dispatchEvent(new w.Event("input", { bubbles: true })); $("#send").click(); await sleep(120); },
+    // the HTML of every toast currently showing (showToast puts them on <body> with z-index 9999)
+    toasts: () => [...w.document.querySelectorAll("body > div")].filter(d => d.style.zIndex === "9999").map(d => d.innerHTML),
+    // the page keeps timers running (keep-alive pings, animations): closing the window stops them so Node can exit
+    close: () => w.close(),
+  };
+}
+
+module.exports = { bootApp };
diff --git a/backend/test/app.test.js b/backend/test/app.test.js
new file mode 100644
index 0000000..ff0f0f4
--- /dev/null
+++ b/backend/test/app.test.js
@@ -0,0 +1,296 @@
+// Drives the REAL page (index.html + every script, see test/app-harness.js) in jsdom: easter-egg toasts, the background
+// flag, /photos, the .zip download, and the theme colours in style.css.   run:  node test/app.test.js
+"use strict";
+const fs = require("fs"), path = require("path"), assert = require("assert"), { spawnSync } = require("child_process");
+const { bootApp } = require("./app-harness");
+
+let passed = 0;
+async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e && e.message)); process.exitCode = 1; } }
+// every test gets a fresh page and always closes it (the page's timers would keep Node running)
+async function withApp(opts, fn) { const app = await bootApp(opts); try { await fn(app); assert.deepStrictEqual(app.errors.map(e => String(e && e.message || e)), [], "the page reported script errors"); } finally { app.close(); } }
+
+const plain = x => JSON.parse(JSON.stringify(x)); // values made inside the page come from another JS realm; compare them as plain data
+const CSS = fs.readFileSync(path.join(__dirname, "..", "public", "style.css"), "utf8");
+
+// ---- a tiny CSS reader: [{ selectors: [...], decl: { prop: value } }] (top-level and @media rules alike) ----
+function cssRules(css) {
+  const rules = [];
+  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
+  for (const m of flat.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
+    const decl = {};
+    m[2].split(";").forEach(d => { const i = d.indexOf(":"); if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s*!important$/, ""); });
+    rules.push({ selectors: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean), decl });
+  }
+  return rules;
+}
+const RULES = cssRules(CSS);
+const rulesFor = sel => RULES.filter(r => r.selectors.includes(sel));
+const lum = hex => { const n = parseInt(hex.replace("#", "").padEnd(6, hex.length === 4 ? hex.slice(1).replace(/(.)/g, "$1$1") : "0").slice(0, 6), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
+const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
+
+// ---- an independent .zip reader (its own CRC, written differently from zip.js) so a bug in one can't hide in both ----
+function slowCrc(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; }
+function readZip(buf) {
+  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
+  assert(eocd >= 0, "no end-of-zip record");
+  const count = buf.readUInt16LE(eocd + 10);
+  let p = buf.readUInt32LE(eocd + 16);
+  const files = {};
+  for (let i = 0; i < count; i++) {
+    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, "bad directory entry");
+    const flag = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
+    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
+    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), at = buf.readUInt32LE(p + 42);
+    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
+    assert.strictEqual(buf.readUInt32LE(at), 0x04034b50, "bad file header for " + name);
+    assert(flag & 0x800, "name not marked UTF-8: " + name);
+    const data = buf.subarray(at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28) + csize);
+    assert.strictEqual(method, 0); assert.strictEqual(csize, usize);
+    assert.strictEqual(slowCrc(data), crc, "checksum mismatch for " + name);
+    files[name] = data.toString("utf8");
+    p += 46 + nlen + elen + clen;
+  }
+  return files;
+}
+const blobBytes = (w, blob) => new Promise((res, rej) => { const fr = new w.FileReader(); fr.onload = () => res(Buffer.from(fr.result)); fr.onerror = rej; fr.readAsArrayBuffer(blob); });
+
+const IMAGES = q => ({ status: 200, json: { query: q, provider: "Wikimedia Commons", images: [
+  { title: "Golden Gate", thumb: "https://upload.wikimedia.org/thumb/a.jpg", url: "https://upload.wikimedia.org/a.jpg", page: "https://commons.wikimedia.org/wiki/File:A.jpg", source: "commons.wikimedia.org" },
+  { title: "Insecure", thumb: "http://insecure.example/b.jpg", url: "", page: "", source: "insecure.example" },
+  { title: "Odd page link", thumb: "https://upload.wikimedia.org/thumb/c.jpg", url: "https://upload.wikimedia.org/c.jpg", page: "javascript:alert(1)", source: "example.org" },
+] } });
+
+(async () => {
+  /* ------------------------------------------------------------ */
+  console.log("easter eggs: toasts and the background flag");
+  for (const [word, expected] of [["dinosaur", "Dino game unlocked! Click the T-Rex button anytime to play!"], ["t-rex", "Dino game unlocked! Click the T-Rex button anytime to play!"], ["pacman", "Pac-Man game unlocked! Click the Pac-Man button anytime to play!"], ["pac-man", "Pac-Man game unlocked! Click the Pac-Man button anytime to play!"]]) {
+    await t(`typing "${word}" shows the plain-text toast (no emoji, no icon)`, () => withApp({}, async app => {
+      await app.send(word);
+      const toasts = app.toasts();
+      assert.deepStrictEqual(toasts, [expected]);
+      assert(!/[<>]/.test(toasts[0]) && !/\p{Extended_Pictographic}/u.test(toasts[0]), "no markup, no emoji");
+    }));
+  }
+  await t("the background flag follows the background button, on <html> and <body>", () => withApp({}, async app => {
+    const flagged = () => [app.w.document.documentElement, app.w.document.body].map(e => e.classList.contains("bg-on"));
+    assert.deepStrictEqual(flagged(), [false, false]);
+    const btn = [...app.w.document.querySelectorAll("#header-btns button")].find(b => b.title === "Toggle background");
+    btn.click(); await app.sleep(20);
+    assert.deepStrictEqual(flagged(), [true, true]); assert.strictEqual(app.$("#bg-layer").style.display, "block");
+    btn.click(); await app.sleep(20);
+    assert.deepStrictEqual(flagged(), [false, false]); assert.strictEqual(app.$("#bg-layer").style.display, "none");
+  }));
+  await t("a saved 'background on' is flagged from the first moment the page loads", () => withApp({ storage: { agent1102_easter: "true" } }, async app => {
+    assert(app.w.document.body.classList.contains("bg-on") && app.w.document.documentElement.classList.contains("bg-on"));
+  }));
+
+  /* ------------------------------------------------------------ */
+  console.log("colours in style.css (read from the real stylesheet)");
+  await t("text highlight is the app's blue with white text, in every browser engine", () => {
+    for (const sel of ["::selection", "::-moz-selection"]) {
+      const r = rulesFor(sel)[0];
+      assert(r, sel + " has a rule");
+      assert.strictEqual(r.decl.background, "var(--accent)"); assert(/^#fff(fff)?$/i.test(r.decl.color));
+    }
+    const accent = /--accent:\s*(#[0-9a-f]{6})/i.exec(CSS)[1];
+    const [r, g, b] = [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16));
+    assert(b > r + 60 && b > g + 40, accent + " is a blue");
+    assert(contrast("#ffffff", accent) >= 4.5, "white text on the highlight is readable");
+  });
+  await t("light theme, background OFF: replies use the light theme's dark text", () => {
+    const light = rulesFor(".light").find(r => r.decl["--text"]);
+    assert(lum(light.decl["--text"]) < 0.05, "dark text: " + light.decl["--text"]);
+    // nothing outside the bg-on rules turns reply text white in light mode
+    RULES.filter(r => r.selectors.some(s => /^\.light(?!\.bg-on)\b/.test(s) && /\.(ai-text|msg-wrap)/.test(s)))
+      .forEach(r => { ["--text", "color"].forEach(p => { if (r.decl[p] && /^#[0-9a-f]{3,6}$/i.test(r.decl[p])) assert(lum(r.decl[p]) < 0.5, r.selectors.join() + " " + p); }); });
+  });
+  await t("light theme, background ON: replies switch to the dark theme's white text and dark surfaces", () => {
+    const on = rulesFor(".light.bg-on .msg-wrap.ai")[0];
+    assert(on, "the bg-on rule exists");
+    assert(lum(on.decl["--text"]) > 0.85, "white-ish text: " + on.decl["--text"]);
+    assert(lum(on.decl["--text-muted"]) > 0.55, "muted text still light");
+    assert(lum(on.decl["--surface"]) < 0.05 && lum(on.decl["--surface2"]) < 0.05, "surfaces are dark so white text stays readable on them");
+    assert(contrast(on.decl["--text"], on.decl["--surface"]) >= 12);
+    // the backdrop itself is near black, which is the whole reason for white text
+    const dark = rulesFor(":root")[0].decl;
+    assert(lum(dark["--text"]) > 0.7, "the dark theme also uses light text");
+  });
+  await t("every hard-coded light-theme colour used inside a reply has a matching background-ON override", () => {
+    const parts = /\.(ai-text|msg-content-body|chart-block|chart-error-msg|study-block|math-error|mathviz-block|mv-inline|code-block|link-card)\b/;
+    const needed = [];
+    RULES.forEach(r => r.selectors.forEach(s => { const m = /^\.light (?!\.bg-on)(.+)$/.exec(s); if (m && parts.test(m[1])) needed.push(m[1]); }));
+    assert(needed.length >= 8, "found the light rules: " + needed.join(" | "));
+    needed.forEach(rest => assert(RULES.some(r => r.selectors.some(s => s === ".light.bg-on " + rest || s === ".light.bg-on .msg-wrap.ai " + rest)), "no bg-on override for: .light " + rest));
+  });
+  await t("the header, message box and your own bubbles are NOT given the white-text rule (they stay light surfaces)", () => {
+    RULES.forEach(r => r.selectors.forEach(s => { if (/\.bg-on/.test(s)) assert(/\.(msg-wrap\.ai|ai-text|msg-content-body|chart-|study-|math-|mathviz|mv-inline|web-image)/.test(s), "bg-on rule reaches outside replies: " + s); }));
+  });
+
+  /* ------------------------------------------------------------ */
+  console.log("/photos: pictures from the web");
+  await t("/photos <words> shows a gallery; nothing is sent to the AI; the request is signed in and carries the search", () => withApp({ routes: { "/web-images": b => IMAGES(b.query) } }, async app => {
+    await app.send("/photos golden gate bridge");
+    const req = app.calls.find(c => c.path === "/web-images");
+    assert.deepStrictEqual(req.body, { query: "golden gate bridge" });
+    assert(/^Bearer \S+/.test(req.headers.Authorization));
+    assert(!app.calls.some(c => c.path === "/chat"), "this never goes to the AI");
+    assert.strictEqual(app.$("#input").value, "");
+    assert([...app.w.document.querySelectorAll(".msg-wrap.user .msg-text")].some(n => n.textContent === "/photos golden gate bridge"));
+    assert.strictEqual(app.$(".web-gallery-head").textContent, "Pictures from the web for \u201cgolden gate bridge\u201d");
+    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 2, "the http:// picture is dropped");
+    app.w.document.querySelectorAll(".web-image img").forEach(img => {
+      assert(img.src.startsWith("https://")); assert.strictEqual(img.getAttribute("referrerpolicy"), "no-referrer"); assert.strictEqual(img.getAttribute("loading"), "lazy");
+    });
+    const links = [...app.w.document.querySelectorAll(".web-gallery a")];
+    links.forEach(a => { assert.strictEqual(a.target, "_blank"); assert(/noopener/.test(a.rel)); assert(/^https:/.test(a.href), a.href); });
+    assert(!app.$(".web-gallery a[href^='javascript']"), "a javascript: link is never created");
+    assert(/credit and licence/.test(app.$(".web-gallery-note").textContent) && /Wikimedia Commons/.test(app.$(".web-gallery-note").textContent));
+  }));
+  await t("the result is saved on the chat, and a follow-up question shows the AI a plain text list (never the gallery data)", () => withApp({
+    routes: { "/web-images": b => IMAGES(b.query), "/chat": () => ({ status: 500, json: { error: "not needed" } }) },
+  }, async app => {
+    await app.send("/photos golden gate bridge");
+    const entry = app.peek("history").pop();
+    assert.strictEqual(entry.role, "assistant");
+    assert(entry.webImages && entry.webImages.query === "golden gate bridge");
+    assert(/^Pictures from the web for "golden gate bridge" \(via Wikimedia Commons\):/.test(entry.content));
+    assert(entry.content.includes("1. [Golden Gate](https://commons.wikimedia.org/wiki/File:A.jpg) (commons.wikimedia.org)"), entry.content);
+    await app.sleep(100);
+    const saved = app.calls.filter(c => c.path === "/chats" && c.method === "POST").pop();
+    assert(saved && saved.body.history.pop().webImages.images.length === 3, "the chat is saved with its gallery data");
+    await app.send("which one is the best?");
+    const asked = app.calls.filter(c => c.path === "/chat").pop();
+    const seen = asked.body.messages.find(m => m.role === "assistant" && /^Pictures from the web/.test(m.content));
+    assert(seen, "the AI can see what was shown");
+    assert.deepStrictEqual(Object.keys(seen).sort(), ["content", "role"], "only role + content go to the server");
+  }));
+  await t("a saved chat reopens with its gallery; without the saved data the same message is just a text list", () => withApp({}, async app => {
+    const saved = IMAGES("tower").json;
+    const content = app.w.agent1102Render.webImagesText(saved);
+    app.w.addHistoryMsg({ role: "assistant", content, webImages: saved }, 1);
+    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 2);
+    app.w.document.getElementById("chat").innerHTML = "";
+    app.w.addHistoryMsg({ role: "assistant", content }, 1);
+    assert.strictEqual(app.w.document.querySelectorAll("#chat .web-image, #chat img").length, 0, "no pictures without the data");
+    assert(/Golden Gate/.test(app.$(".ai-text").textContent));
+  }));
+  await t("an AI reply can NOT make the page load a picture: fake galleries and markdown images stay as text/links", () => withApp({}, async app => {
+    const sneaky = '```webimages\n{"images":[{"thumb":"https://evil.example/p.png"}]}\n```\n\n![x](https://evil.example/q.png?secret=1)\n\n<img src="https://evil.example/r.png">';
+    app.w.addMsg("ai", sneaky);
+    assert.strictEqual(app.w.document.querySelectorAll('img[src*="evil.example"]').length, 0);
+    assert.strictEqual(app.w.document.querySelectorAll(".web-gallery, .web-image").length, 0);
+    // and passing gallery data through the 5th argument does not work for user messages either
+    app.w.addMsg("user", "hi", null, undefined, { webImages: IMAGES("x").json });
+    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 0);
+  }));
+  await t("/photos with nothing after it explains itself; a search with no results, a refusal and an outage each say so", () => {
+    let mode = "ok";
+    return withApp({ routes: { "/web-images": b => mode === "none" ? { status: 200, json: { query: b.query, images: [] } } : mode === "refuse" ? { status: 400, json: { error: "I can't search for pictures of that." } } : mode === "down" ? { status: 502, json: { error: "The picture search isn't working right now. Please try again in a moment." } } : IMAGES(b.query) } }, async app => {
+      const lastAi = () => [...app.w.document.querySelectorAll(".msg-wrap.ai .ai-text")].pop().textContent;
+      await app.send("/photos");
+      assert(/What should I look for\? For example: \/photos golden gate bridge/.test(lastAi()));
+      assert(!app.calls.some(c => c.path === "/web-images"), "no request for an empty search");
+      mode = "none"; await app.send("/photos zzzz");
+      assert(/couldn't find any pictures for zzzz/.test(lastAi()));
+      mode = "refuse"; await app.send("/photos something");
+      assert.strictEqual(lastAi().trim(), "I can't search for pictures of that.");
+      mode = "down"; await app.send("/pics eiffel tower");
+      assert(/isn't working right now/.test(lastAi()));
+      assert.deepStrictEqual(app.calls.filter(c => c.path === "/web-images").pop().body, { query: "eiffel tower" }, "/pics is the same command");
+    });
+  });
+  await t("Try again runs the search again and replaces the gallery", () => withApp({ routes: { "/web-images": b => IMAGES(b.query) } }, async app => {
+    await app.send("/photos golden gate bridge");
+    app.$(".msg-wrap.ai:last-of-type .retry-btn").click();
+    await app.sleep(200);
+    assert.strictEqual(app.calls.filter(c => c.path === "/web-images").length, 2);
+    assert.strictEqual(app.w.document.querySelectorAll(".web-gallery-block").length, 1, "still one gallery, not two");
+    assert.strictEqual(app.peek("history.length"), 3, "greeting + your command + one result");
+  }));
+  await t("a picture that won't load disappears; if none load, the gallery says so", () => withApp({ routes: { "/web-images": b => IMAGES(b.query) } }, async app => {
+    await app.send("/photos golden gate bridge");
+    const imgs = [...app.w.document.querySelectorAll(".web-image img")];
+    imgs[0].dispatchEvent(new app.w.Event("error"));
+    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 1);
+    imgs[1].dispatchEvent(new app.w.Event("error"));
+    assert.strictEqual(app.w.document.querySelectorAll(".web-image").length, 0);
+    assert(/None of those pictures would load/.test(app.$(".web-gallery-head").textContent));
+  }));
+  await t("the command is in the / menu, has aliases, /help explains it, and /image (create) is unaffected", () => withApp({}, async app => {
+    const C = app.w.agent1102Commands, R = app.w.agent1102Render;
+    const cmd = C.COMMANDS.find(c => c.name === "photos");
+    assert(cmd && cmd.group === "Search" && cmd.aliases.includes("pics") && cmd.aliases.includes("pictures"));
+    assert.deepStrictEqual(plain(C.parseWebImages("/photos golden gate bridge")), { query: "golden gate bridge" });
+    assert.deepStrictEqual(plain(C.parseWebImages("/Pictures of the eiffel tower")), { query: "the eiffel tower" });
+    assert.deepStrictEqual(plain(C.parseWebImages("/pics   cats  ")), { query: "cats" });
+    assert.deepStrictEqual(plain(C.parseWebImages("/photos")), { query: "" });
+    assert.strictEqual(C.parseWebImages("/image a cat"), null); assert.strictEqual(C.parseWebImages("show me photos of cats"), null);
+    assert.strictEqual(R.parseImageRequest("/photos golden gate bridge"), null, "never mistaken for 'create an image'");
+    assert(R.parseImageRequest("/image a cat"), "/image still creates pictures");
+    assert(/\/photos/.test(C.helpMarkdown()));
+  }));
+
+  /* ------------------------------------------------------------ */
+  console.log("download all files (.zip)");
+  const SITE = [
+    "Here is your site.", "", "**index.html**", "```html", "<!doctype html><title>Café</title><link rel=\"stylesheet\" href=\"style.css\">", "```", "",
+    "Save this as `style.css`:", "```css", "body { color: red; }", "```", "",
+    "```js title=\"src/app.js\"", "console.log('héllo ✓');", "```", "",
+    "```python", "# server.py", "print('hi')", "```", "",
+    "Install first:", "```bash", "npm install", "```", "",
+    "```chart", "{\"type\":\"bar\"}", "```",
+  ].join("\n");
+  await t("a reply with several files gets a button; the .zip holds each file under a sensible name, byte for byte", () => withApp({}, async app => {
+    app.w.addMsg("ai", SITE);
+    const btn = app.$('button[title^="Download all"]');
+    assert(btn, "the button is there"); assert.strictEqual(btn.title, "Download all 4 files (.zip)");
+    btn.click();
+    assert(/^agent1102-files-\d{8}-\d{6}\.zip$/.test(app.w.__lastDownload.name), app.w.__lastDownload.name);
+    const files = readZip(await blobBytes(app.w, app.w.__lastBlob));
+    assert.deepStrictEqual(Object.keys(files).sort(), ["index.html", "src/app.js", "server.py", "style.css"].sort());
+    assert.strictEqual(files["index.html"], "<!doctype html><title>Café</title><link rel=\"stylesheet\" href=\"style.css\">\n");
+    assert.strictEqual(files["src/app.js"], "console.log('héllo ✓');\n");
+    assert.strictEqual(files["style.css"], "body { color: red; }\n");
+    assert.strictEqual(files["server.py"], "# server.py\nprint('hi')\n");
+  }));
+  await t("python's own zip reader and `unzip` agree the file is valid (when they're installed)", () => withApp({}, async app => {
+    app.w.addMsg("ai", SITE); app.$('button[title^="Download all"]').click();
+    const file = path.join(require("os").tmpdir(), "agent1102-test-" + process.pid + ".zip");
+    fs.writeFileSync(file, await blobBytes(app.w, app.w.__lastBlob));
+    const py = spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(len(z.namelist()))", file], { encoding: "utf8" });
+    if (!py.error) { assert.strictEqual(py.status, 0, py.stderr); assert.strictEqual(py.stdout.trim(), "4"); } else console.log("       (python3 not installed: skipped)");
+    const un = spawnSync("unzip", ["-tq", file], { encoding: "utf8" });
+    if (!un.error) assert.strictEqual(un.status, 0, un.stdout + un.stderr); else console.log("       (unzip not installed: skipped)");
+    fs.unlinkSync(file);
+  }));
+  await t("no button for a single file, for shell commands, or for a reply with no code", () => withApp({}, async app => {
+    const has = () => !!app.$('button[title^="Download all"]');
+    app.w.addMsg("ai", "```js\nconsole.log(1)\n```"); assert(!has(), "one file");
+    app.w.addMsg("ai", "```js\nconsole.log(1)\n```\n\n```bash\nnpm install\n```\n\n```bash\nnpm start\n```"); assert(!has(), "one file + two commands");
+    app.w.addMsg("ai", "Just words, and a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |"); assert(!has());
+    app.w.addMsg("ai", "```js\na()\n```\n\n```css\nb{}\n```"); assert(has(), "two unnamed files still count");
+  }));
+  await t("file names: from the code block's label, its first line, or the line above it; tool names like Node.js are not file names", () => withApp({}, async app => {
+    const names = md => plain(app.w.agent1102Zip.extractFiles(md, l => ({ js: "js", html: "html", css: "css", python: "py", json: "json" })[l]).map(f => f.name));
+    assert.deepStrictEqual(names("```html index.html\n<p>1</p>\n```\n```js:src/a.js\nx\n```\n```index2.html\n<p>2</p>\n```"), ["index.html", "src/a.js", "index2.html"]);
+    assert.deepStrictEqual(names("```css\n/* theme.css */\na{}\n```\n```html\n<!-- page.html -->\n<p>x</p>\n```\n```python\n# filename: tool.py\nx=1\n```"), ["theme.css", "page.html", "tool.py"]);
+    assert.deepStrictEqual(names("### config.json\n```json\n{\"a\":1}\n```\n1. `main.js`:\n```js\nm()\n```\nFile: other.css\n```css\no{}\n```"), ["config.json", "main.js", "other.css"]);
+    assert.deepStrictEqual(names("Here is a Node.js example:\n```js\nx()\n```\nand `Array.map` works:\n```js\ny()\n```"), ["file-1.js", "file-2.js"]);
+    assert.deepStrictEqual(names("**a.js**\n```js\n1\n```\n```js\n2\n```"), ["a.js", "file-2.js"], "one label names only the block right under it");
+    assert.deepStrictEqual(names("```js title=\"a.js\"\n1\n```\n```js title=\"a.js\"\n2\n```\n```js title=\"a.js\"\n1\n```"), ["a.js", "a-2.js"], "same name twice gets a number; an identical repeat is skipped");
+    assert.deepStrictEqual(names("```text .gitignore\nnode_modules\n```\n```text .gitignore\nother\n```"), [".gitignore", ".gitignore-2"]);
+    const nested = plain(app.w.agent1102Zip.extractFiles("````md\n```js\ninner()\n```\n````\n```js\nouter()\n```\n```js\nouter2()\n```", l => ({ js: "js", md: "md" })[l]));
+    assert.deepStrictEqual(nested.map(f => f.name), ["file-1.md", "file-2.js", "file-3.js"], "the inner fence belongs to the markdown file, not a separate file");
+    assert.strictEqual(nested[0].content, "```js\ninner()\n```\n");
+  }));
+  await t("file names can never escape the zip: no .., no leading /, no drive letters, no control characters", () => withApp({}, async app => {
+    const names = md => plain(app.w.agent1102Zip.extractFiles(md, () => "txt").map(f => f.name));
+    const out = names(['```js title="../../etc/passwd.js"', "a", "```", '```js title="/etc/cron.d/x.js"', "b", "```", '```js title="C:\\\\win\\\\evil.js"', "c", "```", '```js title="a/../../b.js"', "d", "```'"].join("\n"));
+    assert(out.length >= 3, out.join());
+    out.forEach(n => { assert(!n.split("/").includes(".."), n); assert(!n.startsWith("/"), n); assert(!/[:\\\u0000-\u001f]/.test(n), n); });
+    assert.deepStrictEqual(out.slice(0, 2), ["etc/passwd.js", "etc/cron.d/x.js"]);
+  }));
+
+  console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
+  process.exit(process.exitCode || 0);
+})();
diff --git a/backend/test/integration.test.js b/backend/test/integration.test.js
index 0c1854a..1acebf9 100644
--- a/backend/test/integration.test.js
+++ b/backend/test/integration.test.js
@@ -45,6 +45,19 @@ const groqServer = http.createServer((req, res) => {
   });
 });
 
+// ---------- fake Wikimedia Commons (the keyless picture search) ----------
+const COMMONS_PORT = 4103;
+const commonsCalls = [];
+let commonsMode = "ok";
+const commonsServer = http.createServer((req, res) => {
+  commonsCalls.push(new URL(req.url, "http://x").searchParams.get("gsrsearch"));
+  if (commonsMode === "error") { res.writeHead(500); return res.end("down"); }
+  res.writeHead(200, { "Content-Type": "application/json" });
+  res.end(JSON.stringify({ query: { pages: commonsMode === "empty" ? [] : [
+    { title: "File:Golden_Gate.jpg", index: 1, imageinfo: [{ mime: "image/jpeg", url: "https://upload.wikimedia.org/gg.jpg", thumburl: "https://upload.wikimedia.org/thumb/gg.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Golden_Gate.jpg" }] },
+  ] } }));
+});
+
 // ---------- fake Supabase ----------
 let memories = [], adminUpdates = [], memoryTableMissing = false;
 const sbServer = http.createServer((req, res) => {
@@ -104,10 +117,10 @@ let passed = 0;
 async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e && e.message)); process.exitCode = 1; } }
 
 (async () => {
-  await listen(groqServer, GROQ_PORT); await listen(sbServer, SB_PORT);
+  await listen(groqServer, GROQ_PORT); await listen(sbServer, SB_PORT); await listen(commonsServer, COMMONS_PORT);
   const server = spawn("node", ["server.js"], {
     cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
-    env: { ...process.env, RATE_LIMIT_SCALE: "1000", PORT: APP_PORT, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "service", GROQ_API_KEY: "k", GROQ_API_URL: `http://127.0.0.1:${GROQ_PORT}/v1/chat/completions`, SITE_URL: `http://127.0.0.1:${APP_PORT}`, TAVILY_API_KEY: "", BRAVE_API_KEY: "", MEMORY_EXTRACT_GAP_MS: "400" },
+    env: { ...process.env, RATE_LIMIT_SCALE: "1000", PORT: APP_PORT, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_KEY: "service", GROQ_API_KEY: "k", GROQ_API_URL: `http://127.0.0.1:${GROQ_PORT}/v1/chat/completions`, SITE_URL: `http://127.0.0.1:${APP_PORT}`, TAVILY_API_KEY: "", BRAVE_API_KEY: "", COMMONS_API_URL: `http://127.0.0.1:${COMMONS_PORT}/w/api.php`, MEMORY_EXTRACT_GAP_MS: "400" },
   });
   let serverLog = ""; server.stdout.on("data", d => serverLog += d); server.stderr.on("data", d => serverLog += d);
   for (let i = 0; i < 50; i++) { try { if ((await call("GET", "/ping")).ok) break; } catch (_) {} await sleep(100); }
@@ -315,7 +328,7 @@ async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " +
     assert.strictEqual((await send("POST", "/chats", { body: { id: "c1", title: "x", history: [], token: FORGED } })).status, 401, "token in the body too");
   });
   await t("study, graph, title, images, read-aloud and link previews need a real sign-in", async () => {
-    const routes = [["POST", "/study"], ["POST", "/graph"], ["POST", "/title"], ["POST", "/generate-image"], ["POST", "/edit-image"], ["POST", "/tts"], ["GET", "/link-preview?url=https://example.com"]];
+    const routes = [["POST", "/study"], ["POST", "/graph"], ["POST", "/title"], ["POST", "/generate-image"], ["POST", "/edit-image"], ["POST", "/web-images"], ["POST", "/tts"], ["GET", "/link-preview?url=https://example.com"]];
     for (const [method, p] of routes) {
       const none = await send(method, p, method === "POST" ? { body: {} } : {});
       assert.strictEqual(none.status, 401, p + " with no token");
@@ -331,6 +344,33 @@ async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " +
     const title = await send("POST", "/title", { token: TOKEN, body: { messages: [] } });
     assert.notStrictEqual(title.status, 401);
   });
+  await t("/web-images: finds pictures with no API key (Wikimedia Commons), https links only", async () => {
+    commonsCalls.length = 0; commonsMode = "ok";
+    const r = await send("POST", "/web-images", { token: TOKEN, body: { query: "  golden   gate bridge " } });
+    assert.strictEqual(r.status, 200);
+    const j = await r.json();
+    assert.strictEqual(j.query, "golden gate bridge"); assert.strictEqual(j.provider, "Wikimedia Commons");
+    assert.deepStrictEqual(j.images, [{ title: "Golden Gate", thumb: "https://upload.wikimedia.org/thumb/gg.jpg", url: "https://upload.wikimedia.org/gg.jpg", page: "https://commons.wikimedia.org/wiki/File:Golden_Gate.jpg", source: "commons.wikimedia.org" }]);
+    assert.strictEqual(commonsCalls[0], "filetype:bitmap golden gate bridge");
+  });
+  await t("/web-images: asks for a search term, refuses blocked searches, says so when nothing is found or the search is down", async () => {
+    const before = commonsCalls.length;
+    for (const body of [{}, { query: "" }, { query: " a " }, { query: 42 }]) {
+      const r = await send("POST", "/web-images", { token: TOKEN, body });
+      assert.strictEqual(r.status, 400, JSON.stringify(body));
+      assert(/What should I look for/.test((await r.json()).error));
+    }
+    const blocked = await send("POST", "/web-images", { token: TOKEN, body: { query: "nude photos" } });
+    assert.strictEqual(blocked.status, 400); assert(/can't search/.test((await blocked.json()).error));
+    assert.strictEqual(commonsCalls.length, before, "nothing was sent to the search for these");
+    commonsMode = "empty";
+    const none = await send("POST", "/web-images", { token: TOKEN, body: { query: "zzz nothing at all" } });
+    assert.strictEqual(none.status, 200); assert.deepStrictEqual((await none.json()).images, []);
+    commonsMode = "error";
+    const down = await send("POST", "/web-images", { token: TOKEN, body: { query: "search is down now" } });
+    assert.strictEqual(down.status, 502); assert(/isn't working right now/.test((await down.json()).error));
+    commonsMode = "ok";
+  });
   await t("every response carries the browser security headers", async () => {
     const r = await fetch(BASE + "/ping");
     const csp = r.headers.get("content-security-policy") || "";
@@ -389,7 +429,7 @@ async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " +
   });
 
   server.kill();
-  groqServer.close(); sbServer.close();
+  groqServer.close(); sbServer.close(); commonsServer.close();
   console.log(`\n${passed} passed${process.exitCode ? ", SOME FAILED" : ""}`);
   if (process.exitCode) console.log("--- server log ---\n" + serverLog.slice(-1500));
   process.exit(process.exitCode || 0);
diff --git a/backend/test/run-all.js b/backend/test/run-all.js
index 16e3404..7a49736 100644
--- a/backend/test/run-all.js
+++ b/backend/test/run-all.js
@@ -4,7 +4,7 @@
 const { spawnSync } = require("child_process");
 const path = require("path");
 
-const suites = ["unit", "integration", "client"];
+const suites = ["unit", "integration", "client", "app"];
 const failed = [];
 for (const name of suites) {
   console.log(`\n===== ${name} tests =====`);
diff --git a/backend/test/unit.test.js b/backend/test/unit.test.js
index 6cf0d90..c534af7 100644
--- a/backend/test/unit.test.js
+++ b/backend/test/unit.test.js
@@ -240,6 +240,111 @@ async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " +
     assert(!("Strict-Transport-Security" in plain), "no HSTS over plain http");
   });
 
+  console.log("finding pictures on the web (lib/imagesearch.js)");
+  const http = require("http");
+  const img = require("../lib/imagesearch");
+  // one fake server stands in for Brave, Tavily and Wikimedia Commons; `seen` records what was asked of it
+  const seen = [];
+  let behaviour = {};
+  const fake = http.createServer((req, res) => {
+    let raw = ""; req.on("data", d => raw += d); req.on("end", () => {
+      const url = new URL(req.url, "http://x");
+      seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : null });
+      const mode = behaviour[url.pathname];
+      if (mode === "error") { res.writeHead(500); return res.end("nope"); }
+      if (mode === "empty") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(url.pathname === "/brave" ? '{"results":[]}' : url.pathname === "/tavily" ? '{"images":[]}' : '{"query":{"pages":[]}}'); }
+      res.writeHead(200, { "Content-Type": "application/json" });
+      if (url.pathname === "/brave") return res.end(JSON.stringify({ results: [
+        { title: "Bridge <b>one</b>", thumbnail: { src: "https://imgs.search.brave.com/t1" }, properties: { url: "https://site.example/full1.jpg" }, url: "https://site.example/page1", source: "site.example" },
+        { title: "Insecure", thumbnail: { src: "http://imgs.search.brave.com/t2" }, properties: { url: "http://site.example/full2.jpg" }, url: "http://site.example/page2", source: "site.example" },
+        { title: "Dup", thumbnail: { src: "https://imgs.search.brave.com/t1" }, properties: { url: "https://site.example/full1.jpg" }, url: "https://site.example/page1", source: "site.example" },
+        { title: "No thumb", properties: { url: "https://site.example/full3.jpg" } },
+      ] }));
+      if (url.pathname === "/tavily") return res.end(JSON.stringify({ images: ["https://cdn.example/a.jpg", { url: "https://cdn.example/b.jpg", description: "A described picture" }, { url: "javascript:alert(1)" }] }));
+      res.end(JSON.stringify({ query: { pages: [
+        { title: "File:Second_best.png", index: 2, imageinfo: [{ mime: "image/png", url: "https://upload.wikimedia.org/s.png", thumburl: "https://upload.wikimedia.org/thumb/s.png", descriptionurl: "https://commons.wikimedia.org/wiki/File:Second_best.png" }] },
+        { title: "File:Best.jpg", index: 1, imageinfo: [{ mime: "image/jpeg", url: "https://upload.wikimedia.org/b.jpg", thumburl: "https://upload.wikimedia.org/thumb/b.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Best.jpg" }] },
+        { title: "File:Scan.pdf", index: 3, imageinfo: [{ mime: "application/pdf", url: "https://upload.wikimedia.org/x.pdf" }] },
+        { title: "File:Clip.ogv", index: 4, imageinfo: [{ mime: "video/ogg", url: "https://upload.wikimedia.org/x.ogv" }] },
+      ] } }));
+    });
+  });
+  await new Promise(r => fake.listen(4193, "127.0.0.1", r));
+  Object.assign(process.env, { BRAVE_IMAGES_URL: "http://127.0.0.1:4193/brave", TAVILY_API_URL: "http://127.0.0.1:4193/tavily", COMMONS_API_URL: "http://127.0.0.1:4193/commons", BRAVE_API_KEY: "", TAVILY_API_KEY: "" });
+  const reset = (b = {}) => { seen.length = 0; behaviour = b; };
+
+  await t("with no keys it uses Wikimedia Commons: best match first, only real pictures, a polite User-Agent, nice titles", async () => {
+    reset();
+    const r = await img.searchImages("commons only one");
+    assert.strictEqual(r.provider, "commons"); assert.strictEqual(r.label, "Wikimedia Commons");
+    assert.deepStrictEqual(r.images.map(i => i.title), ["Best", "Second best"], "pdf and video are left out, sorted by rank, File: and extension removed");
+    assert.strictEqual(r.images[0].thumb, "https://upload.wikimedia.org/thumb/b.jpg");
+    assert.strictEqual(r.images[0].url, "https://upload.wikimedia.org/b.jpg");
+    assert.strictEqual(r.images[0].page, "https://commons.wikimedia.org/wiki/File:Best.jpg");
+    assert.strictEqual(r.images[0].source, "commons.wikimedia.org");
+    assert(/filetype:bitmap commons only one/.test(seen[0].query.gsrsearch));
+    assert(/agent1102/.test(seen[0].headers["user-agent"]), "Wikimedia asks every client to identify itself");
+  });
+  await t("with a Brave key it asks Brave first, with strict safe-search, and uses Brave's proxied thumbnails", async () => {
+    reset(); process.env.BRAVE_API_KEY = "brave-key";
+    const r = await img.searchImages("brave first one");
+    process.env.BRAVE_API_KEY = "";
+    assert.strictEqual(r.provider, "brave");
+    assert.strictEqual(seen.length, 1, "no need to ask anyone else");
+    assert.strictEqual(seen[0].headers["x-subscription-token"], "brave-key");
+    assert.strictEqual(seen[0].query.safesearch, "strict");
+    assert.strictEqual(r.images.length, 1, "http:// pictures, repeats and entries without a thumbnail are dropped");
+    assert.deepStrictEqual(r.images[0], { title: "Bridge one", thumb: "https://imgs.search.brave.com/t1", url: "https://site.example/full1.jpg", page: "https://site.example/page1", source: "site.example" }, "HTML tags are removed from titles");
+  });
+  await t("Tavily's two image shapes both work, and a javascript: address is never passed on", async () => {
+    reset(); process.env.TAVILY_API_KEY = "tav-key";
+    const r = await img.searchImages("tavily shapes one");
+    process.env.TAVILY_API_KEY = "";
+    assert.strictEqual(r.provider, "tavily");
+    assert.strictEqual(seen[0].body.include_images, true); assert.strictEqual(seen[0].body.include_image_descriptions, true);
+    assert.strictEqual(seen[0].headers.authorization, "Bearer tav-key");
+    assert.deepStrictEqual(r.images.map(i => [i.title, i.thumb]), [["", "https://cdn.example/a.jpg"], ["A described picture", "https://cdn.example/b.jpg"]]);
+    assert.strictEqual(r.images[0].source, "cdn.example");
+  });
+  await t("a provider that fails, or finds nothing, hands over to the next one (Brave -> Tavily -> Commons)", async () => {
+    reset({ "/brave": "error", "/tavily": "empty" }); Object.assign(process.env, { BRAVE_API_KEY: "k", TAVILY_API_KEY: "k" });
+    const r = await img.searchImages("fallback chain one");
+    Object.assign(process.env, { BRAVE_API_KEY: "", TAVILY_API_KEY: "" });
+    assert.strictEqual(r.provider, "commons");
+    assert.deepStrictEqual(seen.map(s => s.path), ["/brave", "/tavily", "/commons"]);
+    assert.strictEqual(r.failed, false);
+  });
+  await t("nothing found is not an error, but every provider failing is", async () => {
+    reset({ "/commons": "empty" });
+    const none = await img.searchImages("nothing here one");
+    assert.deepStrictEqual([none.images.length, none.failed], [0, false]);
+    reset({ "/commons": "error" });
+    const broken = await img.searchImages("everything broken one");
+    assert.deepStrictEqual([broken.images.length, broken.failed], [0, true]);
+  });
+  await t("the same search twice is answered from memory; a failure is never remembered", async () => {
+    reset(); await img.searchImages("cache me please"); await img.searchImages("Cache me   please");
+    assert.strictEqual(seen.length, 1);
+    reset({ "/commons": "error" }); await img.searchImages("flaky one"); reset(); const ok = await img.searchImages("flaky one");
+    assert.strictEqual(ok.images.length, 2, "the next try asks again");
+  });
+  await t("too-short or blocked searches are refused before anything is sent", async () => {
+    reset();
+    assert.deepStrictEqual((await img.searchImages(" a ")).images, []);
+    assert.strictEqual(seen.length, 0);
+    ["nude photos", "NSFW pics", "porn", "hentai art", "xxx"].forEach(q => assert(img.isBlockedQuery(q), q));
+    ["golden gate bridge", "renaissance painting", "assess the damage", "Essex"].forEach(q => assert(!img.isBlockedQuery(q), q));
+  });
+  await t("normalize keeps only https, removes repeats, caps the count, and falls back to the thumbnail for the full-size link", () => {
+    const out = img.normalize([
+      { thumb: "https://a/1.jpg" }, { thumb: "https://a/1.jpg" }, { thumb: "ftp://a/2.jpg" }, { thumb: "not a url" },
+      { thumb: "https://a/3.jpg", full: "http://a/3-big.jpg", page: "javascript:x" }, { thumb: "https://a/4.jpg" },
+    ], 3);
+    assert.deepStrictEqual(out.map(i => i.thumb), ["https://a/1.jpg", "https://a/3.jpg", "https://a/4.jpg"]);
+    assert.strictEqual(out[1].url, "https://a/3.jpg"); assert.strictEqual(out[1].page, "");
+  });
+  fake.close();
+
   console.log(`\n${passed} passed, ${failed} failed`);
   process.exit(failed ? 1 : 0);
 })();