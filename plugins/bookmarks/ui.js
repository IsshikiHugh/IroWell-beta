// Bookmarks: the web pages you keep, in sections. The tile shows the first three; a click opens them all,
// a filter on top. Click one to open it in a new tab (Enter opens the first one the filter leaves).
// Drag a bookmark to another place or section, and a section by its heading. What you keep stays on this
// computer, with the local client (api.save: plugin-data/bookmarks.json), never on a server.
import { h } from '/ui/render.js';
import { holdToRun } from '/ui/hold.js';

let data = { sections: [] }; // { sections: [{ name, items: [{ title, url }] }] }
let tileEl = null;
let changes = 0; // edits made here: a read that started before one doesn't put back what was there

const host = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };
// "openreview.net" → "https://openreview.net/"; "localhost:6006" → "http://localhost:6006/"
function normalUrl(text) {
  const t = text.trim();
  if (!t) return '';
  const u = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : (/^(localhost|127\.|\[?::1)/.test(t) ? 'http://' : 'https://') + t;
  try { return new URL(u).href; } catch { return u; }
}
const valid = (data) => data && Array.isArray(data.sections) && data.sections.every((s) => s && typeof s.name === 'string' && Array.isArray(s.items));

// A site's letter on a light tint of its own hue (the letter a darker shade of it).
const HUES = [18, 40, 95, 150, 190, 215, 260, 320];
function mono(item, size) {
  let n = 0;
  for (const c of host(item.url)) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const hue = HUES[n % HUES.length];
  const m = h('span', 'bm-mono', (item.title.replace(/^[^\p{L}\p{N}]+/u, '')[0] || host(item.url)[0] || '·').toUpperCase());
  m.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px;background:hsl(${hue} 38% 90%);color:hsl(${hue} 30% 36%)`;
  return m;
}

function drawTile() {
  if (!tileEl) return;
  const first = data.sections.flatMap((s) => s.items).slice(0, 3);
  if (first.length) tileEl.replaceChildren(...first.map((it) => mono(it, 18)));
  else tileEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.5h8v11l-4-3-4 3z"/></svg>';
}

async function load(api) {
  const n = changes;
  const d = await api.load();
  if (changes !== n) return; // (a null then: the first save is not on disk yet)
  if (valid(d)) data = d;
  else if (d == null) data = { sections: [{ name: 'Bookmarks', items: [] }] };
}

export default {
  tile(el, api) {
    tileEl = el;
    el.classList.add('bm-tile');
    drawTile();
    load(api).then(drawTile, (e) => console.warn('bookmarks:', e.message));
  },

  open(el, api) {
    const q = h('input', 'bm-q');
    q.spellcheck = false;
    const list = h('div', 'bm-sections');
    const newSec = h('button', 'bm-newsec', '+ New section');
    newSec.type = 'button';
    const err = h('div', 'bm-err');
    el.append(q, list, newSec, err);

    let editing = null; // { s, i } a bookmark being edited (i: null for a new one), or { s, rename: true }
    let drag = null; // { s, i } a bookmark being dragged, or { s } a section

    async function change(fn) {
      fn();
      changes++;
      editing = null;
      draw();
      drawTile();
      try { await api.save(data); err.textContent = ''; } catch (e) { err.textContent = `Not saved: ${e.message}`; }
    }
    const go = (url) => { window.open(url, '_blank', 'noopener'); api.close(); };

    // A bookmark's fields, in place of it (or at the end of its section, for a new one).
    function form(s, i) {
      const it = i == null ? { title: '', url: '' } : data.sections[s].items[i];
      const f = h('form', 'bm-form');
      const title = h('input');
      title.placeholder = 'Title';
      title.value = it.title;
      const url = h('input');
      url.placeholder = 'https://…';
      url.value = it.url;
      url.spellcheck = title.spellcheck = false;
      const save = h('button', 'primary', i == null ? 'Add' : 'Save');
      const cancel = h('button', null, 'Cancel');
      cancel.type = 'button';
      cancel.onclick = () => { editing = null; draw(); };
      f.onsubmit = (ev) => {
        ev.preventDefault();
        const u = normalUrl(url.value);
        if (!u) return url.focus();
        const item = { title: title.value.trim() || host(u), url: u };
        change(() => { if (i == null) data.sections[s].items.push(item); else data.sections[s].items[i] = item; });
      };
      f.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); cancel.click(); } };
      f.append(title, url, save, cancel);
      setTimeout(() => (i == null ? url : title).focus(), 0);
      return f;
    }

    // Dropped on a bookmark's left half it goes before that one, on its right half after.
    const after = (ev, el) => { const r = el.getBoundingClientRect(); return ev.clientX > r.left + r.width / 2; };
    const below = (ev, el) => { const r = el.getBoundingClientRect(); return ev.clientY > r.top + r.height / 2; };
    const unmark = () => { for (const x of list.querySelectorAll('.drop-before, .drop-after, .drop-above, .drop-below, .drop-into')) x.classList.remove('drop-before', 'drop-after', 'drop-above', 'drop-below', 'drop-into'); };
    function moveItem(to, at) { // the dragged bookmark to section `to`, before its bookmark `at` (its end: length)
      const { s, i } = drag;
      if (s === to && (at === i || at === i + 1)) return;
      change(() => {
        const [it] = data.sections[s].items.splice(i, 1);
        data.sections[to].items.splice(s === to && at > i ? at - 1 : at, 0, it);
      });
    }

    function chip(s, i, it) {
      const a = h('a', 'bm-chip');
      a.href = it.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = it.url;
      a.draggable = true;
      a.onclick = (ev) => { if (!ev.metaKey && !ev.ctrlKey && !ev.shiftKey) setTimeout(() => api.close(), 0); };
      const edit = h('button', 'bm-act', '✎');
      edit.type = 'button';
      edit.title = 'Edit';
      edit.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); editing = { s, i }; draw(); };
      const x = h('button', 'bm-act bm-x', '✕');
      x.type = 'button';
      x.title = 'Remove';
      x.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); change(() => data.sections[s].items.splice(i, 1)); };
      a.append(mono(it, 20), h('span', 'bm-t', it.title), edit, x);
      a.ondragstart = (ev) => {
        if (q.value) return ev.preventDefault(); // (filtered, the order isn't all there)
        drag = { s, i };
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/uri-list', it.url);
        a.classList.add('dragging');
      };
      a.ondragend = () => { drag = null; a.classList.remove('dragging'); unmark(); };
      a.ondragover = (ev) => {
        if (drag?.i == null) return;
        ev.preventDefault();
        ev.stopPropagation();
        unmark();
        if (drag.s !== s || drag.i !== i) a.classList.add(after(ev, a) ? 'drop-after' : 'drop-before');
      };
      a.ondrop = (ev) => {
        if (drag?.i == null) return;
        ev.preventDefault();
        ev.stopPropagation();
        unmark();
        moveItem(s, i + (after(ev, a) ? 1 : 0));
      };
      return a;
    }

    function section(s) {
      const sec = data.sections[s];
      const box = h('section', 'bm-sec');
      const head = h('div', 'bm-head');
      if (editing?.s === s && editing.rename) {
        const name = h('input', 'bm-rename');
        name.value = sec.name;
        name.spellcheck = false;
        const done = (keep) => {
          if (editing?.s !== s) return;
          const v = name.value.trim();
          if (keep && v && v !== sec.name) change(() => { sec.name = v; });
          else { editing = null; draw(); }
        };
        name.onkeydown = (ev) => { if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } };
        name.onblur = () => done(true);
        head.append(name);
        setTimeout(() => { name.focus(); name.select(); }, 0);
      } else {
        head.draggable = true;
        head.title = 'Drag to move the section';
        head.append(h('span', 'bm-name', sec.name), h('span', 'bm-n', String(sec.items.length)));
        const add = h('button', 'bm-act', '+');
        add.type = 'button';
        add.title = 'Add a bookmark';
        add.onclick = () => { editing = { s, i: null }; draw(); };
        const ren = h('button', 'bm-act', '✎');
        ren.type = 'button';
        ren.title = 'Rename';
        ren.onclick = () => { editing = { s, rename: true }; draw(); };
        const del = h('button', 'bm-act bm-x', '✕');
        del.type = 'button';
        del.title = sec.items.length ? `Remove the section and its ${sec.items.length} bookmark${sec.items.length === 1 ? '' : 's'} (hold)` : 'Remove the section (hold)';
        holdToRun(del, () => change(() => data.sections.splice(s, 1)));
        head.append(add, ren, del);
      }
      head.ondragstart = (ev) => {
        if (q.value) return ev.preventDefault();
        drag = { s };
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', sec.name);
        box.classList.add('dragging');
      };
      head.ondragend = () => { drag = null; box.classList.remove('dragging'); unmark(); };
      // A section dragged onto another goes above or below it; a bookmark dropped on a section (not on one of
      // its bookmarks) goes to its end.
      box.ondragover = (ev) => {
        if (!drag) return;
        ev.preventDefault();
        unmark();
        if (drag.i != null) box.classList.add('drop-into');
        else if (drag.s !== s) box.classList.add(below(ev, box) ? 'drop-below' : 'drop-above');
      };
      box.ondrop = (ev) => {
        if (!drag) return;
        ev.preventDefault();
        unmark();
        if (drag.i != null) return moveItem(s, sec.items.length);
        const from = drag.s, to = s + (below(ev, box) ? 1 : 0);
        if (to === from || to === from + 1) return;
        change(() => { const [x] = data.sections.splice(from, 1); data.sections.splice(to > from ? to - 1 : to, 0, x); });
      };
      const chips = h('div', 'bm-chips');
      // The filter's words in a bookmark's title or address, or in its section's name.
      const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const hit = (it) => words.every((w) => `${sec.name} ${it.title} ${it.url}`.toLowerCase().includes(w));
      sec.items.forEach((it, i) => {
        if (words.length && !hit(it)) return;
        chips.append(editing?.s === s && editing.i === i ? form(s, i) : chip(s, i, it));
      });
      if (words.length) head.querySelector('.bm-n')?.replaceChildren(String(chips.childElementCount));
      if (editing?.s === s && editing.i === null && !editing.rename) chips.append(form(s, null));
      if (words.length && !chips.childElementCount) return null; // nothing here matches
      box.append(head, chips);
      return box;
    }

    function draw() {
      const all = data.sections.reduce((n, s) => n + s.items.length, 0);
      q.placeholder = all ? `Filter ${all} bookmark${all === 1 ? '' : 's'}` : 'Filter';
      list.replaceChildren(...data.sections.map((_, s) => section(s)).filter(Boolean));
      list.classList.toggle('filtered', !!q.value);
    }

    q.oninput = draw;
    q.onkeydown = (ev) => {
      if (ev.key !== 'Enter') return;
      const first = list.querySelector('a.bm-chip');
      if (first) go(first.href);
    };
    newSec.onclick = () => change(() => { data.sections.push({ name: 'New section', items: [] }); }).then(() => {
      editing = { s: data.sections.length - 1, rename: true };
      draw();
    });

    draw();
    setTimeout(() => q.focus(), 0);
    // (not drawn over a form or a name being typed: it is drawn again when that ends)
    load(api).then(() => { if (!editing) draw(); drawTile(); }, (e) => { err.textContent = `Could not read the bookmarks: ${e.message}`; });
  },
};
