// The open session's progress list, docked at the foot of the right rail: what its long task has to do, is
// doing and has done. A session starts one through the irowell:progress skill; until it does there is no
// list and nothing is shown. From then on Claude and you both write to it, and Claude is shown what you
// changed (server/daemon.mjs, "progress lists"). Its bar folds it down to one line; End (held) ends it.
// The items themselves: ui/checklist.js, which the rail's to-do list (ui/todo.js) shares.
import { createChecklist } from './checklist.js';
import { holdToRun } from './hold.js';

// `call`: the page's command to the server. `sessionId()`: the open session's Claude session id (none for a
// draft). `onResize()`: the list took or gave up room in the rail.
export function createProgress({ call, sessionId, onResize }) {
  const box = document.getElementById('progress');
  const bar = box.querySelector('.pg-bar'), count = box.querySelector('.pg-count');
  const list = createChecklist({
    call, sessionId, rows: box.querySelector('.pg-list'), add: box.querySelector('.pg-add'), read: 'progress', write: 'progressEdit',
    drawn(items, held) {
      const was = box.hidden;
      box.hidden = !items;
      if (items && !held) count.textContent = `${items.filter((i) => i.state === 'done').length}/${items.length}`;
      if (was !== box.hidden) onResize();
    },
  });

  // The task is over: the list goes (Claude is told, and starts a new one for the next task).
  holdToRun(box.querySelector('.pg-end'), () => list.edit({ op: 'end' }, () => null));

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
    sync: list.sync, onPartial: list.onPartial, reset: list.reset,
    // The room it takes at the rail's foot, which the anchors keep clear of.
    height: () => (box.hidden ? 0 : box.offsetHeight),
  };
}
