// ============================================================
//  The drag corner of the resizable text boxes in Settings.
//
//  Browsers draw that little corner (and its mouse cursor) themselves, and no CSS can change the cursor there. So with a mouse or
//  trackpad the browser's own corner is switched off (style.css) and this file does the same job: hovering the bottom-right corner
//  shows your vertical-resize cursor, and dragging it makes the box taller or shorter. Touch-only screens keep the browser's own corner.
// ============================================================
(function () {
  "use strict";
  if (!window.matchMedia || !window.matchMedia("(any-pointer: fine)").matches) return;

  const BOX = ".settings-box textarea";
  const ZONE = 18; // px: how big the draggable corner is
  let marked = null; // the box whose corner the mouse is over right now
  let drag = null;   // { box, y, height, min } while dragging

  const inCorner = (box, e) => {
    const r = box.getBoundingClientRect();
    return e.clientX >= r.right - ZONE && e.clientX <= r.right + 2 && e.clientY >= r.bottom - ZONE && e.clientY <= r.bottom + 2;
  };
  const mark = (box, on) => { if (box) box.classList.toggle("cur-resize-v", on); };
  const px = v => parseFloat(v) || 0;

  document.addEventListener("pointerdown", e => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const box = e.target.closest && e.target.closest(BOX);
    if (!box || !inCorner(box, e)) return;
    const cs = getComputedStyle(box);
    const extra = cs.boxSizing === "border-box" ? 0 : px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    drag = { box, y: e.clientY, height: box.getBoundingClientRect().height - extra, min: px(cs.minHeight), transition: box.style.transition };
    box.style.transition = "none"; // the boxes animate their changes; while dragging, the height must follow the mouse straight away
    box.style.flex = "none";       // the global textarea rule gives them flex:1 1 0%, which makes a column-flex parent ignore any height we set
    e.preventDefault();
    try { box.setPointerCapture(e.pointerId); } catch (_) { /* fine without it */ }
    mark(box, true);
  });

  document.addEventListener("pointermove", e => {
    if (drag) { drag.box.style.height = Math.max(drag.min, drag.height + (e.clientY - drag.y)) + "px"; e.preventDefault(); return; }
    if (e.pointerType !== "mouse") return;
    const box = e.target.closest && e.target.closest(BOX);
    const over = box && inCorner(box, e) ? box : null;
    if (marked && marked !== over) mark(marked, false);
    if (over) mark(over, true);
    marked = over;
  });

  const stop = () => { if (!drag) return; const b = drag.box; b.style.transition = drag.transition; drag = null; mark(b, false); marked = null; };
  document.addEventListener("pointerup", stop);
  document.addEventListener("pointercancel", stop);
})();
