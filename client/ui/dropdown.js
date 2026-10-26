// A styled dropdown on top of a native <select>. The select stays the source of truth (value,
// options, disabled, change events); it is only visually hidden, so code and tests can keep using it.
import { h } from './render.js';
import { showLayer, hideLayer, placeNear } from './layer.js';

let openMenu = null; // the open one: { btn, menu, key(ev) }
function closeMenu() {
  if (openMenu) hideLayer();
}

/**
 * @param {HTMLSelectElement} select
 * @param {{ button(opt): Node, item(opt): Node, className?: string, up?: boolean }} view
 */
export function enhanceSelect(select, view) {
  select.classList.add('dd-native');
  const btn = h('button', 'dd-btn ' + (view.className || ''));
  btn.type = 'button';
  btn.title = select.title;
  select.after(btn);

  const current = () => select.selectedOptions[0] || select.options[0];
  function refresh() {
    btn.disabled = select.disabled;
    btn.title = select.title;
    btn.replaceChildren();
    const opt = current();
    if (opt) btn.append(view.button(opt));
  }

  function choose(value) {
    closeMenu();
    if (select.value === value) return;
    select.value = value;
    refresh();
    select.dispatchEvent(new Event('change'));
  }

  function open() {
    if (select.disabled) return;
    if (openMenu?.btn === btn) return closeMenu();
    closeMenu();
    const menu = h('div', 'dd-menu ' + (view.className || ''));
    const items = [];
    for (const opt of select.options) {
      if (opt.hidden) continue;
      const it = h('div', 'dd-item' + (opt.value === select.value ? ' sel' : '') + (opt.disabled ? ' disabled' : ''));
      it.setAttribute('aria-disabled', String(opt.disabled));
      it.append(view.item(opt), h('span', 'dd-check', opt.value === select.value ? '✓' : ''));
      if (!opt.disabled) {
        it.onmousedown = (ev) => { ev.preventDefault(); choose(opt.value); };
        items.push({ it, value: opt.value });
      }
      menu.append(it);
    }
    showLayer(menu, { anchor: btn, onClose: () => { menu.remove(); btn.classList.remove('open'); if (openMenu?.menu === menu) openMenu = null; } });
    document.body.append(menu);
    // Above the button when it fits (the status line sits at the bottom of the window), unless `up` is false.
    placeNear(menu, btn.getBoundingClientRect(), { gap: 6, above: view.up !== false });
    btn.classList.add('open');
    let index = Math.max(0, items.findIndex((x) => x.value === select.value));
    const mark = () => items.forEach((x, i) => x.it.classList.toggle('hover', i === index));
    mark();
    openMenu = {
      btn, menu,
      key(ev) {
        if (!items.length) return;
        if (ev.key === 'ArrowDown') index = (index + 1) % items.length;
        else if (ev.key === 'ArrowUp') index = (index + items.length - 1) % items.length;
        else if (ev.key === 'Enter') return choose(items[index].value);
        else if (ev.key === 'Escape') return closeMenu();
        else return;
        mark();
      },
    };
    for (const [i, x] of items.entries()) x.it.onmouseenter = () => { index = i; mark(); };
  }

  btn.onclick = open;
  btn.addEventListener('keydown', (ev) => {
    if (openMenu?.btn === btn && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(ev.key)) {
      ev.preventDefault();
      ev.stopPropagation();
      openMenu.key(ev);
    }
  });
  new MutationObserver(refresh).observe(select, { childList: true, subtree: true, attributes: true });
  select.addEventListener('change', refresh);
  refresh();
  return { refresh, button: btn };
}
