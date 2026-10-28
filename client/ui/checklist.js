// A session's list of items you tick, reword, drag and remove: the core of the progress list (ui/progress.js)
// and of the to-do list (ui/todo.js). It keeps each session's items as the server last sent them, draws the
// open session's, and sends your changes.
import { h, imeKey } from './render.js';


// `call`: the page's command to the server. `sessionId()`: the open session's Claude session id (none for a
// draft). `rows`: where the items go. `add`: the field that adds one. `read` / `write`: the server's commands
// for a session's list and for a change to it. `drawn(items, held)`: the list was drawn (items: null, no
// list; held: an item is being reworded or dragged, so its rows were left as they are).
export function createChecklist({ call, sessionId, rows, add, read, write, drawn }) {
  const lists = new Map(); // Claude session id -> its items (null: it has no list)
  let shown = null; // the Claude session id whose list is drawn
  let held = false; // an item is being reworded or dragged: the list is redrawn when that ends
  let drag = null; // the id of the item being dragged
  const heard = new Map(); // Claude session id -> how many lists the server has sent for it unasked

  // Your change: shown at once (`now(items)` makes it here; what it returns, if anything, takes the items'
  // place), then as the server has it (only that, before the list has come from the server). One the server
  // refuses is said in a dialog, and the list is read again. `id`: the session whose list it is.
  const edit = async (cmd, now, id = shown) => {
    if (lists.get(id)) {
      const items = now(lists.get(id));
      if (items !== undefined) lists.set(id, items);
      draw();
    }
    const list = await call(write, { claudeSessionId: id, ...cmd }) ?? await call(read, { claudeSessionId: id }, { quiet: true });
    if (list !== undefined) got(id, list);
  };
  function got(id, list) {
    const items = list?.items ?? null;
    // (unchanged, e.g. the answer to your own change: no redraw, which would eat a click under way)
    if (lists.has(id) && JSON.stringify(items) === JSON.stringify(lists.get(id))) return;
    lists.set(id, items);
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
    row.draggable = !!it.id; // (a move names the item by its id: one just added has none until the server answers)
    // a box ticked once it is done (one being done, Claude's `doing`, shows by its bold text)
    const mark = h('input', 'box pg-state');
    mark.type = 'checkbox';
    mark.checked = it.state === 'done';
    mark.setAttribute('aria-label', 'Done');
    mark.onchange = () => { const to = mark.checked ? 'done' : 'todo'; edit({ op: 'state', ids: [it.id], state: to }, () => { it.state = to; }); };
    const text = h('span', 'pg-text', it.text);
    text.onclick = (ev) => reword(row, text, it, ev);
    const x = h('button', 'pg-x', '✕');
    x.type = 'button';
    x.title = 'Remove';
    // (by id, as for a drag: the list may have come again from the server; with the item gone, nothing to take out)
    x.onclick = () => edit({ op: 'remove', ids: [it.id] }, (all) => { const at = all.findIndex((i) => i.id === it.id); if (at >= 0) all.splice(at, 1); });
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
    const items = lists.get(shown) ?? null;
    if (!held) rows.replaceChildren(...(items || []).map((it) => rowOf(it, items)));
    drawn(items, held);
  }

  add.onkeydown = (ev) => {
    if (ev.key !== 'Enter' || imeKey(ev)) return;
    ev.preventDefault();
    const text = add.value.trim();
    if (!text) return;
    add.value = '';
    edit({ op: 'add', texts: [text] }, (all) => { all.push({ id: 0, text, state: 'todo' }); }); // (its id comes with the server's answer)
  };

  return {
    edit,
    shown: () => shown,
    // The open session may be another one now (or have just got its Claude session id): show its list, as
    // last known at once, then as the server has it. `again`: ask the server even for the same session.
    async sync(again = false) {
      const id = sessionId() || null;
      if (id === shown && !again) return;
      shown = id;
      held = false;
      draw();
      if (!id) return;
      const n = heard.get(id);
      const list = await call(read, { claudeSessionId: id }, { quiet: true });
      if (list !== undefined && heard.get(id) === n) got(id, list); // (a list sent meanwhile is newer)
    },
    // A list changed on the server (the session's change, or yours from another tab).
    onPartial(d) { heard.set(d.claudeSessionId, (heard.get(d.claudeSessionId) || 0) + 1); got(d.claudeSessionId, d.list); },
    reset() { lists.clear(); shown = null; held = false; draw(); },
  };
}
