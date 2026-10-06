// Confirmations and notices drawn in the page instead of window.confirm / alert. A browser can stop a
// page's own dialogs (after a burst of them it offers to keep the site from prompting again), and from
// then on confirm() answers "cancel" without showing anything: Detach, Archive, Stop… did nothing at all.
import { h } from './render.js';
import { hideLayer } from './layer.js';

let queue = Promise.resolve();
// Resolves true for OK, false for Cancel, Esc or a click outside. One at a time: the next one waits.
export function ask(text, { ok = 'OK', cancel = 'Cancel' } = {}) {
  const p = queue.then(() => show(String(text), ok, cancel));
  queue = p;
  return p;
}
// A notice with just OK.
export const tell = (text) => ask(text, { cancel: null }).then(() => undefined);
export const dialogOpen = () => !!document.querySelector('.dlg-back');

function show(text, ok, cancel) {
  return new Promise((resolve) => {
    hideLayer();
    const before = document.activeElement;
    const back = h('div', 'dlg-back');
    const box = h('div', 'dlg');
    box.setAttribute('role', 'alertdialog');
    const btns = h('div', 'dlg-btns');
    const no = cancel ? h('button', 'dlg-cancel', cancel) : null;
    const yes = h('button', 'primary dlg-ok', ok);
    if (no) btns.append(no);
    btns.append(yes);
    box.append(h('div', 'dlg-text', text), btns);
    back.append(box);
    document.body.append(back);
    const done = (v) => {
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      before?.focus?.();
      resolve(v);
    };
    // Keys go to the dialog only (the page's shortcuts wait): Enter answers the focused button, Esc cancels.
    const onKey = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); done(false); }
      else if (ev.key === 'Enter') { ev.preventDefault(); done(document.activeElement !== no); }
      else if (ev.key === 'Tab') { ev.preventDefault(); (document.activeElement === yes && no ? no : yes).focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    yes.onclick = () => done(true);
    if (no) no.onclick = () => done(false);
    back.onmousedown = (ev) => { if (ev.target === back) done(false); };
    yes.focus();
  });
}
