// The Ports dialog (the plug next to a remote server's name): the server's ports that this computer reaches
// as localhost. The local client holds them (client/main.mjs, "ports") and lists them in every transport
// status: the forwards of ~/.ssh/config, the ports you add here, and the ones a session on the server asked
// for because it started something for you to open.
import { h } from './render.js';

const BY = { config: '~/.ssh/config', claude: 'Claude', user: 'you' };
// Why a port's local number is not the server's (client/main.mjs, openPort): said next to it.
const WHY = { taken: (p) => `${p.remote} taken here`, low: () => 'below 1024', chosen: () => 'chosen' };
const WHY_TITLE = { taken: (p) => `Port ${p.remote} is in use on this computer, so the forward got a free local port.`, low: () => 'A port below 1024 can\'t be listened on here, so the forward got a free local port.', chosen: () => 'This local port was asked for.' };
let status = null; // the last transport status of a server reached over ssh (null: this machine, or none)
let redraw = null; // set while the dialog is open

// The button for the connection line (null when the server is this machine: its ports are at localhost already).
export function portsButton(t, ctx) {
  status = t.ports ? t : null;
  if (redraw) status ? redraw() : ctx.closeModal();
  if (!status) return null;
  const b = h('button', 'conn-icon conn-ports');
  b.id = 'portsBtn';
  b.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>';
  const n = t.ports.filter((p) => !p.error).length;
  if (n) b.append(h('span', 'conn-count', String(n)));
  b.title = `Ports of ${t.host} at localhost on this computer${n ? ` (${n} forwarded)` : ''}`;
  b.setAttribute('aria-label', 'Forwarded ports');
  b.onclick = () => openPorts(ctx);
  return b;
}

// A port's dot: yellow when something has the port (`on`: busy), hollow when it is free, grey while that isn't
// known. It stands by itself: no legend, and no words that only repeat it.
function dot(on, title) {
  const d = h('span', 'dot pt-dot ' + (on == null ? 'unknown' : on ? 'on' : 'off'));
  d.title = title;
  return d;
}
const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

