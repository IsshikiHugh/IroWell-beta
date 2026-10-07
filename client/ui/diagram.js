// Mermaid diagrams (render.js draws them), as on GitHub: drag to pan, ⌘/Ctrl-scroll or pinch to zoom, and
// the buttons that show on hover. The listeners sit on the document: a reply that is still typing out is
// drawn again every frame, so its elements come and go.

const views = new WeakMap(); // .diagram -> { s, x, y }
const ZOOM = 1.25, PAN = 60, MIN = 0.2, MAX = 8;

const viewOf = (frame) => views.get(frame) || { s: 1, x: 0, y: 0 };
function show(frame, t) {
  views.set(frame, t);
  frame.querySelector('.diagram-view').style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.s})`;
}
// Zoom by `k`, keeping the point (cx, cy) where it is on screen (the frame's centre when not given).
function zoom(frame, k, cx, cy) {
  const t = viewOf(frame);
  const s = Math.min(MAX, Math.max(MIN, t.s * k));
  if (cx == null) { const f = frame.getBoundingClientRect(); cx = f.left + f.width / 2; cy = f.top + f.height / 2; }
  const r = frame.querySelector('.diagram-view').getBoundingClientRect(); // its top left is where the pan put it
  const px = cx - (r.left - t.x), py = cy - (r.top - t.y);
  show(frame, { s, x: px - (px - t.x) * (s / t.s), y: py - (py - t.y) * (s / t.s) });
}
const pan = (frame, dx, dy) => { const t = viewOf(frame); show(frame, { ...t, x: t.x + dx, y: t.y + dy }); };
const ACTS = {
  'zoom-in': (f) => zoom(f, ZOOM), 'zoom-out': (f) => zoom(f, 1 / ZOOM), reset: (f) => show(f, { s: 1, x: 0, y: 0 }),
  up: (f) => pan(f, 0, -PAN), down: (f) => pan(f, 0, PAN), left: (f) => pan(f, -PAN, 0), right: (f) => pan(f, PAN, 0),
};

// `openModal(title)` (app.js) opens a dialog and returns its body.
export function initDiagrams(openModal) {
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('.diagram-block [data-act], .diagram-block .diagram-toggle');
    if (!b) return;
    const block = b.closest('.diagram-block');
    const frame = block.querySelector('.diagram');
    const act = b.dataset.act || 'source';
    if (act === 'source') block.classList.toggle('show-source');
    else if (act === 'copy') {
      let ok = true;
      try { await navigator.clipboard.writeText(block.querySelector('.diagram-source code').textContent); } catch { ok = false; }
      b.dataset.done = ok ? '✓' : '✕'; // style.css shows it in place of the icon for a moment
      setTimeout(() => delete b.dataset.done, 1200);
    } else if (act === 'expand') {
      const body = openModal('Diagram');
      body.parentElement.classList.add('diagram-modal');
      const big = block.cloneNode(true);
      big.classList.add('expanded');
      big.classList.remove('show-source');
      big.querySelector('.diagram-view').style.transform = '';
      for (const e of big.querySelectorAll('[data-done]')) delete e.dataset.done;
      body.append(big);
    } else ACTS[act]?.(frame);
  });

  let drag = null;
  document.addEventListener('pointerdown', (ev) => {
    const frame = ev.button === 0 && !ev.target.closest('button') && ev.target.closest('.diagram-block:not(.failed) .diagram');
    if (!frame) return;
    const t = viewOf(frame);
    drag = { frame, id: ev.pointerId, x0: ev.clientX - t.x, y0: ev.clientY - t.y };
    frame.setPointerCapture(ev.pointerId);
    frame.classList.add('dragging');
    ev.preventDefault();
  });
  document.addEventListener('pointermove', (ev) => {
    if (drag?.id === ev.pointerId) show(drag.frame, { ...viewOf(drag.frame), x: ev.clientX - drag.x0, y: ev.clientY - drag.y0 });
  });
  const stop = (ev) => { if (drag?.id === ev.pointerId) { drag.frame.classList.remove('dragging'); drag = null; } };
  document.addEventListener('pointerup', stop);
  document.addEventListener('pointercancel', stop);

  // A plain scroll still scrolls the conversation; with ⌘/Ctrl (a trackpad pinch sends ctrlKey) it zooms.
  document.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;
    const frame = ev.target.closest?.('.diagram-block:not(.failed) .diagram');
    if (!frame) return;
    ev.preventDefault();
    zoom(frame, Math.exp(-Math.max(-25, Math.min(25, ev.deltaY)) * 0.01), ev.clientX, ev.clientY); // a wheel notch: ×1.28 at most
  }, { passive: false });
}
