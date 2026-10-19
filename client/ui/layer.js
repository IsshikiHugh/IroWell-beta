// Menus and popovers (a right-click menu, a dropdown, the model panel): one open at a time. Opening
// one closes the other, and a mousedown outside it (and outside the button that opened it) closes it.
// Dialogs close it too when they open (app.js openModal, picker.js).
// Also here: where a popover goes beside what it belongs to (placeNear), and dragging an edge to resize (dragEdge).

let open = null; // { el, anchor, onClose }

// `onClose(how)` takes it down: `how` is what hideLayer was given, or 'outside' for a click elsewhere.
export function showLayer(el, { anchor = null, onClose } = {}) {
  hideLayer();
  open = { el, anchor, onClose };
}
export function hideLayer(how) {
  if (!open) return;
  const l = open;
  open = null;
  l.onClose?.(how);
}
export const isLayer = (el) => !!el && open?.el === el;

document.addEventListener('mousedown', (ev) => {
  if (open && !open.el.contains(ev.target) && !open.anchor?.contains(ev.target)) hideLayer('outside');
}, true);

// Puts `el` (position: fixed, already in the page) beside `at` ({ left, top, right, bottom }; a point has left === right,
// top === bottom): below it when it fits, else above; its left edge at at.left (`align: 'end'`: its right edge at
// at.right); kept 8 px inside the window. `gap`: px between them. (`above`: above first, for a button at the foot of
// the window.) Returns where it went: { left, top, below }.
export function placeNear(el, at, { gap = 4, align = 'start', above = false } = {}) {
  const w = el.offsetWidth, ht = el.offsetHeight;
  const below = above ? at.top - gap - ht < 8 : at.bottom + gap + ht <= innerHeight - 8;
  // (fitting on neither side: moved up into the window, its top at 8 px when it is taller than the window)
  const top = Math.max(8, Math.min(below ? at.bottom + gap : at.top - gap - ht, innerHeight - ht - 8));
  const left = Math.max(8, Math.min(align === 'end' ? at.right - w : at.left, innerWidth - w - 8));
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  return { left, top, below };
}

// Dragging `grip` resizes something: pointerdown starts (pointer capture), `onMove(ev, start)` on each move (`start`: the
// pointerdown event), `cls` on <body> meanwhile (cursor, no text selection), `onEnd(ev)` on pointerup or pointercancel.
// Returns nothing. (Persisting the size stays with the caller.)
export function dragEdge(grip, { cls, onMove, onEnd }) {
  grip.addEventListener('pointerdown', (start) => {
    start.preventDefault();
    grip.setPointerCapture(start.pointerId); // (the moves and the release come to the grip wherever the pointer goes)
    document.body.classList.add(cls);
    const move = (ev) => onMove(ev, start);
    const end = (ev) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      document.body.classList.remove(cls);
      onEnd?.(ev);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  });
}
