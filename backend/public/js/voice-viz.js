// ============================================================
//  Voice input: audio visualizer inside the message box
//  While the microphone is listening, a row of bars replaces the text area and moves with the sound.
//  (Click the bars, or the mic button, to stop.)  chat.js calls start() / stop() / setSpeaking().
//
//  Two ways of driving the bars:
//   - "mic": the real microphone level, read with the Web Audio API (desktop browsers).
//   - "sim": a gently moving animation that swells whenever the speech recognizer reports sound: it
//     is told when sound starts and stops, and gets a pulse each time it hears more words (pulse()).
//     Used on phones and tablets, where the browser's speech recognizer and a second microphone
//     stream can fight over the one microphone (the recognizer then stops listening), and also on
//     any device where the extra microphone stream can't be opened. Phones send very few events, so
//     this mode always keeps visibly moving, and the bars never sit flat.
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
  let burst = 0;            // set to 1 by pulse() (more words heard), fades away in about half a second
  let speakStamp = 0;       // when speaking was last switched on or refreshed: a phone may never say that the sound stopped, so it expires
  const SPEAKING_EXPIRES_MS = 2000;
  let lastFrame = 0;
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
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0.016;
    lastFrame = now;
    if (speaking && performance.now() - speakStamp > SPEAKING_EXPIRES_MS) speaking = false; // no news for two seconds: it has gone quiet
    speakAmt += ((speaking ? 1 : 0) - speakAmt) * Math.min(1, dt * 8);
    burst *= Math.pow(0.5, dt / 0.25); // halves every quarter of a second
    const energy = Math.max(speakAmt, burst); // 0 = quiet, 1 = talking
    return levels.map((_, i) => {
      const k = edgeDistance(i);
      const shape = 1 - 0.4 * k; // taller in the middle
      if (reducedMotion()) return (0.16 + 0.6 * energy) * shape; // still, just taller while you speak
      const wave = 0.5 + 0.5 * Math.sin(t * (2.1 + i * 0.29) + i * 1.7);
      const wave2 = 0.5 + 0.5 * Math.sin(t * (3.3 + i * 0.17) + i * 0.6);
      const idle = 0.1 + 0.16 * wave; // always moving, so it is clearly alive even when no events arrive (phones)
      const talking = energy * (0.3 + 0.65 * (0.55 * wave2 + 0.45 * wave));
      return (idle + talking) * shape;
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
    burst = 0;
    lastFrame = 0;
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
    burst = 0;
    row.classList.remove("listening");
    viz.setAttribute("aria-hidden", "true");
    bars.forEach(b => { b.style.transform = ""; });
  }

  function setSpeaking(on) { speaking = !!on; speakStamp = performance.now(); }
  // the recognizer just heard more words: swell the bars for a moment (only the animated mode needs this). It also counts as
  // news that there is still sound, so a "speaking" state that never got its "stopped" event is kept alive only while words keep coming.
  function pulse() { burst = 1; speakStamp = performance.now(); }

  viz.setAttribute("aria-hidden", "true");
  window.agent1102VoiceViz = { start, stop, setSpeaking, pulse, get active() { return running; }, get mode() { return mode; } };
})();
