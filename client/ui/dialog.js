// Confirmations and notices drawn in the page instead of window.confirm / alert. A browser can stop a
// page's own dialogs (after a burst of them it offers to keep the site from prompting again), and from
// then on confirm() answers "cancel" without showing anything: Detach, Archive, Stop… did nothing at all.
//
// Both open where the hand already is: at the mouse pointer, or beside the focused field when the last
// thing done was typing (a slash command). A confirmation is one button named after the action, with
// text only when there is something you can't see elsewhere (Rewind's files); a click outside or Esc
// cancels. A notice floats there and fades out by itself.
import { h } from './render.js';
import { hideLayer, placeNear } from './layer.js';

let pointer = null, pointerAt = 0, keyAt = 0;
const seePointer = (ev) => { pointer = { x: ev.clientX, y: ev.clientY }; pointerAt = performance.now(); };
window.addEventListener('pointerdown', seePointer, true);
window.addEventListener('pointermove', seePointer, true);
window.addEventListener('keydown', () => { keyAt = performance.now(); }, true);

// Where to open: a point (the pointer) or the focused element's box, whichever was used last. `x`: where across the
// box it grows from, 16 px in from the box's left edge (so the button opens under the pointer).
function anchor() {
  const point = (x, y, gap) => ({ at: { left: x - 16, right: x - 16, top: y, bottom: y }, gap, x });
  if (pointer && pointerAt >= keyAt) return point(pointer.x, pointer.y, 12);
  const f = document.activeElement;
  const r = f && f !== document.body ? f.getBoundingClientRect() : null;
  if (r && r.width) return { at: r, gap: 6, x: r.left + 16 };
  return point(innerWidth / 2, innerHeight / 2, 0);
}
// Below the anchor if it fits, else above it; never off the page.
function place(el, a) {
  const { left, below } = placeNear(el, a.at, { gap: a.gap });
  el.style.transformOrigin = `${a.x - left}px ${below ? 0 : el.offsetHeight}px`;
}

let queue = Promise.resolve();
// Resolves true for the action, false for Esc or a click outside. One at a time: the next one waits.
// `text`: only what the person can't already see; null for none.
export function ask(text, { ok = 'OK' } = {}) {
  const p = queue.then(() => show(text == null ? '' : String(text), ok));
  queue = p;
  return p;
}

// A double click, or a key held down, must not answer a confirmation the moment it opens.
const SETTLE = 300;
function show(text, ok) {
  return new Promise((resolve) => {
    hideLayer();
    const before = document.activeElement;
    const back = h('div', 'dlg-back');
    const box = h('div', 'ctx-menu dlg');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-label', ok);
    const yes = h('button', 'ctx-item dlg-ok', ok);
    box.append(yes);
    if (text) box.append(h('div', 'dlg-text', text));
    back.append(box);
    document.body.append(back);
    place(box, anchor());
    const opened = performance.now();
    const settling = (ev) => ev.isTrusted && performance.now() - opened < SETTLE;
    const done = (v) => {
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      before?.focus?.();
      resolve(v);
    };
    // Keys go to the dialog only (the page's shortcuts wait): Enter answers, Esc cancels.
    const onKey = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (!ev.repeat && !settling(ev)) done(true); }
      else if (ev.key === 'Tab') ev.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    yes.onclick = (ev) => { if (!settling(ev)) done(true); };
    back.onmousedown = (ev) => { if (ev.target === back && !settling(ev)) done(false); };
    yes.focus();
  });
}

// A notice: floats where you are and fades out, longer for a longer text. Hovering keeps it.
export function tell(text) {
  document.querySelector('.toast.note')?.remove();
  const t = h('div', 'toast note', String(text));
  t.setAttribute('role', 'status');
  document.body.append(t);
  place(t, anchor());
  requestAnimationFrame(() => t.classList.add('show'));
  const ms = Math.min(10000, 2500 + 40 * String(text).length);
  let timer;
  const fade = () => { timer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms); };
  t.onmouseenter = () => clearTimeout(timer);
  t.onmouseleave = fade;
  fade();
  return Promise.resolve();
}