// `ctx`: { openModal, closeModal, post, onClose(fn): what closing the dialog also does }
function openPorts(ctx) {
  const host = status.host;
  const body = ctx.openModal(`Ports · ${host}`);
  body.classList.add('ports');
  const list = h('div', 'pt-list');
  const field = (cls, placeholder) => {
    const el = h('input', 'pt-input ' + cls);
    Object.assign(el, { placeholder, inputMode: 'numeric', autocomplete: 'off', spellcheck: false });
    return el;
  };
  const inp = field('pt-remote', `Port on ${host}, e.g. 6006`);
  const loc = field('pt-want', 'same');
  // Left empty, the local port is the server's number: shown in grey there as the port is typed.
  const sameAs = () => { const v = inp.value.trim(); loc.placeholder = v !== '' && isPort(Number(v)) ? v : 'same'; };
  loc.title = 'The local port. Empty: the same number when it is free on this computer, else a free one.';
  const add = h('button', 'primary', 'Forward');
  add.type = 'button';
  const row = h('div', 'pt-add');
  row.append(inp, h('span', 'pt-at', 'at localhost:'), loc, add);
  const probe = h('div', 'pt-probe');
  const msg = h('div', 'pt-msg');
  body.append(h('div', 'pt-note', `Ports of ${host} at localhost on this computer, while this client stays connected to it. The local port is the server's number when that is free here; otherwise, or when you choose one, it is another. Claude adds a port when it starts something for you to open.`), list, row, probe, msg);

  // Whether each port is in use, asked again every few seconds while the dialog is open: { local: { port:
  // something has it here }, free: { port: a forward could take it }, remote: { port: something listens on
  // the server } or null (the server can't say) }.
  let busy = { local: {}, free: {}, remote: null };
  let shown = '', asked = 0;
  // The port being typed: { remote, want: the local port typed, or 0 }.
  const typed = () => {
    const remote = Number(inp.value.trim()), want = loc.value.trim() === '' ? 0 : Number(loc.value.trim());
    return inp.value.trim() !== '' && isPort(remote) && (!want || isPort(want)) ? { remote, want } : null;
  };
  const draw = () => {
    const t = typed();
    const key = JSON.stringify([status.ports, busy, t]);
    if (key === shown) return; // (as it was: the row under the pointer stays the same element)
    shown = key;
    list.textContent = '';
    if (!status.ports.length) list.append(h('div', 'pt-empty', 'No port is forwarded yet.'));
    for (const p of status.ports) {
      const r = h('div', 'pt-row');
      r.dataset.port = p.remote;
      const up = !p.error && !p.opening;
      const here = up ? busy.local[p.local] : null, there = busy.remote?.[p.remote];
      const state = (v) => (v == null ? 'unknown' : v ? 'busy' : 'free');
      r.dataset.local = state(here);
      r.dataset.remote = state(there);
      const end = h('span', 'pt-end');
      // (No dot for the local port: a forward that is up has it, always. Only one that lost it says so, below.)
      const to = h('span', 'pt-to', '→ ');
      to.append(dot(there, there == null ? `Whether something listens on ${host}:${p.remote} is not known (an older server: reconnect to update)` : there ? `Something listens on ${host}:${p.remote}` : `Nothing listens on ${host}:${p.remote}: the link opens nothing yet`), `${host}:${p.remote}`);
      if (p.error) { end.append(h('span', 'pt-local', `localhost:${p.local || p.remote}`)); r.append(end, to, h('span', 'pt-by pt-bad', p.error)); }
      else if (p.opening) { end.append(h('span', 'pt-local', `localhost:${p.local || '…'}`)); r.append(end, to, h('span', 'pt-by', 'opening…')); }
      else {
        const a = h('a', 'pt-local', `localhost:${p.local}`);
        a.href = `http://localhost:${p.local}/`;
        a.target = '_blank';
        a.rel = 'noreferrer';
        a.title = 'Open in a new tab';
        end.append(a);
        const why = p.local !== p.remote && WHY[p.why]?.(p);
        const by = h('span', 'pt-by');
        if (here === false) by.append(h('span', 'pt-bad', 'not forwarded'), ' · ');
        by.append([why, BY[p.by]].filter(Boolean).join(' · '));
        by.title = [here === false && `Nothing listens on localhost:${p.local}: the forward is not up.`, there === false && `Nothing listens on ${host}:${p.remote} yet.`, why && WHY_TITLE[p.why](p)].filter(Boolean).join(' ');
        r.append(end, to, by);
      }
      if (p.by !== 'config') {
        const x = h('button', 'run-stop pt-x', 'Remove'); // (the look of Stop in the Tasks tab)
        x.type = 'button';
        x.title = 'Stop forwarding this port';
        x.setAttribute('aria-label', `Stop forwarding port ${p.remote}`);
        x.onclick = async () => { const out = await ctx.post('closePort', { port: p.remote }); msg.textContent = out.error || ''; };
        r.append(x);
      }
      list.append(r);
    }
    // The port being typed, before it is forwarded: whether each side has it.
    probe.textContent = '';
    delete probe.dataset.local;
    delete probe.dataset.remote;
    const had = t && status.ports.find((p) => p.remote === t.remote);
    if (had) probe.append(`${host}:${t.remote} is forwarded already, at localhost:${had.local || '…'}`);
    else if (t) {
      const there = busy.remote?.[t.remote], local = t.want || t.remote, free = busy.free[local];
      probe.dataset.remote = there == null ? 'unknown' : there ? 'busy' : 'free';
      probe.dataset.local = free == null ? 'unknown' : free ? 'free' : 'busy';
      const part = (on, text) => { const s = h('span', 'pt-end'); s.append(dot(on, ''), text); return s; };
      probe.append(part(there, `${host}:${t.remote} ${there == null ? '' : there ? 'in use' : 'free: nothing listens there yet'}`),
        part(free == null ? null : !free, `localhost:${local} ${free == null ? '' : free ? 'free' : t.want ? 'in use: pick another local port' : 'in use: a free local port will be used'}`));
    }
  };
  const refresh = async () => {
    if (!redraw) return;
    const my = ++asked, t = typed();
    const out = await ctx.post('portStatus', {
      local: status.ports.filter((p) => p.local && !p.opening && !p.error).map((p) => p.local),
      remote: [...status.ports.map((p) => p.remote), ...(t ? [t.remote] : [])],
      free: t ? [t.want || t.remote] : [],
    });
    if (my !== asked || !redraw || out.error != null || !out.data) return; // (a client from before this: the dots stay grey)
    busy = out.data;
    draw();
  };
  redraw = () => { draw(); refresh(); };
  const timer = setInterval(refresh, 4000);
  let typing = null;
  const onType = () => { sameAs(); draw(); clearTimeout(typing); typing = setTimeout(refresh, 250); };

  const submit = async () => {
    const port = Number(inp.value.trim());
    if (!inp.value.trim() || add.disabled) return;
    add.disabled = true;
    msg.textContent = '';
    const out = await ctx.post('openPort', { port, local: loc.value.trim() === '' ? null : Number(loc.value.trim()) });
    add.disabled = false;
    if (out.error != null) msg.textContent = out.error;
    else inp.value = loc.value = '';
    sameAs();
    redraw?.();
    inp.focus();
  };
  add.onclick = submit;
  inp.oninput = loc.oninput = onType;
  inp.onkeydown = loc.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } };
  ctx.onClose(() => { redraw = null; clearInterval(timer); clearTimeout(typing); });
  redraw();
  inp.focus();
}
