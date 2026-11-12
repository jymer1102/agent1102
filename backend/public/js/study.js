// ============================================================
//  Study widgets: interactive quiz + flip flashcards
//  The AI reply carries the data in a ```quiz or ```flashcards JSON block
//  (so it saves/restores with the chat); render.js hands those blocks here.
// ============================================================
(function () {
  "use strict";

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function shuffle(a) {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
    return r;
  }
  function icon(name) { const i = el("i", "fa-solid " + name); return i; }
  function btn(cls, iconName, label) {
    const b = el("button", cls);
    b.type = "button";
    if (iconName) b.appendChild(icon(iconName));
    if (label) b.appendChild(el("span", "", label));
    return b;
  }
  function errorBox(kind, rawText, msg) {
    const box = el("div", "study-block study-error");
    box.textContent = `I couldn't show this ${kind}: ${msg} Try asking for it again.`;
    return box;
  }

  /* ------------------- Formulas, graphs and charts ------------------- */
  const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

  // Text that may hold formulas (LaTeX in \( \) or $$ $$, chemistry with \ce{}) is drawn as real math (see render.js)
  function setRich(node, text) {
    const R = window.agent1102Render;
    if (R && R.renderMathText) R.renderMathText(node, text); else node.textContent = text;
    return node;
  }
  function rich(tag, cls, text) { return setRich(el(tag, cls), text); }

  // A math picture (function graph, number line, geometry figure, fractions): the drawn element, or null if it can't be drawn
  function picture(spec) {
    const MV = window.agent1102MathViz;
    return isObj(spec) && MV ? MV.buildInline(spec) : null;
  }
  // A data chart. A quiz is built before it is attached to the page and Chart.js needs a canvas that is in the page,
  // so drawing waits until the chart is attached (and gives up after a couple of seconds if it never is).
  function chartPicture(spec) {
    const R = window.agent1102Render;
    const c = isObj(spec) && R && R.buildStudyChart ? R.buildStudyChart(spec) : null;
    if (!c) return null;
    let tries = 0;
    (function tryDraw() {
      if (c.node.isConnected) { try { c.draw(); } catch (e) { console.error("Quiz chart failed:", e); } }
      else if (++tries < 60) setTimeout(tryDraw, 40);
    })();
    return c;
  }
  const missing = what => el("div", "study-error quiz-missing", `(The ${what} for this question couldn't be shown.)`);

  /* ------------------------------ Quiz ------------------------------ */
  // An option is plain text, or { text, visual } when the choices are pictures ("Which graph shows ...?")
  const asOption = o => isObj(o)
    ? { text: o.text != null ? String(o.text) : "", visual: isObj(o.visual) ? o.visual : null }
    : { text: String(o), visual: null };

  function normalizeQuiz(raw) {
    if (!raw || !Array.isArray(raw.questions)) throw new Error("the quiz data was incomplete or malformed.");
    const questions = raw.questions.filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 2 &&
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length)
      .map(q => ({
        question: String(q.question), options: q.options.map(asOption), answer: q.answer,
        explanation: q.explanation ? String(q.explanation) : "",
        visual: isObj(q.visual) ? q.visual : null,                         // graph / number line / figure above the question
        chart: isObj(q.chart) ? q.chart : null,                            // bar / line / pie / donut / radar chart above the question
        explanationVisual: isObj(q.explanationVisual) ? q.explanationVisual : null, // shown after answering
      }));
    if (!questions.length) throw new Error("it has no usable questions.");
    return { title: raw.title ? String(raw.title) : "Quiz", questions };
  }

  function buildQuiz(rawText) {
    let quiz;
    try { quiz = normalizeQuiz(JSON.parse(rawText)); }
    catch (e) { return errorBox("quiz", rawText, e instanceof SyntaxError ? "the data was incomplete or malformed." : e.message); }

    const block = el("div", "study-block quiz-block");
    const head = el("div", "study-head");
    const kind = el("span", "study-kind");
    kind.append(icon("fa-clipboard-question"), document.createTextNode(" " + quiz.title));
    const progress = el("span", "study-progress");
    head.append(kind, progress);
    const bar = el("div", "study-bar"); const fill = el("div", "study-bar-fill"); bar.appendChild(fill);
    const body = el("div", "study-body");
    block.append(head, bar, body);

    let order, idx, score, missed;
    let liveChart = null; // the chart of the question on screen (freed when the question changes)
    function dropChart() { if (liveChart) { liveChart.destroy(); liveChart = null; } }
    function start(list) { order = shuffleQuestions(list); idx = 0; score = 0; missed = []; show(); }
    // shuffle answer positions too so a retake isn't memorised by position
    function shuffleQuestions(list) {
      return shuffle(list).map(q => {
        const opts = q.options.map((o, i) => ({ o, ok: i === q.answer }));
        const mixed = shuffle(opts);
        return { question: q.question, options: mixed.map(m => m.o), answer: mixed.findIndex(m => m.ok), explanation: q.explanation,
          visual: q.visual, chart: q.chart, explanationVisual: q.explanationVisual, orig: q };
      });
    }

    function show() {
      dropChart();
      body.replaceChildren();
      if (idx >= order.length) return finish();
      const q = order[idx];
      progress.textContent = `Question ${idx + 1} of ${order.length}`;
      fill.style.width = (idx / order.length * 100) + "%";

      if (q.visual) body.appendChild(picture(q.visual) || missing("graph"));  // graph / number line / diagram for this question
      if (q.chart) {                                                          // data chart for this question
        liveChart = chartPicture(q.chart);
        body.appendChild(liveChart ? liveChart.node : missing("chart"));
      }
      body.appendChild(rich("div", "quiz-question", q.question));
      const list = el("div", "quiz-options" + (q.options.some(o => o.visual) ? " has-pictures" : ""));
      const feedback = el("div", "quiz-feedback");
      const next = btn("study-btn primary", idx + 1 >= order.length ? "fa-flag-checkered" : "fa-arrow-right", idx + 1 >= order.length ? "See results" : "Next");
      next.style.display = "none";
      let answered = false;

      q.options.forEach((opt, i) => {
        const o = btn("quiz-option");
        const letter = String.fromCharCode(65 + i);
        const content = el("span", "quiz-content");
        const pic = opt.visual ? picture(opt.visual) : null;
        if (pic) content.appendChild(pic);
        if (opt.text) content.appendChild(rich("span", "quiz-text", opt.text));
        else if (!pic) content.appendChild(el("span", "quiz-text", "(picture unavailable)"));
        if (!opt.text) o.setAttribute("aria-label", "Option " + letter + (pic ? ", a picture" : ""));
        o.append(el("span", "quiz-letter", letter), content);
        o.addEventListener("click", () => {
          if (answered) return;
          answered = true;
          const right = i === q.answer;
          if (right) score++; else missed.push(q.orig);
          [...list.children].forEach((c, ci) => {
            c.disabled = true;
            if (ci === q.answer) c.classList.add("correct");
            else if (ci === i) c.classList.add("wrong");
          });
          feedback.replaceChildren();
          const verdict = el("div", "quiz-verdict " + (right ? "ok" : "bad"));
          verdict.append(icon(right ? "fa-circle-check" : "fa-circle-xmark"), document.createTextNode(right ? " Correct!" : " Not quite."));
          feedback.appendChild(verdict);
          if (q.explanation) feedback.appendChild(rich("div", "quiz-explain", q.explanation));
          const ePic = q.explanationVisual ? picture(q.explanationVisual) : null;
          if (ePic) { ePic.classList.add("quiz-explain-pic"); feedback.appendChild(ePic); } // e.g. the same graph with the answer marked
          next.style.display = "inline-flex";
          fill.style.width = ((idx + 1) / order.length * 100) + "%";
        });
        list.appendChild(o);
      });
      next.addEventListener("click", () => { idx++; show(); });
      body.append(list, feedback, next);
    }

    function finish() {
      dropChart();
      progress.textContent = "Done";
      fill.style.width = "100%";
      const pct = Math.round(score / order.length * 100);
      const box = el("div", "quiz-result");
      box.appendChild(el("div", "quiz-score", `${score} / ${order.length}`));
      box.appendChild(el("div", "quiz-score-label",
        pct === 100 ? "Perfect score!" : pct >= 80 ? "Great job!" : pct >= 60 ? "Good effort, a little more practice will lock it in." : "Keep practicing, you'll get there."));
      const row = el("div", "study-actions");
      if (missed.length) {
        const rev = btn("study-btn primary", "fa-rotate-left", `Retry ${missed.length} missed`);
        rev.addEventListener("click", () => start(missed.slice()));
        row.appendChild(rev);
      }
      const again = btn("study-btn", "fa-shuffle", "Retake all");
      again.addEventListener("click", () => start(quiz.questions));
      row.appendChild(again);
      box.appendChild(row);
      body.replaceChildren(box);
    }

    start(quiz.questions);
    return block;
  }

  /* --------------------------- Flashcards --------------------------- */
  function normalizeDeck(raw) {
    if (!raw || !Array.isArray(raw.cards)) throw new Error("the flashcard data was incomplete or malformed.");
    const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
    const cards = raw.cards.filter(c => c && c.front && c.back).map(c => ({ front: String(c.front), back: String(c.back), frontVisual: obj(c.frontVisual), backVisual: obj(c.backVisual) }));
    if (!cards.length) throw new Error("it has no usable cards.");
    return { title: raw.title ? String(raw.title) : "Flashcards", cards };
  }

  function buildFlashcards(rawText) {
    let deck;
    try { deck = normalizeDeck(JSON.parse(rawText)); }
    catch (e) { return errorBox("flashcards", rawText, e instanceof SyntaxError ? "the data was incomplete or malformed." : e.message); }

    const block = el("div", "study-block cards-block");
    const head = el("div", "study-head");
    const kind = el("span", "study-kind");
    kind.append(icon("fa-clone"), document.createTextNode(" " + deck.title));
    const progress = el("span", "study-progress");
    head.append(kind, progress);
    const bar = el("div", "study-bar"); const fill = el("div", "study-bar-fill"); bar.appendChild(fill);
    const body = el("div", "study-body");
    block.append(head, bar, body);

    let list, i, known;
    function start(cards) { list = cards.slice(); i = 0; known = 0; show(); }

    function show() {
      body.replaceChildren();
      if (i >= list.length) return finish();
      const c = list[i];
      progress.textContent = `Card ${i + 1} of ${list.length}`;
      fill.style.width = (i / list.length * 100) + "%";

      const card = btn("flashcard");
      card.setAttribute("aria-label", "Flashcard. Tap to flip.");
      const inner = el("div", "flashcard-inner");
      const front = el("div", "flashcard-face front");
      const MV = window.agent1102MathViz;
      const fPic = c.frontVisual && MV ? MV.buildInline(c.frontVisual) : null;
      const bPic = c.backVisual && MV ? MV.buildInline(c.backVisual) : null;
      front.append(el("div", "flashcard-tag", "Front"));
      if (fPic) front.appendChild(fPic);
      front.append(el("div", "flashcard-text", c.front), el("div", "flashcard-hint", "Tap to flip"));
      const back = el("div", "flashcard-face back");
      back.append(el("div", "flashcard-tag", "Back"));
      if (bPic) back.appendChild(bPic);
      back.append(el("div", "flashcard-text", c.back));
      if (fPic || bPic) card.classList.add("has-visual");
      inner.append(front, back);
      card.appendChild(inner);
      card.addEventListener("click", () => { card.classList.toggle("flipped"); actions.style.visibility = "visible"; });

      const actions = el("div", "study-actions");
      actions.style.visibility = "hidden"; // grading unlocks after the first flip
      const learning = btn("study-btn", "fa-rotate", "Still learning");
      const gotIt = btn("study-btn primary", "fa-check", "Got it");
      learning.addEventListener("click", () => { list.push(c); i++; show(); }); // comes around again at the end
      gotIt.addEventListener("click", () => { known++; i++; show(); });
      actions.append(learning, gotIt);
      body.append(card, actions);
    }

    function finish() {
      progress.textContent = "Done";
      fill.style.width = "100%";
      const box = el("div", "quiz-result");
      box.appendChild(el("div", "quiz-score", "Deck complete"));
      box.appendChild(el("div", "quiz-score-label", `You went through all ${deck.cards.length} cards.`));
      const row = el("div", "study-actions");
      const again = btn("study-btn primary", "fa-shuffle", "Shuffle and go again");
      again.addEventListener("click", () => start(shuffle(deck.cards)));
      row.appendChild(again);
      box.appendChild(row);
      body.replaceChildren(box);
    }

    start(deck.cards);
    return block;
  }

  /* ------------------ Plain text (copy / download) ------------------ */
  // Short text stand-ins for pictures. The graph's equations are included, so a follow-up like "explain question 3" still has them.
  function visualText(v) {
    const MV = window.agent1102MathViz;
    let out = MV ? MV.toText(v) : "[Math visual]";
    const fns = isObj(v) && Array.isArray(v.functions) ? v.functions.map(f => f && (f.label || f.expr)).filter(Boolean).join("; ") : "";
    if (fns && out.endsWith("]")) out = out.slice(0, -1) + (out.includes(":") ? " | " : ": ") + fns + "]";
    return out;
  }
  function chartText(spec) {
    try {
      const c = window.agent1102Render.normalizeChartSpec(spec);
      const many = c.datasets.length > 1;
      const data = c.datasets.map(d => (many ? d.label + ": " : "") + c.labels.map((l, i) => `${l} = ${d.data[i]}`).join(", ")).join("; ");
      const name = c.type === "doughnut" ? "Donut" : c.type[0].toUpperCase() + c.type.slice(1);
      return `[${name} chart${c.title ? ": " + c.title : ""} (${data})]`;
    } catch (_) { return "[Chart]"; }
  }
  function quizToText(rawText) {
    try {
      const q = normalizeQuiz(JSON.parse(rawText));
      const letter = k => String.fromCharCode(65 + k);
      return `**${q.title}**\n\n` + q.questions.map((x, n) => {
        const lines = [`${n + 1}. ${x.question}`];
        if (x.visual) lines.push("   " + visualText(x.visual));
        if (x.chart) lines.push("   " + chartText(x.chart));
        x.options.forEach((o, k) => lines.push(`   ${letter(k)}) ${[o.text, o.visual ? visualText(o.visual) : ""].filter(Boolean).join(" ")}`));
        lines.push(`   Answer: ${letter(x.answer)}${x.explanation ? " - " + x.explanation : ""}`);
        if (x.explanationVisual) lines.push("   " + visualText(x.explanationVisual));
        return lines.join("\n");
      }).join("\n\n") + "\n";
    } catch (_) { return null; }
  }
  function cardsToText(rawText) {
    try {
      const d = normalizeDeck(JSON.parse(rawText));
      return `**${d.title}**\n\n` + d.cards.map((c, n) => `${n + 1}. ${c.front}\n   ${c.back}`).join("\n\n") + "\n";
    } catch (_) { return null; }
  }

  window.agent1102Study = { buildQuiz, buildFlashcards, quizToText, cardsToText, LANGS: { quiz: "quiz", flashcards: "flashcards" } };
})();
