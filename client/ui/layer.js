// Menus and popovers (a right-click menu, a dropdown, the model panel): one open at a time. Opening
// one closes the other, and a mousedown outside it (and outside the button that opened it) closes it.
// Dialogs close it too when they open (app.js openModal, picker.js).

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
