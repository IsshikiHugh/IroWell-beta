// The open session's to-do list, in the rail's Todo tab: your own notes for the session, kept by hand. Claude
// never sees it (server/daemon.mjs, "to-do lists"). Its items work as a progress list's (ui/checklist.js).
import { createChecklist } from './checklist.js';

export function createTodo({ call, sessionId }) {
  const box = document.getElementById('todo');
  const add = box.querySelector('.pg-add');
  return createChecklist({
    call, sessionId, rows: box.querySelector('.pg-list'), add, read: 'todo', write: 'todoEdit',
    // (a draft has no Claude session id yet, so nowhere to keep a list: its first message gives it one)
    drawn(items) { add.disabled = !sessionId(); },
  });
}
