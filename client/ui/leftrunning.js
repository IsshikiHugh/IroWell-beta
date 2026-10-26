// Left running (the ghost next to the server's name, there while there is any): processes that sessions which
// have ended left behind. A session's processes stop with it (server/daemon.mjs, stopLeftovers), so these are
// the ones that got away: the server was killed, say, or the session ran in a terminal. By session, each job
// once (by its top process); Stop (held) ends the job, every process of it.
import { h } from './render.js';
import { holdToRun, holding } from './hold.js';

let list = []; // [{ cid, title, cwd, procs: [{ pid, cmd, started, children, unit?, name? }] }]
let btn = null;
let redraw = null; // set while the dialog is open
let ctx = null; // { openModal, closeModal, post, onClose(fn), tilde(path), facts(proc), title(proc) }

const count = () => list.reduce((n, g) => n + g.procs.length, 0);
function update() {
  if (!btn) return;
  const n = count();
  btn.hidden = !n;
  btn.querySelector('.conn-count').textContent = String(n);
  btn.title = `${n} process${n > 1 ? 'es' : ''} left running by sessions that have ended`;
}

// The button for the connection line (the same one each time; hidden while nothing is left running).
export function leftRunningButton(c) {
  ctx = c;
  if (!btn) {
    btn = h('button', 'conn-icon conn-ports');
    btn.id = 'leftRunningBtn';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>';
    btn.append(h('span', 'conn-count'));
    btn.setAttribute('aria-label', 'Processes left running');
    btn.onclick = open;
  }
  update();
  return btn;
}

// The list from the server: on connecting, and each time it changes.
export function gotLeftRunning(l) {
  list = Array.isArray(l) ? l : [];
  update();
  if (redraw) redraw();
}

function open() {
  const body = ctx.openModal('Left running');
  body.classList.add('ports');
  const box = h('div', 'pt-list');
  const msg = h('div', 'pt-msg');
  body.append(h('div', 'pt-note', 'Processes that sessions which have ended left running.'), box, msg);
  const stopped = new Set(); // pids (units) asked to stop: their rows wait for the server to say they have gone
  const draw = () => {
    if (holding(box)) return; // not under a Stop being held: drawn again when it ends
    box.textContent = '';
    if (!list.length) box.append(h('div', 'pt-empty', 'Nothing is left running.'));
    for (const g of list) {
      const head = h('div', 'lr-head');
      head.append(h('span', 'lr-title', g.title || 'Untitled session'), h('span', 'lr-where', [g.cwd && ctx.tilde(g.cwd), g.cid.slice(0, 8)].filter(Boolean).join(' · ')));
      head.dataset.cid = g.cid;
      head.title = `Session ${g.cid}${g.cwd ? `\n${g.cwd}` : ''}`;
      box.append(head);
      for (const p of g.procs) {
        const r = h('div', 'pt-row lr-row');
        r.dataset.pid = p.pid;
        if (p.unit) r.dataset.unit = p.unit;
        const cmd = h('span', 'lr-cmd', ctx.title(p));
        cmd.title = p.unit ? `${p.unit}\n${p.cmd || ''}` : p.cmd || '';
        const key = p.unit || p.pid;
        const b = h('button', 'run-stop pt-x', stopped.has(key) ? 'Stopping…' : 'Stop'); // (the look of Stop in the Tasks tab)
        b.type = 'button';
        b.disabled = stopped.has(key);
        b.title = p.unit ? `Stop the systemd unit ${p.unit}` : 'Stop this process and the processes under it';
        holdToRun(b, async () => {
          msg.textContent = '';
          const out = await ctx.post('stopLeftRunning', { pid: p.pid, unit: p.unit });
          if (out.error != null) msg.textContent = out.error;
          else stopped.add(key);
          draw();
        });
        r.append(cmd, h('span', 'pt-by', ctx.facts(p)), b);
        box.append(r);
      }
    }
  };
  box.addEventListener('holdend', () => setTimeout(draw));
  redraw = draw;
  const timer = setInterval(draw, 5000); // (how long each has run)
  ctx.onClose(() => { redraw = null; clearInterval(timer); });
  draw();
}
