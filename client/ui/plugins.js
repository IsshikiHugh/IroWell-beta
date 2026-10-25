// The Plugins page (opened from Settings): the plugins in this client's checkout (plugins/<name>/), where
// each one's widget shows (on every server, on the ones picked, or nowhere) and the order of the widgets
// (the list's: drag a plugin to move it). The local client keeps both (client/main.mjs, "plugins"); a change
// is saved as it is made, and the widgets are drawn again. A plugin's files can be looked at, not edited.
import { h, highlight, langOf } from './render.js';
import { fullPage, askFor } from './page.js';

const WHERE = [
  ['all', 'Every server', 'Its widget shows whichever server a tab is on'],
  ['some', 'Some servers', 'Only on the servers ticked below'],
  ['off', 'Off', 'Its widget shows nowhere'],
];
const kindOf = (where) => (Array.isArray(where) ? 'some' : where);
const tagOf = (p) => (p.error ? 'error' : p.where === 'off' ? 'off' : Array.isArray(p.where) ? `${p.where.length} server${p.where.length === 1 ? '' : 's'}` : 'every server');

// `ctx`: { call, post: { data } or { error } without an alert, openModal, onChange(): the widgets to draw again }
// (data.current: the tab's server, which Some servers starts with)
export function createPluginsPage(ctx) {
  let data = null; // { plugins: [...], servers: [{ id, host, detail }] }
  let sel = null; // the plugin shown
  const page = fullPage({
    id: 'pluginsView', mode: 'plugins-mode', title: 'Plugins', save: () => {},
    sub: 'What plugins add to this page: plugins/ in this client\'s checkout. Their widgets sit above the Usage card, in the order of this list.',
    build: () => {
      const wrap = h('div', 'sk-wrap');
      wrap.append(h('nav', 'sk-list'), h('div', 'sk-edit'));
      return [wrap];
    },
  });
  let view = null;
  const plugin = () => data?.plugins.find((p) => p.name === sel);

  async function load() {
    const out = await askFor(ctx.post, 'pluginPage', 'This client was started before the Plugins page existed: restart it (client.mjs), then open the page again.');
    if (out.error != null) return out.error;
    data = out.data;
    if (!plugin()) sel = data.plugins[0]?.name ?? null;
  }

  let drag = null; // the name of the plugin being dragged
  async function move(names) {
    const by = new Map(data.plugins.map((p) => [p.name, p]));
    data.plugins = names.map((n) => by.get(n)); // (shown at once; then as the client has it)
    draw();
    const d = await ctx.call('pluginOrder', { names });
    if (d === undefined) await load(); else data = d;
    draw();
    ctx.onChange();
  }

  async function set(where) {
    const d = await ctx.call('pluginSet', { name: sel, where });
    if (d === undefined) await load(); // (refused: drawn as it is kept)
    else data = d;
    draw();
    ctx.onChange();
  }

  function drawList() {
    const nav = view.querySelector('.sk-list');
    nav.replaceChildren(h('div', 'sk-head', 'Plugins'), ...data.plugins.map((p) => {
      const b = h('button', 'sk-item' + (p.name === sel ? ' on' : ''));
      b.type = 'button';
      b.title = p.description || p.title;
      const tag = tagOf(p);
      b.append(h('span', 'sk-name', p.name), h('span', `sk-tag ${tag === 'off' || tag === 'error' ? tag : ''}`, tag));
      b.onclick = () => { sel = p.name; draw(); };
      // Dragged onto another plugin's upper half it goes above that one, onto its lower half below.
      b.draggable = true;
      const lower = (ev) => { const r = b.getBoundingClientRect(); return ev.clientY > r.top + r.height / 2; };
      const unmark = () => { for (const el of nav.querySelectorAll('.drop-above, .drop-below')) el.classList.remove('drop-above', 'drop-below'); };
      b.ondragstart = (ev) => { drag = p.name; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', p.name); b.classList.add('dragging'); };
      b.ondragend = () => { drag = null; b.classList.remove('dragging'); unmark(); };
      b.ondragover = (ev) => {
        if (drag == null) return;
        ev.preventDefault();
        unmark();
        if (drag !== p.name) b.classList.add(lower(ev) ? 'drop-below' : 'drop-above');
      };
      b.ondrop = (ev) => {
        ev.preventDefault();
        unmark();
        if (drag == null || drag === p.name) return;
        const names = data.plugins.map((x) => x.name).filter((n) => n !== drag);
        names.splice(names.indexOf(p.name) + (lower(ev) ? 1 : 0), 0, drag);
        if (names.join() !== data.plugins.map((x) => x.name).join()) move(names);
      };
      return b;
    }));
    if (!data.plugins.length) nav.append(h('div', 'sk-note', 'None yet: a plugin is a folder in plugins/ with plugin.json and ui.js.'));
  }

  function drawDetail() {
    const ed = view.querySelector('.sk-edit');
    const p = plugin();
    if (!p) return ed.replaceChildren(h('div', 'sk-note', 'No plugin to show.'));
    const parts = [h('div', 'sk-ed-head', p.title), h('div', 'sk-note', `plugins/${p.name}/`)];
    if (p.error) parts.push(h('div', 'pl-error', p.error));
    if (p.description) parts.push(h('div', 'pl-desc', p.description));
    const kind = kindOf(p.where);
    const modes = h('div', 'sk-modes');
    for (const [k, label, hint] of WHERE) {
      const l = h('label', 'sk-mode' + (kind === k ? ' on' : ''));
      const r = h('input');
      r.type = 'radio';
      r.name = 'pl-where';
      r.checked = kind === k;
      // Some servers starts from the tab's own, when nothing was ticked before
      r.onchange = () => set(k === 'some' ? (Array.isArray(p.where) ? p.where : [data.current].filter(Boolean)) : k);
      l.append(r, h('b', null, label), h('span', null, hint));
      modes.append(l);
    }
    parts.push(h('div', 'sk-label', 'Where it shows'), modes);
    if (kind === 'some') {
      const ticked = new Set(p.where);
      // the servers the page knows, and any ticked one it no longer lists
      const servers = [...data.servers, ...p.where.filter((id) => !data.servers.some((s) => s.id === id)).map((id) => ({ id, host: id.replace(/^ssh:/, ''), detail: '' }))];
      const list = h('div', 'pl-servers');
      for (const s of servers) {
        const l = h('label', 'hall');
        const box = h('input');
        box.type = 'checkbox';
        box.checked = ticked.has(s.id);
        box.onchange = () => set(box.checked ? [...p.where, s.id] : p.where.filter((id) => id !== s.id));
        l.append(box, h('span', null, s.id === 'local' ? 'This machine' : s.host));
        if (s.detail && s.id !== 'local') l.append(h('span', 'pl-detail', s.detail));
        list.append(l);
      }
      parts.push(list);
    }
    if (p.files?.length) {
      const files = h('div', 'sk-files');
      for (const name of p.files) {
        const b = h('button', null, name);
        b.type = 'button';
        b.title = 'Look at it (the page doesn\'t edit a plugin\'s files)';
        b.onclick = async () => {
          const text = await ctx.call('pluginFile', { name: p.name, file: name });
          if (text == null) return;
          const body = ctx.openModal(`plugins/${p.name}/${name}`);
          const pre = h('pre', 'sk-file');
          pre.innerHTML = `<code class="hljs">${highlight(text, langOf(name))}</code>`;
          body.append(pre);
        };
        files.append(b);
      }
      parts.push(h('div', 'sk-label', 'Files'), files);
    }
    ed.replaceChildren(...parts);
  }

  function draw() {
    drawList();
    drawDetail();
  }

  async function show() {
    view = page.show();
    const error = await load();
    if (view.hidden) return;
    if (error) {
      view.querySelector('.sk-wrap').replaceChildren(h('div', 'sk-error', error));
      data = null;
      return;
    }
    if (!view.querySelector('.sk-list')) view.querySelector('.sk-wrap').replaceChildren(h('nav', 'sk-list'), h('div', 'sk-edit'));
    draw();
  }
  return { show, hide: page.hide };
}
