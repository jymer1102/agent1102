// ============================================================
//  "Download all files (.zip)" for a reply that contains several code files.
//    extractFiles(markdown)  finds every code block that is really a file and gives it a sensible name
//    makeZip(files)          builds the .zip itself (no library: it works offline and loads nothing from a CDN)
//  render.js shows the button under a reply when two or more files are found.
// ============================================================
(function () {
  "use strict";

  /* ---------------------------------------------------------- */
  /*  The .zip file                                              */
  /*  Files are stored uncompressed: code is small, and a plain  */
  /*  stored zip opens everywhere (Windows, macOS, Linux, phones) */
  /* ---------------------------------------------------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function dosStamp(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  // files: [{ name, content }] (content is a string or a Uint8Array)  ->  Uint8Array holding the .zip
  function makeZip(files, now) {
    const enc = new TextEncoder();
    const { time, date } = dosStamp(now || new Date());
    const parts = [], central = [];
    let offset = 0;

    files.forEach(f => {
      const name = enc.encode(f.name);
      const data = typeof f.content === "string" ? enc.encode(f.content) : f.content;
      const crc = crc32(data);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);   // local file header
      lv.setUint16(4, 20, true);           // version needed
      lv.setUint16(6, 0x0800, true);       // flag: the name is UTF-8 (accents, other alphabets)
      lv.setUint16(8, 0, true);            // method 0 = stored
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); // compressed size
      lv.setUint32(22, data.length, true); // size
      lv.setUint16(26, name.length, true);
      local.set(name, 30);
      parts.push(local, data);

      const cen = new Uint8Array(46 + name.length);
      const cv = new DataView(cen.buffer);
      cv.setUint32(0, 0x02014b50, true);   // central directory entry
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);      // where this file's local header starts
      cen.set(name, 46);
      central.push(cen);

      offset += local.length + data.length;
    });

    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);     // end of central directory
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0;
    all.forEach(p => { out.set(p, at); at += p.length; });
    return out;
  }

  const toBlob = (files, now) => new Blob([makeZip(files, now)], { type: "application/zip" });

  /* ---------------------------------------------------------- */
  /*  Finding the files in a reply                               */
  /* ---------------------------------------------------------- */
  // Languages that are drawings / study widgets in this app, never files
  const WIDGET_LANGS = new Set(["chart", "chartjs", "chart.js", "chart-json", "mathviz", "mathgraph", "math-visual", "quiz", "flashcards",
    "graph", "plot", "geometry", "numberline", "math", "desmos"]);
  // Blocks like these are usually something to read or a command to run, so they are only a file when they are named
  const UNNAMED_SKIP = new Set(["", "text", "plaintext", "txt", "console", "output", "log", "terminal", "diff", "patch", "bash", "sh", "shell",
    "zsh", "fish", "powershell", "ps1", "bat", "batch", "cmd", "shell-session", "sh-session"]);

  const EXTS = "html|htm|css|scss|sass|less|js|mjs|cjs|jsx|ts|tsx|json|jsonc|md|txt|py|java|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|kt|sh|bat|ps1|sql|" +
    "yml|yaml|xml|toml|ini|cfg|conf|env|csv|tsv|svg|vue|svelte|lua|dart|r|pl|scala|hs|gradle|properties|lock";
  const BARE = "Dockerfile|Makefile|Procfile|Gemfile|Rakefile|\\.gitignore|\\.dockerignore|\\.env(?:\\.[\\w-]+)?|\\.eslintrc|\\.prettierrc|\\.babelrc|\\.npmrc";
  const NAME = "(?:[\\w@.-]+/)*(?:[\\w@][\\w@.-]*\\.(?:" + EXTS + ")|" + BARE + ")";
  const NAME_ONLY = new RegExp("^" + NAME + "$", "i");
  // "Node.js", "Vue.js"... are names of tools, not files
  const FRAMEWORK = /^(?:node|next|nuxt|vue|react|express|d3|p5|three|chart|angular|ember|backbone|socket|alpine|anime|moment|lodash|deno)\.js$/i;
  const isName = s => NAME_ONLY.test(s) && !FRAMEWORK.test(s);

  // "```js title="app.js"", "```js:app.js", "```index.html", "```js app.js"  ->  { lang, name }
  function parseInfo(info) {
    let lang = "", name = "";
    if (!info) return { lang, name };
    const attr = /(?:^|\s)(?:title|filename|file|name|path)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i.exec(info);
    if (attr) name = attr[1] || attr[2] || attr[3];
    const toks = info.replace(/^\{|\}$/g, "").split(/\s+/).filter(Boolean);
    const first = toks[0] || "";
    const colon = /^([\w+#.-]+):(\S.*)$/.exec(first);
    if (colon) { lang = colon[1]; if (!name && isName(colon[2])) name = colon[2]; }
    else if (isName(first)) { if (!name) name = first; lang = first.split(".").pop(); }
    else lang = first.replace(/[{},]/g, "");
    if (!name) {
      for (const t of toks.slice(1)) {
        const c = t.replace(/^["'{]+|["'},:]+$/g, "");
        if (isName(c)) { name = c; break; }
      }
    }
    return { lang: lang.toLowerCase(), name };
  }

  // A first line like  // app.js   # server.py   <!-- index.html -->   /* style.css */   /  "filename: app.js"
  function nameFromFirstLine(code) {
    const first = (String(code).split("\n")[0] || "").trim();
    const m = /^(?:\/\/|#|--|;|%|<!--|\/\*)\s*(?:file(?:name)?\s*:\s*)?(\S+?)\s*(?:-->|\*\/)?$/i.exec(first);
    return m && isName(m[1]) ? m[1] : "";
  }

  // The line just above the code block: "index.html", "**index.html**", "### index.html", "1. index.html:",
  // "File: index.html" or a short sentence ending in a colon with the file name in `code` or **bold**
  function nameFromLine(line) {
    const text = String(line || "").trim();
    if (!text) return "";
    const bare = text.replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/, "").replace(/[*_`]/g, "")
      .replace(/^(?:file(?:name)?|path)\s*:\s*/i, "").replace(/\s*[:：]\s*$/, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (isName(bare)) return bare;
    if (text.length <= 120 && /[:：]\s*$/.test(text)) {
      const re = new RegExp("(?:`|\\*\\*|__)(" + NAME + ")(?:`|\\*\\*|__)", "gi");
      let m, found = "";
      while ((m = re.exec(text))) if (!FRAMEWORK.test(m[1])) found = m[1];
      return found;
    }
    return "";
  }

  // Keeps a path inside the zip: no "..", no leading slash, no odd characters
  function cleanPath(p) {
    return String(p).replace(/\\/g, "/").split("/")
      .map(seg => seg.trim()).filter(seg => seg && seg !== "." && seg !== "..")
      .map(seg => seg.replace(/[^\w@.\- ]+/g, "_").replace(/^\.{2,}/, "_").slice(0, 100))
      .filter(Boolean).join("/").slice(0, 200);
  }

  const MAX_FILES = 100;

  // "app.js" + 2 -> "app-2.js";  "src/app.js" -> "src/app-2.js";  ".gitignore" -> ".gitignore-2"
  function withSuffix(name, n) {
    const slash = name.lastIndexOf("/") + 1, base = name.slice(slash), dot = base.lastIndexOf(".");
    return dot > 0 ? name.slice(0, slash) + base.slice(0, dot) + "-" + n + base.slice(dot) : name + "-" + n;
  }

  // -> [{ name, content, lang }]  (extFor: language -> file extension, used when a block has no name)
  function extractFiles(md, extFor) {
    const lines = String(md == null ? "" : md).split(/\r?\n/);
    const out = [];
    const used = new Map(); // lower-case name -> how many times
    let lastText = "";      // the last line of text above the next code block

    for (let i = 0; i < lines.length && out.length < MAX_FILES; i++) {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
      if (!open || (open[1][0] === "`" && open[2].includes("`"))) { if (lines[i].trim()) lastText = lines[i]; continue; }
      const fence = open[1];
      const close = new RegExp("^ {0,3}" + (fence[0] === "`" ? "`" : "~") + "{" + fence.length + ",}\\s*$");
      const body = [];
      let j = i + 1;
      for (; j < lines.length && !close.test(lines[j]); j++) body.push(lines[j]);
      const code = body.join("\n").replace(/\s+$/, "");
      const above = lastText;
      lastText = "";
      i = j;
      if (!code.trim()) continue;

      const { lang, name: infoName } = parseInfo(open[2].trim());
      if (WIDGET_LANGS.has(lang)) continue;
      const mathviz = window.agent1102MathViz;
      if (mathviz && ["", "json"].includes(lang) && mathviz.looksLikeSpec(code)) continue; // a drawing, not a file

      let name = infoName || nameFromFirstLine(code) || nameFromLine(above);
      if (!name) {
        const ext = extFor ? extFor(lang) : "";
        if (UNNAMED_SKIP.has(lang) || !ext) continue;
        name = "file-" + (out.length + 1) + "." + ext;
      }
      name = cleanPath(name);
      if (!name) continue;

      const key = name.toLowerCase();
      if (used.has(key)) {
        if (out.some(f => f.name.toLowerCase() === key && f.content === code + "\n")) continue; // the same file shown twice
        const n = used.get(key) + 1;
        used.set(key, n);
        name = withSuffix(name, n);
        used.set(name.toLowerCase(), 1);
      } else used.set(key, 1);

      out.push({ name, content: code + "\n", lang });
    }
    return out;
  }

  window.agent1102Zip = { crc32, makeZip, toBlob, extractFiles, parseInfo, nameFromLine, nameFromFirstLine, cleanPath };
})();
