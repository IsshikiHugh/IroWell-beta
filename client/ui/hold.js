// Press and hold: an action that used to ask first runs once its control is held for half a second, while a
// fill grows across the control. Letting go early, or sliding off it, drops it (the fill runs back); a
// plain click does nothing. Enter or Space held on the focused control works the same way.
export const HOLD_MS = 500;

let active = null; // { el, timer, end }
// Whether a hold is under way (inside `box`): a list redrawn every second waits for it.
export const holding = (box) => !!active && (!box || box.contains(active.el));

// `when()`: whether it is a hold right now (else the control's own click does its other job).
// `onStart` / `onEnd(done)`: around the hold, e.g. to show what it will do.
export function holdToRun(el, run, { when = () => true, onStart, onEnd } = {}) {
  el.classList.add('hold');
  el.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
  let swallow = false; // the click that ends a finished hold is not a click
  el.addEventListener('click', (ev) => { if (swallow) { swallow = false; ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);
  const start = () => {
    swallow = false;
    if (active || el.disabled || !when()) return false;
    el.classList.add('holding');
    active = { el, timer: setTimeout(() => stop(true), HOLD_MS) };
    onStart?.();
    return true;
  };
  const stop = (done) => {
    if (active?.el !== el) return;
    clearTimeout(active.timer);
    active = null;
    el.classList.remove('holding');
    onEnd?.(done);
    el.dispatchEvent(new CustomEvent('holdend', { bubbles: true }));
    if (done) { swallow = true; run(); }
  };
  el.addEventListener('pointerdown', (ev) => { if (ev.button === 0 && start()) ev.preventDefault(); });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(t, () => stop(false));
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    if (active?.el === el || (!ev.repeat && start())) { ev.preventDefault(); ev.stopPropagation(); }
  });
  el.addEventListener('keyup', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') stop(false); });
  el.addEventListener('blur', () => stop(false));
  el.addEventListener('contextmenu', (ev) => { if (when()) ev.preventDefault(); }); // a long touch is not a right click
  return { start, stop };
}
