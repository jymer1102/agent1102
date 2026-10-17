document.addEventListener("DOMContentLoaded", () => {
  // addGreeting(), addMsg() and the image-request parser live in render.js

  // ------------------------------------------------------------------
  //  Attachment limits (change these if you like)
  // ------------------------------------------------------------------
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // photos are shrunk before sending
  const MAX_IMAGES = 6;                     // up to 6 photos; study commands read them all (in batches of 3), a normal chat message reads the first 3
  const MAX_FILE_BYTES = 300 * 1024;        // biggest raw code/text file you can attach
  const MAX_PDF_BYTES = 20 * 1024 * 1024;   // biggest PDF you can attach
  const MAX_ZIP_BYTES = 25 * 1024 * 1024;   // biggest zip you can attach
  const MAX_ZIP_ENTRY_BYTES = 5 * 1024 * 1024; // skip individual zip entries bigger than this (uncompressed)
  const MAX_PDF_PAGES = 40;                 // pages of text to read out of one PDF
  const MAX_FILE_CHARS = 40000;             // characters of one file sent to the AI (~10k tokens)
  const MAX_TOTAL_CHARS = 80000;            // characters across all files in one message
  const MAX_FILES = 8;                      // total text/code entries per message (zip contents count toward this)

  // Code / text files the AI can read
  const TEXT_EXTS = new Set((
    "txt md markdown rst tex log csv tsv json json5 jsonl ipynb yaml yml toml ini cfg conf env properties " +
    "py pyw js mjs cjs jsx ts tsx vue svelte astro html htm css scss sass less styl xml svg " +
    "java kt kts scala groovy gradle c h cpp cc cxx hpp hh cs go rs rb php php7 swift m mm dart lua pl pm r jl hs ex exs erl clj cljs edn " +
    "sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto thrift avdl asm s vb fs fsx nim zig coffee " +
    "gitignore gitattributes gitmodules dockerignore npmrc babelrc eslintrc prettierrc editorconfig " +
    "dockerfile makefile cmake toml lock srt vtt tex bib rst adoc"
  ).split(" "));
  const TEXT_NAMES = new Set([
    "dockerfile", "makefile", "cmakelists.txt", "readme", "license", "changelog",
    ".gitignore", ".gitattributes", ".gitmodules", ".dockerignore", ".env", ".env.example",
    ".babelrc", ".eslintrc", ".prettierrc", ".editorconfig", ".npmrc"
  ]);

  function fileExt(name) {
    const base = String(name).split("/").pop();
    const i = base.lastIndexOf(".");
    return i === -1 ? "" : base.slice(i + 1).toLowerCase();
  }
  function isTextFileName(name) {
    return TEXT_EXTS.has(fileExt(name)) || TEXT_NAMES.has(String(name).split("/").pop().toLowerCase());
  }
  function isTextFile(file) {
    if (isTextFileName(file.name)) return true;
    return /^text\//.test(file.type) || /^application\/(json|javascript|xml|x-sh|x-yaml|toml)/.test(file.type);
  }
  const HEIC_TYPES = new Set(["image/heic", "image/heif"]);
  function isHeic(file) {
    return HEIC_TYPES.has(file.type) || /\.hei[cf]$/i.test(file.name);
  }
  function isPdf(file) {
    return file.type === "application/pdf" || fileExt(file.name) === "pdf";
  }
  function isDocx(file) { return fileExt(file.name) === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; }
  function isPptx(file) { return fileExt(file.name) === "pptx" || file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation"; }
  function isXlsx(file) { return fileExt(file.name) === "xlsx" || file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
  function isOpenDoc(file) { return ["odt", "odp", "ods"].includes(fileExt(file.name)); }
  function isRtf(file) { return fileExt(file.name) === "rtf" || file.type === "application/rtf" || file.type === "text/rtf"; }
  function isOldOffice(file) { return ["doc", "ppt", "xls", "pages", "key", "numbers"].includes(fileExt(file.name)); }
  function isZip(file) {
    return ["application/zip", "application/x-zip-compressed", "application/x-zip"].includes(file.type) || fileExt(file.name) === "zip";
  }

  const toast = msg => { if (typeof showToast === "function") showToast(msg); };

  // Loads a <script> once (used to lazy-load heic2any / pdf.js / JSZip only when actually needed)
  const loadedScripts = new Map();
  function loadScript(src) {
    if (loadedScripts.has(src)) return loadedScripts.get(src);
    const p = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load " + src));
      document.head.appendChild(s);
    });
    loadedScripts.set(src, p);
    return p;
  }
  async function ensureHeic2Any() {
    if (!window.heic2any) await loadScript("https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js");
    return window.heic2any;
  }
  async function ensurePdfJs() {
    if (!window.pdfjsLib) {
      await loadScript("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js";
    }
    return window.pdfjsLib;
  }
  async function ensureJsZip() {
    if (!window.JSZip) await loadScript("https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js");
    return window.JSZip;
  }

  // --- Image compression (shrinks photos so uploads stay small and fast) ---
  // Faded scans and dim phone photos are the main reason handwriting and tables get misread, so a low-contrast
  // picture is gently stretched to use the full brightness range (a normal photo is left alone).
  function autoLevels(ctx, w, h) {
    try {
      const img = ctx.getImageData(0, 0, w, h), d = img.data;
      const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 16) hist[(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0]++; // sample every 4th pixel
      const total = hist.reduce((a, b) => a + b, 0);
      let acc = 0, lo = 0, hi = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
      acc = 0;
      for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
      if (hi - lo >= 170 || hi - lo < 25) return; // already contrasty, or basically flat: don't touch
      const scale = 255 / (hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.max(0, Math.min(255, (d[i] - lo) * scale));
        d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] - lo) * scale));
        d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] - lo) * scale));
      }
      ctx.putImageData(img, 0, 0);
    } catch (_) { /* a browser that blocks canvas reads just sends the picture as is */ }
  }
  function compressImage(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const maxSize = 1800; // large enough to keep handwriting and small print readable
          let w = img.width, h = img.height;
          if (w > maxSize || h > maxSize) { if (w > h) { h = (h/w)*maxSize; w = maxSize; } else { w = (w/h)*maxSize; h = maxSize; } }
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff";           // transparent PNGs would otherwise turn black
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          autoLevels(ctx, Math.round(w), Math.round(h));
          resolve(canvas.toDataURL("image/jpeg", 0.88));
        };
        img.onerror = () => { toast("Failed to load image"); resolve(null); };
        img.src = e.target.result;
      };
      reader.onerror = () => { toast("Failed to read file"); resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  // ------------------------------------------------------------------
  //  Attachments (one image + up to MAX_FILES code/text files)
  // ------------------------------------------------------------------
  const uploadBtn = document.getElementById("upload-btn");
  const fileInput = document.getElementById("file-input");
  const previewArea = document.getElementById("preview-area");
  const attachList = document.getElementById("attach-list");

  let pendingImages = []; // { base64, type }
  let pendingFiles = [];  // { name, text, truncated }

  if (fileInput) {
    fileInput.multiple = true;
    fileInput.accept = "image/*,.heic,.heif,.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.rtf,.zip,text/*," + [...TEXT_EXTS].map(e => "." + e).join(",");
  }

  function renderAttachments() {
    if (!attachList || !previewArea) return;
    attachList.innerHTML = "";

    pendingImages.forEach((im, i) => {
      const chip = document.createElement("div");
      chip.className = "attach-chip attach-image";
      const img = document.createElement("img");
      img.src = `data:${im.type};base64,${im.base64}`;
      img.alt = "Attached image";
      const x = document.createElement("button");
      x.type = "button"; x.className = "attach-x"; x.title = "Remove image"; x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      x.addEventListener("click", () => { pendingImages.splice(i, 1); renderAttachments(); });
      chip.append(img, x);
      attachList.appendChild(chip);
    });

    pendingFiles.forEach((f, i) => {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      chip.innerHTML = `<i class="fa-solid ${agent1102Render.fileChipIcon ? agent1102Render.fileChipIcon(f.name) : "fa-file-code"}"></i>`;
      const name = document.createElement("span");
      name.className = "attach-name"; name.textContent = f.name;
      const meta = document.createElement("span");
      meta.className = "attach-meta";
      meta.textContent = f.truncated ? "truncated" : `${f.text.length.toLocaleString()} chars`;
      const x = document.createElement("button");
      x.type = "button"; x.className = "attach-x"; x.title = "Remove file"; x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
      x.addEventListener("click", () => { pendingFiles.splice(i, 1); renderAttachments(); });
      chip.append(name, meta, x);
      attachList.appendChild(chip);
    });

    previewArea.style.display = (pendingImages.length || pendingFiles.length) ? "flex" : "none";
  }

  function clearAttachments() {
    pendingImages = []; pendingFiles = [];
    if (fileInput) fileInput.value = "";
    renderAttachments();
  }

  // Adds one extracted block of text (from a plain file, a PDF, or a zip entry) as a
  // pending "file" attachment, enforcing the size caps. Returns true if it was added.
  function addExtractedText(name, text, opts) {
    opts = opts || {};
    if (pendingFiles.length >= MAX_FILES) { if (!opts.silent) toast(`You can attach up to ${MAX_FILES} files at once`); return false; }
    if (text.includes("\u0000")) { if (!opts.silent) toast(`"${name}" looks like a binary file, so I can't read it`); return false; }
    if (!text.trim()) { if (!opts.silent) toast(`"${name}" is empty`); return false; }

    const used = pendingFiles.reduce((n, f) => n + f.text.length, 0);
    let truncated = false;
    if (text.length > MAX_FILE_CHARS) { text = text.slice(0, MAX_FILE_CHARS); truncated = true; }
    if (used + text.length > MAX_TOTAL_CHARS) { if (!opts.silent) toast("Those files are too big to send together. Try fewer or smaller files"); return false; }
    pendingFiles.push({ name, text, truncated });
    if (truncated && !opts.silent) toast(`"${name}" is long, so only the first ${MAX_FILE_CHARS.toLocaleString()} characters will be sent`);
    return true;
  }

  async function addImage(file) {
    if (pendingImages.length >= MAX_IMAGES) { toast(`You can attach up to ${MAX_IMAGES} images at once`); return; }

    let workingFile = file;
    if (isHeic(file)) {
      toast(`Converting "${file.name}"...`);
      try {
        const heic2any = await ensureHeic2Any();
        const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.85 });
        const blob = Array.isArray(converted) ? converted[0] : converted;
        workingFile = new File([blob], file.name.replace(/\.hei[cf]$/i, ".jpg"), { type: "image/jpeg" });
      } catch (err) {
        console.error(err);
        toast(`Couldn't convert "${file.name}" from HEIC. Try exporting it as JPG first`);
        return;
      }
    } else if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      toast(`"${file.name}" isn't a supported image (use JPG, PNG, WEBP, GIF or HEIC)`); return;
    }

    if (workingFile.size > MAX_IMAGE_BYTES) { toast(`"${file.name}" is too large. Max image size is 10MB`); return; }
    const compressed = await compressImage(workingFile);
    if (!compressed) return;
    pendingImages.push({ base64: compressed.split(",")[1], type: "image/jpeg" });
  }

  async function addTextFile(file) {
    if (pendingFiles.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files at once`); return; }
    if (file.size > MAX_FILE_BYTES) { toast(`"${file.name}" is too large (max ${Math.round(MAX_FILE_BYTES / 1024)} KB)`); return; }
    let text;
    try { text = await file.text(); } catch { toast(`Couldn't read "${file.name}"`); return; }
    addExtractedText(file.name, text);
  }

  // PDFs: extract selectable text page by page. If a PDF turns out to have
  // basically no selectable text (a scan), render its first page(s) as images
  // instead so the vision model can look at them directly.
  async function addPdfFile(file) {
    if (pendingFiles.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files at once`); return; }
    if (file.size > MAX_PDF_BYTES) { toast(`"${file.name}" is too large (max ${MAX_PDF_BYTES / (1024 * 1024)}MB)`); return; }

    let pdfjsLib;
    try { pdfjsLib = await ensurePdfJs(); } catch (err) { console.error(err); toast("Couldn't load the PDF reader. Check your connection and try again"); return; }

    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const pageCount = pdf.numPages;
      const pagesToRead = Math.min(pageCount, MAX_PDF_PAGES);

      let text = "";
      for (let i = 1; i <= pagesToRead; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
        if (pageText) text += `--- Page ${i} ---\n${pageText}\n\n`;
      }
      if (pageCount > pagesToRead) text += `[...${pageCount - pagesToRead} more page(s) not read...]\n`;

      // Basically no extractable text => this is almost certainly a scanned/image-only PDF
      if (text.trim().length < 40) {
        const room = MAX_IMAGES - pendingImages.length;
        if (room <= 0) {
          toast(`"${file.name}" looks like a scanned PDF with no selectable text, and you're out of image slots to show it visually`);
          return;
        }
        const pagesToRender = Math.min(pageCount, room);
        for (let i = 1; i <= pagesToRender; i++) {
          const page = await pdf.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(base.width, base.height)) }); // sharper pages read better, capped so uploads stay small
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width; canvas.height = viewport.height;
          const ctx = canvas.getContext("2d");
          await page.render({ canvasContext: ctx, viewport }).promise;
          pendingImages.push({ base64: canvas.toDataURL("image/jpeg", 0.88).split(",")[1], type: "image/jpeg" });
        }
        toast(`"${file.name}" looks scanned, so ${pagesToRender} page${pagesToRender === 1 ? "" : "s"} of it were attached as image${pagesToRender === 1 ? "" : "s"} instead of text`);
        return;
      }

      addExtractedText(file.name, text.trim());
    } catch (err) {
      console.error(err);
      toast(`Couldn't read "${file.name}" as a PDF`);
    }
  }

  // Word (.docx) and PowerPoint (.pptx) files are zips of XML: pull the text out of them.
  const xmlText = x => String(x)
    .replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>|<w:br\/>|<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  async function addOfficeFile(file, kind) {
    if (pendingFiles.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files at once`); return; }
    if (file.size > MAX_PDF_BYTES) { toast(`"${file.name}" is too large (max ${MAX_PDF_BYTES / (1024 * 1024)}MB)`); return; }
    let JSZip;
    try { JSZip = await ensureJsZip(); } catch (err) { console.error(err); toast("Couldn't load the file reader. Check your connection and try again"); return; }
    try {
      const zip = await JSZip.loadAsync(file);
      let text = "";
      if (kind === "docx") {
        const doc = zip.file("word/document.xml");
        if (!doc) throw new Error("no document.xml");
        text = xmlText(await doc.async("text"));
        for (const n of ["word/footnotes.xml", "word/endnotes.xml"]) {
          const f = zip.file(n); if (f) text += "\n" + xmlText(await f.async("text"));
        }
      } else if (kind === "xlsx") {
        text = await xlsxToText(zip);
      } else if (kind === "odf") {
        const c = zip.file("content.xml");
        if (!c) throw new Error("no content.xml");
        text = String(await c.async("text"))
          .replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n")
          .replace(/<\/text:p>|<\/text:h>|<\/table:table-row>|<\/draw:page>/g, "\n")
          .replace(/<\/table:table-cell>/g, "\t")
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
      } else {
        const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
        for (let i = 0; i < slides.length; i++) {
          const t = xmlText(await zip.file(slides[i]).async("text")).replace(/\n{2,}/g, "\n").trim();
          if (t) text += `--- Slide ${i + 1} ---\n${t}\n\n`;
          const notes = zip.file(`ppt/notesSlides/notesSlide${slides[i].match(/(\d+)\.xml$/)[1]}.xml`);
          if (notes) { const nt = xmlText(await notes.async("text")).replace(/\n{2,}/g, "\n").trim(); if (nt) text += `Notes: ${nt}\n\n`; }
        }
      }
      text = text.replace(/\n{3,}/g, "\n\n").trim();
      if (!text) { toast(`"${file.name}" has no text I can read (it may just contain pictures)`); return; }
      addExtractedText(file.name, text);
    } catch (err) {
      console.error(err);
      toast(`Couldn't read "${file.name}". Is it a valid ${{ docx: "Word (.docx)", pptx: "PowerPoint (.pptx)", xlsx: "Excel (.xlsx)", odf: "OpenDocument" }[kind]} file?`);
    }
  }

  // Excel (.xlsx): read every sheet as tab-separated rows
  async function xlsxToText(zip) {
    const unesc = x => String(x).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    const shared = [];
    const ss = zip.file("xl/sharedStrings.xml");
    if (ss) {
      const xml = await ss.async("text");
      for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(unesc([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join("")));
    }
    let names = [];
    const wb = zip.file("xl/workbook.xml");
    if (wb) names = [...(await wb.async("text")).matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map(m => unesc(m[1]));
    const sheets = Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)\.xml$/)[1], 10) - parseInt(b.match(/(\d+)\.xml$/)[1], 10));
    let out = "";
    for (let i = 0; i < sheets.length; i++) {
      const xml = await zip.file(sheets[i]).async("text");
      const rows = [];
      for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1], inner = c[2] || "";
          const t = (/\bt="(\w+)"/.exec(attrs) || [])[1];
          const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
          let val = "";
          if (t === "s" && v != null) val = shared[parseInt(v, 10)] || "";
          else if (t === "inlineStr") val = unesc([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(""));
          else if (v != null) val = unesc(v);
          cells.push(val);
        }
        if (cells.some(x => x !== "")) rows.push(cells.join("\t"));
      }
      if (rows.length) out += `--- Sheet: ${names[i] || i + 1} ---\n${rows.join("\n")}\n\n`;
    }
    return out;
  }

  // Rich Text Format (.rtf): strip the control codes, keep the words
  async function addRtfFile(file) {
    if (pendingFiles.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files at once`); return; }
    if (file.size > MAX_FILE_BYTES * 4) { toast(`"${file.name}" is too large`); return; }
    let raw;
    try { raw = await file.text(); } catch { toast(`Couldn't read "${file.name}"`); return; }
    const text = raw
      .replace(/\{\\\*[^{}]*\}/g, "")
      .replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict)[\s\S]*?\}\}?/g, "")
      .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(?:par|line)\b ?/g, "\n").replace(/\\tab\b ?/g, "\t")
      .replace(/\\[a-z]+-?\d* ?/gi, "").replace(/\\([\\{}])/g, "$1").replace(/[{}]/g, "")
      .replace(/\n{3,}/g, "\n\n").trim();
    addExtractedText(file.name, text);
  }

  // Zips: extract every readable text/code file inside (skipping images, binaries,
  // and anything oversized), each added as its own attachment named "zip/path/to/file".
  async function addZipFile(file) {
    if (pendingFiles.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files at once`); return; }
    if (file.size > MAX_ZIP_BYTES) { toast(`"${file.name}" is too large (max ${MAX_ZIP_BYTES / (1024 * 1024)}MB)`); return; }

    let JSZip;
    try { JSZip = await ensureJsZip(); } catch (err) { console.error(err); toast("Couldn't load the zip reader. Check your connection and try again"); return; }

    try {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter(f => !f.dir).slice(0, 500);
      let extracted = 0, skipped = 0;

      for (const entry of entries) {
        if (pendingFiles.length >= MAX_FILES) { skipped += entries.length - extracted - skipped; break; }
        const size = entry._data && entry._data.uncompressedSize;
        if (!isTextFileName(entry.name) || (typeof size === "number" && size > MAX_ZIP_ENTRY_BYTES)) { skipped++; continue; }
        let text;
        try { text = await entry.async("text"); } catch { skipped++; continue; }
        const added = addExtractedText(`${file.name}/${entry.name}`, text, { silent: true });
        if (added) extracted++; else skipped++;
      }

      if (extracted === 0) toast(`No readable text/code files found inside "${file.name}"`);
      else toast(`Extracted ${extracted} file${extracted === 1 ? "" : "s"} from "${file.name}"${skipped ? ` (${skipped} skipped)` : ""}`);
    } catch (err) {
      console.error(err);
      toast(`Couldn't read "${file.name}" as a zip`);
    }
  }

  async function handleFiles(files) {
    files = [...files];
    if (!files.length) return;
    for (const file of files) {
      if (file.type.startsWith("image/") || isHeic(file)) await addImage(file);
      else if (isPdf(file)) await addPdfFile(file);
      else if (isDocx(file)) await addOfficeFile(file, "docx");
      else if (isPptx(file)) await addOfficeFile(file, "pptx");
      else if (isXlsx(file)) await addOfficeFile(file, "xlsx");
      else if (isOpenDoc(file)) await addOfficeFile(file, "odf");
      else if (isRtf(file)) await addRtfFile(file);
      else if (isZip(file)) await addZipFile(file);
      else if (isTextFile(file)) await addTextFile(file);
      else if (isOldOffice(file)) toast(`"${file.name}" is an older format I can't read. Save it as .docx, .pptx, .xlsx or PDF and try again`);
      else toast(`"${file.name}" isn't a supported file type yet (photos, PDF, Word, PowerPoint, Excel, OpenDocument, RTF, text/code and zip work)`);
    }
    renderAttachments();
  }

  if (uploadBtn && fileInput) {
    uploadBtn.title = "Attach photos, PDFs, Word/PowerPoint files, text/code, or a zip";
    uploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const files = [...fileInput.files];
      fileInput.value = "";
      await handleFiles(files);
    });
  }

  // Paste a screenshot / copied file straight into the message box, or drag files onto the chat
  const pasteTarget = document.getElementById("input");
  if (pasteTarget) {
    pasteTarget.addEventListener("paste", e => {
      const files = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (!files.length) return; // plain text paste: leave it alone (it can be your notes)
      e.preventDefault();
      handleFiles(files);
    });
  }
  ["dragover", "drop"].forEach(evt => document.addEventListener(evt, e => {
    if (!e.dataTransfer || ![...(e.dataTransfer.types || [])].includes("Files")) return;
    e.preventDefault();
    if (evt === "drop") handleFiles(e.dataTransfer.files);
  }));

  // --- Voice input setup ---
  let recognition = null;
  let isRecording = false;
  const micBtn = document.getElementById("mic-btn");

  if (micBtn && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window)) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    
    recognition.onstart = () => {
      micBtn.classList.add("recording");
      isRecording = true;
      if (typeof showToast === 'function') showToast('<i class="fa-solid fa-microphone"></i> Listening...');
    };
    
    recognition.onresult = (e) => {
      const inputEl = document.getElementById("input");
      if (e.results && e.results.length > 0 && inputEl) {
        const transcript = e.results[e.results.length - 1][0].transcript;
        inputEl.value = transcript;
        if (typeof showToast === 'function') showToast('<span class="toast-success"><i class="fa-solid fa-circle-check"></i> Got it!</span>');
      }
      micBtn.classList.remove("recording");
      isRecording = false;
    };
    
    recognition.onerror = (e) => {
      console.error("Speech recognition error:", e.error);
      if (typeof showToast === 'function') {
        switch (e.error) {
          case "aborted": showToast('Listening cancelled'); break;
          case "no-speech": showToast('Didn\'t catch that — try again'); break;
          case "not-allowed": showToast('Microphone access is blocked'); break;
          default: showToast(`Error: ${e.error}`);
        }
      }
      micBtn.classList.remove("recording");
      isRecording = false;
    };
    
    recognition.onend = () => {
      micBtn.classList.remove("recording");
      isRecording = false;
    };

    micBtn.addEventListener("click", () => {
      if (!recognition) return;
      if (isRecording) {
        recognition.stop();
        return;
      }
      try {
        recognition.start();
      } catch (e) {
        console.error("Error starting recognition:", e);
      }
    });
  }

  // --- Send Message & Core Logic ---
  const btn = document.getElementById("send");
  const input = document.getElementById("input");
  const chatEl = document.getElementById("chat");
  let sending = false;

  // "Thinking..." placeholder (same look as an AI reply, no bubble)
  function addThinking(label) {
    const wrap = document.createElement("div");
    wrap.className = "msg-wrap ai";
    const t = document.createElement("div");
    t.className = "ai-text thinking";
    t.innerHTML = `<i class="fa-solid fa-spinner fa-spin-pulse"></i> <span></span>`;
    t.querySelector("span").textContent = label;
    wrap.appendChild(t);
    chatEl.appendChild(wrap);
    chatEl.scrollTop = chatEl.scrollHeight;
    return { wrap, text: t, setLabel: (s) => { const sp = t.querySelector("span"); if (sp) sp.textContent = s; } };
  }

  // History as the server should see it. Generated images/videos are just a
  // URL in our history, so the AI is told about them in words instead.
  const GENERATED_IMG = /^!\[([^\]]*)\]\(https:\/\/(?:image\.pollinations\.ai\/|[^)\/]+\/storage\/v1\/object\/public\/chat-uploads\/)[^)]*\)$/;
  const GENERATED_VIDEO = /^\[([^\]]*)\]\(https:\/\/(?:image\.pollinations\.ai\/|[^)\/]+\/storage\/v1\/object\/public\/chat-uploads\/)[^)]*\)$/;
  function messagesForServer() {
    return history.map(m => {
      if (m.role === "assistant" && typeof m.content === "string") {
        if (m.content === agent1102Commands.helpMarkdown()) return { role: "assistant", content: "[agent1102 showed the list of slash commands]" };
        // quizzes / flashcards travel as plain text so follow-ups like "explain question 3" work
        if (/```(?:quiz|flashcards)\b/i.test(m.content)) return { role: "assistant", content: agent1102Render.responseToText(m.content) };
        const g = m.content.match(GENERATED_IMG);
        if (g) return { role: "assistant", content: `[agent1102 generated an image for the prompt: "${g[1]}"]` };
        const v = m.content.match(GENERATED_VIDEO);
        if (v) return { role: "assistant", content: `[agent1102 generated a video for the prompt: "${v[1]}"]` };
      }
      return m;
    });
  }

  async function generateImage(typed, prompt, opts) {
    opts = opts || {};
    if (!opts.skipUser) {
      addMsg("user", typed);
      history.push({ role: "user", content: typed });
      input.value = "";
    }

    if (!prompt) {
      const tip = "What should the image show? Describe it and I'll create it, for example: **/image a red sports car on a beach at sunset**";
      addMsg("ai", tip);
      history.push({ role: "assistant", content: tip });
      if (typeof saveCurrentChat === "function") saveCurrentChat();
      return;
    }

    const thinking = addThinking("Creating your image...");
    try {
      const res = await fetch(`${BACKEND_URL}/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      thinking.wrap.remove();
      if (!data.imageUrl) { addMsg("ai", data.error || "Image generation failed. Please try again."); return; }
      const alt = prompt.replace(/[\[\]\r\n]+/g, " ").slice(0, 200);
      const url = data.imageUrl.replace(/\(/g, "%28").replace(/\)/g, "%29");
      const md = `![${alt}](${url})`;
      addMsg("ai", md);
      history.push({ role: "assistant", content: md });
      if (typeof saveCurrentChat === "function") saveCurrentChat();
    } catch {
      thinking.text.classList.remove("thinking");
      thinking.text.textContent = "Error reaching the server. Is your backend running?";
    }
  }

  // Finds the most recent image the AI generated or edited in this chat, so
  // "/edit ..." with nothing attached knows what to edit.
  const GENERATED_IMG_URL = /!\[[^\]]*\]\((https:\/\/(?:image\.pollinations\.ai\/|[^)\/]+\/storage\/v1\/object\/public\/chat-uploads\/)[^)]*)\)/g;
  function lastGeneratedImageUrl() {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role !== "assistant" || typeof m.content !== "string") continue;
      const matches = [...m.content.matchAll(GENERATED_IMG_URL)];
      if (matches.length) return matches[matches.length - 1][1];
    }
    return null;
  }

  async function editImage(typed, prompt, attachedImage, opts) {
    opts = opts || {};
    if (!opts.skipUser) {
      addMsg("user", typed, attachedImage ? [`data:${attachedImage.type};base64,${attachedImage.base64}`] : null);
      history.push({ role: "user", content: typed });
      input.value = "";
      clearAttachments();
    }

    if (!prompt) {
      const tip = "What should I change? Describe the edit, for example: **/edit make the sky purple**";
      addMsg("ai", tip);
      history.push({ role: "assistant", content: tip });
      if (typeof saveCurrentChat === "function") saveCurrentChat();
      return;
    }

    const thinking = addThinking("Editing your image...");
    try {
      const body = { prompt };
      if (attachedImage) body.imageBase64 = `data:${attachedImage.type};base64,${attachedImage.base64}`;
      else {
        const src = lastGeneratedImageUrl();
        if (!src) {
          thinking.wrap.remove();
          addMsg("ai", "Attach an image (📎) to edit, or generate one first with **/image**, then use **/edit** on it.");
          return;
        }
        body.imageUrl = src;
      }
      const res = await fetch(`${BACKEND_URL}/edit-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      thinking.wrap.remove();
      if (!data.imageUrl) { addMsg("ai", data.error || "Image editing failed. Please try again."); return; }
      const alt = prompt.replace(/[\[\]\r\n]+/g, " ").slice(0, 200);
      const url = data.imageUrl.replace(/\(/g, "%28").replace(/\)/g, "%29");
      const md = `![${alt}](${url})`;
      addMsg("ai", md);
      history.push({ role: "assistant", content: md });
      if (typeof saveCurrentChat === "function") saveCurrentChat();
    } catch {
      thinking.text.classList.remove("thinking");
      thinking.text.textContent = "Error reaching the server. Is your backend running?";
    }
  }

  // ------------------------------------------------------------------
  //  /help and the study modes (/learn, /quiz, /flashcards)
  // ------------------------------------------------------------------
  function withFileBlocks(files, typed) {
    if (!files.length) return typed;
    const blocks = files.map(f =>
      `<attached_file name="${f.name.replace(/"/g, "'")}">\n${f.text.replace(/<\/attached_file>/g, "<\\/attached_file>")}${f.truncated ? "\n[...file truncated...]" : ""}\n</attached_file>`
    ).join("\n\n");
    return blocks + (typed ? "\n\n" + typed : "");
  }

  // Text of the files inside a saved user message (used when a study command is retried)
  function materialFromMessage(raw) {
    const out = [];
    for (const m of String(raw).matchAll(/<attached_file name="([^"]*)">\n([\s\S]*?)\n<\/attached_file>/g)) out.push(`--- ${m[1]} ---\n${m[2]}`);
    return out.join("\n\n");
  }

  // Photos and files from the most recent earlier message that had any (so: send a photo, then just type /quiz)
  function recentAttachments(list) {
    for (let i = list.length - 1, seen = 0; i >= 0 && seen < 10; i--, seen++) {
      const m = list[i];
      if (!m || m.role !== "user") continue;
      const parts = Array.isArray(m.content) ? m.content : null;
      const images = parts ? parts.filter(p => p && p.type === "image_url" && p.image_url && p.image_url.url).map(p => p.image_url.url) : [];
      const text = typeof m.content === "string" ? m.content : parts ? parts.filter(p => p && p.type === "text").map(p => p.text).join("\n") : "";
      const material = materialFromMessage(text);
      if (images.length || material) return { images, material };
    }
    return { images: [], material: "" };
  }

  // The recent conversation as plain text, so "/quiz" on its own can quiz what was just discussed
  function studyContext(list) {
    const helpMd = agent1102Commands.helpMarkdown();
    return list.filter(m => {
      if (m.role === "assistant") return m.content !== helpMd;                       // skip the command list
      const t = typeof m.content === "string" ? m.content.trim() : "";
      return !(t.startsWith("/") && agent1102Commands.parseCommand(t));               // skip bare slash commands
    }).slice(-6).map(m => {
      let t = typeof m.content === "string" ? m.content
        : Array.isArray(m.content) ? m.content.filter(p => p && p.type === "text").map(p => p.text).join(" ") : "";
      t = t.replace(/<attached_file[^>]*>[\s\S]*?<\/attached_file>/g, "[attached file]").replace(/```[\s\S]*?```/g, "").trim().slice(0, m.role === "user" ? 5000 : 1500);
      return t ? `${m.role === "user" ? "Student" : "Tutor"}: ${t}` : "";
    }).filter(Boolean).join("\n");
  }

  async function runHelp(typed, opts) {
    opts = opts || {};
    if (!opts.skipUser) {
      addMsg("user", typed);
      history.push({ role: "user", content: typed });
      input.value = "";
    }
    const md = agent1102Commands.helpMarkdown();
    addMsg("ai", md);
    history.push({ role: "assistant", content: md });
    if (typeof saveCurrentChat === "function") saveCurrentChat();
  }

  const STUDY_LABEL = { learn: "Preparing your lesson...", quiz: "Building your quiz...", flashcards: "Making your flashcards..." };
  // /graph, /plot, /numberline: the server returns a real drawing (```mathviz block), never code
  async function runGraph(typed, request, opts) {
    opts = opts || {};
    const before = opts.skipUser ? history.slice(0, -1) : history;
    if (!opts.skipUser) {
      addMsg("user", typed);
      history.push({ role: "user", content: typed });
      input.value = "";
    }
    const context = studyContext(before);
    if (!request.trim() && !context.trim()) {
      const tip = "What should I draw? For example: **/graph y = x^2 - 4**, **/graph number line -2 < x <= 3**, or **/graph right triangle with sides 3, 4, 5**.";
      addMsg("ai", tip);
      history.push({ role: "assistant", content: tip });
      if (typeof saveCurrentChat === "function") saveCurrentChat();
      return;
    }
    const thinking = addThinking("Drawing it...");
    try {
      const res = await fetch(`${BACKEND_URL}/graph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request, context: request.trim() ? context.split("\n").slice(-4).join("\n") : context }),
      });
      const data = await res.json();
      thinking.wrap.remove();
      const reply = data.reply || data.error || "Something went wrong.";
      addMsg("ai", reply);
      if (data.reply) history.push({ role: "assistant", content: reply });
      if (typeof saveCurrentChat === "function") saveCurrentChat();
    } catch {
      thinking.wrap.remove();
      addMsg("ai", "Error reaching the server. Is your backend running?");
    }
  }

  const STUDY_TIP = {
    learn: "What would you like to learn? For example: **/learn how photosynthesis works**. You can also attach your notes and type **/learn**.",
    quiz: "What should the quiz be about? For example: **/quiz 5 the French Revolution**. You can also attach your notes and type **/quiz**, or just type **/quiz** after we've talked about something.",
    flashcards: "What should the flashcards cover? For example: **/flashcards 10 Spanish greetings**. You can also attach your notes and type **/flashcards**, or just type it after we've talked about something.",
  };

  // Joins attached files into one block, giving each a fair share of the size budget
  const STUDY_MATERIAL_CHARS = 40000;
  function buildMaterial(files) {
    if (!files.length) return "";
    const each = Math.max(4000, Math.floor(STUDY_MATERIAL_CHARS / files.length));
    return files.map(f => `--- ${f.name} ---\n${f.text.slice(0, each)}`).join("\n\n");
  }

  // A long or multi-line "topic" is really pasted notes, not a topic
  function splitPastedNotes(cmd, material) {
    const t = cmd.topic || "";
    if (t.length > 200 || /\n/.test(t)) {
      return { cmd: { ...cmd, topic: "" }, material: (material ? material + "\n\n" : "") + "--- Pasted notes ---\n" + t.slice(0, STUDY_MATERIAL_CHARS) };
    }
    return { cmd, material };
  }

  async function runStudy(cmd, opts) {
    opts = opts || {};
    let images = opts.images || []; // data: URLs of photos of paper/notes
    const before = opts.skipUser ? history.slice(0, -1) : history; // the conversation before this command
    const context = studyContext(before);
    const split = splitPastedNotes(cmd, opts.material || "");
    cmd = split.cmd;
    let material = split.material;
    let usedEarlier = false;
    // Nothing given with the command itself: reuse the photos/files sent earlier in this chat
    if (!cmd.topic && !material.trim() && !images.length) {
      const rec = recentAttachments(before);
      if (rec.images.length || rec.material) { images = rec.images.slice(-6); material = rec.material; usedEarlier = true; }
    }
    const hasSource = !!(cmd.topic || material.trim() || images.length);

    if (!opts.skipUser) {
      const shown = opts.modelText || `/${cmd.mode} ${cmd.topic}`.trim();
      const sent = usedEarlier ? [] : images;
      addMsg("user", shown, sent);
      history.push({ role: "user", content: sent.length
        ? [...sent.map(url => ({ type: "image_url", image_url: { url } })), { type: "text", text: shown }]
        : shown });
      input.value = "";
      clearAttachments();
    }

    if (!hasSource && !context.trim()) {
      addMsg("ai", STUDY_TIP[cmd.mode]);
      history.push({ role: "assistant", content: STUDY_TIP[cmd.mode] });
      if (typeof saveCurrentChat === "function") saveCurrentChat();
      return;
    }

    const thinking = addThinking(images.length ? `Reading your ${images.length > 1 ? "photos" : "photo"}...` : usedEarlier ? "Reading your file..." : STUDY_LABEL[cmd.mode]);
    if (images.length) setTimeout(() => { if (thinking.wrap.isConnected) thinking.setLabel(STUDY_LABEL[cmd.mode]); }, 6000);
    try {
      const res = await fetch(`${BACKEND_URL}/study`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: cmd.mode, topic: cmd.topic, count: cmd.count, material, images, context: hasSource ? "" : context }),
      });
      const data = await res.json();
      thinking.wrap.remove();
      const reply = data.reply || data.error || "Something went wrong.";
      addMsg("ai", reply); // errors get a "Try again" button too
      if (data.reply) history.push({ role: "assistant", content: reply });
      if (typeof saveCurrentChat === "function") saveCurrentChat();
    } catch {
      thinking.wrap.remove();
      addMsg("ai", "Error reaching the server. Is your backend running?");
    }
  }

  // Asks the AI to answer the conversation as it stands (last history entry is the user's message).
  // The answer streams in live (see stream.js); the signed-in token lets the server use memory and saved style.
  async function requestReply(label) {
    const thinking = addThinking(label || "Thinking...");
    const draft = agent1102Stream.createDraft(thinking);
    try {
      const res = await fetch(`${BACKEND_URL}/chat`, {
        method: "POST",
        headers: agent1102Stream.headers(userToken),
        body: JSON.stringify({ messages: messagesForServer() }),
      });
      const out = await agent1102Stream.readReply(res, draft);
      const reply = out.reply || out.error || "Something went wrong.";

      thinking.wrap.remove();
      addMsg("ai", reply); // errors get a "Try again" button too (they aren't stored in history)

      if (out.reply) history.push({ role: "assistant", content: reply });
      if (out.meta && out.meta.style && out.meta.style.length) {
        showToast("Got it. From now on: " + out.meta.style.map(agent1102Render.escapeHtml).join(", ") + ". Change it anytime with /style");
      }
      if (typeof saveCurrentChat === "function") saveCurrentChat();
    } catch {
      thinking.wrap.remove();
      addMsg("ai", "Error reaching the server. Is your backend running?");
    }
  }

  // "Try again": throw away the AI reply at `msgIndex` (and everything after it), then get a new one
  // for the user message before it. Slash commands (/image, /edit) are re-run the same way.
  window.retryFrom = async function retryFrom(msgIndex, wrap) {
    if (sending) return;
    const cut = Math.min(msgIndex, history.length);
    const last = history[cut - 1];
    if (!last || last.role !== "user") return;

    sending = true;
    btn.disabled = true;
    try {
      history = history.slice(0, cut);
      let node = wrap;
      while (node) { const next = node.nextSibling; node.remove(); node = next; }

      const text = typeof last.content === "string" ? last.content
        : (last.content || []).filter(p => p && p.type === "text").map(p => p.text).join("\n");
      const hasImg = Array.isArray(last.content) && last.content.some(p => p && p.type === "image_url");

      {
        const typedPart = agent1102Render.parseAttachedFiles(text).rest;
        if (!hasImg && agent1102Commands.isHelp(typedPart)) { await runHelp(typedPart, { skipUser: true }); return; }
        const graphReq = !hasImg && !/<attached_file/.test(text) ? agent1102Commands.parseGraph(typedPart) : null;
        if (graphReq) { await runGraph(typedPart, graphReq.request, { skipUser: true }); return; }
        const study = agent1102Commands.parseStudy(typedPart);
        if (study) {
          const imgs = hasImg ? last.content.filter(p => p && p.type === "image_url").map(p => p.image_url.url) : [];
          await runStudy(study, { skipUser: true, material: materialFromMessage(text), images: imgs });
          return;
        }
      }

      if (!hasImg && !/<attached_file/.test(text)) {
        const editReq = agent1102Render.parseImageEditRequest(text);
        if (editReq) { await editImage(text, editReq.prompt, null, { skipUser: true }); return; }
        const imgReq = agent1102Render.parseImageRequest(text);
        if (imgReq) { await generateImage(text, imgReq.prompt, { skipUser: true }); return; }
      }
      await requestReply(hasImg ? "Looking at your image..." : "Thinking...");
    } finally {
      sending = false;
      btn.disabled = false;
    }
  };

  async function sendMessage() {
    if (sending) return;
    const typed = input.value.trim();
    const images = pendingImages.slice();
    const hasImage = images.length > 0;
    const files = pendingFiles.slice();
    if (!typed && !hasImage && !files.length) return;

    sending = true;
    btn.disabled = true;
    try {
      // 0a) Personal commands: /memory, /remember, /forget, /style (shown in the chat, never sent to the AI)
      if (!hasImage && !files.length && agent1102Personal.match(typed)) { await agent1102Personal.run(typed); return; }
      // 0) Slash commands: /help and the study modes (/learn, /quiz, /flashcards)
      if (!hasImage && !files.length && agent1102Commands.isHelp(typed)) { await runHelp(typed); return; }
      const graphReq = !hasImage && !files.length ? agent1102Commands.parseGraph(typed) : null;
      if (graphReq) { await runGraph(typed, graphReq.request); return; }
      const study = agent1102Commands.parseStudy(typed);
      if (study) {
        await runStudy(study, {
          modelText: withFileBlocks(files, typed),
          material: buildMaterial(files),
          images: images.map(im => `data:${im.type};base64,${im.base64}`),
        });
        return;
      }

      // 1) Is the user asking for an image to be created or an existing one edited?
      if (!hasImage && !files.length) {
        const editReq = agent1102Render.parseImageEditRequest(typed);
        if (editReq) { await editImage(typed, editReq.prompt, null); return; }
        const req = agent1102Render.parseImageRequest(typed);
        if (req) { await generateImage(typed, req.prompt); return; }
      } else if (hasImage && images.length === 1 && !files.length) {
        // An image is attached: "/edit ..." applies the edit to it directly.
        const editReq = agent1102Render.parseImageEditRequest(typed);
        if (editReq) { await editImage(typed, editReq.prompt, images[0]); return; }
      }

      // 2) Normal chat, possibly with image(s) and/or code/PDF/zip files attached.
      // No default question is ever injected here — if the user didn't type
      // anything, the AI just gets the attachment(s) and whatever they typed.
      const modelText = withFileBlocks(files, typed);

      if (images.length > 3) toast("A normal message can read the first 3 photos. To study from up to 6, send them with /quiz, /flashcards or /learn.");
      const imgSrcs = images.map(im => `data:${im.type};base64,${im.base64}`);
      addMsg("user", modelText, imgSrcs);

      const userContent = [];
      imgSrcs.forEach(url => userContent.push({ type: "image_url", image_url: { url } }));
      userContent.push({ type: "text", text: modelText });
      history.push({ role: "user", content: hasImage ? userContent : modelText });

      input.value = "";
      clearAttachments();
      await requestReply(hasImage ? "Looking at your image" + (imgSrcs.length > 1 ? "s..." : "...") : "Thinking...");
    } finally {
      sending = false;
      btn.disabled = false;
    }
  }

  if (btn && input) {
    btn.addEventListener("click", sendMessage);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }
});
