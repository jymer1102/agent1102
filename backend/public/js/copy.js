// ============================================================
//  Copying answers and tables the way people expect.
//  The reply is markdown underneath (**bold**, | tables |, `code`, \(math\)), but nobody wants those symbols
//  on their clipboard. Copying now puts TWO versions there and the place you paste picks the best one:
//    - rich text (real bold, headings, lists, links and real tables)  -> Word, Google Docs, Gmail, Notion, Excel
//    - clean plain text (no ** | # ` marks, tables as tab-separated columns, math as readable symbols) -> everything else
// ============================================================
(function () {
  "use strict";

  /* ---------------------------------------------------------- */
  /*  Math -> readable text (x^2 -> x², \frac{a}{b} -> a/b)      */
  /* ---------------------------------------------------------- */
  const zip = (from, to) => Object.fromEntries([...from].map((c, i) => [c, [...to][i]]));
  const SUP = { ...zip("0123456789+-=()abcdefghijklmnoprstuvwxyz", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ"), "−": "⁻" };
  const SUB = { ...zip("0123456789+-=()aehijklmnoprstuvx", "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"), "−": "₋" };

  const SYMBOLS = {
    // Greek
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
    iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
    phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
    // operators and relations (padded so "a \times b" stays "a × b")
    times: " × ", cdot: " · ", div: " ÷ ", pm: " ± ", mp: " ∓ ", ast: " ∗ ",
    leq: " ≤ ", le: " ≤ ", geq: " ≥ ", ge: " ≥ ", neq: " ≠ ", ne: " ≠ ", approx: " ≈ ", equiv: " ≡ ", sim: " ∼ ", propto: " ∝ ",
    ll: " ≪ ", gg: " ≫ ", cong: " ≅ ",
    rightarrow: " → ", to: " → ", leftarrow: " ← ", leftrightarrow: " ↔ ", Rightarrow: " ⇒ ", Leftarrow: " ⇐ ",
    Leftrightarrow: " ⇔ ", implies: " ⇒ ", iff: " ⇔ ", mapsto: " ↦ ", uparrow: "↑", downarrow: "↓",
    in: " ∈ ", notin: " ∉ ", subset: " ⊂ ", subseteq: " ⊆ ", supset: " ⊃ ", supseteq: " ⊇ ", cup: " ∪ ", cap: " ∩ ",
    forall: "∀", exists: "∃", neg: "¬", land: " ∧ ", lor: " ∨ ", wedge: " ∧ ", vee: " ∨ ",
    // big symbols and misc
    infty: "∞", partial: "∂", nabla: "∇", emptyset: "∅", varnothing: "∅", sum: "∑", prod: "∏", int: "∫", iint: "∬", oint: "∮",
    sqrt: "√", degree: "°", circ: "∘", angle: "∠", perp: " ⊥ ", parallel: " ∥ ", therefore: "∴", because: "∵", hbar: "ħ", ell: "ℓ",
    cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", ddots: "⋱", prime: "′", Re: "ℜ", Im: "ℑ", aleph: "ℵ",
    // spacing commands
    quad: " ", qquad: " ", displaystyle: "", textstyle: "", left: "", right: "", big: "", Big: "", bigg: "", Bigg: "",
    langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", lbrace: "{", rbrace: "}",
  };
  const FUNCS = "sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln lg exp lim limsup liminf max min sup inf det dim gcd lcm mod deg arg ker Pr".split(" ");
  const BLACKBOARD = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", H: "ℍ" };
  const TEXT_WRAPPERS = ["text", "textbf", "textit", "textrm", "mbox"]; // words: kept exactly as written, spaces included
  const WRAPPERS = ["mathrm", "mathbf", "mathit", "mathsf", "mathtt", "mathcal", "boldsymbol", "operatorname", "vec", "hat", "bar", "tilde",
    "overline", "underline", "overrightarrow", "boxed", "cancel", "dot", "ddot"];
  const ESCAPES = { "\\{": "\uE000", "\\}": "\uE001", "\\&": "\uE002", "\\%": "\uE003", "\\$": "\uE004", "\\#": "\uE005", "\\_": "\uE006" };
  const ESCAPED_BACK = { "\uE000": "{", "\uE001": "}", "\uE002": "&", "\uE003": "%", "\uE004": "$", "\uE005": "#", "\uE006": "_" };

  function matchBrace(s, open) {
    let depth = 0;
    for (let k = open; k < s.length; k++) {
      if (s[k] === "\\") { k++; continue; }
      if (s[k] === "{") depth++;
      else if (s[k] === "}" && --depth === 0) return k;
    }
    return -1;
  }

  // One LaTeX argument starting at s[i]: {group}, \command or a single character -> [text, indexAfter]
  function readArg(s, i) {
    while (s[i] === " ") i++;
    if (s[i] === "{") {
      const end = matchBrace(s, i);
      return end < 0 ? [s.slice(i + 1), s.length] : [s.slice(i + 1, end), end + 1];
    }
    if (s[i] === "\\") { const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i)); return m ? [m[0], i + m[0].length] : ["", i + 1]; }
    return [s[i] || "", i + 1];
  }

  function replaceCmd(s, name, argc, build) {
    const re = new RegExp("\\\\" + name + "(?![A-Za-z])", "g");
    let out = "", last = 0, m;
    while ((m = re.exec(s))) {
      let i = m.index + m[0].length;
      const args = [];
      for (let k = 0; k < argc; k++) { const [a, next] = readArg(s, i); args.push(a); i = next; }
      out += s.slice(last, m.index) + build(...args);
      last = i;
      re.lastIndex = i;
    }
    return out + s.slice(last);
  }

  const word = x => /^[\p{L}\p{N}.]+$/u.test(x);
  const wrap = x => word(x) ? x : "(" + x + ")";

  function scripts(s) {
    let out = "";
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (ch !== "^" && ch !== "_") { out += ch; i++; continue; }
      const [raw, next] = readArg(s, i + 1);
      const arg = scripts(raw).trim();
      const map = ch === "^" ? SUP : SUB;
      const mapped = [...arg].map(c => map[c]);
      out += arg && mapped.every(Boolean) ? mapped.join("") : ch + (arg.length > 1 ? "(" + arg + ")" : arg);
      i = next;
    }
    return out;
  }

  function chemistry(s) {
    return s.replace(/([A-Za-z)\]])(\d+)/g, (_, a, d) => a + [...d].map(c => SUB[c]).join(""))
      .replace(/<=>|<->/g, " ⇌ ").replace(/->/g, " → ");
  }

  function mathToText(tex) {
    let s = String(tex == null ? "" : tex);
    // escaped characters survive the cleanup below
    s = s.replace(/\\[{}&%$#_]/g, m => ESCAPES[m]);
    // matrices and aligned lines
    s = s.replace(/\\begin\{[pbvBV]?matrix\}([\s\S]*?)\\end\{[pbvBV]?matrix\}/g, (_, body) => "[" + body.replace(/\\\\/g, "; ").replace(/&/g, ", ").trim() + "]");
    s = s.replace(/\\begin\{[a-z*]+\}/g, "").replace(/\\end\{[a-z*]+\}/g, "").replace(/\\\\/g, "\n").replace(/&/g, " ");
    // commands that take arguments
    ["frac", "dfrac", "tfrac"].forEach(name => {
      s = replaceCmd(s, name, 2, (a, b) => wrap(mathToText(a)) + "/" + wrap(mathToText(b)));
    });
    s = s.replace(/\\sqrt\[([^\]]+)\]/g, (_, n) => "\\root{" + n + "}");
    s = replaceCmd(s, "root", 2, (n, x) => { const N = mathToText(n), X = mathToText(x); const sup = [...N].map(c => SUP[c]); return (sup.every(Boolean) ? sup.join("") : "^(" + N + ")") + "√" + wrap(X); });
    s = replaceCmd(s, "sqrt", 1, x => { const X = mathToText(x); return "√" + (word(X) ? X : "(" + X + ")"); });
    s = replaceCmd(s, "ce", 1, x => chemistry(mathToText(x)));
    s = replaceCmd(s, "mathbb", 1, x => [...x].map(c => BLACKBOARD[c] || c).join(""));
    TEXT_WRAPPERS.forEach(w => { s = replaceCmd(s, w, 1, x => x); });
    WRAPPERS.forEach(w => { s = replaceCmd(s, w, 1, x => mathToText(x)); });
    // symbols, then function names, then whatever commands are left
    s = s.replace(/\\([A-Za-z]+) ?/g, (whole, name) => Object.prototype.hasOwnProperty.call(SYMBOLS, name) ? SYMBOLS[name] : whole);
    s = s.replace(new RegExp("\\\\(" + FUNCS.join("|") + ")(?![A-Za-z])", "g"), "$1");
    s = s.replace(/\\[,;:!> ]/g, " ").replace(/\\([A-Za-z]+)/g, "$1");
    s = scripts(s);
    s = s.replace(/[{}]/g, "").replace(/[\uE000-\uE006]/g, c => ESCAPED_BACK[c]);
    return s.replace(/[ \t]+/g, " ").replace(/ ([,;])/g, "$1").replace(/ ?\n ?/g, "\n").trim();
  }

  /* ---------------------------------------------------------- */
  /*  Rendered DOM -> plain text                                 */
  /* ---------------------------------------------------------- */
  const BLOCK = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "TABLE", "HR", "SECTION",
    "ARTICLE", "FIGURE", "DL", "DT", "DD", "THEAD", "TBODY", "TFOOT", "TR"]);
  const supText = s => { const m = [...s].map(c => SUP[c]); return s && m.every(Boolean) ? m.join("") : "^(" + s + ")"; };
  const subText = s => { const m = [...s].map(c => SUB[c]); return s && m.every(Boolean) ? m.join("") : "_(" + s + ")"; };

  function inlineOf(nodes) {
    let out = "";
    for (const c of nodes) {
      if (c.nodeType === 3) { out += c.nodeValue.replace(/\s+/g, " "); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (c.hasAttribute("data-tex")) out += mathToText(c.getAttribute("data-tex"));
      else if (t === "BR") out += "\n";
      else if (t === "A") {
        const label = inlineOf(c.childNodes), href = c.getAttribute("href") || "";
        const bare = href.replace(/^mailto:/i, "");
        out += !href || label.trim() === href || label.trim() === bare ? label : `${label} (${href})`;
      } else if (t === "IMG") {
        const alt = c.getAttribute("alt") || "", src = c.getAttribute("src") || "";
        out += alt && src ? `${alt} (${src})` : alt || src;
      } else if (t === "INPUT") out += c.hasAttribute("checked") || c.checked ? "[x] " : "[ ] ";
      else if (t === "SUP") out += supText(inlineOf(c.childNodes).trim());
      else if (t === "SUB") out += subText(inlineOf(c.childNodes).trim());
      else if (t === "TD" || t === "TH") out += inlineOf(c.childNodes).trim() + "\t"; // stray cells from a partial selection
      else out += inlineOf(c.childNodes);
    }
    return out;
  }

  // The text of one table cell on one line (line breaks and tabs inside a cell become spaces)
  function cellText(node) {
    return inlineOf(node.childNodes).replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
  }

  function tableRows(table) {
    return [...table.querySelectorAll("tr")].map(tr => [...tr.children].filter(c => c.tagName === "TD" || c.tagName === "TH").map(cellText));
  }

  // Tab-separated columns: pastes into a spreadsheet as real cells and still reads fine as plain text
  function tableTsv(table) {
    return tableRows(table).map(row => row.map(v => /^"/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v).join("\t")).join("\n");
  }

  function listText(list, depth) {
    const ordered = list.tagName === "OL";
    let n = parseInt(list.getAttribute("start"), 10);
    if (!Number.isFinite(n)) n = 1;
    return [...list.children].filter(li => li.tagName === "LI").map(li => {
      const marker = ordered ? (n++) + ". " : depth % 2 ? "◦ " : "• ";
      const pad = " ".repeat(marker.length);
      const body = blocks(li, depth + 1).join("\n");
      return marker + body.split("\n").map((line, i) => i && line ? pad + line : line).join("\n");
    }).join("\n");
  }

  function blocks(parent, depth) {
    const out = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const s = inlineOf(run).replace(/[ \t]*\n[ \t]*/g, "\n").trim();
      if (s) out.push(s);
      run = [];
    };
    for (const c of parent.childNodes) {
      if (c.nodeType !== 1 || !BLOCK.has(c.tagName)) { run.push(c); continue; }
      flush();
      const t = c.tagName;
      if (t === "UL" || t === "OL") out.push(listText(c, depth));
      else if (t === "PRE") out.push(c.textContent.replace(/\n+$/, ""));
      else if (t === "TABLE") out.push(tableTsv(c));
      else if (t === "HR") out.push("────────");
      else if (t === "BLOCKQUOTE") out.push(blocks(c, depth).join("\n\n").split("\n").map(l => l ? "> " + l : ">").join("\n"));
      else out.push(...blocks(c, depth));
    }
    flush();
    return out;
  }

  function domToText(root) {
    return blocks(root, 0).join("\n\n").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  /* ---------------------------------------------------------- */
  /*  Markdown -> clean DOM (the same markdown library the chat  */
  /*  uses, but with no buttons, charts or preview cards)        */
  /* ---------------------------------------------------------- */
  function replaceMath(root) {
    root.querySelectorAll("[data-tex]").forEach(n => n.replaceWith(document.createTextNode(mathToText(n.getAttribute("data-tex")))));
  }

  function restoreMath(root, mathList) {
    if (!mathList.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const hits = [];
    let node;
    while ((node = walker.nextNode())) if (/\uE010MATH\d+\uE011/.test(node.nodeValue)) hits.push(node);
    hits.forEach(n => {
      n.nodeValue = n.nodeValue.replace(/\uE010MATH(\d+)\uE011/g, (whole, i) => mathList[+i] ? mathToText(mathList[+i].tex) : "");
    });
  }

  function renderClean(md) {
    const R = window.agent1102Render;
    if (!R || typeof marked === "undefined" || typeof DOMPurify === "undefined") return null;
    const { text, math } = R.extractMath(R.responseToText(md));
    let html;
    try { html = marked.parse(text, { gfm: true, breaks: true }); } catch (_) { return null; }
    const box = document.createElement("div");
    box.innerHTML = DOMPurify.sanitize(html);
    restoreMath(box, math);
    // pictures are never pulled into a paste; keep what they say and where they are
    box.querySelectorAll("img").forEach(img => {
      const alt = img.getAttribute("alt") || "", src = img.getAttribute("src") || "";
      img.replaceWith(document.createTextNode(alt && /^https?:/i.test(src) ? `${alt} (${src})` : alt || (/^https?:/i.test(src) ? src : "")));
    });
    return box;
  }

  /* ---------------------------------------------------------- */
  /*  Rich-text version: add the borders/fonts Word, Docs and    */
  /*  Outlook need, because they ignore the page's stylesheet    */
  /* ---------------------------------------------------------- */
  function styleForPaste(root) {
    const tables = root.tagName === "TABLE" ? [root] : [...root.querySelectorAll("table")];
    tables.forEach(table => {
      table.setAttribute("border", "1");
      table.setAttribute("cellspacing", "0");
      table.setAttribute("cellpadding", "6");
      table.style.cssText = "border-collapse:collapse;";
      table.querySelectorAll("th, td").forEach(c => {
        c.style.cssText = "border:1px solid #bfbfbf;padding:4px 8px;text-align:left;vertical-align:top;" + (c.tagName === "TH" ? "background:#f2f2f2;font-weight:bold;" : "");
      });
    });
    root.querySelectorAll("pre").forEach(p => { p.style.cssText = "font-family:Consolas,'Courier New',monospace;white-space:pre-wrap;background:#f6f6f6;padding:8px;"; });
    root.querySelectorAll("code").forEach(c => { if (!c.closest("pre")) c.style.cssText = "font-family:Consolas,'Courier New',monospace;"; });
  }

  const page = inner => '<meta charset="utf-8">' + inner;

  function responseClipboard(md) {
    const box = renderClean(md);
    if (!box) { const R = window.agent1102Render; return { html: null, text: R ? R.responseToText(md) : String(md) }; }
    const text = domToText(box);
    styleForPaste(box);
    return { html: page(box.innerHTML), text };
  }

  // A table that is already on the page (its math is KaTeX markup, which would paste as garbage, so it becomes text)
  function tableClipboard(table) {
    const clone = table.cloneNode(true);
    replaceMath(clone);
    clone.querySelectorAll("*").forEach(n => { n.removeAttribute("class"); n.removeAttribute("style"); });
    const text = tableTsv(clone);
    styleForPaste(clone);
    return { html: page(clone.outerHTML), text };
  }

  /* ---------------------------------------------------------- */
  /*  Writing to the clipboard                                   */
  /* ---------------------------------------------------------- */
  async function write(html, text) {
    // Everything above is synchronous, so Safari still counts this as part of the click
    if (html && navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
      try {
        await navigator.clipboard.write([new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        })]);
        return true;
      } catch (_) { /* fall through */ }
    }
    if (html) {
      let ta;
      const onCopy = e => { e.clipboardData.setData("text/html", html); e.clipboardData.setData("text/plain", text); e.preventDefault(); };
      try {
        ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.addEventListener("copy", onCopy, true);
        if (document.execCommand("copy")) return true;
      } catch (_) { /* fall through */ }
      finally { document.removeEventListener("copy", onCopy, true); if (ta) ta.remove(); }
    }
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  const copyResponse = md => { const r = responseClipboard(md); return write(r.html, r.text); };
  const copyTable = table => { const r = tableClipboard(table); return write(r.html, r.text); };

  /* ---------------------------------------------------------- */
  /*  Ctrl+C / Cmd+C on selected text in an answer: formulas are */
  /*  drawn as styled glyphs, which copy as "x2+1". Hand over    */
  /*  the readable version instead. Everything else is left to   */
  /*  the browser.                                               */
  /* ---------------------------------------------------------- */
  document.addEventListener("copy", e => {
    try {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
      const range = sel.getRangeAt(0);
      const anc = range.commonAncestorContainer;
      const host = anc.nodeType === 1 ? anc : anc.parentElement;
      if (!host || !host.closest(".msg-content-body")) return;
      const box = document.createElement("div");
      box.appendChild(range.cloneContents());
      if (!box.querySelector("[data-tex]")) return;
      const text = domToText(box);
      replaceMath(box);
      styleForPaste(box);
      e.clipboardData.setData("text/html", page(box.innerHTML));
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
    } catch (_) { /* never block a normal copy */ }
  });

  window.agent1102Copy = { mathToText, domToText, cellText, tableTsv, responseClipboard, tableClipboard, write, copyResponse, copyTable };
})();
