// ============================================================
//  Math visuals: graphs, inequalities, area under curves, geometry,
//  number lines and fraction models, drawn as crisp SVG.
//
//  The AI writes a ```mathviz block containing ONE JSON object; render.js hands
//  it to agent1102MathViz.build(). Study quizzes/flashcards can also carry a
//  "visual" object which is drawn with agent1102MathViz.buildInline().
//
//  Nothing here uses eval(): expressions like "x^2 - 4" or "sin(2x)/x" go
//  through a small parser of its own. All text and colours from the AI are
//  escaped/validated before they reach the SVG.
// ============================================================
(function () {
  "use strict";

  /* ------------------------- small helpers ------------------------- */
  const PALETTE = ["#4f8cff", "#ff6b6b", "#2ecc71", "#f5a623", "#b06bff", "#1abc9c"];
  let uid = 0;

  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v, d) => { const n = typeof v === "string" ? parseFloat(v) : v; return Number.isFinite(n) ? n : d; };
  const f2 = n => (Math.round(n * 100) / 100).toString();
  function colorOf(c, i) {
    if (typeof c === "string" && /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(c.trim())) return c.trim();
    return PALETTE[(i || 0) % PALETTE.length];
  }
  const pt = p => (Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1])) ? [+p[0], +p[1]] : null;
  const arr = a => (Array.isArray(a) ? a : []);

  const SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻", "+": "⁺", "n": "ⁿ", "x": "ˣ" };
  // "x^2 - sqrt(x)" -> "x² − √(x)" for legends and labels
  function pretty(t) {
    return String(t)
      .replace(/\^\(?(-?[0-9nx+]+)\)?/g, (m, g) => [...g].map(c => SUP[c] || c).join(""))
      .replace(/\bsqrt\b/g, "√").replace(/\bpi\b/gi, "π").replace(/\btheta\b/gi, "θ")
      .replace(/\*/g, "·").replace(/(\s)-(\s)/g, "$1−$2");
  }

  /* ------------------ safe expression parser (no eval) ------------------ */
  const FUNCS1 = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2, exp: Math.exp,
    floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
    sec: v => 1 / Math.cos(v), csc: v => 1 / Math.sin(v), cot: v => 1 / Math.tan(v),
  };
  const FUNCS2 = { pow: Math.pow, min: Math.min, max: Math.max, atan2: Math.atan2, mod: (a, b) => a - b * Math.floor(a / b), logb: (v, b) => Math.log(v) / Math.log(b) };
  const CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

  function tokenize(src) {
    const out = [];
    const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-zA-Zθ_][a-zA-Z0-9_]*)|(\*\*|[-+*/^(),|]))/gy;
    let m, last = 0;
    while (last < src.length && (m = re.exec(src))) {
      last = re.lastIndex;
      if (m[1] != null) out.push({ t: "num", v: parseFloat(m[1]) });
      else if (m[2] != null) out.push({ t: "id", v: m[2] === "θ" ? "theta" : m[2] });
      else out.push({ t: "op", v: m[3] === "**" ? "^" : m[3] });
    }
    if (src.slice(last).trim()) throw new Error(`I couldn't read "${src.trim()}"`);
    return out;
  }

  // Compile "x^2-4" into a function of a variable map: fn({x: 3}) -> 5
  // Turns the ways an AI writes math ("\\frac{1}{x}", "sin^2(x)", "log_2(x)", "x⁴") into plain "(1)/(x)" style text
  const SUPDIG = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-" };
  function cleanNotation(raw) {
    let t = String(raw == null ? "" : raw).slice(0, 400);
    // JSON turns an unescaped "\frac" / "\theta" / "\tan" / "\beta" / "\right" into control characters: undo that
    t = t.replace(/\f(?=rac|loor)/g, "\\f").replace(/\t(?=heta|an|imes|anh)/g, "\\t").replace(/\x08(?=eta)/g, "\\b").replace(/\r(?=ight)/g, "\\r");
    t = t.replace(/\$/g, "").replace(/\\left|\\right|\\[,!;: ]/g, "").replace(/\\(cdot|times)/g, "*").replace(/\\div/g, "/");
    t = t.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+/g, m => "^(" + [...m].map(c => SUPDIG[c]).join("") + ")");
    for (let k = 0; k < 6; k++) {                                   // nested \frac{..}{..} and \sqrt{..}
      t = t.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "(($1)/($2))")
           .replace(/\\sqrt\s*\[\s*3\s*\]\s*\{([^{}]*)\}/g, "cbrt($1)")
           .replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)");
    }
    t = t.replace(/\\(?=[a-zA-Z])/g, "");                          // \sin -> sin, \pi -> pi, \theta -> theta
    t = t.replace(/\b(log|ln)_\{?\s*(\d+(?:\.\d+)?|e)\s*\}?\s*\(([^()]*)\)/gi, (m, f, b, a) => b === "e" || f.toLowerCase() === "ln" ? `ln(${a})` : `logb(${a},${b})`);
    t = t.replace(/\b(sin|cos|tan|sec|csc|cot|sinh|cosh|tanh)\s*\^\s*\{?\s*(-?\d+)\s*\}?\s*\(([^()]*)\)/gi, "(($1($3))^($2))")
         .replace(/\b(sin|cos|tan|sec|csc|cot|sinh|cosh|tanh)\s*\^\s*\{?\s*(-?\d+)\s*\}?\s+([a-z0-9.]+)/gi, "(($1($3))^($2))");
    t = t.replace(/\^\s*\{/g, "^(").replace(/[{}]/g, m => (m === "{" ? "(" : ")")).replace(/\^\s*\(\s*\(/g, "^((");
    return t;
  }

  function compile(raw, vars) {
    let src = cleanNotation(raw)
      .replace(/−|–/g, "-").replace(/×|·/g, "*").replace(/÷/g, "/").replace(/π/g, "pi")
      .replace(/²/g, "^2").replace(/³/g, "^3").replace(/√/g, "sqrt");
    // drop a leading "y =", "f(x) =", "r =" ...
    const eq = src.match(/^\s*[a-zA-Z]\w*(?:\s*\(\s*[a-zA-Z]\w*\s*\))?\s*=(?!=)\s*(.+)$/);
    if (eq && !/=/.test(eq[1])) src = eq[1];
    if (!src.trim()) throw new Error("an expression is empty.");
    const toks = tokenize(src);
    let i = 0;
    const peek = () => toks[i];
    const isOp = v => toks[i] && toks[i].t === "op" && toks[i].v === v;
    const startsFactor = () => { const k = toks[i]; return k && (k.t === "num" || k.t === "id" || (k.t === "op" && k.v === "(")); };

    function parseExpr() {
      let left = parseTerm();
      while (isOp("+") || isOp("-")) {
        const op = toks[i++].v, right = parseTerm(), l = left;
        left = op === "+" ? v => l(v) + right(v) : v => l(v) - right(v);
      }
      return left;
    }
    function parseTerm() {
      let left = parseUnary();
      for (;;) {
        if (isOp("*") || isOp("/")) {
          const op = toks[i++].v, right = parseUnary(), l = left;
          left = op === "*" ? v => l(v) * right(v) : v => l(v) / right(v);
        } else if (startsFactor()) { // implicit multiplication: 2x, 3(x+1), x(x-1)
          const right = parseUnary(), l = left;
          left = v => l(v) * right(v);
        } else break;
      }
      return left;
    }
    function parseUnary() {
      if (isOp("-")) { i++; const x = parseUnary(); return v => -x(v); }
      if (isOp("+")) { i++; return parseUnary(); }
      return parsePower();
    }
    function parsePower() {
      const base = parseAtom();
      if (isOp("^")) { i++; const ex = parseUnary(); return v => Math.pow(base(v), ex(v)); }
      return base;
    }
    function parseAtom() {
      const k = peek();
      if (!k) throw new Error(`"${src.trim()}" ends too early`);
      if (k.t === "num") { i++; const n = k.v; return () => n; }
      if (k.t === "op" && k.v === "(") {
        i++; const e = parseExpr();
        if (!isOp(")")) throw new Error("a closing ) is missing.");
        i++; return e;
      }
      if (k.t === "op" && k.v === "|") { // |x| absolute value
        i++; const e = parseExpr();
        if (!isOp("|")) throw new Error("a closing | is missing.");
        i++; return v => Math.abs(e(v));
      }
      if (k.t === "id") {
        i++;
        const name = k.v.toLowerCase();
        if (isOp("(") && (FUNCS1[name] || FUNCS2[name])) {
          i++;
          const a = parseExpr();
          if (FUNCS2[name]) {
            if (!isOp(",")) throw new Error(`${name}() needs two values`);
            i++;
            const b = parseExpr();
            if (!isOp(")")) throw new Error("a closing ) is missing.");
            i++; const fn = FUNCS2[name]; return v => fn(a(v), b(v));
          }
          if (!isOp(")")) throw new Error("a closing ) is missing.");
          i++; const fn = FUNCS1[name]; return v => fn(a(v));
        }
        if (FUNCS1[name] && toks[i] && (toks[i].t === "num" || toks[i].t === "id" || (toks[i].t === "op" && toks[i].v === "|"))) {
          // "sin x", "sin 2x", "ln|x|": the function applies to the next factor(s)
          let arg = parsePower();
          while (startsFactor() && !(toks[i].t === "id" && (FUNCS1[toks[i].v.toLowerCase()] || FUNCS2[toks[i].v.toLowerCase()]))) { const r = parsePower(), l = arg; arg = v => l(v) * r(v); }
          const fn = FUNCS1[name]; return v => fn(arg(v));
        }
        if (vars.includes(name)) return v => v[name];
        if (name in CONSTS) { const c = CONSTS[name]; return () => c; }
        // "xy", "2pi" style runs of letters: split into single-letter variables/constants
        if (name.length > 1 && [...name].every(c => vars.includes(c) || c === "e")) {
          const parts = [...name].map(c => vars.includes(c) ? (v => v[c]) : (() => Math.E));
          return v => parts.reduce((acc, p) => acc * p(v), 1);
        }
        throw new Error(`I don't know "${k.v}" in "${src.trim()}"`);
      }
      throw new Error(`I couldn't read "${src.trim()}"`);
    }
    const fn = parseExpr();
    if (i < toks.length) throw new Error(`I couldn't read "${src.trim()}"`);
    return fn;
  }

  /* ---------------------- number formatting / ticks ---------------------- */
  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }
  function fmt(n, step) {
    if (Math.abs(n) < 1e-9) return "0";
    const dec = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step || 1)) + 1));
    let s = (Math.abs(n) >= 1e6 || (Math.abs(n) < 1e-4)) ? n.toExponential(1) : String(parseFloat(n.toFixed(dec)));
    return s.replace("-", "−");
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
  function fracLabel(n, d) { // reduced n/d as text
    if (d === 0) return "";
    const g = gcd(n, d) || 1;
    n /= g; d /= g;
    if (d === 1) return String(n).replace("-", "−");
    return `${String(n).replace("-", "−")}/${d}`;
  }
  function piLabel(x) { // multiples of pi/4
    const m = Math.round(x / (Math.PI / 4));
    if (m === 0) return "0";
    const g = gcd(m, 4);
    const n = m / g, d = 4 / g, an = Math.abs(n);
    return (n < 0 ? "−" : "") + (an === 1 ? "" : an) + "π" + (d > 1 ? "/" + d : "");
  }
  const isNil = v => v == null || (typeof v === "string" && /^[-+−]?(inf|infinity|∞)$/i.test(v.trim()));

  /* ------------------------------ styles ------------------------------ */
  function styleText(T) {
    const halo = T ? T.halo : "var(--mv-halo, rgba(15,15,15,0.8))";
    return `.mv-t{fill:currentColor;font:12px Inter,system-ui,sans-serif}.mv-tb{font-weight:600;font-size:14px}.mv-ts{font-size:11px}` +
      `.mv-hs{fill:${halo};stroke:${halo};stroke-width:3.5px;stroke-linejoin:round}` +
      `.mv-grid{stroke:currentColor;stroke-opacity:.13;stroke-width:1;fill:none}.mv-axis{stroke:currentColor;stroke-opacity:.85;stroke-width:1.6;fill:none}` +
      `.mv-frame{stroke:currentColor;stroke-opacity:.25;fill:none}`;
  }
  const wrapSvg = (W, H, inner, T) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" ${T ? `width="${W}" height="${H}"` : `role="img"`} style="color:${T ? T.color : "inherit"}">` +
    `<style>${styleText(T)}</style>${T ? `<rect width="${W}" height="${H}" fill="${T.bg}"/>` : ""}${inner}</svg>`;

  const text = (x, y, s, o) => {
    o = o || {};
    const at = `x="${f2(x)}" y="${f2(y)}" text-anchor="${o.anchor || "middle"}"`;
    // readable over lines and shading: a soft outline drawn underneath the text
    const under = o.halo === false ? "" : `<text class="mv-t ${o.cls || ""} mv-hs" ${at}>${esc(s)}</text>`;
    return under + `<text class="mv-t ${o.cls || ""}" ${at}${o.fill ? ` style="fill:${o.fill}"` : ""}>${esc(s)}</text>`;
  };
  // open circles get the background colour (so lines don't show through); filled ones the accent colour
  const holeAttr = (open, color, T) => open ? `fill="none" style="fill:${T ? T.bg : "var(--mv-hole,#1c1c1e)"}"` : `fill="${color}"`;
  const arrowDef = (id, color) => `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`;

  /* ---------------------------- plane (graphs, geometry) ---------------------------- */
  function renderPlane(spec, T) {
    const id = "mv" + (++uid);
    const W = 640, L = 46, R = 18, B = 36;
    const Tp = spec.title ? 38 : 16;
    const pw = W - L - R;

    // ---- compile everything up front, so a typo gives a clear message ----
    const fns = arr(spec.functions).slice(0, 8).map((f, i) => {
      const o = typeof f === "string" ? { expr: f } : (f || {});
      return { fn: compile(o.expr, ["x"]), expr: String(o.expr), label: o.label, color: colorOf(o.color, i), dashed: !!o.dashed, domain: Array.isArray(o.domain) ? o.domain.map(Number) : null };
    });
    const ineqs = arr(spec.inequalities).slice(0, 6).map((q, i) => {
      const op = String(q.op || ">").replace("≥", ">=").replace("≤", "<=");
      const strict = op === ">" || op === "<";
      const above = op.startsWith(">");
      const base = { color: colorOf(q.color, i + fns.length), strict: q.dashed != null ? !!q.dashed : strict, above, op };
      if (q.x != null && q.expr == null) return { ...base, vertical: num(q.x, 0) };
      if (q.y != null && q.expr == null) return { ...base, fn: () => num(q.y, 0), expr: String(q.y) };
      return { ...base, fn: compile(q.expr, ["x"]), expr: String(q.expr) };
    });
    const areas = arr(spec.areas).slice(0, 4).map((a, i) => ({
      fn: compile(a.expr, ["x"]), fn2: a.expr2 != null ? compile(a.expr2, ["x"]) : null,
      from: num(a.from, -1), to: num(a.to, 1), color: colorOf(a.color, i + 2),
    }));
    const params = arr(spec.parametric).slice(0, 4).map((p, i) => ({
      fx: compile(p.x, ["t"]), fy: compile(p.y, ["t"]), t: (Array.isArray(p.t) ? p.t : [0, 2 * Math.PI]).map(Number), label: p.label, color: colorOf(p.color, i + fns.length), expr: `x=${p.x}, y=${p.y}`,
    }));
    const polars = arr(spec.polar).slice(0, 4).map((p, i) => ({
      fr: compile(p.r, ["t", "theta"]), t: (Array.isArray(p.t) ? p.t : [0, 2 * Math.PI]).map(Number), label: p.label, color: colorOf(p.color, i + fns.length + params.length), expr: `r=${p.r}`,
    }));

    const points = arr(spec.points).map(p => ({ ...p, x: num(p.x, NaN), y: num(p.y, NaN) })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).slice(0, 60);
    const segs = arr(spec.segments).concat(arr(spec.vectors).map(v => ({ ...v, arrow: true }))).map(s => ({ ...s, a: pt(s.from), b: pt(s.to) })).filter(s => s.a && s.b).slice(0, 60);
    const polys = arr(spec.polygons).map(p => ({ ...p, pts: arr(p.points).map(pt).filter(Boolean) })).filter(p => p.pts.length >= 2).slice(0, 12);
    const circles = arr(spec.circles).map(c => ({ ...c, c0: pt(c.center), r: Math.abs(num(c.r, 1)) })).filter(c => c.c0).slice(0, 12);
    const angles = arr(spec.angles).map(a => ({ ...a, v: pt(a.vertex), p1: pt(a.from), p2: pt(a.to) })).filter(a => a.v && a.p1 && a.p2).slice(0, 12);
    const texts = arr(spec.texts).map(t => ({ ...t, x: num(t.x, NaN), y: num(t.y, NaN) })).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y) && t.text != null).slice(0, 30);
    const vlines = arr(spec.vlines).map(Number).filter(Number.isFinite).slice(0, 12);
    const hlines = arr(spec.hlines).map(Number).filter(Number.isFinite).slice(0, 12);

    const usesTrig = fns.some(f => /\b(sin|cos|tan|sec|csc|cot)\b/i.test(f.expr));
    const hasGeom = !!(segs.length || polys.length || circles.length || angles.length || params.length || polars.length);
    const explicitBox = ["xMin", "xMax", "yMin", "yMax"].every(k => Number.isFinite(+spec[k]));

    // ---- ranges ----
    let xMin = num(spec.xMin, NaN), xMax = num(spec.xMax, NaN), yMin = num(spec.yMin, NaN), yMax = num(spec.yMax, NaN);
    const bx = [], by = [];
    const grow = (x, y) => { if (Number.isFinite(x)) bx.push(x); if (Number.isFinite(y)) by.push(y); };
    points.forEach(p => grow(p.x, p.y));
    segs.forEach(s => { grow(s.a[0], s.a[1]); grow(s.b[0], s.b[1]); });
    polys.forEach(p => p.pts.forEach(q => grow(q[0], q[1])));
    circles.forEach(c => { grow(c.c0[0] - c.r, c.c0[1] - c.r); grow(c.c0[0] + c.r, c.c0[1] + c.r); });
    angles.forEach(a => { grow(a.v[0], a.v[1]); grow(a.p1[0], a.p1[1]); grow(a.p2[0], a.p2[1]); });
    texts.forEach(t => grow(t.x, t.y));
    const sampleCurve = (fx, fy, a, b, n) => { for (let k = 0; k <= n; k++) { const t = a + (b - a) * k / n; grow(fx({ t, theta: t }), fy({ t, theta: t })); } };
    params.forEach(p => sampleCurve(p.fx, p.fy, p.t[0], p.t[1], 200));
    polars.forEach(p => sampleCurve(v => p.fr(v) * Math.cos(v.t), v => p.fr(v) * Math.sin(v.t), p.t[0], p.t[1], 240));
    const finiteBx = bx.filter(Number.isFinite);
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) {
      if (fns.length || ineqs.length || areas.length) {
        const a = usesTrig ? -2 * Math.PI : -10, b = usesTrig ? 2 * Math.PI : 10;
        if (finiteBx.length && !usesTrig) {
          // points/shapes were given: frame them (with room around) instead of the generic -10..10 window
          const lo = Math.min(...finiteBx, 0), hi = Math.max(...finiteBx, 0), span = hi - lo || 4, pad = Math.max(2, span * 0.6);
          xMin = lo - pad; xMax = hi + pad;
        } else {
          xMin = Math.min(a, ...(finiteBx.length ? [Math.min(...finiteBx)] : [a])); xMax = Math.max(b, ...(finiteBx.length ? [Math.max(...finiteBx)] : [b]));
        }
        if (!fns.length && areas.length) { xMin = Math.min(...areas.map(a => a.from)) - 1; xMax = Math.max(...areas.map(a => a.to)) + 1; }
      } else if (finiteBx.length) {
        const lo = Math.min(...finiteBx), hi = Math.max(...finiteBx), pad = (hi - lo || 2) * 0.15;
        xMin = lo - pad; xMax = hi + pad;
      } else { xMin = -10; xMax = 10; }
      if (!hasGeom || fns.length) { /* keep origin visible for graphs */ if (!explicitBox && !Number.isFinite(+spec.xMin) && !Number.isFinite(+spec.xMax) && !fns.length && finiteBx.length) { xMin = Math.min(xMin, 0 - (xMax - xMin) * 0.05); xMax = Math.max(xMax, (xMax - xMin) * 0.05); } }
    }
    if (xMax <= xMin) xMax = xMin + 1;
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      const ys = by.filter(Number.isFinite);
      const N = 240;
      const collect = f => { for (let k = 0; k <= N; k++) { const x = xMin + (xMax - xMin) * k / N; const y = f({ x }); if (Number.isFinite(y) && Math.abs(y) < 1e4) ys.push(y); } };
      fns.forEach(f => collect(f.fn));
      ineqs.forEach(q => { if (q.fn) collect(q.fn); });
      areas.forEach(a => { collect(a.fn); if (a.fn2) collect(a.fn2); });
      if (fns.length && ys.length > 20) { // ignore asymptote blow-ups: use the middle 92% of the values
        const s = ys.slice().sort((p, q) => p - q);
        const lo = s[Math.floor(s.length * 0.04)], hi = s[Math.ceil(s.length * 0.96) - 1];
        const rawMin = Math.min(...ys), rawMax = Math.max(...ys);
        yMin = (rawMax - rawMin) > 8 * (hi - lo || 1) ? lo : rawMin; yMax = (rawMax - rawMin) > 8 * (hi - lo || 1) ? hi : rawMax;
      } else if (ys.length) { yMin = Math.min(...ys); yMax = Math.max(...ys); }
      else { yMin = -10; yMax = 10; }
      if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
      const pad = (yMax - yMin) * 0.12; yMin -= pad; yMax += pad;
      if (!hasGeom && fns.length) { yMin = Math.min(yMin, 0 - (yMax - yMin) * 0.04); yMax = Math.max(yMax, (yMax - yMin) * 0.04); }
    }
    if (yMax <= yMin) yMax = yMin + 1;

    // ---- plot size / equal scaling ----
    const autoBox = !explicitBox;
    const equal = spec.equal != null ? !!spec.equal : (hasGeom && !fns.length);
    let ph = 380;
    if (equal) {
      let xs = xMax - xMin, ys = yMax - yMin;
      ph = pw * ys / xs;
      if (ph > 500) { ph = 500; const need = ys * pw / ph, c = (xMin + xMax) / 2; xMin = c - need / 2; xMax = c + need / 2; }
      else if (ph < 220) { ph = 220; const need = xs * ph / pw, c = (yMin + yMax) / 2; yMin = c - need / 2; yMax = c + need / 2; }
    }
    const H = Tp + ph + B;
    const xs = xMax - xMin, ys = yMax - yMin;
    const sx = x => L + (x - xMin) / xs * pw;
    const sy = y => Tp + ph - (y - yMin) / ys * ph;
    const clampPx = v => Math.max(-5000, Math.min(5000, v));

    const showAxes = spec.axes !== false;
    const showGrid = spec.grid != null ? !!spec.grid : showAxes;
    const usePi = spec.xPi != null ? !!spec.xPi : (usesTrig && !Number.isFinite(+spec.xMin) && xs > 3 && xs < 30);

    let g = "";
    const defs = [`<clipPath id="${id}c"><rect x="${L}" y="${Tp}" width="${pw}" height="${ph}"/></clipPath>`];

    // ---- grid + ticks ----
    let xStep = niceStep(xs, 9), yStep = niceStep(ys, 8);
    if (equal) { xStep = yStep = Math.max(xStep, yStep) === xStep ? xStep : yStep; }
    let xTicks = [];
    if (usePi) { const st = xs > 14 ? Math.PI : xs > 7 ? Math.PI / 2 : Math.PI / 4; for (let x = Math.ceil(xMin / st - 1e-9) * st; x <= xMax + 1e-9; x += st) xTicks.push(x); }
    else for (let x = Math.ceil(xMin / xStep - 1e-9) * xStep; x <= xMax + 1e-9; x += xStep) xTicks.push(x);
    const yTicks = [];
    for (let y = Math.ceil(yMin / yStep - 1e-9) * yStep; y <= yMax + 1e-9; y += yStep) yTicks.push(y);

    if (showGrid) {
      xTicks.forEach(x => { g += `<line class="mv-grid" x1="${f2(sx(x))}" x2="${f2(sx(x))}" y1="${Tp}" y2="${Tp + ph}"/>`; });
      yTicks.forEach(y => { g += `<line class="mv-grid" x1="${L}" x2="${L + pw}" y1="${f2(sy(y))}" y2="${f2(sy(y))}"/>`; });
    }
    g += `<rect class="mv-frame" x="${L}" y="${Tp}" width="${pw}" height="${ph}"/>`;

    // ---- shading (below the curves) ----
    let shade = "";
    const N = 400;
    ineqs.forEach(q => {
      if (q.vertical != null) {
        const x0 = sx(q.vertical);
        const xa = q.above ? x0 : L, xb = q.above ? L + pw : x0;
        shade += `<rect x="${f2(Math.min(xa, xb))}" y="${Tp}" width="${f2(Math.abs(xb - xa))}" height="${ph}" fill="${q.color}" fill-opacity="0.22"/>`;
        return;
      }
      let d = "";
      const edge = q.above ? Tp : Tp + ph;
      const pts = [];
      for (let k = 0; k <= N; k++) { const x = xMin + xs * k / N; const y = q.fn({ x }); pts.push([sx(x), Number.isFinite(y) ? clampPx(sy(y)) : NaN]); }
      let run = [];
      const flush = () => { if (run.length > 1) { d += `M${f2(run[0][0])},${edge} ` + run.map(p => `L${f2(p[0])},${f2(p[1])}`).join(" ") + ` L${f2(run[run.length - 1][0])},${edge} Z `; } run = []; };
      pts.forEach(p => { if (Number.isNaN(p[1])) flush(); else run.push(p); });
      flush();
      shade += `<path d="${d}" fill="${q.color}" fill-opacity="0.22" clip-path="url(#${id}c)"/>`;
    });
    areas.forEach(a => {
      const lo = Math.min(a.from, a.to), hi = Math.max(a.from, a.to), top = [], bot = [];
      for (let k = 0; k <= 200; k++) {
        const x = lo + (hi - lo) * k / 200;
        const y1 = a.fn({ x }), y2 = a.fn2 ? a.fn2({ x }) : 0;
        if (!Number.isFinite(y1) || !Number.isFinite(y2)) continue;
        top.push([sx(x), clampPx(sy(y1))]); bot.push([sx(x), clampPx(sy(y2))]);
      }
      if (top.length > 1) shade += `<path d="M${top.map(p => `${f2(p[0])},${f2(p[1])}`).join(" L")} L${bot.reverse().map(p => `${f2(p[0])},${f2(p[1])}`).join(" L")} Z" fill="${a.color}" fill-opacity="0.3" stroke="${a.color}" stroke-opacity="0.5" clip-path="url(#${id}c)"/>`;
    });
    polys.forEach((p, i) => {
      if (p.fill === false || p.pts.length < 3) return;
      shade += `<polygon points="${p.pts.map(q => `${f2(sx(q[0]))},${f2(sy(q[1]))}`).join(" ")}" fill="${colorOf(p.color, i)}" fill-opacity="0.16"/>`;
    });
    circles.forEach((c, i) => { if (c.fill) shade += `<ellipse cx="${f2(sx(c.c0[0]))}" cy="${f2(sy(c.c0[1]))}" rx="${f2(c.r / xs * pw)}" ry="${f2(c.r / ys * ph)}" fill="${colorOf(c.color, i)}" fill-opacity="0.16"/>`; });
    g += shade;

    // ---- axes + labels ----
    if (showAxes) {
      const ax = xMin <= 0 && xMax >= 0 ? sx(0) : L, ay = yMin <= 0 && yMax >= 0 ? sy(0) : Tp + ph;
      g += `<line class="mv-axis" x1="${L}" x2="${L + pw}" y1="${f2(ay)}" y2="${f2(ay)}"/><line class="mv-axis" x1="${f2(ax)}" x2="${f2(ax)}" y1="${Tp}" y2="${Tp + ph}"/>`;
      const xAbove = ay > Tp + ph - 16;
      xTicks.forEach(x => {
        if (Math.abs(x) < 1e-9 && ax !== L) return;
        const px = sx(x);
        g += `<line class="mv-axis" style="stroke-opacity:.6" x1="${f2(px)}" x2="${f2(px)}" y1="${f2(ay - 3)}" y2="${f2(ay + 3)}"/>` + text(px, xAbove ? ay - 8 : ay + 16, usePi ? piLabel(x) : fmt(x, xStep), { cls: "mv-ts" });
      });
      yTicks.forEach(y => {
        if (Math.abs(y) < 1e-9 && ay !== Tp + ph) return;
        const py = sy(y);
        g += `<line class="mv-axis" style="stroke-opacity:.6" x1="${f2(ax - 3)}" x2="${f2(ax + 3)}" y1="${f2(py)}" y2="${f2(py)}"/>` + text(ax < L + 30 ? ax + 6 : ax - 7, py + 4, fmt(y, yStep), { cls: "mv-ts", anchor: ax < L + 30 ? "start" : "end" });
      });
      if (xMin <= 0 && xMax >= 0 && yMin <= 0 && yMax >= 0) g += text(ax - 7, ay + 15, "0", { cls: "mv-ts", anchor: "end" });
      g += text(L + pw - 4, ay - 8, spec.xLabel != null ? spec.xLabel : "x", { anchor: "end", cls: "mv-tb" });
      g += text(ax + 8, Tp + 14, spec.yLabel != null ? spec.yLabel : "y", { anchor: "start", cls: "mv-tb" });
    }

    // ---- helper lines (asymptotes, guides) ----
    vlines.forEach(x => { g += `<line x1="${f2(sx(x))}" x2="${f2(sx(x))}" y1="${Tp}" y2="${Tp + ph}" stroke="currentColor" stroke-opacity=".55" stroke-dasharray="6 5"/>`; });
    hlines.forEach(y => { g += `<line x1="${L}" x2="${L + pw}" y1="${f2(sy(y))}" y2="${f2(sy(y))}" stroke="currentColor" stroke-opacity=".55" stroke-dasharray="6 5"/>`; });

    // ---- curves ----
    const path = (pts, color, dashed) => {
      let d = "", pen = false, prev = null;
      pts.forEach(p => {
        const bad = !Number.isFinite(p[0]) || !Number.isFinite(p[1]);
        if (bad) { pen = false; prev = null; return; }
        if (prev && Math.abs(p[1] - prev[1]) > ph * 2) pen = false; // jump across an asymptote
        d += (pen ? "L" : "M") + f2(p[0]) + "," + f2(clampPx(p[1])) + " ";
        pen = true; prev = p;
      });
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"${dashed ? ' stroke-dasharray="7 6"' : ""} clip-path="url(#${id}c)"/>`;
    };
    // boundaries of inequalities
    ineqs.forEach(q => {
      if (q.vertical != null) { g += `<line x1="${f2(sx(q.vertical))}" x2="${f2(sx(q.vertical))}" y1="${Tp}" y2="${Tp + ph}" stroke="${q.color}" stroke-width="2.4"${q.strict ? ' stroke-dasharray="7 6"' : ""}/>`; return; }
      const pts = []; for (let k = 0; k <= N; k++) { const x = xMin + xs * k / N; const y = q.fn({ x }); pts.push([sx(x), Number.isFinite(y) ? sy(y) : NaN]); }
      g += path(pts, q.color, q.strict);
    });
    fns.forEach(f => {
      const a = f.domain && Number.isFinite(f.domain[0]) ? f.domain[0] : xMin, b = f.domain && Number.isFinite(f.domain[1]) ? f.domain[1] : xMax;
      const pts = []; for (let k = 0; k <= 600; k++) { const x = a + (b - a) * k / 600; const y = f.fn({ x }); pts.push([sx(x), Number.isFinite(y) ? sy(y) : NaN]); }
      g += path(pts, f.color, f.dashed);
    });
    params.forEach(p => { const pts = []; for (let k = 0; k <= 500; k++) { const t = p.t[0] + (p.t[1] - p.t[0]) * k / 500; const x = p.fx({ t, theta: t }), y = p.fy({ t, theta: t }); pts.push([sx(x), sy(y)]); } g += path(pts, p.color, false); });
    polars.forEach(p => { const pts = []; for (let k = 0; k <= 600; k++) { const t = p.t[0] + (p.t[1] - p.t[0]) * k / 600; const r = p.fr({ t, theta: t }); pts.push([sx(r * Math.cos(t)), sy(r * Math.sin(t))]); } g += path(pts, p.color, false); });

    // ---- geometry ----
    const centroidOf = ps => [ps.reduce((s, q) => s + q[0], 0) / ps.length, ps.reduce((s, q) => s + q[1], 0) / ps.length];
    const out = (px, py, cx, cy, dist) => { const dx = px - cx, dy = py - cy, l = Math.hypot(dx, dy) || 1; return [px + dx / l * dist, py + dy / l * dist]; };
    polys.forEach((p, i) => {
      const color = colorOf(p.color, i);
      const closed = p.closed !== false && p.pts.length > 2;
      const P = p.pts.map(q => [sx(q[0]), sy(q[1])]);
      g += `<${closed ? "polygon" : "polyline"} points="${P.map(q => `${f2(q[0])},${f2(q[1])}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"/>`;
      const c = centroidOf(P);
      arr(p.vertexLabels).forEach((lab, k) => { if (P[k] && lab != null) { const o = out(P[k][0], P[k][1], c[0], c[1], 14); g += text(o[0], o[1] + 4, lab, { cls: "mv-tb" }); } });
      arr(p.sideLabels).forEach((lab, k) => {
        const a = P[k], b = P[(k + 1) % P.length];
        if (a && b && lab != null && (closed || k < P.length - 1)) { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], o = out(m[0], m[1], c[0], c[1], 13); g += text(o[0], o[1] + 4, pretty(lab)); }
      });
      if (p.label) g += text(c[0], c[1] + 4, p.label);
    });
    circles.forEach((c, i) => {
      const color = colorOf(c.color, i), cx = sx(c.c0[0]), cy = sy(c.c0[1]);
      g += `<ellipse cx="${f2(cx)}" cy="${f2(cy)}" rx="${f2(c.r / xs * pw)}" ry="${f2(c.r / ys * ph)}" fill="none" stroke="${color}" stroke-width="2.4"${c.dashed ? ' stroke-dasharray="7 6"' : ""}/>`;
      if (c.label) g += text(cx, cy - c.r / ys * ph - 8, c.label);
    });
    const markerIds = new Set();
    segs.forEach((s, i) => {
      const color = colorOf(s.color, i + 1);
      let mk = "";
      if (s.arrow) { const mid = `${id}a${markerIds.size}`; markerIds.add(mid); defs.push(arrowDef(mid, color)); mk = ` marker-end="url(#${mid})"`; }
      g += `<line x1="${f2(sx(s.a[0]))}" y1="${f2(sy(s.a[1]))}" x2="${f2(sx(s.b[0]))}" y2="${f2(sy(s.b[1]))}" stroke="${color}" stroke-width="2.4" stroke-linecap="round"${s.dashed ? ' stroke-dasharray="7 6"' : ""}${mk}/>`;
      if (s.label != null && s.label !== "") {
        const mx = (sx(s.a[0]) + sx(s.b[0])) / 2, my = (sy(s.a[1]) + sy(s.b[1])) / 2;
        const dx = sx(s.b[0]) - sx(s.a[0]), dy = sy(s.b[1]) - sy(s.a[1]), l = Math.hypot(dx, dy) || 1;
        g += text(mx + dy / l * 13, my - dx / l * 13 + 4, pretty(s.label));
      }
    });
    angles.forEach((a, i) => {
      const color = colorOf(a.color, i + 3), vx = sx(a.v[0]), vy = sy(a.v[1]);
      const u1 = [sx(a.p1[0]) - vx, sy(a.p1[1]) - vy], u2 = [sx(a.p2[0]) - vx, sy(a.p2[1]) - vy];
      const a1 = Math.atan2(u1[1], u1[0]), a2 = Math.atan2(u2[1], u2[0]);
      let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI;
      const r = a.right ? 16 : 24;
      if (a.right) {
        const e1 = [Math.cos(a1) * r, Math.sin(a1) * r], e2 = [Math.cos(a2) * r, Math.sin(a2) * r];
        g += `<path d="M${f2(vx + e1[0])},${f2(vy + e1[1])} L${f2(vx + e1[0] + e2[0])},${f2(vy + e1[1] + e2[1])} L${f2(vx + e2[0])},${f2(vy + e2[1])}" fill="none" stroke="${color}" stroke-width="1.8"/>`;
      } else {
        g += `<path d="M${f2(vx + Math.cos(a1) * r)},${f2(vy + Math.sin(a1) * r)} A${r},${r} 0 0 ${d > 0 ? 1 : 0} ${f2(vx + Math.cos(a2) * r)},${f2(vy + Math.sin(a2) * r)}" fill="none" stroke="${color}" stroke-width="1.8"/>`;
      }
      if (a.label) { const mid = a1 + d / 2; g += text(vx + Math.cos(mid) * (r + 15), vy + Math.sin(mid) * (r + 15) + 4, a.label); }
    });

    // ---- points + free text ----
    points.forEach((p, i) => {
      const color = colorOf(p.color, i), px = sx(p.x), py = sy(p.y);
      g += `<circle cx="${f2(px)}" cy="${f2(py)}" r="5" fill="${p.open ? "none" : color}" stroke="${color}" stroke-width="2.2"/>`;
      if (p.label != null && p.label !== "") g += text(px + 8, py - 8, pretty(p.label), { anchor: "start" });
    });
    texts.forEach(t => { g += text(sx(t.x), sy(t.y) + 4, pretty(t.text)); });

    // ---- legend ----
    const legend = [];
    fns.forEach(f => legend.push({ color: f.color, label: f.label != null ? f.label : "y = " + pretty(f.expr.replace(/^\s*[a-zA-Z]\w*(\(\s*x\s*\))?\s*=\s*/, "")), dashed: f.dashed }));
    ineqs.forEach(q => { if (q.expr != null || q.vertical != null) legend.push({ color: q.color, label: q.vertical != null ? `x ${q.op} ${q.vertical}` : `y ${q.op} ${pretty(q.expr)}`, dashed: q.strict }); });
    params.forEach(p => legend.push({ color: p.color, label: p.label != null ? p.label : pretty(p.expr) }));
    polars.forEach(p => legend.push({ color: p.color, label: p.label != null ? p.label : pretty(p.expr) }));
    const shown = legend.filter(l => l.label !== "").slice(0, 6);
    if (shown.length && spec.legend !== false) {
      const lw = Math.min(300, 40 + Math.max(...shown.map(l => l.label.length)) * 7);
      g += `<rect x="${L + 8}" y="${Tp + 8}" width="${lw}" height="${shown.length * 20 + 8}" rx="8" style="fill:${T ? T.bg : "var(--mv-legend,rgba(15,15,15,0.72))"}" fill-opacity="${T ? 0.85 : 1}"/>`;
      shown.forEach((l, k) => {
        const yy = Tp + 22 + k * 20;
        g += `<line x1="${L + 16}" x2="${L + 36}" y1="${yy - 4}" y2="${yy - 4}" stroke="${l.color}" stroke-width="3"${l.dashed ? ' stroke-dasharray="5 4"' : ""}/>` + text(L + 44, yy, l.label, { anchor: "start", halo: false });
      });
    }
    if (spec.title) g += text(W / 2, 24, spec.title, { cls: "mv-tb", halo: false });

    return wrapSvg(W, H, `<defs>${defs.join("")}</defs>${g}`, T);
  }

  /* ------------------------------ number line ------------------------------ */
  function renderNumberLine(spec, T) {
    const id = "mv" + (++uid);
    const W = 640, L = 36, R = 36, pw = W - L - R;
    const pts = arr(spec.points).map(p => ({ ...p, value: num(p.value, NaN) })).filter(p => Number.isFinite(p.value)).slice(0, 30);
    const ivs = arr(spec.intervals).slice(0, 8);
    const arcs = arr(spec.arcs).map(a => ({ ...a, from: num(a.from, NaN), to: num(a.to, NaN) })).filter(a => Number.isFinite(a.from) && Number.isFinite(a.to)).slice(0, 10);
    const denom = Math.max(0, Math.min(16, Math.floor(num(spec.denominator, 0))));

    const vals = pts.map(p => p.value).concat(arcs.flatMap(a => [a.from, a.to]));
    ivs.forEach(iv => { if (!isNil(iv.from)) vals.push(num(iv.from, 0)); if (!isNil(iv.to)) vals.push(num(iv.to, 0)); });
    let min = num(spec.min, NaN), max = num(spec.max, NaN);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      const lo = vals.length ? Math.min(...vals) : -5, hi = vals.length ? Math.max(...vals) : 5;
      const pad = Math.max(1, Math.ceil((hi - lo) * 0.25));
      min = Number.isFinite(min) ? min : Math.floor(lo - pad); max = Number.isFinite(max) ? max : Math.ceil(hi + pad);
      if (!vals.length) { min = -5; max = 5; }
    }
    if (max <= min) max = min + 1;
    const span = max - min;
    let step = num(spec.step, 0);
    if (denom) step = 1 / denom; else if (!(step > 0)) step = niceStep(span, 10);
    if (span / step > 60) step = niceStep(span, 12);

    const arcRoom = arcs.length ? 100 : 0;
    const top = (spec.title ? 40 : 18) + (ivs.length ? 28 : 0) + arcRoom;
    const ly = top + 34, H = ly + 60;
    const sx = v => L + (v - min) / span * pw;
    let g = "";
    const defs = [];

    g += `<line class="mv-axis" x1="${L - 18}" x2="${W - R + 18}" y1="${ly}" y2="${ly}" marker-start="url(#${id}s)" marker-end="url(#${id}e)"/>`;
    defs.push(`<marker id="${id}e" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>`);
    defs.push(`<marker id="${id}s" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="currentColor"/></marker>`);

    const custom = new Map(arr(spec.labels).map(l => [Math.round(num(l.value, NaN) / step * 1000) / 1000, l.text]));
    const ticks = [];
    for (let k = Math.ceil(min / step - 1e-9); k * step <= max + 1e-9; k++) ticks.push({ v: k * step, k });
    const every = ticks.length > 24 ? Math.ceil(ticks.length / 16) : 1;
    ticks.forEach((t, idx) => {
      const x = sx(t.v), major = denom ? t.k % denom === 0 : true;
      g += `<line class="mv-axis" x1="${f2(x)}" x2="${f2(x)}" y1="${ly - (major ? 8 : 5)}" y2="${ly + (major ? 8 : 5)}"/>`;
      if (idx % every) return;
      let label = custom.get(t.k);
      if (label == null) label = denom ? fracLabel(t.k, denom) : fmt(t.v, step);
      if (label !== "") g += text(x, ly + 26, label, { cls: major ? "" : "mv-ts", halo: false });
    });

    // intervals (solution sets) above the line
    ivs.forEach((iv, i) => {
      const color = colorOf(iv.color, i), y = ly - 18 - i * 0;
      // an end sitting on the window edge (x < 2 written as from:-5 on a -5..5 line) means "keeps going": draw an arrow
      const noFrom = isNil(iv.from) || num(iv.from, min) <= min, noTo = isNil(iv.to) || num(iv.to, max) >= max;
      const a = noFrom ? L - 18 : sx(num(iv.from, min)), b = noTo ? W - R + 18 : sx(num(iv.to, max));
      g += `<line x1="${f2(a)}" x2="${f2(b)}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="5" stroke-linecap="butt"/>`;
      if (noFrom) g += `<path d="M${f2(a - 2)},${y - 8} L${f2(a - 14)},${y} L${f2(a - 2)},${y + 8} z" fill="${color}"/>`;
      if (noTo) g += `<path d="M${f2(b + 2)},${y - 8} L${f2(b + 14)},${y} L${f2(b + 2)},${y + 8} z" fill="${color}"/>`;
      if (!noFrom) g += `<circle cx="${f2(a)}" cy="${y}" r="6" ${holeAttr(iv.fromOpen, color, T)} stroke="${color}" stroke-width="2.4"/>`;
      if (!noTo) g += `<circle cx="${f2(b)}" cy="${y}" r="6" ${holeAttr(iv.toOpen, color, T)} stroke="${color}" stroke-width="2.4"/>`;
      if (iv.label) g += text((a + b) / 2, y - 12, pretty(iv.label));
      g += `<line x1="${f2(a)}" x2="${f2(a)}" y1="${y + 6}" y2="${ly - 2}" stroke="${color}" stroke-opacity=".35" stroke-dasharray="3 3"${noFrom ? ' visibility="hidden"' : ""}/><line x1="${f2(b)}" x2="${f2(b)}" y1="${y + 6}" y2="${ly - 2}" stroke="${color}" stroke-opacity=".35" stroke-dasharray="3 3"${noTo ? ' visibility="hidden"' : ""}/>`;
    });

    // hops / arcs (counting on a number line)
    arcs.forEach((a, i) => {
      const color = colorOf(a.color, i + 1), x1 = sx(a.from), x2 = sx(a.to), h = Math.min(80, 26 + Math.abs(x2 - x1) * 0.22), dir = a.below ? 1 : -1;
      const mk = `${id}h${i}`; defs.push(arrowDef(mk, color));
      const cy = ly + dir * (h * 2 - 4);
      g += `<path d="M${f2(x1)},${ly + dir * 4} Q${f2((x1 + x2) / 2)},${f2(cy)} ${f2(x2)},${ly + dir * 4}" fill="none" stroke="${color}" stroke-width="2.4" marker-end="url(#${mk})"/>`;
      if (a.label != null && a.label !== "") g += text((x1 + x2) / 2, ly + dir * (h + 4) + (dir < 0 ? -6 : 16), pretty(a.label), { cls: "mv-tb" });
    });

    pts.forEach((p, i) => {
      const color = colorOf(p.color, i), x = sx(p.value);
      g += `<circle cx="${f2(x)}" cy="${ly}" r="6.5" ${holeAttr(p.open, color, T)} stroke="${color}" stroke-width="2.6"/>`;
      if (p.label != null && p.label !== "") g += text(x, ly - 14, pretty(p.label), { cls: "mv-tb" });
    });
    if (spec.title) g += text(W / 2, 24, spec.title, { cls: "mv-tb", halo: false });
    return wrapSvg(W, H, `<defs>${defs.join("")}</defs>${g}`, T);
  }

  /* ------------------------------ fraction models ------------------------------ */
  function renderFractions(spec, T) {
    const items = (arr(spec.items).length ? arr(spec.items) : [spec]).slice(0, 6).map(it => ({
      n: Math.max(0, Math.floor(num(it.numerator, 1))), d: Math.max(1, Math.min(24, Math.floor(num(it.denominator, 2)))),
      shape: it.shape === "circle" ? "circle" : "bar", label: it.label, color: it.color,
    }));
    const W = 640, cols = items.length > 1 && items.every(i => i.shape === "circle") ? Math.min(3, items.length) : (items.length > 3 ? 2 : 1);
    const rows = Math.ceil(items.length / cols), cellW = (W - 40) / cols;
    const rowHs = [];
    for (let r = 0; r < rows; r++) rowHs.push(items.slice(r * cols, (r + 1) * cols).some(i => i.shape === "circle") ? 170 : 96);
    const top = spec.title ? 42 : 16, H = top + rowHs.reduce((a, b) => a + b, 0) + 8;
    let g = "";
    items.forEach((it, idx) => {
      const c = idx % cols, r = Math.floor(idx / cols), x0 = 20 + c * cellW, y0 = top + rowHs.slice(0, r).reduce((a, b) => a + b, 0), color = colorOf(it.color, idx);
      const n = Math.min(it.n, it.d);
      const label = it.label != null ? it.label : `${it.n}/${it.d}`;
      if (it.shape === "circle") {
        const R = 56, cx = x0 + cellW / 2, cy = y0 + R + 4;
        for (let k = 0; k < it.d; k++) {
          const a1 = -Math.PI / 2 + k * 2 * Math.PI / it.d, a2 = -Math.PI / 2 + (k + 1) * 2 * Math.PI / it.d;
          const d = it.d === 1
            ? `M${cx - R},${cy} a${R},${R} 0 1,0 ${2 * R},0 a${R},${R} 0 1,0 ${-2 * R},0`
            : `M${f2(cx)},${f2(cy)} L${f2(cx + R * Math.cos(a1))},${f2(cy + R * Math.sin(a1))} A${R},${R} 0 ${(a2 - a1) > Math.PI ? 1 : 0} 1 ${f2(cx + R * Math.cos(a2))},${f2(cy + R * Math.sin(a2))} Z`;
          g += `<path d="${d}" fill="${color}" fill-opacity="${k < n ? 0.85 : 0.08}" stroke="currentColor" stroke-opacity=".7" stroke-width="1.6"/>`;
        }
        g += text(cx, y0 + 2 * R + 22, label, { cls: "mv-tb", halo: false });
      } else {
        const bw = Math.min(360, cellW - 20), bh = 42, bx = x0 + (cellW - bw) / 2, by = y0 + 6;
        for (let k = 0; k < it.d; k++) g += `<rect x="${f2(bx + k * bw / it.d)}" y="${by}" width="${f2(bw / it.d)}" height="${bh}" fill="${color}" fill-opacity="${k < n ? 0.85 : 0.08}" stroke="currentColor" stroke-opacity=".7" stroke-width="1.6"/>`;
        g += text(bx + bw / 2, by + bh + 22, label, { cls: "mv-tb", halo: false });
      }
    });
    if (spec.title) g += text(W / 2, 26, spec.title, { cls: "mv-tb", halo: false });
    return wrapSvg(W, H, g, T);
  }

  /* --------------------------------- dispatch --------------------------------- */
  const KINDS = { plane: "Graph", numberline: "Number line", fraction: "Fractions" };
  function normalizeType(spec) {
    const t = String(spec.type || "").toLowerCase().replace(/[\s_-]/g, "");
    if (["numberline", "number"].includes(t)) return "numberline";
    if (["fraction", "fractions", "fractionmodel"].includes(t)) return "fraction";
    if (["plane", "function", "functions", "graph", "geometry", "coordinateplane", "cartesian", "polar", "parametric", "diagram", ""].includes(t)) return "plane";
    throw new Error(`I don't know the visual type "${spec.type}"`);
  }
  function svgFor(spec, T) {
    const type = normalizeType(spec);
    return { type, svg: type === "numberline" ? renderNumberLine(spec, T) : type === "fraction" ? renderFractions(spec, T) : renderPlane(spec, T) };
  }
  // JSON.parse, but forgiving about what AIs often write: trailing commas, // comments, single quotes,
  // unquoted keys, Python True/False/None, stray text around the object, and "\sin" style backslashes
  function parseLoose(raw) {
    if (typeof raw !== "string") return raw;
    let t = raw.trim();
    try { return JSON.parse(t); } catch (_) {}
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a > 0 || (b !== -1 && b < t.length - 1)) { if (a !== -1 && b > a) t = t.slice(a, b + 1); }
    t = t.replace(/^\s*\/\/.*$/gm, "").replace(/([,{\[]\s*)\/\/[^\n]*$/gm, "$1").replace(/\/\*[\s\S]*?\*\//g, "");
    if (!/"/.test(t)) t = t.replace(/'/g, '"');
    t = t.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
    t = t.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
    t = t.replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(t); } catch (_) {}
    t = t.replace(/\\(?!["\\\/bfnrtu])/g, "\\\\");                 // "\sin(x)" -> "\\sin(x)"
    return JSON.parse(t);
  }

  function parseSpec(raw) {
    const spec = typeof raw === "string" ? parseLoose(raw) : raw;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("the data was incomplete or malformed.");
    return spec;
  }

  function errorBox(msg) {
    const box = document.createElement("div");
    box.className = "study-block study-error";
    box.textContent = `I couldn't draw this math visual: ${msg} Try asking for it again.`;
    return box;
  }

  const isLight = () => document.body.classList.contains("light") || document.documentElement.classList.contains("light");

  function savePng(spec, name) {
    const T = isLight()
      ? { color: "#111111", bg: "#ffffff", halo: "rgba(255,255,255,0.9)" }
      : { color: "#f0f0f0", bg: "#141416", halo: "rgba(20,20,22,0.85)" };
    const { svg } = svgFor(spec, T);
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    const w = +m[1], h = +m[2], scale = 2;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = w * scale; c.height = h * scale;
      const ctx = c.getContext("2d");
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      c.toBlob(b => {
        if (!b) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = (name || "math-visual").replace(/[^\w-]+/g, "_") + ".png";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }, "image/png");
    };
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  // Full block with a toolbar (for chat replies)
  function build(raw) {
    let spec, out;
    try { spec = parseSpec(raw); out = svgFor(spec); }
    catch (e) { return errorBox(e instanceof SyntaxError ? "the data was incomplete or malformed." : e.message); }
    const block = document.createElement("div");
    block.className = "study-block mathviz-block";
    const bar = document.createElement("div");
    bar.className = "chart-toolbar";
    const kind = document.createElement("span");
    kind.className = "chart-kind";
    kind.textContent = KINDS[out.type] || "Graph";
    const dl = document.createElement("button");
    dl.type = "button"; dl.className = "code-btn"; dl.title = "Download as an image";
    dl.innerHTML = '<i class="fa-solid fa-image"></i> <span>Save PNG</span>';
    dl.addEventListener("click", () => {
      savePng(spec, spec.title || KINDS[out.type]);
      const label = dl.querySelector("span"); label.textContent = "Saved";
      setTimeout(() => { label.textContent = "Save PNG"; }, 1600);
    });
    bar.append(kind, dl);
    const wrap = document.createElement("div");
    wrap.className = "mathviz-svg";
    wrap.innerHTML = out.svg;
    block.append(bar, wrap);
    return block;
  }

  // Just the picture (for quiz questions / flashcards)
  function buildInline(raw) {
    const wrap = document.createElement("div");
    wrap.className = "mathviz-svg mv-inline";
    try { wrap.innerHTML = svgFor(parseSpec(raw)).svg; }
    catch (e) { return null; }
    return wrap;
  }

  // Short text stand-in for copy / download / read aloud
  function toText(raw) {
    try { const s = parseSpec(raw); return `[${KINDS[normalizeType(s)] || "Math visual"}${s.title ? ": " + s.title : ""}]`; }
    catch (_) { return "[Math visual]"; }
  }

  // True when a code block's text is a drawable spec (used to draw it even if the AI labelled the block "json", "graph", ...)
  function looksLikeSpec(rawText) {
    let o;
    try { o = parseLoose(String(rawText)); } catch (_) { return false; }
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    const t = String(o.type || "").toLowerCase().replace(/[\s_-]/g, "");
    if (["graph", "plane", "function", "functions", "geometry", "numberline", "fraction", "fractions", "coordinateplane", "cartesian", "mathviz"].includes(t)) return true;
    return ["functions", "inequalities", "areas", "parametric", "polar", "intervals", "arcs", "polygons", "circles", "angles"].some(k => Array.isArray(o[k]));
  }

  window.agent1102MathViz = { build, buildInline, toText, compile, looksLikeSpec, parseLoose, _svgFor: svgFor };
})();
