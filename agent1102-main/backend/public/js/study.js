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
    box.textContent = `Couldn't show this ${kind}: ${msg}`;
    return box;
  }

  /* ------------------------------ Quiz ------------------------------ */
  function normalizeQuiz(raw) {
    if (!raw || !Array.isArray(raw.questions)) throw new Error("the quiz data isn't valid.");
    const questions = raw.questions.filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 2 &&
      Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length)
      .map(q => ({ question: String(q.question), options: q.options.map(String), answer: q.answer, explanation: q.explanation ? String(q.explanation) : "", visual: q.visual && typeof q.visual === "object" ? q.visual : null }));
    if (!questions.length) throw new Error("it has no usable questions.");
    return { title: raw.title ? String(raw.title) : "Quiz", questions };
  }

  function buildQuiz(rawText) {
    let quiz;
    try { quiz = normalizeQuiz(JSON.parse(rawText)); }
    catch (e) { return errorBox("quiz", rawText, e instanceof SyntaxError ? "the data wasn't valid JSON." : e.message); }

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
    function start(list) { order = shuffleQuestions(list); idx = 0; score = 0; missed = []; show(); }
    // shuffle answer positions too so a retake isn't memorised by position
    function shuffleQuestions(list) {
      return shuffle(list).map(q => {
        const opts = q.options.map((text, i) => ({ text, ok: i === q.answer }));
        const mixed = shuffle(opts);
        return { question: q.question, options: mixed.map(o => o.text), answer: mixed.findIndex(o => o.ok), explanation: q.explanation, visual: q.visual, orig: q };
      });
    }

    function show() {
      body.replaceChildren();
      if (idx >= order.length) return finish();
      const q = order[idx];
      progress.textContent = `Question ${idx + 1} of ${order.length}`;
      fill.style.width = (idx / order.length * 100) + "%";

      const pic = q.visual && window.agent1102MathViz ? window.agent1102MathViz.buildInline(q.visual) : null;
      if (pic) body.appendChild(pic); // graph / number line / diagram for this question
      body.appendChild(el("div", "quiz-question", q.question));
      const list = el("div", "quiz-options");
      const feedback = el("div", "quiz-feedback");
      const next = btn("study-btn primary", idx + 1 >= order.length ? "fa-flag-checkered" : "fa-arrow-right", idx + 1 >= order.length ? "See results" : "Next");
      next.style.display = "none";
      let answered = false;

      q.options.forEach((text, i) => {
        const o = btn("quiz-option");
        o.append(el("span", "quiz-letter", String.fromCharCode(65 + i)), el("span", "quiz-text", text));
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
          if (q.explanation) feedback.appendChild(el("div", "quiz-explain", q.explanation));
          next.style.display = "inline-flex";
          fill.style.width = ((idx + 1) / order.length * 100) + "%";
        });
        list.appendChild(o);
      });
      next.addEventListener("click", () => { idx++; show(); });
      body.append(list, feedback, next);
    }

    function finish() {
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
    if (!raw || !Array.isArray(raw.cards)) throw new Error("the flashcard data isn't valid.");
    const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : null);
    const cards = raw.cards.filter(c => c && c.front && c.back).map(c => ({ front: String(c.front), back: String(c.back), frontVisual: obj(c.frontVisual), backVisual: obj(c.backVisual) }));
    if (!cards.length) throw new Error("it has no usable cards.");
    return { title: raw.title ? String(raw.title) : "Flashcards", cards };
  }

  function buildFlashcards(rawText) {
    let deck;
    try { deck = normalizeDeck(JSON.parse(rawText)); }
    catch (e) { return errorBox("flashcards", rawText, e instanceof SyntaxError ? "the data wasn't valid JSON." : e.message); }

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
  function quizToText(rawText) {
    try {
      const q = normalizeQuiz(JSON.parse(rawText));
      return `**${q.title}**\n\n` + q.questions.map((x, n) =>
        `${n + 1}. ${x.question}\n` + x.options.map((o, k) => `   ${String.fromCharCode(65 + k)}) ${o}`).join("\n") +
        `\n   Answer: ${String.fromCharCode(65 + x.answer)}${x.explanation ? " - " + x.explanation : ""}`).map((t, i) => (x => x)(q.questions[i].visual && window.agent1102MathViz ? "   " + window.agent1102MathViz.toText(q.questions[i].visual) + "\n" + t : t)).join("\n\n") + "\n";
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
