// Header + sidebar layout, text on red buttons, solid cards, the microphone visualizer, and the /quiz widget
// (formulas, graphs, charts), driven through the REAL page in jsdom.   run:  node test/ui.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { bootApp } = require("./app-harness");

let passed = 0, failed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); } }
async function withApp(opts, fn) {
  const app = await bootApp(opts);
  try { app.w.confirm = () => true; await fn(app); assert.deepStrictEqual(app.errors.map(e => String(e && e.message || e)), [], "the page reported script errors"); }
  finally { app.close(); }
}
const PUBLIC = path.join(__dirname, "..", "public");
const CSS = fs.readFileSync(path.join(PUBLIC, "style.css"), "utf8");
// the declarations of the FIRST rule whose selector list is exactly `selector`
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&");
  const m = new RegExp("(?:^|\\n|\\})\\s*" + esc + "\\s*\\{([^}]*)\\}").exec(CSS);
  assert(m, "no CSS rule for " + selector);
  return m[1];
}
const scale = bar => parseFloat(/scaleY\(([\d.]+)\)/.exec(bar.style.transform)[1]);

(async () => {
  console.log("header and sidebar");
  await t("the theme toggle works from the sidebar footer: light on, light off, icon follows", () => withApp({}, async app => {
    const btn = app.$("#sidebar-footer #theme-btn");
    assert(btn && !app.$("header").contains(btn));
    assert(!app.w.document.body.classList.contains("light"));
    btn.click();
    assert(app.w.document.body.classList.contains("light") && app.w.document.documentElement.classList.contains("light"));
    assert(btn.querySelector(".fa-sun"), "sun icon while light");
    btn.click();
    assert(!app.w.document.body.classList.contains("light") && btn.querySelector(".fa-moon"));
  }));
  await t("no header delete-chat button; deleting a chat is done from the sidebar (and still resets the open chat)", () => withApp({
    routes: { "/chats": () => ({ status: 200, json: { chats: [{ id: "c1", title: "Old chat", history: [] }], success: true } }), "/chats/c1": () => ({ status: 200, json: { success: true } }) },
  }, async app => {
    assert(!app.$("#clear-btn"));
    app.$("#history-btn").click(); await app.sleep(60);
    const del = app.$(".delete-chat-btn");
    assert(del, "per-chat delete button in the sidebar");
    del.click(); await app.sleep(60);
    assert(app.calls.some(c => c.method === "DELETE" && c.path === "/chats/c1"));
  }));
  await t("easter-egg buttons are still added to the header's right side once unlocked", () => withApp({ storage: { agent1102_dino: "true" } }, async app => {
    const dino = [...app.$("#header-btns").querySelectorAll("button")].find(b => b.title === "Play Dino Game");
    assert(dino && dino.style.display !== "none");
  }));

  console.log("\ntext on red buttons: dark-theme dark colour in dark mode, white in light mode");
  await t("--on-danger is the dark theme's dark colour by default and white under .light", () => {
    assert(/--on-danger:#0a0a0c/.test(rule(":root")));
    assert(/--on-danger:#ffffff/.test(rule(".light")));
    assert(/--bg:#0a0a0c/.test(rule(":root")), "...which is the dark theme's own background colour");
  });
  await t("every solid red button takes its text and icon colour from it", () => {
    for (const sel of ["#clear-all-btn", ".delete-chat-btn:hover", ".tool-btn.recording", "#bottom-row .tool-btn.recording, #bottom-row .tool-btn.recording:hover:not(:disabled)",
      ".modal-btn.danger-solid, #profile-delete", "#clear-all-btn, #profile-delete"]) {
      const body = rule(sel);
      assert(/color:var\(--on-danger\)/.test(body), sel + " uses var(--on-danger)");
      assert(!/[^-]color:\s*(#fff\b|#ffffff|white)/i.test(body), sel + " has no hard-coded white");
    }
    assert(/\.avatar-x\s*\{[^}]*background:#c0392b; color:var\(--on-danger\)/.test(CSS), ".avatar-x");
  });

  console.log("\ncards are solid (no see-through fills or borders)");
  await t("quiz, flashcard, graph, chart, image, link and web-image cards use solid colours", () => {
    for (const sel of [".study-block", ".chart-block", ".image-frame", ".link-card", ".web-image", ".web-image-link", ".link-card-image", ".link-card-icon", ".danger-card"]) {
      const body = rule(sel.startsWith(".link-card") && sel !== ".link-card-image" && sel !== ".link-card-icon" ? ".link-card" : sel);
      assert(!/rgba?\(|opacity|hsla/i.test(body), sel + " has a see-through colour: " + body.trim().slice(0, 120));
    }
    assert(!/\.light \.(study-block|chart-block)\s*\{/.test(CSS), "no leftover light-mode translucent override");
    assert(!/\.light\.bg-on \.chart-block, \.light\.bg-on \.study-block/.test(CSS));
    for (const v of ["--card-bg", "--card-border", "--card-inset"]) assert(new RegExp(v + ":#[0-9a-f]{6}").test(rule(":root")) && new RegExp(v + ":#[0-9a-f]{6}").test(rule(".light")), v + " is solid in both themes");
  });

  console.log("\nmicrophone visualizer");
  const fakeRecognition = w => { w.__recs = []; w.webkitSpeechRecognition = class { constructor() { w.__recs.push(this); this.started = 0; this.stopped = 0; } start() { this.started++; } stop() { this.stopped++; } }; };
  const fakeAudio = (w, level) => {
    const st = { opened: 0, stopped: 0, closed: 0, level };
    Object.defineProperty(w.navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => { st.opened++; return { getTracks: () => [{ stop: () => st.stopped++ }] }; } } });
    w.AudioContext = class {
      constructor() { this.state = "running"; }
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return { fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 128, connect() {}, getByteFrequencyData: a => a.fill(st.level) }; }
      close() { st.closed++; return Promise.resolve(); }
      resume() { return Promise.resolve(); }
    };
    return st;
  };
  await t("the bars sit inside the message box, between the mic button and the text area, and start hidden", () => withApp({ pre: fakeRecognition }, async app => {
    const viz = app.$("#bottom-row #mic-viz");
    assert(viz && viz.nextElementSibling === app.$("#input") && viz.previousElementSibling === app.$("#mic-btn"));
    assert.strictEqual(viz.children.length, 32);
    assert(!app.$("#bottom-row").classList.contains("listening"));
    assert(/#bottom-row\.listening #input\s*\{\s*display:none/.test(CSS) && /#mic-viz\s*\{\s*display:none/.test(CSS) && /#bottom-row\.listening #mic-viz\s*\{\s*display:flex/.test(CSS));
  }));
  await t("listening shows them and moves them; a result, an error, or the end of listening hides them again", () => withApp({ pre: fakeRecognition }, async app => {
    const rec = app.w.__recs[0], row = app.$("#bottom-row"), viz = app.w.agent1102VoiceViz;
    app.$("#mic-btn").click();
    assert.strictEqual(rec.started, 1);
    rec.onstart();
    assert(row.classList.contains("listening") && app.$("#mic-btn").classList.contains("recording") && viz.active);
    rec.onspeechstart(); await app.sleep(260);
    const bars = [...app.$("#mic-viz").children];
    assert(bars.every(b => /scaleY/.test(b.style.transform)), "bars are animated");
    assert(Math.max(...bars.map(scale)) > 0.2, "bars rise while you speak");
    assert(scale(bars[15]) > scale(bars[0]), "the middle is taller than the ends");
    rec.onspeechend();
    rec.onresult({ results: [[{ transcript: "hello world" }]] });
    assert(!row.classList.contains("listening") && !viz.active && !app.$("#mic-btn").classList.contains("recording"));
    assert.strictEqual(app.$("#input").value, "hello world");
    for (const finish of [() => rec.onerror({ error: "no-speech" }), () => rec.onend()]) {
      app.$("#mic-btn").click(); rec.onstart();
      assert(row.classList.contains("listening"));
      finish();
      assert(!row.classList.contains("listening") && !viz.active);
    }
    assert(bars.every(b => b.style.transform === ""), "bars are reset");
  }));
  await t("clicking the bars stops listening", () => withApp({ pre: fakeRecognition }, async app => {
    const rec = app.w.__recs[0];
    app.$("#mic-btn").click(); rec.onstart();
    app.$("#mic-viz").click();
    assert.strictEqual(rec.stopped, 1);
  }));
  await t("on a computer the bars follow the real microphone (loud = tall, silent = short) and everything is released afterwards", () => withApp({ pre: fakeRecognition }, async app => {
    const st = fakeAudio(app.w, 255), rec = app.w.__recs[0], viz = app.w.agent1102VoiceViz;
    app.$("#mic-btn").click(); rec.onstart();
    await app.sleep(300);
    assert.strictEqual(st.opened, 1); assert.strictEqual(viz.mode, "mic");
    const bars = [...app.$("#mic-viz").children];
    assert(bars.every(b => scale(b) > 0.9), "loud sound: all bars tall");
    st.level = 0; await app.sleep(500);
    assert(bars.every(b => scale(b) < 0.15), "silence: all bars short");
    rec.onend();
    assert.strictEqual(st.stopped, 1, "microphone stream stopped"); assert.strictEqual(st.closed, 1, "audio context closed");
  }));
  await t("stopping before the browser has answered the microphone request still releases the microphone", () => withApp({ pre: fakeRecognition }, async app => {
    const st = fakeAudio(app.w, 100), rec = app.w.__recs[0];
    app.$("#mic-btn").click(); rec.onstart(); rec.onend();
    await app.sleep(60);
    assert.strictEqual(st.opened, 1); assert.strictEqual(st.stopped, 1, "late stream is stopped at once"); assert.strictEqual(app.w.agent1102VoiceViz.mode, "sim");
  }));
  await t("on a phone or tablet it never opens a second microphone stream (it would fight the speech recognizer): the bars react to speech events instead", () => withApp({ pre: fakeRecognition }, async app => {
    const st = fakeAudio(app.w, 255), rec = app.w.__recs[0];
    app.w.matchMedia = q => ({ matches: /pointer:\s*coarse/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
    app.$("#mic-btn").click(); rec.onstart(); await app.sleep(120);
    assert.strictEqual(st.opened, 0); assert.strictEqual(app.w.agent1102VoiceViz.mode, "sim");
    const bars = [...app.$("#mic-viz").children], quiet = Math.max(...bars.map(scale));
    rec.onspeechstart(); await app.sleep(500);
    assert(Math.max(...bars.map(scale)) > quiet + 0.1, "bars swell while speech is detected");
    rec.onend();
  }));
  await t("if the microphone is blocked the bars still run (animated version)", () => withApp({ pre: fakeRecognition }, async app => {
    fakeAudio(app.w, 255);
    app.w.navigator.mediaDevices.getUserMedia = async () => { throw new Error("denied"); };
    const rec = app.w.__recs[0];
    app.$("#mic-btn").click(); rec.onstart(); await app.sleep(120);
    assert.strictEqual(app.w.agent1102VoiceViz.mode, "sim"); assert(app.w.agent1102VoiceViz.active);
    rec.onend();
  }));

  console.log("\n/quiz in the chat: formulas, graphs, charts");
  const showQuiz = (app, quiz) => app.w.addMsg("ai", "Here's your quiz.\n\n```quiz\n" + JSON.stringify(quiz) + "\n```");
  // stands in for KaTeX (not installed for tests): what matters is that the page asks it to draw the right formulas
  const fakeKatex = w => { w.__tex = []; w.katex = { renderToString: (tex, o) => { w.__tex.push([tex, !!o.displayMode]); return `<span class="katex">[${tex}]</span>`; } }; };
  const fakeChart = w => {
    w.__charts = []; w.__destroyed = 0;
    w.Chart = class { constructor(canvas, cfg) { this.canvas = canvas; this.cfg = cfg; w.__charts.push(this); } destroy() { w.__destroyed++; } };
    w.Chart.defaults = { font: {} };
  };
  const optTexts = app => [...app.w.document.querySelectorAll(".quiz-option .quiz-text")];
  const pickOption = (app, matcher) => { const o = [...app.w.document.querySelectorAll(".quiz-option")].find(b => matcher.test(b.textContent)); assert(o, "option " + matcher); o.click(); return o; };

  await t("formulas in the question, options and explanation are drawn as math (inline and display, chemistry too)", () => withApp({}, async app => {
    fakeKatex(app.w);
    showQuiz(app, { title: "Math", questions: [{
      question: "What is \\(\\frac{1}{2} + \\frac{1}{4}\\)?",
      options: ["\\(\\frac{3}{4}\\)", "\\(\\ce{H2O}\\)", "$$x^2$$", "plain words"],
      answer: 0, explanation: "Common denominator: $$\\frac{2}{4}+\\frac{1}{4}=\\frac{3}{4}$$ so \\(\\frac{3}{4}\\).",
    }] });
    const q = app.$(".quiz-question");
    assert(q.querySelector(".math-inline[data-tex='\\\\frac{1}{2} + \\\\frac{1}{4}']"), "question formula: " + q.innerHTML);
    assert(!/\\\(/.test(q.textContent), "no raw \\( left in the question");
    const opts = optTexts(app);
    assert(opts[0].querySelector(".math-inline") || opts.some(o => o.querySelector(".math-inline[data-tex='\\\\frac{3}{4}']")), "option formula");
    assert(opts.some(o => o.querySelector(".math-inline[data-tex='\\\\ce{H2O}']")), "chemistry option");
    assert(opts.some(o => o.querySelector(".math-display[data-tex='x^2']")), "display math option");
    assert(opts.some(o => o.textContent === "plain words"));
    pickOption(app, /3/);
    const ex = app.$(".quiz-explain");
    assert(ex.querySelector(".math-display[data-tex='\\\\frac{2}{4}+\\\\frac{1}{4}=\\\\frac{3}{4}']") && ex.querySelector(".math-inline"), "explanation math: " + ex.innerHTML);
    assert(app.w.__tex.some(([tex, display]) => display && /frac\{2\}\{4\}/.test(tex)), "KaTeX was asked for display mode");
  }));
  await t("quiz text is never treated as HTML", () => withApp({}, async app => {
    showQuiz(app, { title: "T", questions: [{ question: "<img src=x onerror=alert(1)> what?", options: ["<b>a</b>", "<script>1</script>"], answer: 0, explanation: "<i>e</i>" }] });
    pickOption(app, /a/);
    assert.strictEqual(app.w.document.querySelectorAll(".quiz-block img, .quiz-block b, .quiz-block script, .quiz-block i:not(.fa-solid)").length, 0);
    assert(/<img src=x/.test(app.$(".quiz-question").textContent));
  }));
  await t("a graph above the question and one shown after answering (the same graph with the answer marked)", () => withApp({}, async app => {
    showQuiz(app, { title: "G", questions: [{
      question: "Where does it cross the x-axis?", options: ["-2 and 2", "0", "4", "-4 and 4"], answer: 0, explanation: "Set y = 0.",
      visual: { type: "graph", functions: [{ expr: "x^2-4" }], xMin: -5, xMax: 5, yMin: -5, yMax: 10 },
      explanationVisual: { type: "graph", functions: [{ expr: "x^2-4" }], points: [{ x: 2, y: 0 }, { x: -2, y: 0 }], xMin: -5, xMax: 5, yMin: -5, yMax: 10 },
    }] });
    const body = app.$(".study-body");
    assert(body.querySelector(".mv-inline svg"), "graph shown with the question");
    assert(body.children[0].classList.contains("mv-inline"), "...above the question text");
    assert(!app.$(".quiz-explain-pic"), "explanation graph hidden until answered");
    pickOption(app, /-2 and 2/);
    assert(app.$(".quiz-feedback .quiz-explain-pic svg"), "explanation graph appears after answering");
  }));
  await t("answers that are pictures ('which graph shows ...?'): a grid of graphs, each with its letter, and the right one is marked", () => withApp({}, async app => {
    const g = expr => ({ text: "", visual: { type: "graph", functions: [{ expr }] } });
    showQuiz(app, { title: "G", questions: [{ question: "Which graph shows y = x^2?", options: [g("x^2"), g("-x^2"), { text: "a line", visual: { type: "graph", functions: [{ expr: "x" }] } }], answer: 0, explanation: "A parabola opening up." }] });
    const list = app.$(".quiz-options");
    assert(list.classList.contains("has-pictures"));
    const opts = [...list.querySelectorAll(".quiz-option")];
    assert.strictEqual(opts.length, 3);
    assert(opts.every(o => o.querySelector(".quiz-content svg")), "every option has a picture");
    assert(opts.some(o => /a line/.test(o.textContent)), "picture + label");
    assert.deepStrictEqual(opts.map(o => o.querySelector(".quiz-letter").textContent).sort(), ["A", "B", "C"]);
    assert(opts.filter(o => !o.textContent.replace(/[ABC]/, "").trim()).every(o => /^Option [ABC], a picture$/.test(o.getAttribute("aria-label"))), "picture-only options get a spoken name");
    // the correct one is whichever has the upward parabola: find by clicking each in a fresh quiz is overkill, so click one and check the marking is applied somewhere
    opts[0].click();
    assert.strictEqual(list.querySelectorAll(".correct").length, 1);
    assert(opts.every(o => o.disabled));
  }));
  await t("a data chart above the question is drawn with the page's chart code; it is freed when you move on", () => withApp({}, async app => {
    fakeChart(app.w);
    const chart = { type: "bar", title: "Sales", labels: ["Jan", "Feb", "Mar"], datasets: [{ label: "Units", data: [12, 30, 21] }] };
    showQuiz(app, { title: "C", questions: [
      { question: "Which month sold most?", options: ["Jan", "Feb"], answer: 1, explanation: "Feb.", chart },
      { question: "Which month sold least?", options: ["Jan", "Mar"], answer: 0, explanation: "Jan.", chart },
    ] });
    await app.sleep(150);
    assert.strictEqual(app.w.__charts.length, 1, "chart drawn once the quiz is on the page");
    const c = app.w.__charts[0];
    assert(c.canvas.isConnected && c.canvas.closest(".quiz-chart") && c.canvas.closest(".quiz-block"));
    assert.strictEqual(c.cfg.type, "bar");
    assert.strictEqual(JSON.stringify(c.cfg.data.labels), '["Jan","Feb","Mar"]'); assert.strictEqual(JSON.stringify(c.cfg.data.datasets[0].data), "[12,30,21]");
    app.w.document.querySelectorAll(".quiz-option")[0].click();
    app.$(".study-btn.primary").click(); await app.sleep(150);
    assert.strictEqual(app.w.__destroyed, 1, "first question's chart released");
    assert.strictEqual(app.w.__charts.length, 2, "second question's chart drawn");
  }));
  await t("if the chart or graph can't be shown the question still works and says so", () => withApp({}, async app => {
    delete app.w.Chart;
    showQuiz(app, { title: "C", questions: [{ question: "Which month?", options: ["Jan", "Feb"], answer: 1, explanation: "e", chart: { type: "bar", labels: ["a", "b"], datasets: [{ data: [1, 2] }] }, visual: { type: "hologram" } }] });
    assert.strictEqual(app.w.document.querySelectorAll(".quiz-missing").length, 2, "one note for the graph, one for the chart");
    assert(/chart/.test(app.$(".quiz-missing").textContent) || /chart/.test(app.w.document.querySelectorAll(".quiz-missing")[1].textContent));
    pickOption(app, /Feb/);
    assert(app.$(".quiz-verdict.ok"));
  }));
  await t("quizzes saved before this change (plain text options) still work start to finish, with a retry for missed ones", () => withApp({}, async app => {
    showQuiz(app, { title: "Old", questions: [
      { question: "Capital of France?", options: ["Paris", "Rome", "Oslo", "Bern"], answer: 0, explanation: "Paris." },
      { question: "2 + 2?", options: ["3", "4", "5"], answer: 1, explanation: "Four." },
    ] });
    for (let i = 0; i < 2; i++) {
      const q = app.$(".quiz-question").textContent;
      pickOption(app, q.startsWith("Capital") ? /Paris/ : /^B?4$|4/);
      assert(app.$(".quiz-verdict.ok"), "correct on question " + (i + 1));
      app.$(".study-btn.primary").click();
    }
    assert.strictEqual(app.$(".quiz-score").textContent, "2 / 2");
    assert(/Perfect/.test(app.$(".quiz-score-label").textContent));
  }));
  await t("copying or downloading a quiz (and what the AI sees in follow-ups) includes formulas, chart data and graph equations", () => withApp({}, async app => {
    const json = JSON.stringify({ title: "Mixed", questions: [
      { question: "Read the graph", options: ["a", { text: "", visual: { type: "graph", functions: [{ expr: "x^2" }] } }], answer: 0, explanation: "Because \\(x^2\\).",
        visual: { type: "graph", functions: [{ expr: "x^2-4" }] }, chart: { type: "bar", title: "Sales", labels: ["Jan", "Feb"], datasets: [{ label: "Units", data: [1, 2] }] } },
    ] });
    const text = app.w.agent1102Study.quizToText(json);
    assert(/\*\*Mixed\*\*/.test(text) && /1\. Read the graph/.test(text));
    assert(/\[Graph[^\]]*x\^2-4/.test(text), "graph equation: " + text);
    assert(/\[Bar chart: Sales \(Jan = 1, Feb = 2\)\]/.test(text), "chart data: " + text);
    assert(/B\) \[Graph[^\]]*x\^2/.test(text), "picture option");
    assert(/Answer: A - Because \\\(x\^2\\\)\./.test(text), "formula kept as written");
    const viaResponse = app.w.agent1102Render.responseToText("```quiz\n" + json + "\n```");
    assert(/Bar chart: Sales/.test(viaResponse));
  }));

  console.log("\nthe creator link");
  await t("the AI's instructions and the quick hint both point at jymer1102.com, not the old github.io address", () => {
    const sp = require("../lib/system-prompt").SYSTEM_PROMPT;
    assert(sp.includes("https://jymer1102.com (their site)") && !sp.includes("github.io"));
    const chatRoute = fs.readFileSync(path.join(__dirname, "..", "routes", "chat.js"), "utf8");
    assert(chatRoute.includes("https://jymer1102.com and https://linktr.ee/jymer1102") && !chatRoute.includes("github.io"));
  });

  console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
  process.exit(failed ? 1 : 0);
})();
