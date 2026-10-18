// The open session's progress list, docked at the foot of the right rail: what its long task has to do, is
// doing and has done. A session starts one through the irowell:progress skill; until it does there is no
// list and nothing is shown. From then on Claude and you both write to it, and Claude is shown what you
// changed (server/daemon.mjs, "progress lists"). Its bar folds it down to one line.
import { h, imeKey } from './render.js';

const NEXT = { todo: 'doing', doing: 'done', done: 'todo' }; // what a click on an item's mark makes it
const MARK = { todo: 'To do', doing: 'Doing', done: 'Done' };

// `call`: the page's command to the server. `sessionId()`: the open session's Claude session id (none for a
// draft). `onResize()`: the list took or gave up room in the rail.
export function createProgress({ call, sessionId, onResize }) {
  const box = document.getElementById('progress');
  const bar = box.querySelector('.pg-bar'), count = box.querySelector('.pg-count'), rows = box.querySelector('.pg-list'), add = box.querySelector('.pg-add');
  const lists = new Map(); // Claude session id -> its items (null: it has no list)
  let shown = null; // the Claude session id the rail shows the list of
  let held = false; // an item is being reworded or dragged: the list is redrawn when that ends
  let drag = null; // the id of the item being dragged

  // Your change: shown at once (`now(items)` makes it here), then as the server has it. One the server
  // refuses is said in a dialog, and the list is read again. `id`: the session whose list it is.
  const edit = async (cmd, now, id = shown) => {
    now(lists.get(id));
    draw();
    const list = await call('progressEdit', { claudeSessionId: id, ...cmd }) ?? await call('progress', { claudeSessionId: id }, { quiet: true });
    if (list !== undefined) got(id, list);
  };
  function got(id, list) {
    lists.set(id, list?.items ?? null);
    if (id === shown) draw();
  }

  // A click on an item's text makes it a field, with the caret where the click was.
  function reword(row, text, it, ev) {
    if (text.isContentEditable) return;
    const id = shown; // (the open session may change before the reword ends)
    held = true;
    row.draggable = false;
    text.contentEditable = 'plaintext-only';
    text.spellcheck = false;
    text.focus();
    const at = document.caretRangeFromPoint?.(ev.clientX, ev.clientY), sel = getSelection();
    if (at && text.contains(at.startContainer)) { sel.removeAllRanges(); sel.addRange(at); }
    else { sel.selectAllChildren(text); sel.collapseToEnd(); }
    const end = (save) => {
      text.onblur = text.onkeydown = null;
      held = false;
      const now = text.textContent.replace(/\s+/g, ' ').trim();
      if (save && now && now !== it.text) edit({ op: 'edit', item: it.id, text: now }, () => { it.text = now; }, id);
      else draw(); // as it was, and what changed meanwhile
    };
    text.onkeydown = (ev) => {
      if (imeKey(ev)) return;
      if (ev.key === 'Enter') { ev.preventDefault(); end(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); end(false); }
    };
    text.onblur = () => end(true);
  }

  function rowOf(it, items) {
    const row = h('div', `pg-item ${it.state}`);
    row.dataset.id = it.id;
    row.draggable = true;
    const mark = h('button', 'pg-state');
    mark.type = 'button';
    mark.title = `${MARK[it.state]}: click for ${MARK[NEXT[it.state]].toLowerCase()}`;
    mark.setAttribute('aria-label', mark.title);
    mark.onclick = () => edit({ op: 'state', ids: [it.id], state: NEXT[it.state] }, () => { it.state = NEXT[it.state]; });
    const text = h('span', 'pg-text', it.text);
    text.onclick = (ev) => reword(row, text, it, ev);
    const x = h('button', 'pg-x', '✕');
    x.type = 'button';
    x.title = 'Remove';
    x.onclick = () => edit({ op: 'remove', ids: [it.id] }, (all) => all.splice(all.indexOf(it), 1));
    row.append(mark, text, x);

    // Dragged onto another item's upper half it goes above that one, onto its lower half below.
    const lower = (ev) => { const r = row.getBoundingClientRect(); return ev.clientY > r.top + r.height / 2; };
    const unmark = () => { for (const el of rows.querySelectorAll('.drop-above, .drop-below')) el.classList.remove('drop-above', 'drop-below'); };
    row.ondragstart = (ev) => {
      drag = it.id; held = true;
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', it.text);
      row.classList.add('dragging');
    };
    row.ondragend = () => { drag = null; held = false; draw(); };
    row.ondragover = (ev) => {
      if (drag == null) return;
      ev.preventDefault();
      unmark();
      if (drag !== it.id) row.classList.add(lower(ev) ? 'drop-below' : 'drop-above');
    };
    row.ondrop = (ev) => {
      ev.preventDefault();
      if (drag == null || drag === it.id) return;
      const others = items.filter((i) => i.id !== drag), k = others.indexOf(it);
      const after = lower(ev) ? it.id : others[k - 1]?.id ?? 0;
      const moving = drag, from = items.findIndex((i) => i.id === moving);
      if ((items[from - 1]?.id ?? 0) === after) return;
      // (by id: the list may have come again from the server during the drag; with either item gone, it waits for the server's answer)
      edit({ op: 'move', item: moving, after }, (all) => {
        const at = all.findIndex((i) => i.id === moving);
        if (at < 0 || (after && !all.some((i) => i.id === after))) return;
        const [moved] = all.splice(at, 1);
        all.splice(after ? all.findIndex((i) => i.id === after) + 1 : 0, 0, moved);
      });
    };
    return row;
  }

  function draw() {
    const items = lists.get(shown);
    const was = box.hidden;
    box.hidden = !items;
    if (items && !held) {
      count.textContent = `${items.filter((i) => i.state === 'done').length}/${items.length}`;
      rows.replaceChildren(...items.map((it) => rowOf(it, items)));
    }
    if (was !== box.hidden) onResize();
  }

  add.onkeydown = (ev) => {
    if (ev.key !== 'Enter' || imeKey(ev)) return;
    ev.preventDefault();
    const text = add.value.trim();
    if (!text) return;
    add.value = '';
    edit({ op: 'add', texts: [text] }, (all) => all.push({ id: 0, text, state: 'todo' })); // (its id comes with the server's answer)
  };

  // Folded, only the bar shows. Remembered in this browser.
  const fold = (on) => {
    box.classList.toggle('folded', on);
    bar.setAttribute('aria-expanded', String(!on));
    box.querySelector('.pg-fold').inert = on; // (nothing in the closed body takes the focus)
    try { localStorage.setItem('iro-progress-folded', on ? '1' : ''); } catch {}
  };
  bar.onclick = () => fold(!box.classList.contains('folded'));
  try { fold(!!localStorage.getItem('iro-progress-folded')); } catch {}
  new ResizeObserver(() => onResize()).observe(box);

  return {
    // The open session may be another one now (or have just got its Claude session id): show its list, as
    // last known at once, then as the server has it. `again`: ask the server even for the same session.
    async sync(again = false) {
      const id = sessionId() || null;
      if (id === shown && !again) return;
      shown = id;
      held = false;
      draw();
      if (!id) return;
      const list = await call('progress', { claudeSessionId: id }, { quiet: true });
      if (list !== undefined) got(id, list);
    },
    // A list changed on the server (Claude's change, or yours from another tab).
    onPartial(d) { got(d.claudeSessionId, d.list); },
    reset() { lists.clear(); shown = null; held = false; draw(); },
    // The room it takes at the rail's foot, which the anchors keep clear of.
    height: () => (box.hidden ? 0 : box.offsetHeight),
  };
}
