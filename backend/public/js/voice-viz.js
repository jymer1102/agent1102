// ============================================================
//  Voice input: audio visualizer inside the message box
//  While the microphone is listening, a row of bars replaces the text area and moves with the sound.
//  (Click the bars, or the mic button, to stop.)  chat.js calls start() / stop() / setSpeaking().
//
//  Two ways of driving the bars:
//   - "mic": the real microphone level, read with the Web Audio API (desktop browsers).
//   - "sim": a calm animation that swells while the speech recognizer reports that you are talking.
//     Used on phones and tablets, where the browser's speech recognizer and a second microphone
//     stream can fight over the one microphone (the recognizer then stops listening), and also on
//     any device where the extra microphone stream can't be opened.
// ============================================================
(function () {
  "use strict";

  const BARS = 32;
  const row = document.getElementById("bottom-row");
  const input = document.getElementById("input");
  if (!row || !input) return;

  // ---- the bars (plain elements, so no canvas is needed and the theme colours come from CSS) ----
  const viz = document.createElement("div");
  viz.id = "mic-viz";
  viz.setAttribute("role", "img");
  viz.setAttribute("aria-label", "Listening. The bars move with your voice. Tap to stop.");
  viz.title = "Listening... tap to stop";
  const bars = [];
  for (let i = 0; i < BARS; i++) {
    const b = document.createElement("span");
    b.className = "mic-viz-bar";
    viz.appendChild(b);
    bars.push(b);
  }
  row.insertBefore(viz, input);
  viz.addEventListener("click", () => { const m = document.getElementById("mic-btn"); if (m) m.click(); });

  // ---- state ----
  let running = false;
  let token = 0;            // bumped on every start/stop, so a late microphone answer can tell it is out of date
  let raf = 0;
  let mode = "sim";
  let speaking = false;
  let speakAmt = 0;         // eases towards 1 while speaking
  let stream = null, audioCtx = null, analyser = null, freq = null;
  const levels = new Array(BARS).fill(0);

  const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const isTouchDevice = () =>
    !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "") ||
    ((navigator.maxTouchPoints || 0) > 1 && /Mac/i.test(navigator.platform || "")); // iPadOS says "Mac"
  const canReadMic = () =>
    !isTouchDevice() && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext));

  function closeMic() {
    if (stream) { try { stream.getTracks().forEach(t => t.stop()); } catch (_) {} }
    if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
    stream = audioCtx = analyser = freq = null;
  }

  function openMic(mine) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(s => {
      if (mine !== token || !running) { s.getTracks().forEach(t => t.stop()); return; } // stopped while the browser was answering
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AC();
        const src = audioCtx.createMediaStreamSource(s);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.55;
        src.connect(analyser);
        freq = new Uint8Array(analyser.frequencyBinCount);
        stream = s;
        if (audioCtx.state === "suspended" && audioCtx.resume) audioCtx.resume().catch(() => {});
        mode = "mic";
      } catch (_) {
        s.getTracks().forEach(t => t.stop());
        closeMic();
        mode = "sim";
      }
    }).catch(() => { mode = "sim"; }); // blocked or busy: the animated version keeps going
  }

  // The loudest sounds in the middle, quieter high sounds towards the edges
  const edgeDistance = i => Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2); // 0 in the middle, 1 at the ends

  function targetsFromMic() {
    analyser.getByteFrequencyData(freq);
    const top = Math.min(freq.length - 1, 44); // speech lives in the lower part of the spectrum
    return levels.map((_, i) => {
      const k = edgeDistance(i);
      const bin = 1 + Math.round(k * (top - 1));
      const v = (freq[bin] + (freq[bin + 1] || freq[bin])) / 510; // 0..1
      return Math.min(1, Math.pow(v, 1.25) * 1.45);
    });
  }

  function targetsFromSim(now) {
    const t = now / 1000;
    speakAmt += ((speaking ? 1 : 0) - speakAmt) * 0.08;
    const base = 0.07 + 0.5 * speakAmt;
    return levels.map((_, i) => {
      const k = edgeDistance(i);
      if (reducedMotion()) return base * (1 - 0.5 * k); // still, just taller while you speak
      const wave = 0.5 + 0.5 * Math.sin(t * (2.1 + i * 0.29) + i * 1.7);
      const wave2 = 0.5 + 0.5 * Math.sin(t * (3.3 + i * 0.17) + i * 0.6);
      return base * (0.3 + 0.7 * (0.6 * wave + 0.4 * wave2)) * (1 - 0.45 * k) * (speakAmt > 0.2 ? 1.35 : 1);
    });
  }

  function frame(now) {
    if (!running) return;
    let targets;
    try { targets = mode === "mic" && analyser ? targetsFromMic() : targetsFromSim(now); }
    catch (_) { mode = "sim"; targets = targetsFromSim(now); }
    for (let i = 0; i < BARS; i++) {
      const rise = targets[i] > levels[i];
      levels[i] += (targets[i] - levels[i]) * (rise ? 0.55 : 0.16);
      bars[i].style.transform = "scaleY(" + Math.max(0.1, Math.min(1, levels[i])).toFixed(3) + ")";
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    running = true;
    const mine = ++token;
    mode = "sim";
    speaking = false;
    speakAmt = 0;
    levels.fill(0);
    row.classList.add("listening");
    viz.setAttribute("aria-hidden", "false");
    if (canReadMic()) openMic(mine);
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (!running) return;
    running = false;
    token++;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    closeMic();
    mode = "sim";
    speaking = false;
    row.classList.remove("listening");
    viz.setAttribute("aria-hidden", "true");
    bars.forEach(b => { b.style.transform = ""; });
  }

  function setSpeaking(on) { speaking = !!on; }

  viz.setAttribute("aria-hidden", "true");
  window.agent1102VoiceViz = { start, stop, setSpeaking, get active() { return running; }, get mode() { return mode; } };
})();
