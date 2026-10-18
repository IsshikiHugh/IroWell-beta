// Confirmations and notices drawn in the page instead of window.confirm / alert. A browser can stop a
// page's own dialogs (after a burst of them it offers to keep the site from prompting again), and from
// then on confirm() answers "cancel" without showing anything: Detach, Archive, Stop… did nothing at all.
//
// Both open where the hand already is: at the mouse pointer, or beside the focused field when the last
// thing done was typing (a slash command). A confirmation is one button named after the action, with
// text only when there is something you can't see elsewhere (Rewind's files); a click outside or Esc
// cancels. A notice floats there and fades out by itself.
import { h } from './render.js';
import { hideLayer } from './layer.js';

let pointer = null, pointerAt = 0, keyAt = 0;
const seePointer = (ev) => { pointer = { x: ev.clientX, y: ev.clientY }; pointerAt = performance.now(); };
window.addEventListener('pointerdown', seePointer, true);
window.addEventListener('pointermove', seePointer, true);
window.addEventListener('keydown', () => { keyAt = performance.now(); }, true);

// Where to open: a point (the pointer) or the focused element's box, whichever was used last.
function anchor() {
  if (pointer && pointerAt >= keyAt) return { left: pointer.x, top: pointer.y, bottom: pointer.y, gap: 12 };
  const f = document.activeElement;
  const r = f && f !== document.body ? f.getBoundingClientRect() : null;
  if (r && r.width) return { left: r.left + 16, top: r.top, bottom: r.bottom, gap: 6 };
  return { left: innerWidth / 2, top: innerHeight / 2, bottom: innerHeight / 2, gap: 0 };
}
// Below the anchor if it fits, else above it; never off the page.
function place(el, a) {
  const w = el.offsetWidth, ht = el.offsetHeight;
  const below = a.bottom + a.gap + ht <= innerHeight - 8;
  const top = below ? a.bottom + a.gap : Math.max(8, a.top - a.gap - ht);
  const left = Math.max(8, Math.min(a.left - 16, innerWidth - w - 8));
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  el.style.transformOrigin = `${a.left - left}px ${below ? 0 : ht}px`;
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
    const yes = h('button', 'primary dlg-ok', ok);
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
