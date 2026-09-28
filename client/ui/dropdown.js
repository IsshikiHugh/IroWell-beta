// A styled dropdown on top of a native <select>. The select stays the source of truth (value,
// options, disabled, change events); it is only visually hidden, so code and tests can keep using it.
import { h } from './render.js';

let openMenu = null;
function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.btn.classList.remove('open');
  openMenu = null;
}
document.addEventListener('mousedown', (ev) => {
  if (openMenu && !openMenu.menu.contains(ev.target) && !openMenu.btn.contains(ev.target)) closeMenu();
});

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
    btn.replaceChildren();
    const opt = current();
    if (opt) btn.append(view.button(opt));
    btn.append(h('span', 'dd-chev'));
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
      const it = h('div', 'dd-item' + (opt.value === select.value ? ' sel' : ''));
      it.append(view.item(opt), h('span', 'dd-check', opt.value === select.value ? '✓' : ''));
      it.onmousedown = (ev) => { ev.preventDefault(); choose(opt.value); };
      items.push({ it, value: opt.value });
      menu.append(it);
    }
    document.body.append(menu);
    // Place it above the button (the status line sits at the bottom of the window).
    const r = btn.getBoundingClientRect();
    const mh = menu.offsetHeight;
    const top = view.up === false || r.top < mh + 12 ? r.bottom + 6 : r.top - mh - 6;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
    btn.classList.add('open');
    let index = Math.max(0, items.findIndex((x) => x.value === select.value));
    const mark = () => items.forEach((x, i) => x.it.classList.toggle('hover', i === index));
    mark();
    openMenu = {
      btn, menu,
      key(ev) {
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
