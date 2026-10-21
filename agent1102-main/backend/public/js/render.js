// ============================================================
//  Message rendering
//  - user messages: gray bubble + copy button
//  - AI messages: no bubble, markdown, code boxes, charts,
//    and read-aloud / copy / download buttons
// ============================================================
(function () {
  "use strict";

  /* ---------------------------------------------------------- */
  /*  Small helpers                                              */
  /* ---------------------------------------------------------- */
  function el(tag, cls, html) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function toast(msg) { if (typeof showToast === "function") showToast(msg); }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback for non-secure contexts / older browsers
      try {
        const ta = el("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (_) { return false; }
    }
  }

  function downloadFile(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function setBtn(btn, icon, label) {
    btn.innerHTML = `<i class="fa-solid ${icon}"></i>` + (label ? ` <span>${label}</span>` : "");
  }

  function makeBtn(cls, icon, label, title) {
    const b = el("button", cls);
    b.type = "button";
    b.title = title || label || "";
    b.setAttribute("aria-label", title || label || "");
    setBtn(b, icon, label);
    return b;
  }

  // Briefly swap a button to a green "done" state
  function flash(btn, icon, label, doneLabel) {
    btn.classList.add("copied");
    setBtn(btn, "fa-check", doneLabel);
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      btn.classList.remove("copied");
      setBtn(btn, icon, label);
    }, 1600);
  }

  function timestamp() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  const fmt = v => {
    if (!Number.isFinite(v)) return String(v);
    return (Math.round(v * 100) / 100).toLocaleString();
  };

  /* ---------------------------------------------------------- */
  /*  Attached files                                             */
  /*  Code/text files are stored inside the message text as      */
  /*  <attached_file name="..."> blocks so they persist in saved */
  /*  chats. The chat shows them as small chips, not raw text.   */
  /* ---------------------------------------------------------- */
  const FILE_RE = /<attached_file name="([^"]*)">\n([\s\S]*?)\n<\/attached_file>\n*/g;

  function parseAttachedFiles(text) {
    const files = [];
    const rest = String(text).replace(FILE_RE, (_, name, body) => {
      files.push({ name, lines: body.replace(/\n+$/, "").split("\n").length });
      return "";
    });
    return { files, rest: rest.trim() };
  }

  // Picks a file-chip icon based on the attachment's name (works for plain
  // files and for "zipname/path/inside.ext" names produced by zip extraction).
  function fileChipIcon(name) {
    const base = String(name).split("/").pop() || "";
    const ext = (base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "").toLowerCase();
    if (ext === "pdf") return "fa-file-pdf";
    if (ext === "zip") return "fa-file-zipper";
    if (["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "svg"].includes(ext)) return "fa-file-image";
    return "fa-file-code";
  }

  /* ---------------------------------------------------------- */
  /*  "Generate an image" detection                              */
  /*  Returns null (not an image request) or { prompt }          */
  /*  (prompt is "" when the user didn't say what to draw).      */
  /* ---------------------------------------------------------- */
  const IMG_NOUN = "(?:images?|pictures?|pics?|photos?|photographs?|drawings?|illustrations?|paintings?|artworks?|art|logos?|wallpapers?|posters?|portraits?|icons?|sketch(?:es)?|renders?|avatars?|memes?)";
  const NOT_AN_IMAGE = /\b(code|script|function|program|python|javascript|typescript|html|css|java|sql|regex|chart|graph|table|diagram|api|app|website|classifier|classification|pytorch|tensorflow|keras|opencv|dataset|algorithm|library|framework|sdk|database|component|node\.?js|react|django|flask)\b/i;
  // Questions and how-to requests are never "please draw this"
  const QUESTION_START = /^\s*(?:how|what|whats|what's|why|when|where|which|who|is|are|was|were|does|do|did|should|explain|tell me|describe|write|help|teach|show me how|can you explain|could you explain)\b/i;
  // "an image classifier", "a picture viewer"... the noun is part of a bigger thing, not a picture request
  const COMPOUND_AFTER = /^\s*(?:classifier|classification|generator|resizer|viewer|editor|gallery|carousel|slider|upload|uploader|processing|recognition|detection|segmentation|captioning|dataset|format|file|library|sensor|compression|converter|tool|pipeline)\b/i;

  function tidyPrompt(s) {
    return String(s || "").replace(/^[\s:,\-–]+/, "").replace(/^(of|showing|depicting|featuring)\s+/i, "").replace(/[\s.!?]+$/, "").trim();
  }

  function parseImageRequest(raw) {
    const t = String(raw || "").trim();
    if (!t) return null;

    // Explicit command: /image a red car on a beach
    let m = t.match(/^\/(?:image|imagine|img|draw)\b\s*([\s\S]*)$/i);
    if (m) return { prompt: tidyPrompt(m[1]) };

    if (NOT_AN_IMAGE.test(t) || QUESTION_START.test(t)) return null;

    // "generate / create / make / design ... an image of ..."
    m = t.match(new RegExp("\\b(?:generate|create|make|produce|render|design|draw|paint)\\b(?:\\s+me|\\s+us)?(?:\\s+(?:an?|some|another|one))?((?:\\s+[\\w-]+){0,3}?)\\s+" + IMG_NOUN + "\\b\\s*(?:of|showing|depicting|featuring|with|about|for|that|where|:|-)?\\s*([\\s\\S]*)$", "i"));
    if (m && COMPOUND_AFTER.test(m[2])) return null;
    if (m) {
      const subject = tidyPrompt(m[2]);
      const style = m[1].trim();
      return { prompt: subject ? (style ? subject + ", " + style : subject) : "" };
    }

    // "show me / give me a picture of ..."
    m = t.match(new RegExp("\\b(?:show|give)\\s+me\\s+(?:an?\\s+)?(?:[\\w-]+\\s+){0,2}" + IMG_NOUN + "\\s+of\\s+([\\s\\S]+)$", "i"));
    if (m) return { prompt: tidyPrompt(m[1]) };

    // "draw / paint / sketch / illustrate me a dragon"
    m = t.match(/^(?:please\s+|pls\s+|can you\s+|could you\s+|can u\s+)*(?:draw|paint|sketch|illustrate)\b(?:\s+me|\s+us)?\s+([\s\S]+)$/i);
    if (m) return { prompt: tidyPrompt(m[1]) };

    return null;
  }

  /* ---------------------------------------------------------- */
  /*  "/edit" (image editing) command detection                  */
  /* ---------------------------------------------------------- */
  function parseImageEditRequest(raw) {
    const t = String(raw || "").trim();
    const m = t.match(/^\/edit\b\s*([\s\S]*)$/i);
    return m ? { prompt: tidyPrompt(m[1]) } : null;
  }

  // A short, single-line title for the sidebar
  function historyTitle(msg) {
    let text = "";
    if (typeof msg.content === "string") text = msg.content;
    else if (Array.isArray(msg.content)) text = msg.content.filter(p => p && p.type === "text").map(p => p.text).join(" ");
    const parsed = parseAttachedFiles(text);
    const title = parsed.rest || (parsed.files[0] ? "File: " + parsed.files[0].name : "Image message");
    return title.replace(/\s+/g, " ").slice(0, 40);
  }

  /* ---------------------------------------------------------- */
  /*  Code boxes (copy / download just the code)                 */
  /* ---------------------------------------------------------- */
  const FILE_EXT = {
    javascript: "js", js: "js", jsx: "jsx", typescript: "ts", ts: "ts", tsx: "tsx", node: "js",
    python: "py", py: "py", html: "html", css: "css", scss: "scss", json: "json",
    java: "java", c: "c", cpp: "cpp", "c++": "cpp", csharp: "cs", "c#": "cs", cs: "cs",
    go: "go", rust: "rs", rs: "rs", ruby: "rb", rb: "rb", php: "php", swift: "swift",
    kotlin: "kt", kt: "kt", bash: "sh", sh: "sh", shell: "sh", zsh: "sh",
    powershell: "ps1", ps1: "ps1", sql: "sql", yaml: "yml", yml: "yml", xml: "xml",
    markdown: "md", md: "md", r: "r", lua: "lua", dart: "dart", perl: "pl", scala: "scala",
    haskell: "hs", matlab: "m", bat: "bat", batch: "bat", toml: "toml", ini: "ini", csv: "csv",
    text: "txt", plaintext: "txt", txt: "txt",
  };

  const HTML_LANGS = ["html", "htm", "xhtml"];

  // One accent color per language (loosely GitHub's linguist palette), so a
  // Python block, a JS block, a shell block etc. are visually distinct at a
  // glance, the same way file icons differ by type in an IDE.
  const LANG_COLOR = {
    javascript: "#f1e05a", js: "#f1e05a", jsx: "#f1e05a", mjs: "#f1e05a", cjs: "#f1e05a", node: "#f1e05a",
    typescript: "#3178c6", ts: "#3178c6", tsx: "#3178c6",
    python: "#3572a5", py: "#3572a5", pyw: "#3572a5",
    html: "#e34c26", htm: "#e34c26", xhtml: "#e34c26",
    css: "#563d7c", scss: "#c6538c", sass: "#a53b70", less: "#1d365d",
    json: "#cbcb41", json5: "#cbcb41", jsonl: "#cbcb41",
    java: "#b07219",
    c: "#a8b9cc", h: "#a8b9cc",
    cpp: "#f34b7d", "c++": "#f34b7d", cc: "#f34b7d", cxx: "#f34b7d", hpp: "#f34b7d",
    csharp: "#178600", cs: "#178600", "c#": "#178600",
    go: "#00add8",
    rust: "#dea584", rs: "#dea584",
    ruby: "#e9573f", rb: "#e9573f",
    php: "#8892bf",
    swift: "#f05138",
    kotlin: "#a97bff", kt: "#a97bff",
    bash: "#89e051", sh: "#89e051", shell: "#89e051", zsh: "#89e051", fish: "#89e051",
    powershell: "#6da8dd", ps1: "#6da8dd", bat: "#6da8dd", batch: "#6da8dd",
    sql: "#e38cd7",
    yaml: "#cb171e", yml: "#cb171e",
    xml: "#61a6e6",
    markdown: "#4c9bd8", md: "#4c9bd8",
    r: "#198ce7",
    lua: "#7896c9",
    dart: "#00b4ab",
    perl: "#0298c3", pl: "#0298c3",
    scala: "#c22d40",
    haskell: "#5e5086", hs: "#5e5086",
    matlab: "#e16737",
    toml: "#9c4221",
    ini: "#6d8086", cfg: "#6d8086", conf: "#6d8086",
    csv: "#3fb950", tsv: "#3fb950",
    dockerfile: "#61dafb",
    graphql: "#e10098", gql: "#e10098",
    vue: "#41b883", svelte: "#ff3e00",
    diff: "#e0883d", patch: "#e0883d",
  };
  const langColor = lang => LANG_COLOR[lang] || "#9aa0a6";

  function buildCodeBlock(text, lang) {
    const cleanLang = /^[\w+#.-]{1,20}$/.test(lang || "") ? lang.toLowerCase() : "";
    const shown = String(text).replace(/\n$/, "");
    const isHtml = HTML_LANGS.includes(cleanLang);
    const color = langColor(cleanLang);

    const box = el("div", "code-block");
    box.style.setProperty("--lang-color", color);
    const head = el("div", "code-header");
    const langWrap = el("span", "code-lang-wrap");
    const dot = el("span", "code-lang-dot");
    dot.style.background = color;
    const label = el("span", "code-lang");
    label.style.color = color;
    label.textContent = cleanLang || "code";
    langWrap.append(dot, label);

    const actions = el("div", "code-actions");
    const previewBtn = isHtml ? makeBtn("code-btn", "fa-eye", "Preview", "Preview this HTML") : null;
    const copyBtn = makeBtn("code-btn", "fa-copy", "Copy", "Copy code");
    const dlBtn = makeBtn("code-btn", "fa-download", "Download", "Download code");

    copyBtn.addEventListener("click", async () => {
      if (await copyText(shown)) flash(copyBtn, "fa-copy", "Copy", "Copied");
      else toast("I couldn't copy that. Your browser blocked it.");
    });
    dlBtn.addEventListener("click", () => {
      const ext = FILE_EXT[cleanLang] || "txt";
      downloadFile(`agent1102-code.${ext}`, shown + "\n");
      flash(dlBtn, "fa-download", "Download", "Saved");
    });

    const pre = el("pre");
    const code = el("code");
    if (cleanLang) code.className = "language-" + cleanLang;
    code.textContent = shown;
    pre.appendChild(code);

    if (previewBtn) {
      let previewing = false;
      let frame = null;
      previewBtn.addEventListener("click", () => {
        previewing = !previewing;
        if (previewing) {
          if (!frame) {
            frame = el("iframe", "code-preview-frame");
            frame.setAttribute("sandbox", "allow-scripts allow-forms allow-modals allow-popups");
            frame.srcdoc = shown;
          }
          pre.replaceWith(frame);
          setBtn(previewBtn, "fa-code", "View Code");
          previewBtn.title = "View the code";
        } else {
          frame.replaceWith(pre);
          setBtn(previewBtn, "fa-eye", "Preview");
          previewBtn.title = "Preview this HTML";
        }
      });
    }

    actions.append(...[previewBtn, copyBtn, dlBtn].filter(Boolean));
    head.append(langWrap, actions);

    box.append(head, pre);
    return box;
  }

  /* ---------------------------------------------------------- */
  /*  Charts                                                     */
  /* ---------------------------------------------------------- */
  const CHART_LANGS = ["chart", "chartjs", "chart.js", "chart-json"];
  const MATH_LANGS = ["mathviz", "mathgraph", "math-visual"];

  // The drawing code lives in js/mathviz.js. If the page didn't load it (old index.html, file in the wrong
  // folder, stale cache), load it now instead of showing the drawing data as a code block.
  let mathvizLoading = null;
  function ensureMathViz() {
    if (window.agent1102MathViz) return Promise.resolve(window.agent1102MathViz);
    if (!mathvizLoading) {
      mathvizLoading = new Promise((resolve, reject) => {
        const sc = document.createElement("script");
        sc.src = new URL("js/mathviz.js?v=" + Date.now(), document.baseURI).href;
        sc.onload = () => (window.agent1102MathViz ? resolve(window.agent1102MathViz) : reject(new Error("mathviz.js ran but did not define the drawer")));
        sc.onerror = () => reject(new Error("js/mathviz.js could not be loaded"));
        document.head.appendChild(sc);
      });
      mathvizLoading.catch(() => { mathvizLoading = null; });
    }
    return mathvizLoading;
  }
  function lazyMathBlock(text) {
    const box = el("div", "study-block mathviz-block");
    box.textContent = "Drawing...";
    ensureMathViz().then(mv => { box.replaceWith(mv.build(text)); scrollChat(); })
      .catch(err => { console.error("Graph drawing failed:", err); box.className = "study-block study-error"; box.textContent = "I couldn't draw this graph. Refresh the page and try again."; });
    return box;
  }
  const TYPE_MAP = {
    bar: "bar", column: "bar", line: "line",
    pie: "pie", doughnut: "doughnut", donut: "doughnut",
    radar: "radar", spider: "radar", web: "radar",
  };
  const TYPE_LABEL = { bar: "Bar chart", line: "Line chart", pie: "Pie chart", doughnut: "Donut chart", radar: "Radar chart" };
  const PALETTE = ["#4f8cff", "#ff7a59", "#2ecc71", "#f5c542", "#a06cd5", "#1fc7c7", "#ff5d8f", "#8fb339", "#e08a1e", "#7a8cff"];

  const toNumber = v => {
    if (typeof v === "number") return v;
    if (typeof v === "string") return Number(v.replace(/[,$%\s]/g, ""));
    return NaN;
  };

  // Validates the chart the AI sent. Throws a readable Error if anything is off,
  // so we never draw a chart with wrong or misaligned numbers.
  function normalizeChartSpec(raw) {
    if (!raw || typeof raw !== "object") throw new Error("the chart data isn't an object.");

    // Accept Chart.js-style { type, data: { labels, datasets } } as well
    if (raw.data && !Array.isArray(raw.data) && Array.isArray(raw.data.labels)) {
      raw = { ...raw, labels: raw.data.labels, datasets: raw.data.datasets, title: raw.title || raw.options?.plugins?.title?.text };
    }
    // Accept the shorthand { labels, data: [...] }
    if (!Array.isArray(raw.datasets) && Array.isArray(raw.data)) {
      raw = { ...raw, datasets: [{ label: raw.label || raw.yLabel || "", data: raw.data }] };
    }

    const typeKey = String(raw.type || "").toLowerCase().replace(/[^a-z]/g, "").replace(/(chart|graph)$/, "");
    const type = TYPE_MAP[typeKey];
    if (!type) throw new Error(`unsupported chart type "${raw.type}". Use bar, line, pie, doughnut or radar.`);

    if (!Array.isArray(raw.labels) || raw.labels.length === 0) throw new Error("there are no labels.");
    if (!Array.isArray(raw.datasets) || raw.datasets.length === 0) throw new Error("there is no data.");
    if (raw.labels.length > 60) throw new Error("too many labels (max 60).");

    const labels = raw.labels.map(String);
    const circular = type === "pie" || type === "doughnut";
    const source = circular ? raw.datasets.slice(0, 1) : raw.datasets.slice(0, 10);

    const datasets = source.map((d, i) => {
      const values = Array.isArray(d) ? d : d && d.data;
      if (!Array.isArray(values)) throw new Error(`dataset ${i + 1} has no data array.`);
      if (values.length !== labels.length) {
        throw new Error(`dataset ${i + 1} has ${values.length} values but there are ${labels.length} labels.`);
      }
      const nums = values.map(toNumber);
      const bad = nums.findIndex(n => !Number.isFinite(n));
      if (bad !== -1) throw new Error(`"${values[bad]}" (${labels[bad]}) isn't a number.`);
      if (circular && nums.some(n => n < 0)) throw new Error("pie and donut charts can't have negative values.");
      let label = d && !Array.isArray(d) && d.label ? String(d.label) : "";
      if (!label) label = source.length > 1 ? `Series ${i + 1}` : String(raw.yLabel || "Value");
      return { label, data: nums };
    });

    if (circular && datasets[0].data.reduce((a, b) => a + b, 0) <= 0) {
      throw new Error("all the values are zero, so there's nothing to draw.");
    }

    return {
      type,
      title: raw.title ? String(raw.title) : "",
      labels,
      datasets,
      xLabel: raw.xLabel ? String(raw.xLabel) : "",
      yLabel: raw.yLabel ? String(raw.yLabel) : "",
    };
  }

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function themeColors() {
    const light = document.body.classList.contains("light");
    return light
      ? { light, text: "#1f1f1f", muted: "#666666", grid: "rgba(0,0,0,0.10)", edge: "#ffffff", bg: "#ffffff" }
      : { light, text: "#ececec", muted: "#a3a3a3", grid: "rgba(255,255,255,0.12)", edge: "#171717", bg: "#171717" };
  }

  // Draws the actual numbers on bars and the percentages on pie / donut slices
  const valueLabelPlugin = {
    id: "agent1102ValueLabels",
    afterDatasetsDraw(chart) {
      const type = chart.config.type;
      if (type !== "bar" && type !== "pie" && type !== "doughnut") return;
      const ctx = chart.ctx;
      const t = themeColors();
      ctx.save();
      ctx.font = "600 12px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";

      if (type === "bar") {
        if (chart.data.labels.length * chart.data.datasets.length <= 30) {
          ctx.fillStyle = t.text;
          chart.data.datasets.forEach((ds, di) => {
            const meta = chart.getDatasetMeta(di);
            if (meta.hidden) return;
            meta.data.forEach((bar, i) => {
              const v = ds.data[i];
              if (!Number.isFinite(v)) return;
              ctx.textBaseline = v < 0 ? "top" : "bottom";
              ctx.fillText(fmt(v), bar.x, v < 0 ? bar.y + 4 : bar.y - 4);
            });
          });
        }
      } else {
        const ds = chart.data.datasets[0];
        const meta = chart.getDatasetMeta(0);
        const total = ds.data.reduce((a, b) => a + b, 0);
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = "rgba(0,0,0,0.6)";
        ctx.shadowBlur = 4;
        meta.data.forEach((arc, i) => {
          if (!chart.getDataVisibility(i) || !total) return;
          const pct = ds.data[i] / total;
          if (pct < 0.04) return; // too thin to fit a label
          const a = (arc.startAngle + arc.endAngle) / 2;
          const r = (arc.innerRadius + arc.outerRadius) / 2;
          ctx.fillText((pct * 100).toFixed(1) + "%", arc.x + Math.cos(a) * r, arc.y + Math.sin(a) * r);
        });
      }
      ctx.restore();
    },
  };

  function chartConfig(spec, animate) {
    const t = themeColors();
    const circular = spec.type === "pie" || spec.type === "doughnut";

    const datasets = spec.datasets.map((d, i) => {
      const c = PALETTE[i % PALETTE.length];
      if (circular) {
        return { label: d.label, data: d.data, backgroundColor: spec.labels.map((_, j) => PALETTE[j % PALETTE.length]), borderColor: t.edge, borderWidth: 2, hoverOffset: 8 };
      }
      if (spec.type === "bar") {
        return { label: d.label, data: d.data, backgroundColor: hexToRgba(c, 0.85), borderColor: c, borderWidth: 1, borderRadius: 6, maxBarThickness: 64 };
      }
      if (spec.type === "line") {
        return { label: d.label, data: d.data, borderColor: c, backgroundColor: c, borderWidth: 2.5, tension: 0.3, pointRadius: 4, pointHoverRadius: 6, fill: false };
      }
      return { label: d.label, data: d.data, borderColor: c, backgroundColor: hexToRgba(c, 0.2), pointBackgroundColor: c, pointBorderColor: c, borderWidth: 2, pointRadius: 3 };
    });

    const circTotal = circular ? spec.datasets[0].data.reduce((a, b) => a + b, 0) : 0;
    const pctOf = v => (circTotal ? ((v / circTotal) * 100).toFixed(1) : "0.0") + "%";

    const legendLabels = { color: t.text, usePointStyle: true, boxWidth: 9, boxHeight: 9, padding: 14, font: { size: 12 } };
    if (circular) {
      legendLabels.generateLabels = chart => {
        const gen = (Chart.overrides.doughnut && Chart.overrides.doughnut.plugins.legend.labels.generateLabels)
          || Chart.defaults.plugins.legend.labels.generateLabels;
        const items = gen(chart);
        items.forEach(it => {
          const v = chart.data.datasets[0].data[it.index];
          it.text = `${it.text}: ${fmt(v)} (${pctOf(v)})`;
          it.fontColor = t.text;
        });
        return items;
      };
    }

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: animate ? { duration: 700 } : false,
      layout: { padding: { top: spec.type === "bar" ? 18 : 4, right: 6 } },
      plugins: {
        title: { display: !!spec.title, text: spec.title, color: t.text, font: { size: 16, weight: "600" }, padding: { bottom: 12 } },
        legend: { display: true, position: circular ? "bottom" : "top", labels: legendLabels },
        tooltip: circular
          ? { callbacks: { label: c => ` ${c.label}: ${fmt(c.parsed)} (${pctOf(c.parsed)})` } }
          : {},
      },
    };

    if (spec.type === "bar" || spec.type === "line") {
      options.scales = {
        x: {
          ticks: { color: t.muted, maxRotation: 45 },
          grid: { color: t.grid },
          title: { display: !!spec.xLabel, text: spec.xLabel, color: t.muted },
        },
        y: {
          beginAtZero: spec.type === "bar",
          grace: "8%",
          ticks: { color: t.muted },
          grid: { color: t.grid },
          title: { display: !!spec.yLabel, text: spec.yLabel, color: t.muted },
        },
      };
    } else if (spec.type === "radar") {
      options.scales = {
        r: {
          beginAtZero: true,
          angleLines: { color: t.grid },
          grid: { color: t.grid },
          pointLabels: { color: t.text, font: { size: 12 } },
          ticks: { color: t.muted, backdropColor: "transparent", maxTicksLimit: 6 },
        },
      };
    }

    return { type: spec.type, data: { labels: spec.labels, datasets }, options, plugins: [valueLabelPlugin] };
  }

  const liveCharts = new Set();

  function drawChart(entry, animate) {
    if (entry.chart) entry.chart.destroy();
    Chart.defaults.font.family = "Inter, system-ui, sans-serif";
    entry.chart = new Chart(entry.canvas, chartConfig(entry.spec, animate));
  }

  // Re-draw charts when the light/dark theme is toggled so text stays readable
  let lastLight = document.body.classList.contains("light");
  new MutationObserver(() => {
    const light = document.body.classList.contains("light");
    if (light === lastLight) return;
    lastLight = light;
    liveCharts.forEach(entry => {
      if (!entry.canvas.isConnected) { if (entry.chart) entry.chart.destroy(); liveCharts.delete(entry); return; }
      drawChart(entry, false);
    });
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  function downloadChartPng(entry) {
    const src = entry.chart.canvas;
    const out = el("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    ctx.fillStyle = themeColors().bg;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, 0, 0);
    const slug = (entry.spec.title || "chart").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "chart";
    out.toBlob(blob => { if (blob) downloadFile(`agent1102-${slug}.png`, blob); }, "image/png");
  }

  function chartError(rawText, message) {
    const box = el("div", "chart-error");
    box.innerHTML = `<div class="chart-error-msg"><i class="fa-solid fa-triangle-exclamation"></i> I couldn't draw this chart: ${escapeHtml(message)}</div>`;
    box.appendChild(buildCodeBlock(rawText, "json"));
    return box;
  }

  function buildChartBlock(rawText) {
    let spec;
    try {
      spec = normalizeChartSpec(JSON.parse(rawText));
    } catch (e) {
      return chartError(rawText, e instanceof SyntaxError ? "the chart data was incomplete or malformed." : e.message);
    }
    if (typeof Chart === "undefined") {
      return chartError(rawText, "the chart library didn't load. Check your connection and refresh the page.");
    }

    const block = el("div", "chart-block");
    const bar = el("div", "chart-toolbar");
    const kind = el("span", "chart-kind");
    kind.textContent = TYPE_LABEL[spec.type];
    const dl = makeBtn("code-btn", "fa-image", "Save PNG", "Download chart as an image");
    bar.append(kind, dl);

    const wrap = el("div", "chart-canvas-wrap");
    const canvas = el("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${TYPE_LABEL[spec.type]}${spec.title ? ": " + spec.title : ""}`);
    wrap.appendChild(canvas);
    block.append(bar, wrap);

    const entry = { canvas, spec, chart: null };
    liveCharts.add(entry);
    dl.addEventListener("click", () => { if (entry.chart) { downloadChartPng(entry); flash(dl, "fa-image", "Save PNG", "Saved"); } });

    // Chart.js needs the canvas to be in the page before it can measure it,
    // so the actual drawing happens after the message is attached (see renderInto)
    block._entry = entry;
    return block;
  }

  /* ---------------------------------------------------------- */
  /*  Generated images                                           */
  /* ---------------------------------------------------------- */
  const GEN_IMAGE_HOST = "image.pollinations.ai";

  function isGeneratedImageUrl(src) {
    try {
      const u = new URL(src, location.href);
      if (u.protocol !== "https:") return false;
      // Pollinations-generated images, or /edit results saved in our storage bucket
      return u.hostname === GEN_IMAGE_HOST || u.pathname.startsWith("/storage/v1/object/public/chat-uploads/");
    } catch (_) { return false; }
  }

  function scrollChat() {
    const chat = document.getElementById("chat");
    if (chat) chat.scrollTop = chat.scrollHeight;
  }

  function buildImageCard(src, alt) {
    const card = el("figure", "image-card");
    const frame = el("div", "image-frame loading");
    const status = el("div", "image-status");
    const im = el("img");
    im.alt = alt;
    im.decoding = "async";
    frame.append(status, im);

    const caption = el("figcaption");
    caption.textContent = alt;

    const actions = el("div", "image-actions");
    const dl = makeBtn("code-btn", "fa-download", "Download", "Download image");
    actions.appendChild(dl);
    card.append(frame, caption, actions);

    let attempt = 0;
    function load() {
      frame.classList.remove("failed");
      frame.classList.add("loading");
      status.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> <span>Generating your image… this can take a few seconds</span>';
      im.src = attempt ? src + (src.includes("?") ? "&" : "?") + "retry=" + Date.now() : src;
    }
    im.addEventListener("load", () => { frame.classList.remove("loading", "failed"); card.classList.add("ready"); scrollChat(); });
    im.addEventListener("error", () => {
      frame.classList.remove("loading");
      frame.classList.add("failed");
      status.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> <span>I couldn\'t load the image. The free image service allows about one image every 15 seconds, so wait a moment and try again.</span>';
      const retry = makeBtn("code-btn", "fa-rotate-right", "Try again", "Try again");
      retry.addEventListener("click", () => { attempt++; load(); });
      status.appendChild(retry);
    });

    dl.addEventListener("click", async () => {
      try {
        const r = await fetch(im.currentSrc || im.src, { cache: "force-cache" });
        if (!r.ok) throw new Error("bad response");
        const blob = await r.blob();
        const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[blob.type] || "jpg";
        downloadFile(`agent1102-image-${timestamp()}.${ext}`, blob);
        flash(dl, "fa-download", "Download", "Saved");
      } catch (_) {
        window.open(im.currentSrc || im.src, "_blank", "noopener");
        toast("Opened the image in a new tab. Right-click or long-press it to save.");
      }
    });

    load();
    return card;
  }

  /* ---------------------------------------------------------- */
  /*  Link preview cards                                         */
  /*  Any external link the AI shares (or a standalone link on   */
  /*  its own line) is shown as a small card with an Open button */
  /*  rather than auto-loading its content.                      */
  /* ---------------------------------------------------------- */
  const linkPreviewCache = new Map(); // url -> Promise<preview>
  function fetchLinkPreview(href) {
    if (!linkPreviewCache.has(href)) {
      const p = fetch(`${BACKEND_URL}/link-preview?url=${encodeURIComponent(href)}`)
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
      linkPreviewCache.set(href, p);
    }
    return linkPreviewCache.get(href);
  }

  function buildLinkCard(href, label) {
    let hostname = href;
    try { hostname = new URL(href, location.href).hostname.replace(/^www\./, ""); } catch (_) {}
    const fallbackTitle = (label || "").trim();

    const card = el("div", "link-card loading");
    const image = el("div", "link-card-image");
    const row = el("div", "link-card-row");
    const icon = el("div", "link-card-icon");
    icon.innerHTML = '<i class="fa-solid fa-link"></i>';
    const body = el("div", "link-card-body");
    const title = el("div", "link-card-title");
    title.textContent = fallbackTitle && fallbackTitle !== href ? fallbackTitle : hostname;
    const host = el("div", "link-card-host");
    host.textContent = hostname;
    body.append(title, host);
    const open = makeBtn("code-btn link-card-open", "fa-arrow-up-right-from-square", "Open", "Open link");
    open.addEventListener("click", () => window.open(href, "_blank", "noopener"));
    row.append(icon, body, open);
    const desc = el("div", "link-card-desc");
    desc.style.padding = "0 0.7rem 0.6rem";
    card.append(image, row, desc);

    fetchLinkPreview(href).then(info => {
      card.classList.remove("loading");
      if (!info) return;
      if (info.title) title.textContent = info.title;
      if (info.siteName) host.textContent = info.siteName === hostname ? hostname : `${info.siteName} · ${hostname}`;
      if (info.description) desc.textContent = info.description;
      if (info.image) {
        // Load through an <img> first so a broken image never leaves an empty box.
        const probe = new Image();
        probe.referrerPolicy = "no-referrer";
        probe.onload = () => {
          image.style.backgroundImage = `url("${info.image.replace(/"/g, "%22")}")`;
          card.classList.add("has-image");
          scrollChat();
        };
        probe.src = info.image;
      }
    });
    return card;
  }

  /* ---------------------------------------------------------- */
  /*  Math (KaTeX)                                               */
  /*  Delimiters: \( ... \) inline, $$ ... $$ or \[ ... \] block. */
  /*  Plain single $ is never treated as math, so prices like     */
  /*  "$5 to $10" are never misread as a formula.                 */
  /* ---------------------------------------------------------- */
  const MATH_OPEN = "\uE010", MATH_CLOSE = "\uE011"; // private-use markers; markdown/DOMPurify treat them as plain text

  // Swaps fenced code blocks / inline code for placeholders so math delimiters
  // inside code (e.g. a LaTeX example in a code sample) are never touched.
  function protectCode(text) {
    const saved = [];
    const put = s => { saved.push(s); return MATH_OPEN + "CODE" + (saved.length - 1) + MATH_CLOSE; };
    let out = text.replace(/```[\s\S]*?```/g, put).replace(/`[^`\n]+`/g, put);
    return { out, restore: s => s.replace(/\uE010CODE(\d+)\uE011/g, (_, i) => saved[+i]) };
  }

  // Pulls $$...$$, \[...\] and \(...\) out of markdown text and replaces each with a
  // placeholder token, so marked/DOMPurify pass them through untouched as plain text.
  function extractMath(markdown) {
    const { out: codeProtected, restore } = protectCode(markdown);
    const found = [];
    const stash = (display, tex) => { found.push({ display, tex }); return MATH_OPEN + "MATH" + (found.length - 1) + MATH_CLOSE; };
    let out = codeProtected
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => stash(true, tex))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => stash(true, tex))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => stash(false, tex));
    return { text: restore(out), math: found };
  }

  // Renders one TeX string to a sanitized <span>. Never throws: bad TeX becomes
  // a small inline error rather than breaking the whole message.
  function renderMathSpan(tex, display) {
    const span = el("span", display ? "math-display" : "math-inline");
    if (typeof katex === "undefined") { span.textContent = display ? `$$${tex}$$` : `\\(${tex}\\)`; return span; }
    try {
      const html = katex.renderToString(tex, { throwOnError: true, displayMode: display, output: "html", strict: "ignore", maxSize: 500, maxExpand: 1000 });
      span.innerHTML = (typeof DOMPurify !== "undefined") ? DOMPurify.sanitize(html) : html;
    } catch (e) {
      span.className += " math-error";
      span.title = "I couldn't display this formula.";
      span.textContent = display ? `$$${tex}$$` : `(${tex})`;
    }
    return span;
  }

  // Walks the rendered DOM and swaps each placeholder for its KaTeX span.
  // Skips text inside <code>/<pre> as a second line of defense.
  function renderMathIn(root, mathList) {
    if (!mathList.length) return;
    const re = /\uE010MATH(\d+)\uE011/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement && n.parentElement.closest("code, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const hits = [];
    let node;
    while ((node = walker.nextNode())) { if (re.test(node.nodeValue)) hits.push(node); }

    hits.forEach(node => {
      const frag = document.createDocumentFragment();
      const parts = node.nodeValue.split(/\uE010MATH(\d+)\uE011/);
      parts.forEach((part, i) => {
        if (i % 2 === 0) { if (part) frag.appendChild(document.createTextNode(part)); return; }
        const m = mathList[+part];
        if (!m) { frag.appendChild(document.createTextNode(part)); return; }
        frag.appendChild(renderMathSpan(m.tex, m.display));
      });
      node.parentNode.replaceChild(frag, node);
    });
  }

    /* ---------------------------------------------------------- */
  /*  Markdown -> DOM                                            */
  /* ---------------------------------------------------------- */
  function enhance(root) {
    const pending = [];

    // Images: only our own generated images are loaded. Anything else an AI reply
    // points to becomes a plain link (auto-loading arbitrary URLs can leak data).
    root.querySelectorAll("img").forEach(img => {
      const src = img.getAttribute("src") || "";
      const parent = img.parentElement;
      const soleChild = parent && (parent.tagName === "P" || parent.tagName === "LI") && parent.childNodes.length === 1;
      if (isGeneratedImageUrl(src)) {
        const card = buildImageCard(src, img.getAttribute("alt") || "Generated image");
        if (soleChild) parent.replaceWith(card); else img.replaceWith(card);
      } else if (/^https?:/i.test(src)) {
        // Not our own image: never auto-load it (privacy). Show a small
        // link-preview card instead, same idea as a generated image.
        const card = buildLinkCard(src, img.getAttribute("alt") || "");
        if (soleChild) parent.replaceWith(card); else img.replaceWith(card);
      } else {
        img.remove();
      }
    });

    root.querySelectorAll("pre").forEach(pre => {
      const codeEl = pre.querySelector("code");
      const text = (codeEl || pre).textContent;
      const m = codeEl && /(?:^|\s)language-(\S+)/.exec(codeEl.className);
      const lang = m ? m[1] : "";

      const study = window.agent1102Study;
      if (study && lang.toLowerCase() === "quiz") {
        pre.replaceWith(study.buildQuiz(text));
      } else if (study && lang.toLowerCase() === "flashcards") {
        pre.replaceWith(study.buildFlashcards(text));
      } else if (!window.agent1102MathViz && MATH_LANGS.includes(lang.toLowerCase())) {
        pre.replaceWith(lazyMathBlock(text));
      } else if (window.agent1102MathViz && (MATH_LANGS.includes(lang.toLowerCase()) ||
                 (["", "json", "graph", "plot", "geometry", "numberline", "math", "desmos"].includes(lang.toLowerCase()) && window.agent1102MathViz.looksLikeSpec(text)))) {
        pre.replaceWith(window.agent1102MathViz.build(text));
      } else if (CHART_LANGS.includes(lang.toLowerCase())) {
        const block = buildChartBlock(text);
        if (block._entry) pending.push(block._entry);
        pre.replaceWith(block);
      } else {
        pre.replaceWith(buildCodeBlock(text, lang));
      }
    });

    // A drawing spec the AI forgot to put in a code block (bare JSON in a paragraph) is still drawn
    if (window.agent1102MathViz) {
      root.querySelectorAll("p").forEach(p => {
        const t = p.textContent.trim();
        if (t.length > 30 && t[0] === "{" && t[t.length - 1] === "}" && window.agent1102MathViz.looksLikeSpec(t)) {
          p.replaceWith(window.agent1102MathViz.build(t));
        }
      });
    }

    root.querySelectorAll("table").forEach(table => {
      const wrap = el("div", "table-wrap");
      table.replaceWith(wrap);
      wrap.appendChild(table);
    });

    // Links that sit on their own (alone in a paragraph / list item, or one per line)
    // become preview cards. Links inside a sentence stay ordinary inline links.
    const isBlank = n => n.nodeType === 3 && !n.textContent.trim();
    const isLinkish = n => n.nodeName === "BR" || isBlank(n) || (n.nodeName === "A" && /^https?:/i.test(n.getAttribute("href") || ""));
    root.querySelectorAll("p, li").forEach(block => {
      if (block.closest(".link-cards, .link-card, .code-block, .chart-block")) return;
      const kids = [...block.childNodes];
      const anchors = kids.filter(n => n.nodeName === "A");
      if (!anchors.length || !kids.every(isLinkish)) return;
      const box = el("div", "link-cards");
      const seen = new Set();
      anchors.forEach(a => {
        const href = a.href;
        if (seen.has(href)) return;
        seen.add(href);
        const text = a.textContent.trim();
        box.appendChild(buildLinkCard(href, text === a.getAttribute("href") ? "" : text));
      });
      block.replaceChildren(box);
    });

    root.querySelectorAll("a[href]").forEach(a => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });

    return pending;
  }

  function renderInto(target, markdown) {
    const md = String(markdown == null ? "" : markdown);
    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
      // Libraries didn't load: show plain, safely-escaped text rather than raw HTML
      target.style.whiteSpace = "pre-wrap";
      target.textContent = md;
      return;
    }
    // Pull out $$...$$, \[...\] and \(...\) before markdown parsing, so marked
    // doesn't mangle backslashes and DOMPurify never has to touch KaTeX's HTML.
    const { text: mdForMarked, math } = extractMath(md);

    let html;
    try { html = marked.parse(mdForMarked, { gfm: true, breaks: true }); }
    catch (_) { html = escapeHtml(md).replace(/\n/g, "<br>"); }

    target.innerHTML = DOMPurify.sanitize(html);
    renderMathIn(target, math);
    const charts = enhance(target);
    // The message is already in the page here, so charts can size themselves
    charts.forEach(entry => drawChart(entry, true));
  }

  /* ---------------------------------------------------------- */
  /*  Plain-text version of a response (for copy / download)     */
  /* ---------------------------------------------------------- */
  function chartToMarkdownTable(spec) {
    const head = ["Category", ...spec.datasets.map(d => d.label)];
    const rows = spec.labels.map((l, i) => [l, ...spec.datasets.map(d => d.data[i])]);
    const line = cells => "| " + cells.map(c => String(c).replace(/\|/g, "\\|")).join(" | ") + " |";
    return [line(head), line(head.map(() => "---")), ...rows.map(line)].join("\n");
  }

  // Chart blocks are JSON; in copied / downloaded text they become a readable table instead
  function responseToText(md) {
    const study = window.agent1102Study;
    if (study) {
      md = String(md)
        .replace(/```quiz[^\n]*\n([\s\S]*?)```/gi, (whole, body) => study.quizToText(body) || whole)
        .replace(/```flashcards[^\n]*\n([\s\S]*?)```/gi, (whole, body) => study.cardsToText(body) || whole);
    }
    md = String(md).replace(/```(?:mathviz|mathgraph|math-visual)[^\n]*\n([\s\S]*?)```/gi, (whole, body) => (window.agent1102MathViz ? window.agent1102MathViz.toText(body) : "[Math visual]"));
    return String(md).replace(/```(?:chart|chartjs|chart\.js|chart-json)[^\n]*\n([\s\S]*?)```/gi, (whole, body) => {
      try {
        const spec = normalizeChartSpec(JSON.parse(body));
        return `**${spec.title || TYPE_LABEL[spec.type]}** (${TYPE_LABEL[spec.type].toLowerCase()})\n\n${chartToMarkdownTable(spec)}\n`;
      } catch (_) { return whole; }
    });
  }

  /* ---------------------------------------------------------- */
  /*  Math -> spoken English                                     */
  /*  Reading the rendered glyphs of a formula produces garbage   */
  /*  ("x2+1" for x^2+1), so read-aloud converts the ORIGINAL      */
  /*  LaTeX source into words instead. This covers the constructs */
  /*  the system prompt asks the AI to use; anything unrecognized */
  /*  degrades gracefully to its bare words rather than throwing. */
  /* ---------------------------------------------------------- */
  const GREEK_WORDS = {
    alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta", epsilon: "epsilon", zeta: "zeta",
    eta: "eta", theta: "theta", iota: "iota", kappa: "kappa", lambda: "lambda", mu: "mu", nu: "nu",
    xi: "xi", omicron: "omicron", pi: "pi", rho: "rho", sigma: "sigma", tau: "tau", upsilon: "upsilon",
    phi: "phi", chi: "chi", psi: "psi", omega: "omega",
  };
  const MATH_WORDS = {
    pm: "plus or minus", mp: "minus or plus", times: "times", cdot: "times", ast: "times",
    div: "divided by", frac: "over",
    leq: "is less than or equal to", le: "is less than or equal to",
    geq: "is greater than or equal to", ge: "is greater than or equal to",
    neq: "is not equal to", ne: "is not equal to", approx: "is approximately",
    equiv: "is equivalent to", sim: "is similar to", propto: "is proportional to",
    infty: "infinity", partial: "partial", nabla: "del",
    forall: "for all", exists: "there exists", in: "is in", notin: "is not in",
    subset: "is a subset of", subseteq: "is a subset of or equal to",
    cup: "union", cap: "intersect", emptyset: "the empty set",
    rightarrow: "yields", to: "yields", Rightarrow: "implies",
    leftarrow: "comes from", leftrightarrow: "if and only if", Leftrightarrow: "if and only if",
    cdots: "and so on", ldots: "and so on", dots: "and so on",
    quad: " ", qquad: "  ", displaystyle: "", textstyle: "",
    left: "", right: "", begin: "", end: "",
    degree: "degrees", angle: "angle", perp: "is perpendicular to", parallel: "is parallel to",
  };
  const ROOT_WORDS = { 2: "square", 3: "cube", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth" };

  // Finds the index of the "}" that matches the "{" at s[openIdx].
  function findMatchingBrace(s, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  // Reads one LaTeX "argument" starting at index i: a {...} group (possibly
  // nested), a lone \command, or a single character.
  function readArg(s, i) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === "{") {
      const end = findMatchingBrace(s, i);
      if (end === -1) return { arg: s.slice(i + 1), next: s.length };
      return { arg: s.slice(i + 1, end), next: end + 1 };
    }
    if (s[i] === "\\") {
      const m = /^\\[a-zA-Z]+/.exec(s.slice(i));
      if (m) return { arg: m[0], next: i + m[0].length };
    }
    return { arg: s[i] || "", next: i + 1 };
  }

  // Replaces every \name{...} (or \name{...}{...}, or \sqrt[n]{...}) with build(args, optional).
  function replaceCommand(s, name, argCount, build) {
    const cmdRe = new RegExp("\\\\" + name + "(?![a-zA-Z])", "g");
    let out = "", last = 0, m;
    while ((m = cmdRe.exec(s))) {
      let i = m.index + m[0].length;
      let optional = null;
      if (name === "sqrt" && s[i] === "[") {
        const close = s.indexOf("]", i);
        if (close !== -1) { optional = s.slice(i + 1, close); i = close + 1; }
      }
      const args = [];
      for (let k = 0; k < argCount; k++) { const r = readArg(s, i); args.push(r.arg); i = r.next; }
      out += s.slice(last, m.index) + build(args, optional);
      last = i;
      cmdRe.lastIndex = i;
    }
    return out + s.slice(last);
  }

  function ordinalRootWord(nStr) {
    const n = parseInt(nStr, 10);
    if (ROOT_WORDS[n]) return ROOT_WORDS[n];
    if (Number.isFinite(n)) return `${n}th`;
    return mathToSpeech(nStr);
  }

  function speakExponent(exp) {
    const e = String(exp).trim();
    if (e === "2") return "squared";
    if (e === "3") return "cubed";
    if (/^-?\d+$/.test(e)) return `to the power of ${e}`;
    return `to the power of ${mathToSpeech(e)}`;
  }

  // ^{...} and _{...} are not backslash commands, so they get their own pass.
  function replaceScripts(s) {
    let out = "", i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "^" || c === "_") {
        const { arg, next } = readArg(s, i + 1);
        out += c === "^" ? ` ${speakExponent(arg)} ` : ` sub ${mathToSpeech(arg)} `;
        i = next;
      } else { out += c; i++; }
    }
    return out;
  }

  // A very approximate reading of mhchem \ce{...} content: formula digits,
  // reaction arrows, ionic charges, and (s)/(l)/(g)/(aq) states.
  function speakChem(inner) {
    let s = String(inner)
      .replace(/<=>|<->/g, " is in equilibrium with ")
      .replace(/->|\\rightarrow|\\to\b/g, " yields ")
      .replace(/\(\s*(s|l|g|aq)\s*\)/gi, (_, st) => ({ s: " solid ", l: " liquid ", g: " gas ", aq: " aqueous " }[st.toLowerCase()]))
      .replace(/\^\{?(\d*)\+\}?/g, (_, n) => ` ${n || "a positive"} ${n ? "plus" : ""} charge `)
      .replace(/\^\{?(\d*)-\}?/g, (_, n) => ` ${n || "a negative"} ${n ? "minus" : ""} charge `)
      .replace(/_\{?(\d+)\}?/g, " $1 ")
      .replace(/(\d+)/g, " $1 ")
      .replace(/\+/g, " plus ")
      .replace(/[{}\[\]]/g, " ");
    return ` ${s.replace(/\s+/g, " ").trim()} `;
  }

  function speakMatrices(s) {
    return s.replace(/\\begin\{[pbvB]?matrix\}[\s\S]*?\\end\{[pbvB]?matrix\}/g, " a matrix ");
  }

  function mathToSpeechImpl(tex) {
    let s = String(tex == null ? "" : tex);
    s = speakMatrices(s);
    s = replaceCommand(s, "ce", 1, ([inner]) => speakChem(inner));
    s = replaceCommand(s, "text", 1, ([inner]) => ` ${inner} `);
    s = replaceCommand(s, "mathrm", 1, ([inner]) => ` ${inner} `);
    s = replaceCommand(s, "operatorname", 1, ([inner]) => ` ${inner} `);
    s = replaceCommand(s, "mathbf", 1, ([inner]) => ` ${mathToSpeech(inner)} `);
    s = replaceCommand(s, "mathit", 1, ([inner]) => ` ${mathToSpeech(inner)} `);
    s = replaceCommand(s, "boldsymbol", 1, ([inner]) => ` ${mathToSpeech(inner)} `);
    s = replaceCommand(s, "frac", 2, ([a, b]) => ` ${mathToSpeech(a)} over ${mathToSpeech(b)} `);
    s = replaceCommand(s, "sqrt", 1, ([a], n) => n ? ` the ${ordinalRootWord(n)} root of ${mathToSpeech(a)} ` : ` the square root of ${mathToSpeech(a)} `);
    s = replaceScripts(s);
    s = s
      .replace(/\\sum/g, " the sum ")
      .replace(/\\prod/g, " the product ")
      .replace(/\\oint/g, " the contour integral ")
      .replace(/\\int/g, " the integral ")
      .replace(/\\lim/g, " the limit ");
    s = s.replace(/\\([a-zA-Z]+)/g, (_, name) => {
      const key = name.toLowerCase();
      if (GREEK_WORDS[key]) return ` ${GREEK_WORDS[key]} `;
      if (name in MATH_WORDS) return ` ${MATH_WORDS[name]} `;
      return ` ${name} `; // unrecognized command: say its name rather than dropping it silently
    });
    s = s
      .replace(/->/g, " yields ")
      .replace(/<=>|<->/g, " is in equilibrium with ")
      .replace(/[{}&]/g, " ")
      .replace(/\\/g, " ")
      .replace(/\*/g, " times ")
      .replace(/\+/g, " plus ")
      .replace(/-/g, " minus ")
      .replace(/=/g, " equals ")
      .replace(/</g, " is less than ")
      .replace(/>/g, " is greater than ");
    return s.replace(/\s+/g, " ").trim();
  }

  // Never let a formula-to-speech bug take down read-aloud for the whole message.
  function mathToSpeech(tex) {
    try { return mathToSpeechImpl(tex); }
    catch (_) { return String(tex || "").replace(/[\\{}$]/g, " ").replace(/\s+/g, " ").trim(); }
  }

  /* ---------------------------------------------------------- */
  /*  Text-to-speech                                             */
  /* ---------------------------------------------------------- */
  let ttsSession = 0;
  let ttsBtn = null;
  let voicesReadyPromise = null;

  // Chrome loads voices asynchronously; speak() called before they're ready can
  // silently do nothing on some builds. Wait briefly for "voiceschanged" once.
  function waitForVoices(timeoutMs = 300) {
    if (!("speechSynthesis" in window)) return Promise.resolve([]);
    const existing = speechSynthesis.getVoices();
    if (existing.length) return Promise.resolve(existing);
    if (voicesReadyPromise) return voicesReadyPromise;
    voicesReadyPromise = new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(speechSynthesis.getVoices()); };
      speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
      setTimeout(finish, timeoutMs); // some browsers never fire the event; don't wait forever
    });
    return voicesReadyPromise;
  }

  function pickVoice(voices) {
    const lang = navigator.language || "en-US";
    return voices.find(v => v.lang === lang) || voices.find(v => v.lang && v.lang.slice(0, 2) === lang.slice(0, 2)) || voices.find(v => v.default) || voices[0] || null;
  }

  function speakableText(markdown) {
    // Swap each formula for spoken words BEFORE stripping markdown, using the
    // original LaTeX source (not the rendered glyphs) so it reads naturally.
    const { text: withPlaceholders, math } = extractMath(String(markdown || ""));
    let text = withPlaceholders.replace(/\uE010MATH(\d+)\uE011/g, (_, i) => {
      const m = math[Number(i)];
      return m ? ` ${mathToSpeech(m.tex)} ` : "";
    });
    // Code (and our chart JSON) is unreadable aloud; drop fenced blocks entirely.
    text = text.replace(/```(?:quiz|flashcards|mathviz|mathgraph|math-visual)[^\n]*\n[\s\S]*?```/gi, " ");
    text = text.replace(/```[\s\S]*?```/g, " Code omitted. ");

    if (typeof marked === "undefined") return text.replace(/\s+/g, " ").trim();
    let html;
    try { html = marked.parse(text, { gfm: true, breaks: true }); }
    catch (_) { return text.replace(/\s+/g, " ").trim(); }

    const tmp = document.createElement("div");
    tmp.innerHTML = (typeof DOMPurify !== "undefined") ? DOMPurify.sanitize(html) : html;
    tmp.querySelectorAll("td, th").forEach(n => n.append(", "));
    tmp.querySelectorAll("li, h1, h2, h3, h4, h5, h6").forEach(n => n.append(". "));
    tmp.querySelectorAll("p, br").forEach(n => n.append(" "));
    return (tmp.textContent || "").replace(/\s+/g, " ").trim();
  }

  // Chrome silently stops long utterances, so read in sentence-sized pieces
  function chunkText(text, max = 220) {
    const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    const chunks = [];
    let cur = "";
    const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
    for (let s of sentences) {
      while (s.length > max * 1.5) {
        let cut = s.lastIndexOf(" ", max);
        if (cut < max / 2) cut = max;
        if (cur) push();
        chunks.push(s.slice(0, cut).trim());
        s = s.slice(cut);
      }
      if (cur && (cur + s).length > max) push();
      cur += s;
    }
    push();
    return chunks;
  }

  // Two read-aloud engines:
  //  1) Real audio generated by the server (ElevenLabs) and played through an
  //     <audio> element. This is NOT silenced by an iPhone's mute switch —
  //     only the volume matters — the same as any music or podcast app.
  //  2) The browser's own built-in voice (window.speechSynthesis), used only
  //     if the server route isn't configured or a request fails. On iPhone,
  //     this fallback IS silenced by the mute switch; that's an iOS
  //     restriction on that API specifically, not something a page can change.
  // Which one actually gets used is figured out on first use and remembered
  // for the rest of the page session, so a real outage doesn't retry forever.
  let serverTTSAvailable = null; // null = unknown yet, true/false once known
  let ttsAudioEl = null;
  let ttsAudioUnlocked = false;

  // A ~25ms silent clip, just long enough for iOS to register it as "played".
  const SILENT_WAV = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YZABAAA=";

  function getAudioEl() {
    if (!ttsAudioEl) {
      ttsAudioEl = new Audio();
      ttsAudioEl.setAttribute("playsinline", "true");
    }
    return ttsAudioEl;
  }

  // Must run synchronously inside the click handler, with no await before it.
  // iOS only allows an <audio> element to play without a fresh user gesture
  // once it has already played, from a real gesture, at least once — so this
  // "unlocks" the element with a silent clip, and every later play() call on
  // this same element (even from inside a fetch().then()) is then allowed.
  function unlockAudioElement() {
    if (ttsAudioUnlocked) return;
    const el = getAudioEl();
    el.src = SILENT_WAV;
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
    ttsAudioUnlocked = true;
  }

  function stopTTS() {
    ttsSession++;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (ttsAudioEl) { ttsAudioEl.pause(); ttsAudioEl.onended = null; ttsAudioEl.onerror = null; }
    if (ttsBtn) { setBtn(ttsBtn, "fa-volume-high"); ttsBtn.classList.remove("speaking"); ttsBtn.title = "Read aloud"; ttsBtn = null; }
  }

  function toggleTTS(btn, text) {
    const sameButton = ttsBtn === btn;
    stopTTS(); // synchronous: cancels anything playing, no delay before what follows
    if (sameButton) return;
    if (!text) { toast("There's nothing to read aloud in this reply."); return; }

    unlockAudioElement(); // still synchronous, still inside this click

    const session = ++ttsSession;
    ttsBtn = btn;
    btn.classList.add("speaking");
    btn.title = "Stop reading";
    setBtn(btn, "fa-spinner fa-spin"); // brief loading state while the first chunk is fetched

    if (serverTTSAvailable === false) speakWithBrowserVoice(btn, text, session);
    else speakWithServerAudio(btn, text, session);
  }

  // ElevenLabs handles a few thousand characters per call comfortably, so
  // fewer, larger chunks are used here than for the browser-voice fallback.
  function speakWithServerAudio(btn, text, session) {
    const chunks = chunkText(text, 1000);
    if (!chunks.length) { stopTTS(); return; }
    const el = getAudioEl();

    const playChunk = (i) => {
      if (session !== ttsSession) return;
      if (i >= chunks.length) { stopTTS(); return; }

      fetch(`${BACKEND_URL}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunks[i] }),
      }).then(async (res) => {
        if (session !== ttsSession) return;

        if (res.status === 501) {
          // Not configured on the server — a deployment detail, not a real
          // failure, so no toast: just quietly use the browser's own voice.
          serverTTSAvailable = false;
          speakWithBrowserVoice(btn, chunks.slice(i).join(" "), session);
          return;
        }
        if (!res.ok) {
          let msg = "I couldn't read this aloud.";
          try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) {}
          if (res.status === 429) {
            // Monthly quota used up: tell the person once, then fall back for the rest.
            serverTTSAvailable = false;
            toast(msg);
            speakWithBrowserVoice(btn, chunks.slice(i).join(" "), session);
            return;
          }
          throw new Error(msg); // a one-off server/network hiccup — try the fallback below, but don't disable server audio for later
        }

        const contentType = res.headers.get("content-type") || "";
        if (!contentType.startsWith("audio/")) {
          // A 200 response that isn't actually audio (a proxy hiccup, an
          // unrelated catch-all route) — treat like any other failure rather
          // than trying to "play" it, which would just error out noisily.
          throw new Error("I couldn't read this aloud.");
        }

        serverTTSAvailable = true;
        const blob = await res.blob();
        if (session !== ttsSession) return;
        const url = URL.createObjectURL(blob);
        el.src = url;
        el.onended = () => { URL.revokeObjectURL(url); playChunk(i + 1); };
        el.onerror = () => {
          URL.revokeObjectURL(url);
          if (session !== ttsSession) return;
          stopTTS();
          toast("I couldn't read this aloud.");
        };
        setBtn(btn, "fa-stop");
        el.play().catch(() => {
          URL.revokeObjectURL(url);
          if (session !== ttsSession) return;
          stopTTS();
          toast("I couldn't read this aloud. Try tapping the button again.");
        });
      }).catch(() => {
        // Network hiccup reaching our own server: fall back for this reply
        // without permanently giving up on server audio for next time.
        if (session !== ttsSession) return;
        speakWithBrowserVoice(btn, chunks.slice(i).join(" "), session);
      });
    };
    playChunk(0);
  }

  // Safari (and several Android/embedded Chrome builds) require speak() to be
  // called synchronously inside the click handler: once anything — an await,
  // a setTimeout, a promise callback — comes between the click and the first
  // speak(), the browser silently drops it. No error, no sound, nothing. This
  // fallback is only ever entered from toggleTTS (synchronous) or from a spot
  // in speakWithServerAudio where the element was already unlocked earlier in
  // the SAME click, so this constraint is satisfied either way. Chunking below
  // keeps each utterance under Chrome's ~15s single-utterance cutoff, so no
  // periodic pause()/resume() nudge is needed — that trick is also a known
  // cause of permanent silence on some platforms, so it's deliberately unused.
  function speakWithBrowserVoice(btn, text, session) {
    if (!("speechSynthesis" in window)) {
      if (session === ttsSession) { stopTTS(); toast("Read aloud isn't available right now."); }
      return;
    }
    const chunks = chunkText(text, 220);
    if (!chunks.length) { if (session === ttsSession) stopTTS(); return; }

    if (speechSynthesis.paused) speechSynthesis.resume(); // recover from a stuck engine

    // Best-effort voice pick using whatever the browser already has cached.
    // Never awaited: waiting here would push the first speak() past the click.
    let voice = pickVoice(speechSynthesis.getVoices());

    let i = 0;
    const speakNext = () => {
      if (session !== ttsSession) return;
      if (i >= chunks.length) { stopTTS(); return; }

      const u = new SpeechSynthesisUtterance(chunks[i]);
      try {
        if (voice) u.voice = voice;
        u.lang = (voice && voice.lang) || navigator.language || "en-US";
      } catch (_) {
        // A stale or invalid voice reference must never break read-aloud entirely;
        // fall back to the browser's own default voice for this chunk.
      }
      let started = false;
      const watchdog = setTimeout(() => {
        if (started || session !== ttsSession) return;
        stopTTS();
        toast("I couldn't read this aloud. Your browser or device may not have a voice installed.");
      }, 5000);
      u.onstart = () => { started = true; clearTimeout(watchdog); setBtn(btn, "fa-stop"); };
      u.onend = () => { clearTimeout(watchdog); i++; speakNext(); };
      u.onerror = (e) => {
        clearTimeout(watchdog);
        if (session !== ttsSession) return; // our own stopTTS() caused this; already handled
        // "interrupted"/"canceled" just mean something else stopped this utterance on purpose
        if (e && (e.error === "interrupted" || e.error === "canceled")) return;
        stopTTS();
        toast("I couldn't read this aloud. Your browser or device may not have a voice installed.");
      };
      try {
        speechSynthesis.speak(u);
      } catch (e) {
        // A handful of browsers throw synchronously instead of firing onerror;
        // without this, that exception would silently kill read-aloud entirely.
        clearTimeout(watchdog);
        stopTTS();
        toast("I couldn't read this aloud. Your browser or device may not have a voice installed.");
      }
    };
    speakNext();

    // If the voice list wasn't ready yet, refine it in the background for the
    // chunks still to come. Purely cosmetic — playback has already started.
    if (!voice) {
      waitForVoices().then(voices => { if (session === ttsSession) voice = pickVoice(voices); });
    }
  }

  /* ---------------------------------------------------------- */
  /*  Public API                                                 */
  /* ---------------------------------------------------------- */
  window.addMsg = function addMsg(role, text, imgSrc, index) {
    const chat = document.getElementById("chat");
    const isUser = role === "user";
    const content = String(text == null ? "" : text);
    const imgList = Array.isArray(imgSrc) ? imgSrc.filter(Boolean) : (imgSrc ? [imgSrc] : []);
    // Which slot in `history` this message will occupy. Callers that add a
    // message and push it onto history right afterward (live sends, the
    // greeting) can omit this — history.length at this point is correct
    // since the push hasn't happened yet. Replaying a saved chat passes it
    // explicitly (see addHistoryMsg) since the whole history array is
    // already in place by then.
    const msgIndex = typeof index === "number" ? index : (typeof history !== "undefined" && Array.isArray(history) ? history.length : null);
    const wrap = el("div", "msg-wrap " + (isUser ? "user" : "ai"));
    chat.appendChild(wrap);

    if (isUser) {
      const parsed = parseAttachedFiles(content);
      const shown = parsed.rest;
      const bubble = el("div", "msg");
      if (parsed.files.length) {
        const chips = el("div", "msg-files");
        parsed.files.forEach(f => {
          const chip = el("span", "msg-file");
          chip.innerHTML = `<i class="fa-solid ${fileChipIcon(f.name)}"></i> `;
          const name = el("span", "msg-file-name");
          name.textContent = f.name;
          const meta = el("span", "msg-file-meta");
          meta.textContent = ` · ${f.lines} line${f.lines === 1 ? "" : "s"}`;
          chip.append(name, meta);
          chips.appendChild(chip);
        });
        bubble.appendChild(chips);
      }
      if (shown) {
        const p = el("div", "msg-text");
        p.textContent = shown;
        bubble.appendChild(p);
      }
      if (imgList.length) {
        const imgs = el("div", "msg-images");
        imgList.forEach(src => {
          const img = el("img");
          img.src = src;
          img.alt = "Uploaded image";
          imgs.appendChild(img);
        });
        bubble.appendChild(imgs);
      }
      wrap.appendChild(bubble);

      // A message that is nothing but link(s) also gets preview card(s) under the bubble
      const onlyLinks = shown.trim() && !parsed.files.length && !imgList.length
        ? shown.trim().split(/\s+/) : null;
      if (onlyLinks && onlyLinks.every(t => /^https?:\/\/[^\s<>"]+$/i.test(t))) {
        const box = el("div", "link-cards");
        [...new Set(onlyLinks)].slice(0, 3).forEach(u => box.appendChild(buildLinkCard(u, "")));
        wrap.appendChild(box);
      }

      if (shown) {
        const actions = el("div", "msg-actions");
        const copyBtn = makeBtn("msg-action-btn", "fa-copy", "", "Copy message");
        copyBtn.addEventListener("click", async () => {
          if (await copyText(shown)) flash(copyBtn, "fa-copy", "", "");
          else toast("I couldn't copy that. Your browser blocked it.");
        });
        actions.appendChild(copyBtn);

        if (msgIndex != null) {
          const editBtn = makeBtn("msg-action-btn", "fa-pen", "", "Edit & resend");
          editBtn.addEventListener("click", () => {
            const inputEl = document.getElementById("input");
            if (inputEl) inputEl.value = shown;
            // Drop this message and everything after it, both on screen and
            // in history, so the edited prompt starts a fresh reply.
            if (typeof history !== "undefined" && Array.isArray(history)) history = history.slice(0, msgIndex);
            let node = wrap;
            while (node) { const next = node.nextSibling; node.remove(); node = next; }
            if (inputEl) { inputEl.focus(); inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length); }
            if (typeof saveCurrentChat === "function") saveCurrentChat();
          });
          actions.appendChild(editBtn);
        }

        wrap.appendChild(actions);
      }
    } else {
      const body = el("div", "ai-text msg-content-body");
      wrap.appendChild(body);
      renderInto(body, content);

      const actions = el("div", "msg-actions");
      const ttsButton = makeBtn("msg-action-btn", "fa-volume-high", "", "Read aloud");
      const copyBtn = makeBtn("msg-action-btn", "fa-copy", "", "Copy response");
      const dlBtn = makeBtn("msg-action-btn", "fa-download", "", "Download response");

      ttsButton.addEventListener("click", () => toggleTTS(ttsButton, speakableText(content)));
      copyBtn.addEventListener("click", async () => {
        if (await copyText(responseToText(content))) flash(copyBtn, "fa-copy", "", "");
        else toast("I couldn't copy that. Your browser blocked it.");
      });
      dlBtn.addEventListener("click", () => {
        downloadFile(`agent1102-response-${timestamp()}.md`, responseToText(content) + "\n", "text/markdown;charset=utf-8");
        flash(dlBtn, "fa-download", "", "");
      });

      actions.append(ttsButton, copyBtn, dlBtn);

      // "Try again": only when a user message came before this reply (not the greeting).
      // Drops this reply (and anything after it) and asks for a fresh one.
      const hasUserBefore = typeof history !== "undefined" && Array.isArray(history) && msgIndex != null &&
        history.slice(0, msgIndex).some(m => m && m.role === "user");
      if (hasUserBefore) {
        const retryBtn = makeBtn("msg-action-btn retry-btn", "fa-rotate-right", "", "Try again");
        retryBtn.addEventListener("click", () => {
          if (typeof window.retryFrom !== "function") return;
          retryBtn.classList.add("spinning");
          Promise.resolve(window.retryFrom(msgIndex, wrap)).finally(() => retryBtn.classList.remove("spinning"));
        });
        actions.appendChild(retryBtn);
      }
      wrap.appendChild(actions);
    }

    scrollChat();
    setTimeout(scrollChat, 60);
    return wrap;
  };

  // Re-draws one saved history entry (text, image + text, attached files, generated images)
  window.addHistoryMsg = function addHistoryMsg(m, index) {
    if (!m || m.role === "system") return null;
    if (typeof m.content === "string") return window.addMsg(m.role, m.content, null, index);
    if (Array.isArray(m.content)) {
      const urls = m.content
        .filter(p => p && p.type === "image_url" && p.image_url && typeof p.image_url.url === "string" && p.image_url.url.startsWith("data:image/"))
        .map(p => p.image_url.url);
      const text = m.content.filter(p => p && p.type === "text").map(p => p.text).join("\n");
      return window.addMsg(m.role, text, urls, index);
    }
    return null;
  };

  window.addGreeting = function addGreeting() {
    const name = localStorage.getItem("agent1102_name");
    const greeting = `Hi${name ? ` ${name}` : ""}! I'm agent1102, your personal AI assistant by jymer1102. How can I help you?`;
    window.addMsg("ai", greeting);
    if (typeof history !== "undefined" && Array.isArray(history)) {
      history.push({ role: "assistant", content: greeting });
    }
  };

  // Exposed for testing / other scripts
  window.agent1102Render = {
    normalizeChartSpec, responseToText, chunkText, parseImageRequest, parseImageEditRequest,
    parseAttachedFiles, historyTitle, escapeHtml, mathToSpeech, speakableText, extractMath, fileChipIcon,
    buildLinkCard,
  };
})();
