// The server picker: which server this client talks to. Shown on start (until one is picked) and
// from ⇄ next to the connection status. Lists this machine first, then the servers connected to most
// recently, then the rest of ~/.ssh/config in its own order (the client builds the list); any other
// ssh host can be typed in.
import { h } from './render.js';

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const SSH_HOST = /^[\w.@%:[\]+-]+$/; // what the client accepts as an ssh destination

export const pickerOpen = () => document.getElementById('picker');
export function closePicker() { pickerOpen()?.remove(); }

// `required`: no server yet, so it can't be dismissed. `post(type, body)` sends a command to the client
// and resolves to its { data } or { error }.
export async function openPicker({ post, required = false }) {
  closePicker();
  const back = h('div', 'picker-back');
  back.id = 'picker';
  back.dataset.required = required ? '1' : '';
  const box = h('div', 'picker');
  const close = h('button', 'picker-close', '✕');
  close.title = 'Close (Esc)';
  close.hidden = required;
  close.onclick = closePicker;
  const filter = h('input', 'picker-filter');
  filter.placeholder = 'Filter, or type an ssh host (user@host)…';
  filter.spellcheck = false;
  filter.autocomplete = 'off';
  const list = h('div', 'picker-list');
  const err = h('div', 'picker-err');
  box.append(close, h('div', 'picker-brand', 'IroWell'), h('h2', 'picker-title', 'Connect to a server'),
    h('div', 'picker-sub', 'This machine, or a host from your ~/.ssh/config. Sessions run there and keep running when you close this page.'),
    filter, list, err, h('div', 'picker-hint', '↑ ↓ choose · Enter connects' + (required ? '' : ' · Esc closes')));
  back.append(box);
  if (!required) back.onclick = (ev) => { if (ev.target === back) closePicker(); };
  document.body.append(back);
  filter.focus();

  const r = await post('targets');
  if (r.error) err.textContent = r.error;
  const data = r.data || { list: [], current: null };
  let rows = [], index = 0;
  async function pick(t) {
    err.textContent = '';
    const r = await post('connect', { target: t.id });
    if (r.error) { err.textContent = r.error; return; }
    closePicker();
  }
  function draw() {
    const q = filter.value.trim(), lq = q.toLowerCase();
    rows = data.list.filter((t) => !lq || `${t.local ? 'this machine local ' : ''}${t.host} ${t.detail || ''}`.toLowerCase().includes(lq));
    if (q && SSH_HOST.test(q) && !q.startsWith('-') && !data.list.some((t) => !t.local && t.host === q)) rows.push({ id: `ssh:${q}`, host: q, typed: true });
    index = Math.max(0, Math.min(index, rows.length - 1));
    list.replaceChildren(...rows.map((t, i) => {
      const row = h('div', 'picker-row' + (i === index ? ' on' : '') + (t.local ? ' local' : ''));
      const name = h('div', 'pr-name', t.typed ? `Connect to ${t.host}` : t.local ? 'This machine' : t.host);
      const sub = h('div', 'pr-sub', t.typed ? 'ssh host, not in ~/.ssh/config' : t.local ? `local · ${t.host}` : t.detail || 'ssh');
      const side = h('div', 'pr-side', t.id === data.current ? 'current' : t.lastUsed ? ago(t.lastUsed) : '');
      if (t.id === data.current) side.classList.add('current');
      const text = h('div', 'pr-text');
      text.append(name, sub);
      row.append(h('span', 'pr-icon', t.local ? '⌂' : '›_'), text, side);
      row.onmousedown = (ev) => ev.preventDefault();
      row.onclick = () => pick(t);
      return row;
    }));
    if (!rows.length) list.append(h('div', 'picker-empty', 'Nothing matches.'));
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  filter.oninput = () => { index = 0; draw(); };
  filter.onkeydown = (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (rows.length) index = (index + (ev.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      draw();
    } else if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      if (rows[index]) pick(rows[index]);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation(); // not an interrupt of the session behind it
      if (!required) closePicker();
    }
  };
  draw();
}
