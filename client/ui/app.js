import { h, esc, fmtK, markdown, toolCard, highlight, langOf, relPath } from './render.js';
import { usagePanel, contextPanel } from './panels.js';
import { enhanceSelect } from './dropdown.js';
import { createResources, KIND } from './resources.js';
import { usagePage } from './usage.js';

const TOKEN = document.querySelector('meta[name="token"]').content;
const $ = (id) => document.getElementById(id);

let sessions = {};            // sid -> { cwd, title, state, model, mode, claudeSessionId, events: [] }
const alive = (s) => !!s && !s.draft && !s.closed && s.state !== 'ended'; // started, and not detached
const nonce = () => Math.random().toString(36).slice(2);
let lastSeq = 0, current = null, connected = false, wantNonce = null, restoreSid = null, restoreClaude = null;
const INPUT_PLACEHOLDER = document.getElementById('input').placeholder;
let wantDraft = null;         // the draft being turned into a real session by its first message
let folders = null;           // the sidebar's directories, registered on the server (null until loaded)
let remoteHome = null;        // $HOME on the server, for ~/ paths
let pendingCommand = null;    // { sid, text } of a slash command sent from this tab: its output pops up

// Per-render state of the open conversation. The feed is a list of turns; each turn is
// the question (sticky while you scroll its answer), the answer, and a footer.
let view = null;

const MODES = [
  ['default', 'Ask before edits'],
  ['acceptEdits', 'Accept edits'],
  ['plan', 'Plan mode'],
  ['auto', 'Auto mode'],
  ['bypassPermissions', 'Bypass permissions'],
];
const MODE_INFO = {
  default: 'Asks before editing files or running commands',
  acceptEdits: 'Edits files without asking; still asks for commands',
  plan: 'Researches and proposes a plan; changes nothing until you approve',
  auto: 'A classifier approves safe actions and asks about the rest',
  bypassPermissions: 'Runs every tool without asking',
};

// Dropdown looks: a coloured dot per permission mode, signal bars for effort.
function modeView(opt) {
  const d = h('span', 'dd-mode');
  d.append(h('span', 'mode-dot m-' + opt.value), h('span', 'dd-label', opt.textContent));
  return d;
}
function modeItem(opt) {
  const d = h('span', 'dd-rich');
  const top = h('span', 'dd-mode');
  top.append(h('span', 'mode-dot m-' + opt.value), h('span', 'dd-label', opt.textContent));
  d.append(top, h('span', 'dd-desc', MODE_INFO[opt.value] || ''));
  return d;
}

// Every command is a request: { data } or { error }.
async function post(type, body = {}) {
  let r;
  try {
    r = await fetch('/cmd', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-token': TOKEN }, body: JSON.stringify({ type, ...body }),
    });
  } catch {
    return { error: 'Lost contact with the local client (client.mjs). Is it still running?' };
  }
  if (!r.ok) return { error: r.status === 503 ? 'Not connected to the server right now.' : r.status === 413 ? 'Too large (images?)' : 'Command failed: ' + r.status };
  return r.json();
}
// Its data, or undefined after showing the error (`quiet`: no alert, and nothing sent while disconnected).
async function call(type, body = {}, { quiet = false } = {}) {
  if (quiet && !connected) return undefined; // background refreshes wait for the connection
  const out = await post(type, body);
  if (out.error != null) {
    if (!quiet) alert(out.error);
    return undefined;
  }
  return out.data ?? null;
}

// ---------------------------------------------------------------- event stream

const es = new EventSource('/events?t=' + TOKEN);
es.onerror = () => {
  if (es.readyState === EventSource.CLOSED) setConn(false, 'local client restarted: reload this page');
};
es.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.type === 'reset') {
    // History follows as separate messages; reselect the open session when it reappears.
    // Drafts live only in this page, so they survive a reconnect.
    const keep = sessions[current]?.draft ? current : null;
    restoreSid = keep ? null : current;
    restoreClaude = keep ? null : sessions[current]?.claudeSessionId; // a restarted daemon lists it under a new sid
    sessions = Object.fromEntries(Object.entries(sessions).filter(([, s]) => s.draft));
    lastSeq = 0; current = keep;
    renderList(); renderFeed();
  } else if (d.type === 'transport') {
    if (d.home && d.home !== remoteHome) { remoteHome = d.home; renderList(); }
    // Your initial on your messages (the first letter of the host's user name; "Y" for "you" without one).
    const initial = [...(d.user || '').trim()][0]?.toUpperCase() || 'Y';
    document.documentElement.style.setProperty('--me', JSON.stringify(initial));
    const doing = d.deploy === 'install' ? `installing IroWell on ${d.host}…` : `updating ${d.host}…`;
    setConn(d.up, d.deploying ? doing : d.up ? d.host : d.deploy === 'install' ? `IroWell is not on ${d.host} yet` : `reconnecting to ${d.host}…`, d.error || d.stale, d);
    if (d.up) { setTimeout(loadOverview, 500); loadFolders(); loadLimits(); }
  } else if (d.type === 'event' && d.seq > lastSeq) {
    lastSeq = d.seq;
    apply(d);
  } else if (d.type === 'partial') {
    if (d.op === 'act' || d.op === 'tick' || d.op === 'tasks') onActivity(d);
    else if (d.op === 'media') resources.onMedia(d);
    else if (d.op === 'folders') { folders = d.folders; renderList(); }
    else if (d.op === 'btw' || d.op === 'btw-done') btwPartial(d);
    else if (view && d.sid === view.sid) livePartial(d);
  } else if (d.type === 'error') {
    alert(d.text);
  }
};

function setConn(up, text, error, t = {}) {
  connected = up;
  const c = $('conn');
  c.innerHTML = '';
  c.append(h('span', 'dot ' + (up ? 'up' : 'down')), text);
  // Install (a host without IroWell; the client tries once by itself) or Update (the server runs older
  // code than this client, or a newer Claude Code is out).
  if (t.canDeploy || t.deploying) {
    const install = t.deploy === 'install';
    const b = h('button', 'conn-update', t.deploying ? (install ? 'Installing…' : 'Updating…') : install ? 'Install server' : 'Update server');
    b.id = 'updateServer';
    b.disabled = !!t.deploying;
    b.title = install ? 'Install IroWell (this client’s server code and the newest Claude Code) on the host'
      : 'Install this client’s server code (and the newest Claude Code) on the host; running sessions move over as they go idle';
    b.onclick = install ? () => call('deploy') : updateServer;
    c.append(b);
  }
  if (error && !t.deploying) c.append(h('div', 'conn-err', error));
  renderControls();
}
async function updateServer() {
  const running = Object.values(sessions).filter(alive).length;
  if (!confirm(`Update the server (this client's code, and the newest Claude Code)?${running ? ` Nothing is interrupted: each of the ${running} running session${running > 1 ? 's' : ''} moves to the new version as soon as it is idle; a busy one finishes on the current version first.` : ''}`)) return;
  await call('deploy');
}

function apply(e) {
  if (e.kind === 'created') {
    sessions[e.sid] = { cwd: e.cwd, title: e.title, state: 'idle', model: e.model, mode: e.mode, claudeSessionId: e.claudeSessionId, events: [],
      dormant: !!e.dormant, lastActive: e.lastActive || e.ts, color: e.color };
    if (wantNonce && e.nonce === wantNonce) {
      wantNonce = null; current = e.sid;
      if (wantDraft) { delete sessions[wantDraft]; wantDraft = null; } // the draft became this session
    } else if (restoreClaude && e.claudeSessionId === restoreClaude) { current = e.sid; restoreClaude = null; }
    else if (e.sid === restoreSid || !current) current = e.sid;
  }
  const s = sessions[e.sid];
  if (!s) return;
  if (e.kind === 'state') s.state = e.state;
  if (e.kind === 'suggest') { s.suggestion = e.text; if (e.sid === current) updateGhost(); return; }
  if (e.kind === 'stats') { const { type, seq, sid: _, ts, kind, ...st } = e; s.stats = st; s.statsAt = ts; if (e.sid === current) renderControls(); return; }
  if (e.kind === 'queue') { s.queue = e.items; if (e.sid === current) renderQueue(); return; }
  if (e.kind === 'user_text') { s.suggestion = null; s.lastActive = e.ts; }
  if (e.kind === 'msg' && e.msg.type === 'result') s.lastActive = e.ts;
  if (e.kind === 'init') { s.claudeSessionId = e.claudeSessionId; s.model = e.model; if (e.mode) s.mode = e.mode; }
  if (e.kind === 'meta') {
    if ('title' in e) s.title = e.title;
    if ('mode' in e) s.mode = e.mode;
    if ('model' in e) s.modelChoice = e.model;
    if ('color' in e) s.color = e.color;
  }
  if (e.kind === 'closed') s.closed = true;
  if (e.kind === 'rewound') { // the turns from that message on are gone from the conversation
    s.events = s.events.filter((x) => x.seq < e.from);
    s.events.push(e);
    schedule();
    if (e.sid === current) renderFeed();
    return;
  }
  s.events.push(e);
  schedule();
  if (e.sid === current) {
    if (e.kind === 'created') renderFeed();
    else { pendingUi.stick ??= nearBottom(); appendEvent(e); }
    pendingUi.controls = true;
    if (e.kind === 'user_text') { const a = actOf(e.sid); a.turnStart ??= Date.now(); a.tickAt = Date.now(); a.tokens = 0; a.thinkingAt = 0; }
    if (e.kind === 'msg' && e.msg.type === 'result') actOf(e.sid).turnStart = null;
  }
}

// The sidebar, the controls and the scroll position are redrawn once per frame, not once per event:
// a reconnect replays the whole event log, and redrawing the sidebar for each of tens of thousands of
// events (each redraw scanning every session's events) froze the page for seconds to minutes.
const pendingUi = { raf: 0, stick: null, controls: false };
// The open session is a detached copy of one that runs again under another sid (reattached here,
// in another tab, or before this page loaded, when the replay's first session gets picked): open
// the live copy. The sidebar hides such copies, so leaving one open would show a ghost row.
function leaveStaleCopy() {
  const s = sessions[current];
  if (!s || s.draft || !s.claudeSessionId || alive(s)) return false;
  const twin = Object.keys(sessions).find((k) => k !== current && sessions[k].claudeSessionId === s.claudeSessionId && alive(sessions[k]));
  if (!twin) return false;
  current = twin;
  return true;
}
function schedule() {
  if (!pendingUi.raf) pendingUi.raf = requestAnimationFrame(flushUi);
}
function flushUi() {
  const { stick, controls } = pendingUi;
  Object.assign(pendingUi, { raf: 0, stick: null, controls: false });
  if (leaveStaleCopy()) { renderList(); return renderFeed(); }
  renderList();
  if (stick) scrollDown();
  if (controls) renderControls();
}

// ---------------------------------------------------------------- sidebar / header

// Three states: busy (green: working, or anything still running in the background), idle (yellow:
// alive with nothing running, safe to detach), detached (grey: no Claude process here any more).
function sessionStatus(s) {
  if (s.draft) return 'draft';
  if (!alive(s)) return 'detached';
  const a = s.act;
  if (s.state === 'running' || s.state === 'waiting' || a?.tasks?.length || a?.procs?.length) return 'busy';
  return 'idle';
}
const STATUS_TEXT = { busy: 'busy', idle: 'idle', detached: 'detached', draft: 'not started' };

// Two waits per session, from the event log:
//   user waiting  – since Claude finished answering your last message;
//   agent waiting – since Claude last finished anything, including turns it started itself
//                   (subagent / background reports, scheduled work). Same number when nothing
//                   ran on its own since.
function waits(s) {
  let trigger = null, userEnd = null, anyEnd = null, working = false;
  for (const e of s.events) {
    if (e.kind === 'user_text') { trigger = 'user'; working = true; }
    else if (e.kind === 'notify') { trigger = 'agent'; working = true; }
    else if (e.kind === 'msg' && e.msg.type === 'result') {
      if (trigger === 'user') userEnd = e.ts;
      anyEnd = e.ts;
      trigger = null;
      working = false;
    }
  }
  return { userEnd, anyEnd, working: working && (s.state === 'running' || s.state === 'waiting') };
}

// All times on the page move together on one clock that ticks on the minute, so the rows never
// change at different moments.
let clockNow = Date.now();
function since(t) {
  if (!t) return '—';
  const m = Math.max(0, Math.floor((clockNow - t) / 60000));
  if (m < 1) return 'now';
  if (m < 10) return `${m}m`;             // minute steps for the first 10 minutes
  if (m < 60) return `${m - (m % 5)}m`;   // then 5-minute steps
  const hrs = Math.floor(m / 60);
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`;
}

const collapsedDirs = new Set((() => { try { return JSON.parse(localStorage.getItem('iro-collapsed-dirs') || '[]'); } catch { return []; } })());
const tilde = (p) => (remoteHome && (p === remoteHome || p.startsWith(remoteHome + '/')) ? '~' + p.slice(remoteHome.length) : p);

setTimeout(function tick() {
  clockNow = Date.now();
  renderList();
  setTimeout(tick, 60000 - (Date.now() % 60000) + 50); // next wall-clock minute
});

// Folders are the directories registered on the server; each lists its sessions, most recently
// active folder first, then the registered folders with nothing open.
async function loadFolders() {
  const r = await call('folders', {}, { quiet: true });
  if (r) { folders = r; renderList(); }
}
const folderShown = (dir) => !folders || folders.includes(dir);
const ICONS = {
  plus: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>',
  history: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.5v2.6h2.6"/><path d="M8 5v3.2l2 1.3"/></svg>',
};
const iconBtn = (cls, icon, title, onclick) => {
  const b = h('button', cls);
  b.type = 'button';
  b.innerHTML = ICONS[icon];
  b.title = title;
  b.onclick = (ev) => { ev.stopPropagation(); onclick(); };
  return b;
};

const SIDEBAR_MAX = 8;
function renderList() {
  const list = $('list');
  list.innerHTML = '';
  const groups = new Map();
  // Each folder lists its sessions by last use, newest first: every live one, and detached ones
  // while the folder has fewer than SIDEBAR_MAX rows (the server remembers that many across restarts).
  const byUse = Object.entries(sessions).filter(([, s]) => !s.draft && folderShown(s.cwd))
    .sort(([ka, a], [kb, b]) => alive(b) - alive(a) || (kb === current) - (ka === current) || (b.lastActive || 0) - (a.lastActive || 0));
  const seen = new Set(); // Claude session ids already listed: a reattached session shows up once, as the live copy
  for (const [sid, s] of byUse) {
    if (s.claudeSessionId && seen.has(s.claudeSessionId)) continue;
    if (s.claudeSessionId) seen.add(s.claudeSessionId);
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    const rows = groups.get(s.cwd);
    if (!alive(s) && rows.length >= SIDEBAR_MAX && sid !== current) continue;
    rows.push([sid, s]);
  }
  for (const rows of groups.values()) rows.sort(([, a], [, b]) => (b.lastActive || 0) - (a.lastActive || 0));
  for (const d of folders || []) if (!groups.has(d)) groups.set(d, []);
  for (const [sid, s] of Object.entries(sessions)) {
    if (!s.draft) continue;
    if (!groups.has(s.cwd)) groups.set(s.cwd, []);
    groups.get(s.cwd).unshift([sid, s]); // drafts on top of their folder
  }
  if (!groups.size) list.append(h('div', 'side-empty', folders ? 'No folders yet. Add one with the button above.' : ''));
  // Folders stay put: sorted by path, never by what is open or used last.
  for (const [dir, rows] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const folder = h('div', 'folder' + (collapsedDirs.has(dir) ? ' collapsed' : ''));
    folder.dataset.dir = dir;
    const head = h('div', 'folder-head');
    const name = tilde(dir);
    const n = rows.filter(([, s]) => !s.draft).length;
    const acts = h('span', 'folder-acts');
    acts.append(
      iconBtn('folder-btn', 'history', 'Past sessions in this folder', () => openHistory(dir)),
      iconBtn('folder-btn folder-new', 'plus', 'New session in this folder', () => newDraft(dir)),
    );
    head.append(h('span', 'folder-chev'), h('span', 'folder-name', name.split('/').filter(Boolean).pop() || name), h('span', 'folder-path', name), h('span', 'folder-n', n ? String(n) : ''), acts);
    head.title = `${dir}\nRight-click for more`;
    head.onclick = () => {
      if (collapsedDirs.has(dir)) collapsedDirs.delete(dir); else collapsedDirs.add(dir);
      saveCollapsed();
      renderList();
    };
    head.oncontextmenu = (ev) => { ev.preventDefault(); folderMenu(dir, ev.clientX, ev.clientY); };
    folder.append(head);
    if (!rows.length) folder.append(h('div', 'folder-empty', 'Nothing open here'));
    for (const [sid, s] of rows) {
      if (s.draft) { folder.append(draftRow(sid, s)); continue; }
      const st = sessionStatus(s);
      const row = h('div', `sess ${st}` + (sid === current ? ' active' : ''));
      const color = sessionColor(s.color);
      if (color) row.style.setProperty('--sc', color); // its leading bar; the default accent otherwise
      const t = h('div', 't');
      // Waiting on you (a question or an approval): a yellow dot that breathes and sends out rings.
      const asking = s.state === 'waiting' && !s.closed;
      t.append(h('span', asking ? 'dot st-ask' : `dot st-${st}` + (s.state === 'running' ? ' spinning' : '')), h('span', 'sess-title', s.title));
      const w = waits(s);
      const times = h('span', 'waits');
      const u = h('span', 'wait-user', w.working ? '…' : since(w.userEnd));
      u.title = 'User waiting: since Claude finished answering your last message';
      const a = h('span', 'wait-agent', since(w.anyEnd));
      a.title = 'Agent waiting: since Claude last finished anything, including work it started itself (subagent / background reports)';
      times.append(u, a);
      t.append(times);
      const bg = (s.act?.tasks?.length || 0) + (s.act?.procs?.length || 0);
      row.append(t, h('div', 'm', asking ? 'waiting for your answer' : `${STATUS_TEXT[st]}${bg ? ` · ${bg} in background` : ''}`));
      row.onclick = () => select(sid);
      folder.append(row);
    }
    list.append(folder);
  }
}
const saveCollapsed = () => { try { localStorage.setItem('iro-collapsed-dirs', JSON.stringify([...collapsedDirs])); } catch {} };

// A draft looks like any other session, but nothing runs until its first message is sent.
function draftRow(sid, s) {
  const row = h('div', 'sess draft' + (sid === current ? ' active' : ''));
  const t = h('div', 't');
  const x = h('button', 'sess-x', '✕');
  x.title = 'Discard this draft';
  x.onclick = (ev) => { ev.stopPropagation(); discardDraft(sid); };
  t.append(h('span', 'dot st-draft'), h('span', 'sess-title', 'New session'), x);
  row.append(t, h('div', 'm', s.text?.trim() ? 'not started · draft kept' : 'not started · starts when you send'));
  row.onclick = () => select(sid);
  return row;
}
function newDraft(dir, from) {
  let sid = Object.keys(sessions).find((k) => sessions[k].draft && sessions[k].cwd === dir);
  if (!sid) {
    sid = 'draft-' + nonce().slice(0, 8);
    sessions[sid] = { draft: true, cwd: dir, title: 'New session', state: 'draft', events: [], mode: from?.mode, modeSet: !!from?.mode, modelChoice: from?.modelChoice };
    // Like the terminal, a new session starts in settings.json's permissions.defaultMode: show it.
    if (!from?.mode) call('defaultMode', { cwd: dir }, { quiet: true }).then((m) => {
      const d = sessions[sid];
      if (!m || !d?.draft || d.modeSet) return;
      d.mode = m;
      if (current === sid) renderControls();
    });
  }
  if (collapsedDirs.delete(dir)) saveCollapsed();
  select(sid);
}
function discardDraft(sid) {
  delete sessions[sid];
  if (current === sid) { current = null; input.value = ''; fitInput(); renderFeed(); }
  renderList();
}

// A small menu at (x, y); `alignRight` puts its right edge there. Items: { label, run, title, cls }
// (no `run`: disabled), or 'sep'. A click outside or Esc closes it.
function contextMenu(items, x, y, { alignRight = false } = {}) {
  document.querySelector('.ctx-menu')?.remove();
  const m = h('div', 'ctx-menu');
  const close = () => { m.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); };
  const outside = (ev) => { if (!m.contains(ev.target)) close(); };
  const esc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  for (const it of items) {
    if (it === 'sep') { m.append(h('div', 'ctx-sep')); continue; }
    const b = h('button', 'ctx-item' + (it.cls ? ' ' + it.cls : ''), it.label);
    if (it.title) b.title = it.title;
    if (it.run) b.onclick = () => { close(); it.run(); }; else b.disabled = true;
    m.append(b);
  }
  document.body.append(m);
  m.style.left = `${Math.max(8, Math.min(alignRight ? x - m.offsetWidth : x, window.innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.min(y, window.innerHeight - m.offsetHeight - 8)}px`;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', esc, true);
}

// Right-click on a folder.
function folderMenu(dir, x, y) {
  const copy = async () => {
    const at = document.querySelector(`.folder[data-dir="${CSS.escape(dir)}"] .folder-name`) || $('list');
    try { await navigator.clipboard.writeText(dir); toast('Path copied', at); } catch { toast('Could not copy', at); }
  };
  contextMenu([
    { label: 'New session', run: () => newDraft(dir) },
    { label: 'Past sessions…', run: () => openHistory(dir) },
    { label: 'Copy path', run: copy },
    'sep',
    { label: 'Remove from sidebar', run: () => removeFolder(dir), cls: 'danger' },
  ], x, y);
}

// Only unregisters the folder: its sessions keep running and Claude's memory of it stays on disk.
async function removeFolder(dir) {
  const open = Object.values(sessions).filter((s) => alive(s) && s.cwd === dir).length;
  const msg = `Remove ${tilde(dir)} from the sidebar?\n\nNothing on the server is deleted: past sessions and Claude's memory of this folder stay, and adding the folder again brings them back.`
    + (open ? `\n\n${open} open session${open > 1 ? 's' : ''} here keep${open > 1 ? '' : 's'} running, hidden until you add the folder again.` : '');
  if (!confirm(msg)) return;
  const r = await call('removeFolder', { path: dir });
  if (!r) return;
  folders = r.folders;
  for (const [sid, s] of Object.entries(sessions)) if (s.draft && s.cwd === dir) delete sessions[sid];
  if (current && (!sessions[current] || sessions[current].cwd === dir)) { current = null; renderFeed(); }
  renderList();
}

// Add a folder: type a path, or walk the server's directories by clicking (like VS Code's picker).
async function openFolderPicker() {
  const body = openModal('Add a folder');
  body.classList.add('fp');
  const inp = h('input', 'fp-input');
  inp.value = '~/';
  inp.spellcheck = false;
  inp.autocomplete = 'off';
  inp.placeholder = 'Path on the server, e.g. ~/projects/app';
  const where = h('div', 'fp-where');
  const list = h('div', 'fp-list');
  const foot = h('div', 'fp-foot');
  const addBtn = h('button', 'primary', 'Add folder');
  foot.append(h('span', 'muted small', '↑ ↓ choose · Tab or click opens · Enter adds the highlighted row'), addBtn);
  body.append(inp, where, list, foot);
  let rows = [], index = 0, listed = { base: null, data: null, error: null }, gen = 0, recent = null;
  const split = () => { const v = inp.value, i = v.lastIndexOf('/'); return { base: v.slice(0, i + 1), prefix: v.slice(i + 1) }; };
  const go = (path) => { inp.value = path; refresh(); inp.focus(); };
  async function add(path) {
    const r = await call('addFolder', { path });
    if (!r) return;
    folders = r.folders;
    closeModal();
    if (collapsedDirs.delete(r.path)) saveCollapsed();
    renderList();
    const el = document.querySelector(`.folder[data-dir="${CSS.escape(r.path)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
    el?.classList.add('flash');
  }
  addBtn.onclick = () => add(inp.value);
  async function refresh() {
    const my = ++gen;
    const { base, prefix } = split();
    if (listed.base !== base) {
      const { data = null, error = null } = await post('ls', { path: base || '~' });
      if (my !== gen) return;
      listed = { base, data, error };
    }
    if (inp.value === '~/' && !recent) {
      recent = ((await call('recentDirs', {}, { quiet: true })) || []);
      if (my !== gen) return;
    }
    draw(prefix);
  }
  function draw(prefix) {
    rows = [];
    const { data, error } = listed;
    where.textContent = error ? error : data ? data.path : '';
    where.classList.toggle('err', !!error);
    if (data && !prefix) {
      const on = (folders || []).includes(data.path);
      rows.push({ label: on ? `${tilde(data.path)} is already in the sidebar` : `Add ${tilde(data.path)}`, cls: 'fp-add', run: () => add(data.path), disabled: on });
      if (data.path !== '/') rows.push({ label: '..', cls: 'fp-up', run: () => go(tilde(data.path.slice(0, data.path.lastIndexOf('/')) || '/').replace(/\/?$/, '/')), tab: true });
    }
    if (data) {
      const p = prefix.toLowerCase();
      for (const d of data.dirs) {
        if (d.startsWith('.') && !prefix.startsWith('.')) continue;
        if (!d.toLowerCase().startsWith(p)) continue;
        const full = (data.path === '/' ? '/' : data.path + '/') + d;
        rows.push({ label: d + '/', cls: 'fp-dir' + ((folders || []).includes(full) ? ' added' : ''), run: () => go(split().base + d + '/'), tab: true });
        if (rows.length > 300) break;
      }
    }
    if (inp.value === '~/' && recent?.length) {
      const fresh = recent.filter((d) => !(folders || []).includes(d));
      if (fresh.length) rows.push({ head: 'Recent project folders on this host' });
      for (const d of fresh) rows.push({ label: tilde(d), cls: 'fp-recent', run: () => add(d) });
    }
    index = rows.findIndex((r) => !r.head && !r.disabled);
    if (prefix) index = rows.findIndex((r) => r.cls?.startsWith('fp-dir'));
    paint();
  }
  function paint() {
    list.innerHTML = '';
    rows.forEach((r, i) => {
      if (r.head) { list.append(h('div', 'fp-head', r.head)); return; }
      const el = h('div', `fp-row ${r.cls || ''}` + (i === index ? ' on' : '') + (r.disabled ? ' disabled' : ''), r.label);
      el.onmousedown = (ev) => ev.preventDefault();
      el.onclick = () => { if (!r.disabled) r.run(); };
      list.append(el);
      if (i === index) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
    });
  }
  const move = (d) => {
    const ok = rows.map((r, i) => (!r.head && !r.disabled ? i : -1)).filter((i) => i >= 0);
    if (!ok.length) return;
    const at = ok.indexOf(index);
    index = ok[(at + d + ok.length) % ok.length] ?? ok[0];
    paint();
  };
  inp.oninput = () => refresh();
  inp.onkeydown = (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'Tab') { ev.preventDefault(); const r = rows[index]; if (r?.tab) r.run(); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const r = rows[index];
      if (ev.metaKey || ev.ctrlKey || !r) add(inp.value); else r.run();
    }
  };
  inp.focus();
  inp.setSelectionRange(inp.value.length, inp.value.length);
  refresh();
}
$('addFolder').onclick = openFolderPicker;

function select(sid) {
  hideUsagePage();
  if (btw && btw.sid !== sid) closeBtw(); // the side window belongs to the session it asks about
  // A draft keeps what was typed into it; an empty one goes away when you leave it.
  const prev = sessions[current];
  if (prev?.draft && current !== sid) {
    prev.text = input.value;
    if (!prev.text.trim()) delete sessions[current];
    input.value = '';
  }
  current = sid;
  const s = sessions[sid];
  if (s?.draft && s.text) input.value = s.text;
  fitInput(); updateGhost();
  renderList();
  renderFeed();
  refreshBtwList();
  if (!s?.draft) { pollStats(); loadActivity(sid); }
  $('input').focus();
}

// A session remembered from before a daemon restart has no events here: show its earlier
// conversation, read from the transcript (sending a message reattaches it).
async function loadTranscript(sid) {
  const s = sessions[sid];
  if (!s || s.transcript) return;
  s.transcript = 'loading';
  const evs = await call('transcript', { claudeSessionId: s.claudeSessionId, cwd: s.cwd }, { quiet: true });
  if (!evs) { s.transcript = 'failed'; return; } // e.g. the transcript is gone: the row still reattaches
  s.transcript = 'done';
  s.events.splice(1, 0, ...evs.map((e) => ({ ...e, sid, ts: null }))); // after 'created', before 'closed'
  if (current === sid) renderFeed();
}

// "claude-opus-5-5[1m]" -> "Opus 5.5 (1M)", or the catalog's display name when we have it.
function shortModel(m) {
  if (!m) return '';
  const known = modelList.find((x) => x.resolvedModel === m || x.value === m);
  if (known?.displayName && known.value !== 'default') return known.displayName;
  const x = /^(?:claude-)?([a-z]+)-(\d+)(?:-(\d+))?(\[1m\])?/i.exec(m);
  if (!x) return m.replace(/^claude-/, '');
  return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? '.' + x[3] : ''}${x[4] ? ' (1M)' : ''}`;
}

function renderControls() {
  const s = sessions[current];
  const live = connected && (s?.draft || alive(s));
  // A detached session still takes input: sending reattaches it first.
  const detached = !!s && !s.draft && !alive(s);
  const canReattach = connected && detached && !!s.claudeSessionId;
  $('input').disabled = $('send').disabled = !(live || canReattach);
  $('input').dataset.placeholder = canReattach ? 'Detached · sending a message reattaches it first' : INPUT_PLACEHOLDER; // updateGhost() shows it
  $('stop').disabled = !(live && (s.state === 'running' || s.state === 'waiting'));
  $('model').disabled = $('mode').disabled = $('effort').disabled = !live;
  // One button: Detach while live, Reattach once detached.
  $('closeSess').textContent = detached ? 'Reattach' : 'Detach';
  $('closeSess').title = detached ? 'Reattach: resume this session here' : 'Detach: stop this session here (reattach any time)';
  $('closeSess').disabled = !s || s.draft || (detached ? !canReattach : !live);
  renderActivity();
  $('title').textContent = s ? s.title : 'No session selected';
  $('title').title = s ? (s.draft ? s.cwd : `${s.cwd}\n(click to rename)`) : '';
  $('mode').value = s?.mode || 'default';
  updateGhost();
  $('model').options[0].textContent = shortModel(s?.stats?.model || s?.model) || 'default model';
  $('model').value = s?.modelChoice && [...$('model').options].some((o) => o.value === s.modelChoice) ? s.modelChoice : '';
  if (live && !modelsLoaded && !s.draft) loadModels();
  renderStatus();
  renderQueue();
  applyTheme(s?.color);
}

// Messages sent while Claude is busy wait on the server (each becomes its own turn once the current
// one ends), listed above the input. "Send now" interrupts the turn and sends that one next.
const queueEl = h('div');
queueEl.id = 'queue';
queueEl.hidden = true;
$('composer').prepend(queueEl);
function renderQueue() {
  const s = sessions[current];
  const items = (alive(s) && s.queue) || [];
  queueEl.replaceChildren(...items.map((q) => {
    const row = h('div', 'q-item');
    const text = h('span', 'q-text', (q.images ? `[${q.images} image${q.images > 1 ? 's' : ''}] ` : '') + q.text.replace(/\s+/g, ' ').trim());
    text.title = q.text;
    const now = h('button', 'q-now', 'Send now');
    now.title = 'Stop the current response and send this message next';
    now.onclick = () => call('queue', { sid: current, op: 'now', qid: q.qid });
    const x = h('button', 'q-x', '✕');
    x.title = 'Take it back (into the input, if that is empty)';
    x.setAttribute('aria-label', 'Remove from the queue');
    x.onclick = async () => {
      const r = await call('queue', { sid: current, op: 'remove', qid: q.qid });
      if (r?.text && !input.value.trim()) { input.value = r.text; fitInput(); updateGhost(); input.focus(); }
    };
    row.append(h('span', 'q-tag', 'Queued'), text, now, x);
    return row;
  }));
  queueEl.hidden = !items.length;
}

// /color: the session's colour becomes the page accent (question bars, Send, highlights).
const SESSION_COLORS = {
  red: '#d9534f', orange: '#e0843c', yellow: '#c4892c', green: '#3f9b5f', blue: '#3d78c2',
  purple: '#8b6cd9', pink: '#d96ca8', cyan: '#2fa7b8',
};
// Text on a session colour is always white: a colour too light for it is deepened (same hue) until
// white reads at 4.5:1 (the amber yellow is kept at 3:1, enough for the short bold labels it carries).
const luminance = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const onWhite = (hex) => 1.05 / (luminance(hex) + 0.05);
const scale = (hex, f) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')).join('');
const fillCache = new Map();
function fillFor(hex) {
  if (!fillCache.has(hex)) {
    const target = hex.toLowerCase() === SESSION_COLORS.yellow ? 3 : 4.5;
    let c = hex, f = 1;
    while (onWhite(c) < target && f > 0.4) { f -= 0.02; c = scale(hex, f); }
    fillCache.set(hex, c);
  }
  return fillCache.get(hex);
}
// Accent-coloured text (question titles, links) needs 4.5:1 on the page even for the amber yellow.
const textFor = (fill) => { let c = fill, f = 1; while (onWhite(c) < 4.5 && f > 0.4) { f -= 0.02; c = scale(fill, f); } return c; };
const sessionColor = (color) => { const c = SESSION_COLORS[color] || (/^#[0-9a-f]{6}$/i.test(color || '') ? color : null); return c && fillFor(c.toLowerCase()); };
function applyTheme(color) {
  const root = document.documentElement.style;
  const c = sessionColor(color);
  if (!c) { for (const v of ['--accent', '--accent-text', '--q-bg', '--q-border']) root.removeProperty(v); return; }
  root.setProperty('--accent', c);
  root.setProperty('--accent-text', textFor(c));
  root.setProperty('--q-bg', `color-mix(in srgb, ${c} 13%, var(--bg))`);
  root.setProperty('--q-border', `color-mix(in srgb, ${c} 38%, var(--bg))`);
}
async function setColor(arg) {
  const name = (arg || '').trim().toLowerCase();
  if (!name) {
    const body = openModal('Session colour');
    const row = h('div', 'swatches');
    for (const [n, c] of [...Object.entries(SESSION_COLORS), ['default', null]]) {
      const b = h('button', 'swatch-btn');
      b.title = n;
      b.append(h('span', 'swatch-dot'), h('span', null, n));
      b.firstChild.style.background = c || 'var(--muted)';
      b.onclick = () => { closeModal(); setColor(n); };
      row.append(b);
    }
    body.append(row);
    return;
  }
  const color = name === 'default' || name === 'reset' ? null : name;
  if (color && !SESSION_COLORS[color] && !/^#[0-9a-f]{6}$/.test(color)) return alert(`Unknown colour "${arg}". Try: ${Object.keys(SESSION_COLORS).join(', ')}, default, or #rrggbb.`);
  await call('setColor', { sid: current, color, claudeSessionId: sessions[current]?.claudeSessionId });
}

// ---------------------------------------------------------------- activity indicator (above the composer)
// Like the terminal's spinner: what is running now, for how long, whether the server is still
// talking to us, and which background tasks (background shells, subagents) are alive.

const actOf = (sid) => (sessions[sid].act ??= { tasks: [], tokens: 0 });

function onActivity(d) {
  const s = sessions[d.sid];
  if (!s) return;
  const a = actOf(d.sid);
  if (d.op === 'tick') { a.turnStart = d.turnStart; a.quietMs = d.quietMs; a.tickAt = Date.now(); }
  else if (d.op === 'tasks') { a.tasks = d.tasks; a.procs = d.procs || []; renderList(); }
  else if (d.what === 'thinking') { a.tokens = d.tokens; a.thinkingAt = Date.now(); }
  else if (d.what === 'tool') a.tool = { id: d.toolUseId, name: d.tool, elapsed: d.elapsed, at: Date.now() };
  a.lastAt = Date.now();
  if (d.sid === current) renderActivity();
}

async function loadActivity(sid) {
  const r = await call('activity', { sid }, { quiet: true });
  if (!r || !sessions[sid]) return;
  const a = actOf(sid);
  Object.assign(a, { turnStart: r.turnStart, quietMs: r.quietMs, tickAt: Date.now(), tasks: r.tasks, procs: r.procs || [] });
  if (sid === current) renderActivity();
  renderList();
}

const fmtSecs = (s) => (s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`);

function renderActivity() {
  const s = sessions[current];
  const bar = $('busy');
  const busy = !!s && (s.state === 'running' || s.state === 'waiting') && connected;
  const a = s ? actOf(current) : null;
  const tasks = [...(a?.tasks || []), ...(a?.procs || []).map((p) => ({ id: 'p' + p.pid, description: p.cmd, type: `pid ${p.pid}`, started: p.started }))];
  renderRunList();
  bar.hidden = !busy && !tasks.length;
  if (bar.hidden) return;
  bar.classList.toggle('waiting', s.state === 'waiting');
  bar.classList.toggle('idle', !busy);

  let label = 'Working…';
  if (!busy) label = 'Turn finished · background work still running';
  else if (s.state === 'waiting') label = waitingLabel();
  else if (view?.sid === current) {
    const turnSec = view.turn?.sec;
    const running = [...view.tools.values()].filter((t) => t.status === 'running' && turnSec?.contains(t.card)).pop();
    const live = view.live.get('');
    if (running) {
      const secs = a.tool?.id === running.card.dataset.id ? a.tool.elapsed + (Date.now() - a.tool.at) / 1000
        : running.startedAt ? (Date.now() - running.startedAt) / 1000 : null;
      label = `Running ${running.name}${running.label ? ' · ' + running.label : ''}${secs != null ? ' · ' + fmtSecs(secs) : ''}`;
    } else if (live?.block === 'text') label = 'Writing…';
    else if (live?.block === 'thinking' || (a.thinkingAt && Date.now() - a.thinkingAt < 4000)) label = 'Thinking…';
  }
  $('act-label').textContent = label;

  const parts = [];
  if (busy && a.turnStart) parts.push(fmtSecs((Date.now() - a.turnStart) / 1000));
  if (busy && a.tokens && a.thinkingAt) parts.push(`${fmtK(a.tokens)} thinking tokens`);
  const meta = $('act-meta');
  meta.textContent = parts.join(' · ');
  meta.className = '';
  // Alive? The daemon ticks every 3s while busy; quietMs is how long the CLI has said nothing.
  if (busy && a.tickAt && Date.now() - a.tickAt > 12000) {
    meta.textContent += ' · no heartbeat from the server for ' + fmtSecs((Date.now() - a.tickAt) / 1000);
    meta.className = 'bad';
  } else if (busy && a.quietMs != null) {
    const quiet = (a.quietMs + (Date.now() - (a.tickAt || Date.now()))) / 1000;
    if (quiet > 20) { meta.textContent += ` · no output for ${fmtSecs(quiet)}, still running`; meta.className = 'warn'; }
  }

  const btn = $('act-tasks');
  btn.hidden = !tasks.length;
  btn.textContent = `⧉ ${tasks.length} background task${tasks.length > 1 ? 's' : ''}`;
  const list = $('act-tasklist');
  if (!tasks.length) list.hidden = true;
  list.innerHTML = '';
  for (const t of tasks) {
    const row = h('div', 'act-task');
    row.append(h('span', 'act-spin small'), h('span', 'act-task-d', t.summary ? `${t.description || t.id} — ${t.summary}` : (t.description || t.id)),
      h('span', 'muted', [{ local_bash: 'shell', local_agent: 'subagent' }[t.type] || t.type, t.lastTool && `last: ${t.lastTool}`, t.toolUses != null && `${t.toolUses} tools`, t.started && fmtSecs((Date.now() - t.started) / 1000)].filter(Boolean).join(' · ')));
    list.append(row);
  }
}
$('act-tasks').onclick = () => { $('act-tasklist').hidden = !$('act-tasklist').hidden; };

// Right rail tabs: Anchors (turns) / Resources / Tasks / btw. The chosen tab is remembered in this browser.
let railTab = 'anchors';
try { railTab = localStorage.getItem('iro-rail-tab') || 'anchors'; } catch {}
function showRailTab(tab) {
  railTab = tab;
  for (const b of document.querySelectorAll('#railtabs button')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.rail-pane')) p.hidden = p.dataset.pane !== tab;
  try { localStorage.setItem('iro-rail-tab', tab); } catch {}
}
for (const b of document.querySelectorAll('#railtabs button')) b.onclick = () => showRailTab(b.dataset.tab);
showRailTab(railTab);

// Right rail, "Tasks" (was "Running"): the main turn, Claude's background tasks (shells, subagents, monitors),
// processes the session left running on its own (nohup'd experiments…), and busy btw threads.
function renderRunList() {
  const box = $('runlist');
  const s = sessions[current];
  box.innerHTML = '';
  if (!s) return;
  const a = actOf(current);
  const rows = [];
  const row = (kind, title, sub, stop) => {
    const r = h('div', 'run-item');
    const top = h('div', 'run-top');
    const mono = kind === 'shell' || kind === 'process'; // commands in mono, descriptions in sans
    top.append(h('span', 'run-kind k-' + kind.replace(/\W/g, ''), kind), h('span', 'run-title' + (mono ? ' mono' : ''), title));
    if (stop) {
      const b = h('button', 'run-stop', 'Stop');
      b.title = stop.title;
      b.onclick = (ev) => { ev.stopPropagation(); stop.run(); };
      top.append(b);
    }
    r.append(top);
    if (sub) r.append(h('div', 'run-sub', sub));
    r.title = title;
    rows.push(r);
  };
  // The main thread is always listed, whatever it is doing.
  const st = sessionStatus(s);
  if (s.state === 'running' || s.state === 'waiting') {
    row('main', s.state === 'waiting' ? waitingLabel() : ($('act-label').textContent || 'Working…'), a.turnStart ? `running for ${fmtSecs((Date.now() - a.turnStart) / 1000)}` : 'running');
  } else {
    row('main', st === 'detached' ? 'Detached' : st === 'draft' ? 'Not started' : 'Idle',
      st === 'detached' ? 'no Claude process here' : st === 'draft' ? 'starts when you send the first message' : 'waiting for your next message');
  }
  rows[0].classList.add('main-' + (s.state === 'running' || s.state === 'waiting' ? 'busy' : st));
  const KIND = { local_bash: 'shell', local_agent: 'subagent', monitor: 'monitor', workflow: 'workflow' };
  // Tasks that were running and are gone have finished: the last few stay listed, quietly.
  const kindOf = (t) => KIND[t.type] || (t.type && t.type !== 'task' ? 'subagent' : 'task');
  const seen = (s.seenTasks ||= new Map());
  const live = new Set((a.tasks || []).map((t) => t.id));
  for (const [id, t] of seen) {
    if (live.has(id)) continue;
    seen.delete(id);
    (s.finishedTasks ||= []).unshift({ kind: kindOf(t), title: t.description || t.id, ended: Date.now() });
    s.finishedTasks.length = Math.min(s.finishedTasks.length, 3);
  }
  for (const t of a.tasks || []) seen.set(t.id, t);
  for (const t of a.tasks || []) {
    row(kindOf(t), t.description || t.id,
      [t.summary, t.started && `running for ${fmtSecs((Date.now() - t.started) / 1000)}`, t.toolUses != null && `${t.toolUses} tool calls`, t.lastTool && `last: ${t.lastTool}`].filter(Boolean).join(' · '),
      alive(s) ? { title: 'Stop this task', run: () => confirm(`Stop "${t.description || t.id}"?`) && call('stopTask', { sid: current, taskId: t.id }) } : null);
  }
  for (const p of a.procs || []) {
    row('process', p.cmd || `pid ${p.pid}`,
      [p.started && `running for ${fmtSecs((Date.now() - p.started) / 1000)}`, `pid ${p.pid}`, p.children && `${p.children} child process${p.children > 1 ? 'es' : ''}`].filter(Boolean).join(' · '),
      { title: 'Send SIGTERM to this process', run: () => confirm(`Stop pid ${p.pid}?\n${p.cmd}`) && call('killProc', { sid: current, pid: p.pid }) });
  }
  if (btw?.streaming != null && btw.sid === current) row('btw', btw.messages[0]?.text || 'side question', 'answering…');
  const n = rows.length - 1; // everything besides main (running work only)
  for (const f of s.finishedTasks || []) {
    row(f.kind, f.title, `finished · ${ago(f.ended)}`);
    rows[rows.length - 1].classList.add('run-done');
  }
  box.append(...rows);
  $('taskCount').hidden = !n;
  $('taskCount').textContent = String(n);
}
setInterval(() => { if (current && $('busy').hidden) renderRunList(); }, 5000);

// Background work of every session, for the sidebar colours (tasks/processes of other sessions).
async function loadOverview() {
  const list = await call('overview', {}, { quiet: true });
  if (!list) return;
  for (const o of list) {
    const s = sessions[o.sid];
    if (!s) continue;
    const a = actOf(o.sid);
    if (!o.tasks) a.tasks = [];
    if (!o.procs) a.procs = [];
    if ((o.tasks && !a.tasks?.length) || (o.procs && !a.procs?.length)) loadActivity(o.sid);
  }
  renderList();
}
setInterval(loadOverview, 30000);
setInterval(() => { if (!$('busy').hidden) renderActivity(); }, 1000);

// ---------------------------------------------------------------- status line (under the composer)
// What the terminal status line shows: mode, model @ effort, directory, branch, tokens, cost,
// time, lines, context use, 5-hour and weekly plan limits, session name and id.

const EFFORTS = [
  ['low', 'Low', 'Fastest; least thinking'],
  ['medium', 'Medium', 'Balanced'],
  ['high', 'High', 'Thinks more before answering'],
  ['xhigh', 'Extra high', 'Deep thinking for hard problems'],
  ['max', 'Max', 'Everything it has; slowest'],
];
function effortBars(value) {
  const level = EFFORTS.findIndex((e) => e[0] === value) + 1;
  const bars = h('span', 'bars' + (value === 'max' ? ' max' : ''));
  for (let i = 1; i <= 5; i++) bars.append(h('span', i <= level ? 'on' : ''));
  return bars;
}
for (const [value, label] of EFFORTS) { const o = h('option', null, label); o.value = value; $('effort').append(o); }
$('effort').onchange = async () => {
  const s = sessions[current];
  if (s?.draft) { s.effort = $('effort').value; s.effortSet = true; return renderControls(); } // applied when it starts
  await call('setEffort', { sid: current, effort: $('effort').value }); pollStats();
};

// Effort: the button shows the level; clicking opens a slider (left = low, right = max).
function effortSlider(value, onInput) {
  const wrap = h('div', 'eff-slider');
  const range = h('input');
  range.type = 'range'; range.min = '0'; range.max = String(EFFORTS.length - 1); range.step = '1';
  range.value = String(Math.max(0, EFFORTS.findIndex((e) => e[0] === value)));
  const ticks = h('div', 'eff-ticks');
  EFFORTS.forEach(([, label], i) => {
    const t = h('span', null, label);
    t.style.left = `${(i / (EFFORTS.length - 1)) * 100}%`;
    t.onclick = () => { range.value = String(i); paint(); onInput(EFFORTS[i][0], true); };
    ticks.append(t);
  });
  const desc = h('div', 'eff-desc');
  function paint() {
    const i = Number(range.value);
    range.style.setProperty('--fill', `${(i / (EFFORTS.length - 1)) * 100}%`);
    ticks.querySelectorAll('span').forEach((t, j) => t.classList.toggle('on', j === i));
    desc.textContent = EFFORTS[i][2];
  }
  range.oninput = () => { paint(); onInput(EFFORTS[range.value][0], false); };
  range.onchange = () => onInput(EFFORTS[range.value][0], true);
  paint();
  wrap.append(range, ticks, desc);
  wrap.set = (v) => { range.value = String(Math.max(0, EFFORTS.findIndex((e) => e[0] === v))); paint(); };
  wrap.step = (d) => { range.value = String(Math.min(EFFORTS.length - 1, Math.max(0, Number(range.value) + d))); paint(); return EFFORTS[range.value][0]; };
  return wrap;
}

// One button for model and effort; it opens the same panel as ⌥M.
function refreshModelBtn() {
  const btn = $('modelBtn');
  const s0 = sessions[current];
  const v = $('effort').value;
  btn.disabled = $('model').disabled;
  btn.replaceChildren();
  const opt = $('model').selectedOptions[0];
  const name = opt && opt.value ? opt.textContent : shortModel(s0?.stats?.model || s0?.model) || 'Model';
  const eff = h('span', 'dd-effort');
  eff.append(effortBars(v), h('span', 'dd-label', EFFORTS.find((e) => e[0] === v)?.[1] || ''));
  btn.append(h('span', 'dd-label mb-name', name), h('span', 'mb-sep'), eff, h('span', 'dd-chev'));
}

function setEffortValue(v) {
  if (!v || $('effort').value === v) return;
  $('effort').value = v;
  refreshModelBtn();
  $('effort').dispatchEvent(new Event('change'));
}

let floating = null; // the open popover: { el, anchor, key(ev) }
function closeFloating(apply) {
  if (!floating) return;
  const f = floating;
  floating = null;
  f.el.remove();
  f.anchor?.classList.remove('open');
  f.onClose?.(apply);
}
function openFloating(el, anchor, opts = {}) {
  closeFloating(false);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.max(8, r.top - el.offsetHeight - 8)}px`;
  el.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - el.offsetWidth - 8)}px`;
  anchor.classList.add('open');
  floating = { el, anchor, ...opts };
}
document.addEventListener('mousedown', (ev) => {
  if (floating && !floating.el.contains(ev.target) && !floating.anchor.contains(ev.target)) closeFloating(true);
});

// ⌥M: models (↑ ↓) and effort (← →) in one panel; Enter applies, Esc cancels.
async function openModelPanel() {
  const s = sessions[current];
  if (!s || $('model').disabled) return;
  if (!modelList.length) await loadModels();
  const pop = h('div', 'popover model-pop');
  pop.append(h('div', 'pop-title', 'Model & effort'));
  const list = h('div', 'mp-list');
  const choices = modelList;
  if (!choices.length) return;
  // Starts on the model in use: the one picked here, else the one the session runs.
  const running = s.stats?.model || s.model;
  let index = choices.findIndex((m) => m.value === $('model').value);
  if (index < 0) index = choices.findIndex((m) => m.resolvedModel === running || m.value === running);
  if (index < 0) index = 0;
  const start = index;
  let effort = $('effort').value;
  const rows = choices.map((m, i) => {
    const r = h('div', 'dd-item');
    const t = h('span', 'dd-rich');
    t.append(h('span', 'dd-label', m.displayName || m.value), h('span', 'dd-desc', m.description || ''));
    r.append(t, h('span', 'dd-check'));
    r.onmousedown = (ev) => { ev.preventDefault(); index = i; mark(); };
    r.ondblclick = () => closeFloating(true);
    list.append(r);
    return r;
  });
  const mark = () => rows.forEach((r, i) => { r.classList.toggle('hover', i === index); r.querySelector('.dd-check').textContent = i === index ? '✓' : ''; });
  const slider = effortSlider(effort, (v) => { effort = v; });
  pop.append(list, h('div', 'mp-sep'), slider, h('div', 'pop-hint', '↑ ↓ model · ← → effort · Enter apply · Esc cancel'));
  openFloating(pop, $('modelBtn'), {
    key(ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { index = (index + (ev.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; mark(); rows[index].scrollIntoView({ block: 'nearest' }); return true; }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') { effort = slider.step(ev.key === 'ArrowLeft' ? -1 : 1); return true; }
      if (ev.key === 'Enter') { closeFloating(true); return true; }
      if (ev.key === 'Escape') { closeFloating(false); return true; }
      return false;
    },
    async onClose(apply) {
      if (!apply) return;
      const model = choices[index].value;
      if (index !== start && model !== $('model').value) { $('model').value = model; refreshModelBtn(); $('model').dispatchEvent(new Event('change')); }
      setEffortValue(effort);
    },
  });
  mark();
  rows[index].scrollIntoView({ block: 'nearest' });
}

$('modelBtn').onclick = () => (floating?.anchor === $('modelBtn') ? closeFloating(true) : openModelPanel());

// ⇧Tab cycles the permission mode, like the terminal (bypass is never reached by cycling).
const CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];
async function cycleMode() {
  const s = sessions[current];
  if (!s || $('mode').disabled) return;
  const next = CYCLE[(CYCLE.indexOf(s.mode || 'default') + 1) % CYCLE.length]; // unknown until the first turn: that's default
  $('mode').value = next;
  dd.mode.refresh();
  if (s.draft) Object.assign(s, { mode: next, modeSet: true }); else await call('setMode', { sid: current, mode: next });
  toast(MODES.find((m) => m[0] === next)[1], dd.mode.button);
  renderControls();
}

document.addEventListener('keydown', (ev) => {
  if (floating?.key && !(ev.altKey && ev.code === 'KeyM') && floating.key(ev)) { ev.preventDefault(); ev.stopPropagation(); return; }
  if (ev.altKey && !ev.metaKey && !ev.ctrlKey && ev.code === 'KeyM') {
    ev.preventDefault();
    ev.stopPropagation();
    if (floating?.anchor === $('modelBtn')) closeFloating(true); // ⌥M again closes (and applies)
    else openModelPanel();
    return;
  }
  if (ev.key === 'Tab' && ev.shiftKey && !ev.altKey && !ev.metaKey && !ev.ctrlKey && !$('modal')) { ev.preventDefault(); cycleMode(); }
}, true);

const dd = { mode: enhanceSelect($('mode'), { className: 'dd-modepick', button: modeView, item: modeItem }) };

const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m` : `${Math.floor(s / 60)}m ${s % 60}s`; };
function countdown(iso, days) {
  if (!iso) return '';
  const s = Math.max(0, (new Date(iso) - Date.now()) / 1000);
  const pad = (n) => String(Math.floor(n)).padStart(2, '0');
  return days ? `${pad(s / 86400)}d${pad((s % 86400) / 3600)}h` : `${pad(s / 3600)}h${pad((s % 3600) / 60)}m`;
}
// The sidebar's usage card: one row per limit, the number and a thin bar.
function usageMeter(el, label, pct, extra, title) {
  el.innerHTML = '';
  el.className = 'uc-meter' + (pct == null ? ' none' : pct >= 85 ? ' hot' : pct >= 50 ? ' warm' : '');
  const top = h('span', 'uc-top');
  top.append(h('span', null, label), h('span', 'uc-pct', pct == null ? '—' : `${Math.round(pct)}%`));
  const bar = h('span', 'uc-bar');
  const fill = h('span', 'uc-fill');
  fill.style.width = `${Math.min(100, pct || 0)}%`;
  bar.append(fill);
  el.append(top, bar);
  el.title = [title, extra && `resets in ${extra}`].filter(Boolean).join('\n');
}
// A window whose reset time has passed is over: nothing used in it yet (until a new number arrives).
const windowNow = (w) => (w?.resets && new Date(w.resets) <= Date.now() ? { pct: 0 } : w);
function renderUsageCard() {
  const s = sessions[current];
  // The newer of: what the open session last reported, the server's latest sample.
  const limits = s?.stats?.limits && (s.statsAt || 0) >= lastLimitsAt ? s.stats.limits : lastLimits || s?.stats?.limits;
  const five = windowNow(limits?.five), week = windowNow(limits?.week);
  usageMeter($('sb-5h'), '5-hour window', five?.pct, countdown(five?.resets, false), '5-hour limit');
  usageMeter($('sb-7d'), 'Weekly', week?.pct, countdown(week?.resets, true), 'weekly limit');
}
function miniMeter(el, label, pct, extra, title) {
  el.innerHTML = '';
  if (pct == null) { el.hidden = true; return; }
  el.hidden = false;
  // Quiet by default: grey until half used, dark amber after that, deep red when nearly full.
  const level = pct >= 85 ? 'hot' : pct >= 50 ? 'warm' : 'ok';
  el.className = 'sb-meter ' + level;
  const bar = h('span', 'mini');
  const fill = h('span', 'mini-fill');
  fill.style.width = `${Math.min(100, pct)}%`;
  bar.append(fill);
  el.append(h('span', 'sb-lab', label), bar, h('span', 'sb-pct', `${Math.round(pct)}%`));
  if (extra) el.append(h('span', 'sb-dim', extra));
  el.title = title || '';
}
function setItem(id, text, title) {
  const el = $(id);
  el.textContent = text || '';
  el.hidden = !text;
  el.title = title || '';
}
function renderStatus() {
  const s = sessions[current];
  renderUsageCard();
  $('statusbar').hidden = !s;
  document.querySelector('.head-sub').hidden = !s || s.draft;
  if (!s) return;
  const st = s.stats || {};
  const eff = st.effort || s.effort;
  if (eff && $('effort').value !== eff) $('effort').value = eff;
  $('effort').title = eff ? `Effort: ${eff}` : 'Effort';
  dd.mode.refresh(); refreshModelBtn();
  setItem('sb-dir', `${tilde(st.cwd || s.cwd || '')}${st.branch ? ' · ' + st.branch : ''}`, `${st.cwd || s.cwd}${st.branch ? '\ngit branch: ' + st.branch : ''}`);
  const se = st.session;
  setItem('sb-tokens', se ? `↑${fmtK(se.inTok)} ↓${fmtK(se.outTok)}${se.added || se.removed ? `  +${se.added} −${se.removed}` : ''}` : '', 'tokens in / out this session, lines added / removed');
  setItem('sb-cost', se ? `$${(se.cost || 0).toFixed(2)}` : '', 'this session at API rates');
  setItem('sb-time', se ? `⏱ ${fmtDur(se.durationMs)}` : '', 'session duration');

  const ctx = st.ctx;
  miniMeter($('sb-ctx'), 'Context', ctx?.pct, ctx ? `${fmtK(ctx.used)} / ${fmtK(ctx.max)}` : '', ctx ? `context window: ${fmtK(ctx.used)} of ${fmtK(ctx.max)} tokens` : '');
  const sid = $('sb-sid');
  const id = st.claudeSessionId || s.claudeSessionId;
  sid.innerHTML = '';
  sid.hidden = !id;
  if (id) {
    const dot = h('span', 'sid-dot');
    dot.style.background = sessionColor(s.color) || 'var(--base-fill)'; // the session's colour, as in the sidebar
    const copy = h('span', 'sid-copy');
    copy.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';
    sid.append(dot, h('span', null, id), copy);
  }
}
$('sb-sid').onclick = async () => {
  const id = sessions[current]?.stats?.claudeSessionId || sessions[current]?.claudeSessionId;
  if (!id) return;
  let ok = true;
  try { await navigator.clipboard.writeText(id); } catch { ok = false; }
  toast(ok ? 'Session ID copied' : 'Could not copy', $('sb-sid'));
};

// A small note that floats above an element and fades out.
function toast(text, anchor) {
  document.querySelector('.toast')?.remove();
  const t = h('div', 'toast', text);
  document.body.append(t);
  const r = anchor.getBoundingClientRect();
  t.style.top = `${r.top - t.offsetHeight - 8}px`;
  t.style.left = `${Math.min(r.left + r.width / 2 - t.offsetWidth / 2, window.innerWidth - t.offsetWidth - 8)}px`;
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 1400);
}

let lastLimits = null, lastLimitsAt = 0; // plan limits are per account: a draft shows the last ones seen
// The server's latest usage sample (every 30 minutes, also while no session runs): the usage card
// uses it whenever it is newer than what the open session last reported.
async function loadLimits() {
  const xs = await call('usageHistory', { days: 0.05 }, { quiet: true });
  const x = xs?.length && [...xs].reverse().find((y) => y.five || y.week);
  if (x && x.t > lastLimitsAt) { lastLimits = { five: x.five, week: x.week }; lastLimitsAt = x.t; renderUsageCard(); }
}
setInterval(() => { if (connected) loadLimits(); }, 5 * 60000);
// Plan limits move with every session on the account, so refresh the numbers on screen once a minute.
async function pollStats() {
  const sid = current;
  const s = sessions[sid];
  if (!connected || !alive(s)) return renderStatus();
  const st = await call('stats', { sid }, { quiet: true });
  if (st?.limits) { lastLimits = st.limits; lastLimitsAt = Date.now(); }
  if (st && sessions[sid]) { sessions[sid].stats = st; sessions[sid].statsAt = Date.now(); if (sid === current) renderControls(); }
}
setInterval(pollStats, 60000);
setInterval(() => { if (current) renderStatus(); }, 30000); // countdowns

let modelsLoaded = false;
let modelList = [];
async function loadModels() {
  modelsLoaded = true;
  const list = await call('models', { sid: sessions[current]?.draft ? undefined : current }, { quiet: true });
  if (!list?.length) { modelsLoaded = false; return; }
  // "Default (recommended)" is only an alias: listed under its real name, or not at all when that
  // model has its own entry (Default = Opus 5.5 shows just Opus 5.5).
  modelList = list.flatMap((m) => {
    if (m.value !== 'default') return [m];
    if (list.some((x) => x.value !== 'default' && x.resolvedModel === m.resolvedModel)) return [];
    return [{ ...m, displayName: shortModel(m.resolvedModel) || m.displayName, description: m.description?.replace(/^[^·]*·\s*/, '') }];
  });
  const sel = $('model');
  for (const m of modelList) {
    const o = h('option', null, m.displayName || m.value);
    o.value = m.value;
    o.title = m.description || '';
    sel.append(o);
  }
  renderControls();
}

for (const [value, label] of MODES) {
  const o = h('option', null, label);
  o.value = value;
  $('mode').append(o);
}
$('mode').onchange = async () => {
  const mode = $('mode').value;
  if (mode === 'bypassPermissions' && !confirm('Bypass permissions: Claude will run every tool without asking. Continue?')) return renderControls();
  if (sessions[current]?.draft) { Object.assign(sessions[current], { mode, modeSet: true }); return renderControls(); }
  await call('setMode', { sid: current, mode });
  renderControls();
};
$('model').onchange = async () => {
  if (sessions[current]?.draft) { sessions[current].modelChoice = $('model').value || undefined; return renderControls(); }
  await call('setModel', { sid: current, model: $('model').value || undefined });
  renderControls();
};
$('title').onclick = () => renameCurrent();
function renameCurrent(title) {
  const s = sessions[current];
  if (!s || s.draft) return;
  const t = title ?? prompt('Rename session', s.title);
  if (t && t.trim()) call('rename', { sid: current, title: t.trim() });
}
$('closeSess').onclick = () => {
  const s = sessions[current];
  if (!s || s.draft) return;
  if (!alive(s)) {
    if (s.claudeSessionId) reopen(s);
    return;
  }
  const msg = sessionStatus(s) === 'busy'
    ? 'This session is busy (working or running something in the background). Detach anyway? Its Claude process stops; background shells it started may stop too.'
    : 'Detach this session? Its Claude process stops; you can reattach any time (or just send a message).';
  if (!confirm(msg)) return;
  call('close', { sid: current });
};

// ---------------------------------------------------------------- feed: turns

const feed = () => $('feed');
const nearBottom = () => { const f = feed(); return f.scrollHeight - f.scrollTop - f.clientHeight < 120; };
const scrollDown = () => { const f = feed(); f.scrollTop = f.scrollHeight; };

function renderFeed() {
  const f = feed();
  f.innerHTML = '';
  resetFeedPad();
  $('outline').innerHTML = '';
  const s = sessions[current];
  view = s ? {
    sid: current, tools: new Map(), groups: new Map(), approvals: new Map(), live: new Map(),
    turns: [], turn: null, preamble: h('div', 'preamble'),
    pendingCmd: null, // a slash command whose turn is shown only if the model actually runs
  } : null;
  if (!s) { f.append(h('div', 'empty', 'Pick a session on the left, or start one with + on a folder.')); return renderControls(); }
  if (s.draft) {
    const intro = h('div', 'draft-intro');
    intro.append(h('div', 'di-t', 'New session'), h('div', 'di-dir', tilde(s.cwd)),
      h('div', 'di-s', 'Nothing runs yet. Your first message starts the session in this folder, with the model, effort and mode shown below.'));
    f.append(intro);
    return renderControls();
  }
  f.append(view.preamble);
  if (s.dormant && !s.transcript) loadTranscript(current);
  refreshBtwList();
  for (const e of s.events) appendEvent(e);
  scrollDown();
  markActiveTurn();
  renderControls();
}

const meta = (text, cls = '') => h('div', 'meta ' + cls, text);
const isCommand = (text) => /^\/[\w:.-]+(\s|$)/.test((text || '').trim());

// Anchors put the chosen question at the very top, like the terminal's fullscreen mode: if there
// isn't enough below it, blank space is added at the end instead of stopping halfway.
const FEED_PAD = 24;
function jumpToTurn(sec) {
  const f = feed();
  f.style.paddingBottom = `${FEED_PAD}px`;
  const top = sec.offsetTop;
  const need = top + f.clientHeight - f.scrollHeight;
  if (need > 0) f.style.paddingBottom = `${FEED_PAD + need}px`;
  f.scrollTo({ top, behavior: 'smooth' });
}
function resetFeedPad() { feed().style.paddingBottom = ''; }

function startTurn(e) {
  const sec = h('section', 'turn');
  const q = h('div', 'turn-q');
  q.title = 'Click to show the whole message';
  if (e.images?.length) {
    const row = h('div', 'thumbs');
    for (const im of e.images) {
      const img = h('img');
      img.src = `data:${im.media_type};base64,${im.data}`;
      row.append(img);
    }
    q.append(row);
  }
  q.append(h('div', 'turn-q-text', e.text));
  q.onclick = (ev) => { if (!ev.target.closest('button')) q.classList.toggle('full'); };
  if (e.notify) {
    // Not something the user wrote: a background task or subagent reporting back.
    sec.classList.add('notify');
    const n = e.notify;
    q.prepend(h('div', 'notify-tag', n.summary?.startsWith('Agent') ? '↩ Subagent result' : '↩ Background task result'));
    q.title = 'A background task reported back; Claude continues from here';
    const facts = [n.status, n.toolUses != null && `${n.toolUses} tool calls`, n.durationMs != null && fmtSecs(n.durationMs / 1000), n.tokens != null && `${fmtK(n.tokens)} tokens`].filter(Boolean).join(' · ');
    if (facts) q.append(h('div', 'notify-facts', facts));
  }
  const body = h('div', 'turn-body');
  const foot = h('div', 'turn-foot');
  sec.append(q, body, foot);
  feed().append(sec);
  const turn = { sec, q, body, foot, group: null, command: isCommand(e.text) ? e.text.trim() : null, changes: new Map(), outputs: [], seq: e.seq };
  if (turn.command) sec.classList.add('command');
  if (!e.notify && e.sid) { // ⋯ on the question: Branch from here, Rewind to here
    const more = h('button', 'turn-more', '⋯');
    more.title = 'More';
    more.onclick = (ev) => { ev.stopPropagation(); const r = more.getBoundingClientRect(); turnMenu(e, turn, r.right, r.bottom + 4); };
    q.append(more);
  }
  view.turn = turn;
  view.turns.push(turn);
  const item = h('div', 'ol-item' + (e.notify ? ' ol-notify' : ''), (e.notify ? '↩ ' : '') + (e.text.split('\n')[0].slice(0, 80) || '(image)'));
  if (e.notify) item.title = 'Background task / subagent reporting back (not your message)';
  item.onclick = () => jumpToTurn(sec);
  turn.outlineItem = item;
  $('outline').append(item);
}

// Main-thread content goes into the current turn; subagent content into its Agent card.
function target(parentId) {
  if (parentId) return view.tools.get(parentId)?.children || null;
  return view.turn?.body || view.preamble;
}

// A command like /compact only gets a turn when it leads to model output; until then it is invisible.
function materialize() {
  if (!view.pendingCmd) return;
  const e = view.pendingCmd;
  view.pendingCmd = null;
  startTurn(e);
}

function putText(el, parentId) {
  if (!parentId && view.pendingCmd) { feed().append(el); return; }
  const t = target(parentId);
  if (!t) return;
  if (!parentId && view.turn) view.turn.group = null; // text ends a run of steps
  t.append(el);
}

// Consecutive tool calls / thinking collapse into one "steps" line; expand to see them.
function putStep(el, api, parentId) {
  if (parentId) { target(parentId)?.append(el); return; }
  const turn = view.turn;
  if (!turn) { view.preamble.append(el); return; }
  let g = turn.group;
  if (!g) {
    g = { apis: [], thinking: 0, el: h('div', 'steps'), head: h('div', 'steps-head'), list: h('div', 'steps-list') };
    g.head.onclick = () => { g.el.classList.toggle('open'); g.autoOpened = false; };
    g.el.append(g.head, g.list);
    turn.body.append(g.el);
    turn.group = g;
  }
  g.list.append(el);
  if (api) { g.apis.push(api); view.groups.set(api.card.dataset.id, g); } else g.thinking++;
  refreshGroup(g);
}

function refreshGroup(g) {
  const counts = new Map();
  for (const a of g.apis) counts.set(a.name, (counts.get(a.name) || 0) + 1);
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  if (g.thinking) parts.unshift('thinking');
  const running = g.apis.filter((a) => a.status === 'running').pop();
  const asking = g.apis.some((a) => a.status === 'asking');
  const errors = g.apis.filter((a) => a.status === 'error').length;
  const n = g.apis.length;
  g.head.innerHTML = '';
  g.head.append(h('span', 'chev'), h('span', 'steps-count', n ? `${n} step${n > 1 ? 's' : ''}` : 'thinking'), h('span', 'steps-kinds', parts.join(' · ')));
  if (errors) g.head.append(h('span', 'steps-err', `${errors} failed`));
  if (asking) g.head.append(h('span', 'steps-ask', g.apis.some((a) => a.status === 'asking' && a.name === 'AskUserQuestion') ? 'needs your answer' : 'needs your approval'));
  else if (running) g.head.append(h('span', 'steps-now', `${running.name} ${running.label}`.trim()));
  g.el.classList.toggle('busy', !!running || asking);
  // An approval opens the group; once answered it folds back unless you opened it yourself.
  if (asking && !g.el.classList.contains('open')) { g.el.classList.add('open'); g.autoOpened = true; }
  else if (!asking && g.autoOpened) { g.el.classList.remove('open'); g.autoOpened = false; }
}

function appendEvent(e) {
  const s = sessions[view.sid];
  switch (e.kind) {
    // The folder and the model are in the header and the settings line; only a reopen is worth a line here.
    case 'created': if (e.resumed) view.preamble.append(meta('reopened from history')); break;
    case 'init': break;
    case 'notify': {
      dropLive('');
      view.pendingCmd = null;
      startTurn({ text: e.summary || 'Background task finished', notify: e, seq: e.seq });
      if (e.result) {
        const d = h('details', 'notify-result');
        d.append(h('summary', null, 'What it reported'), markdown(e.result));
        putText(d);
      }
      break;
    }
    case 'user_text':
      dropLive('');
      resetFeedPad();
      view.pendingCmd = null;
      if (isCommand(e.text)) view.pendingCmd = e;
      else startTurn(e);
      break;
    case 'error': putText(h('div', 'err', '⚠ ' + e.text)); break;
    case 'state': if (e.state === 'ended' && !s.closedNoted) putText(endedNote(s)); break;
    case 'closed': s.closedNoted = true; view.pendingCmd = null; view.turn = null; feed().append(endedNote(s, 'detached')); break;
    case 'meta':
      if ('color' in e) break; // shown by the page colour itself
      if ('mode' in e) putText(meta(`permission mode → ${MODES.find((m) => m[0] === e.mode)?.[1] || e.mode}`));
      if ('model' in e) putText(meta(`model → ${e.model || 'default'}`));
      break;
    case 'sys':
      if (e.subtype === 'compact') putText(meta(`context compacted (${e.trigger}${e.pre ? `, ${fmtK(e.pre)} tokens before` : ''})`, 'divider'));
      else if (e.subtype === 'retry') putText(meta(`API error${e.status ? ' ' + e.status : ''}, retrying (${e.attempt}/${e.max})…`, 'warn'));
      else if (e.subtype === 'local') commandOutput(e.text);
      else if (e.subtype === 'hook') putText(hookNote(e));
      else if (e.subtype === 'info') putText(meta(e.text, e.level === 'warning' ? 'warn' : 'note'));
      else if (e.subtype === 'resumed' || e.subtype === 'branched') {
        view.turn = null; view.preamble = h('div', 'preamble');
        feed().append(meta(e.subtype === 'branched' ? '— branched: the conversation above is a copy; new messages go to this branch only —' : '— earlier conversation above; new messages continue it —', 'divider'), view.preamble);
      }
      break;
    case 'rewound': {
      view.turn = null; view.pendingCmd = null;
      const n = e.files?.length || 0;
      const what = n ? `${n} file${n > 1 ? 's' : ''} restored${e.insertions != null ? ` (+${e.insertions} −${e.deletions})` : ''}` : 'no file changes to undo';
      feed().append(meta(`— rewound: the conversation continues from here · ${what}${e.fileError ? ` · files not restored: ${e.fileError}` : ''} —`, 'divider'));
      break;
    }
    case 'approval': showApproval(e); break;
    case 'approval_done': finishApproval(e); break;
    case 'msg': view.ts = e.ts; renderMsg(e.msg, s.cwd); break;
  }
}

// A hook that ran (settings.json "hooks"): one line, its output folded under it.
function hookNote(e) {
  const bad = e.outcome !== 'success';
  const d = h('details', 'hook-note' + (bad ? ' bad' : ''));
  d.append(h('summary', null, `⚓ ${e.event} hook${e.name && e.name !== e.event ? ` · ${e.name}` : ''} ${bad ? `✗ ${e.outcome}${e.exit != null ? ` (exit ${e.exit})` : ''}` : '✓'}`));
  if (e.text) d.append(h('pre', null, e.text));
  if (bad) d.open = true;
  return d;
}

function endedNote(s, why = 'ended') {
  const d = meta(why === 'detached' ? 'Detached. ' : 'Session ended. ', 'warn detached-note');
  if (s.claudeSessionId) {
    const btn = h('button', null, 'Reattach');
    btn.onclick = () => reopen(s);
    d.append(btn);
  }
  return d;
}

function renderMsg(m, cwd) {
  const parentId = m.parent_tool_use_id;
  if (m.type === 'assistant') {
    // Built-in slash commands answer with a "<synthetic>" message instead of a model turn.
    if (m.message.model === '<synthetic>' && !parentId) {
      const text = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      return commandOutput(text);
    }
    if (!parentId) materialize();
    if (!parentId && view.turn && m.uuid) view.turn.lastUuid = m.uuid; // where "Branch from here" cuts
    for (const b of m.message.content) {
      if (b.type === 'text' && b.text.trim()) {
        dropLive(parentId || '');
        putText(assistantText(b.text), parentId);
      } else if (b.type === 'thinking') {
        dropLive(parentId || '');
        putStep(thinkingBlock(b.thinking), null, parentId);
      } else if (b.type === 'tool_use') {
        dropLive(parentId || '');
        const api = toolCard(b, cwd);
        api.startedAt = view.ts || Date.now(); // server time the call was made
        view.tools.set(b.id, api);
        // Questions and plans are part of the conversation, not background steps.
        if (b.name === 'AskUserQuestion' || b.name === 'ExitPlanMode') putText(api.card, parentId);
        else putStep(api.card, api, parentId);
      }
    }
  } else if (m.type === 'user') {
    const content = m.message?.content;
    const texts = typeof content === 'string' ? [content] : (content || []).filter((b) => b.type === 'text').map((b) => b.text);
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type !== 'tool_result') continue;
      const api = view.tools.get(b.tool_use_id);
      if (!api) continue;
      api.setResult(b, m.patch, m.agent);
      const g = view.groups.get(b.tool_use_id);
      if (g) refreshGroup(g);
      if (api.changes && view.turn) { view.turn.changes.set(api.changes.file, api.changes); }
    }
    if (m.isSynthetic || parentId) return; // injected context, subagent prompts
    for (const t of texts) {
      const out = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/.exec(t);
      if (out) { if (out[2].trim()) commandOutput(out[2]); }
      else putText(meta(t, 'note'));
    }
  } else if (m.type === 'result') {
    dropLive('');
    if (view.pendingCmd) { view.pendingCmd = null; return; } // a command that never reached the model
    finishTurn(m);
  }
}

// Output of a CLI slash command: shown in a dialog to the tab that ran it, never in the conversation.
function commandOutput(text) {
  const title = view.pendingCmd?.text.trim() || view.turn?.command || 'Command output';
  if (pendingCommand && (pendingCommand.sid ?? view.sid) === view.sid && title === pendingCommand.text) {
    pendingCommand = null;
    showOutput(title, text);
  }
}

function showOutput(title, text) {
  const body = openModal(title);
  body.append(markdown(text));
}

function finishTurn(m) {
  const turn = view.turn;
  if (!turn) return;
  if (turn.command && !m.num_turns) { turn.foot.innerHTML = ''; return; } // local command: no model turn
  turn.foot.innerHTML = '';
  if (turn.changes.size) {
    const files = h('div', 'changed');
    files.append(h('span', 'muted', 'Changed '));
    for (const c of turn.changes.values()) {
      const f = h('span', 'file-link', relPath(c.file, sessions[view.sid]?.cwd));
      f.dataset.path = c.file;
      files.append(f, h('span', 'plus', ` +${c.add}`), h('span', 'minus', ` −${c.del}  `));
    }
    turn.foot.append(files);
  }
  turn.foot.append(resultLine(m));
  turn.sec.classList.add(m.subtype === 'success' ? 'ok' : 'bad');
}

function assistantText(text) {
  const el = markdown(text);
  el.classList.add('assistant');
  return el;
}

function thinkingBlock(text) {
  const d = h('details', 'thinking');
  d.append(h('summary', null, 'Thinking'), markdown(text));
  return d;
}

function resultLine(m) {
  const parts = [m.subtype === 'success' ? '✓ done' : m.subtype === 'error_during_execution' ? '■ stopped' : '✗ ' + m.subtype];
  if (m.duration_ms != null) parts.push(`${(m.duration_ms / 1000).toFixed(1)}s`);
  const u = m.usage;
  if (u) {
    const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    parts.push(`${fmtK(inTok)} in · ${fmtK(u.output_tokens || 0)} out`);
  }
  if (m.total_cost_usd != null) parts.push(`session ≈ $${m.total_cost_usd.toFixed(3)} at API rates`);
  const el = meta(parts.join(' · '), 'result');
  if (m.subtype !== 'success' && m.subtype !== 'error_during_execution') el.classList.add('warn');
  return el;
}

// Outline on the right: one entry per turn; the one you are reading is highlighted.
function markActiveTurn() {
  if (!view) return;
  const top = feed().getBoundingClientRect().top + 8;
  let active = null;
  if (nearBottom()) active = view.turns[view.turns.length - 1]; // the last turn may be too short to reach the top
  else for (const t of view.turns) if (t.sec.getBoundingClientRect().top <= top + 40) active = t;
  active ??= view.turns[0];
  for (const t of view.turns) t.outlineItem.classList.toggle('active', t === active);
  active?.outlineItem.scrollIntoView({ block: 'nearest' });
}
let scrollRaf = 0;
$('feed').addEventListener('scroll', () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; markActiveTurn(); });
});

// ---------------------------------------------------------------- streaming (live, not logged)

// One live block per thread: '' is the main conversation, otherwise the Agent tool_use id.
function livePartial(d) {
  const key = d.parent || '';
  if (d.op === 'start') {
    dropLive(key);
    if (!d.parent) materialize();
    const t = target(d.parent);
    if (!t) return;
    const stick = nearBottom();
    const el = d.block === 'thinking' ? thinkingBlock('') : h('div', 'md assistant live');
    if (d.block === 'thinking') el.classList.add('live');
    t.append(el);
    view.live.set(key, { el, block: d.block, text: '', raf: 0 });
    renderActivity();
    if (stick) scrollDown();
  } else if (d.op === 'delta') {
    const live = view.live.get(key);
    if (!live || live.block !== d.block) return;
    live.text += d.text;
    if (!live.raf) {
      live.raf = requestAnimationFrame(() => {
        live.raf = 0;
        if (view?.live.get(key) !== live) return;
        const stick = nearBottom();
        const rendered = markdown(live.text);
        if (live.block === 'thinking') live.el.querySelector('.md').replaceWith(rendered);
        else live.el.innerHTML = rendered.innerHTML;
        if (stick) scrollDown();
      });
    }
  }
}

function dropLive(key) {
  const live = view?.live.get(key);
  if (live) {
    cancelAnimationFrame(live.raf);
    live.el.remove();
    view.live.delete(key);
  }
}

// ---------------------------------------------------------------- approvals

// A pending question waits for your answer; anything else for your approval.
function waitingLabel() {
  const open = view?.sid === current ? [...view.approvals.values()].filter((b) => !b.classList.contains('settled')) : [];
  return open.length && open.every((b) => b.querySelector('.q')) ? 'Waiting for your answer' : 'Waiting for your approval';
}

function showApproval(e) {
  materialize();
  const box = h('div', 'approval');
  const decide = (allow, extra) => call('approve', { sid: e.sid, rid: e.rid, allow, ...extra });
  const btns = h('div', 'btns');
  const yes = h('button', 'primary', 'Allow');
  const always = h('button', null, 'Always allow');
  const no = h('button', null, 'Deny');
  yes.onclick = () => decide(true);
  always.onclick = () => decide(true, { always: true });
  no.onclick = () => decide(false);

  if (e.tool === 'AskUserQuestion' && Array.isArray(e.input?.questions)) {
    const many = e.input.questions.length > 1; // one question: the card's head already shows its header
    const readers = e.input.questions.map((q, qi) => {
      const qbox = h('div', 'q');
      if (q.header && many) qbox.append(h('span', 'chip', q.header));
      qbox.append(h('div', 'qtext', q.question));
      const opts = h('div', 'opts');
      for (const o of q.options || []) {
        const lab = h('label', 'opt');
        const inp = h('input');
        inp.type = q.multiSelect ? 'checkbox' : 'radio';
        inp.name = `${e.rid}-${qi}`; inp.value = o.label;
        const txt = h('span', 'opt-text');
        txt.append(h('span', 'opt-label', o.label));
        if (o.description) txt.append(h('span', 'desc', o.description));
        lab.append(inp, txt);
        opts.append(lab);
      }
      const other = h('input', 'other');
      other.placeholder = 'Something else? Type your own answer';
      // A single choice is either an option or your own text, never both.
      if (!q.multiSelect) {
        other.addEventListener('input', () => { if (other.value.trim()) opts.querySelectorAll('input:checked').forEach((i) => (i.checked = false)); });
        opts.addEventListener('change', () => { other.value = ''; });
      }
      qbox.append(opts, other);
      box.append(qbox);
      return () => {
        const picked = [...opts.querySelectorAll('input:checked')].map((i) => i.value);
        if (other.value.trim()) picked.push(other.value.trim());
        return picked.length ? picked.join(', ') : null;
      };
    });
    yes.textContent = 'Submit';
    no.textContent = 'Skip';
    yes.onclick = () => {
      const answers = {};
      for (const [i, read] of readers.entries()) {
        const a = read();
        if (a == null) return alert('Please answer: ' + e.input.questions[i].question);
        answers[e.input.questions[i].question] = a;
      }
      decide(true, { answers });
    };
    btns.append(no, yes); // right-aligned: the quiet Skip, then Submit
  } else {
    box.append(h('div', 'ask', e.title || `Allow ${e.tool}?`));
    if (e.description) box.append(h('div', 'muted', e.description));
    btns.append(yes);
    if (e.canAlways) btns.append(always);
    btns.append(no);
  }
  box.append(btns);
  view.approvals.set(e.rid, box);
  if (e.sid === current) renderActivity(); // "answer" or "approval"

  const api = e.toolUseId && view.tools.get(e.toolUseId);
  if (api) {
    api.setApproval(box);
    const g = view.groups.get(e.toolUseId);
    if (g) refreshGroup(g);
  } else { // no card to attach to: show it on its own
    const card = h('div', 'tool asking');
    const head = e.tool === 'AskUserQuestion' ? (e.input?.questions || []).map((q) => q.header || q.question).join(' · ') : e.tool;
    card.append(h('div', 'tool-head', head), box);
    putText(card);
  }
}

function finishApproval(e) {
  const box = view.approvals.get(e.rid);
  if (!box) return;
  const verdict = !e.allow ? '✗ denied'
    : e.answers ? '✓ answered: ' + Object.values(e.answers).join(' / ')
    : e.always ? '✓ always allowed' : '✓ allowed';
  box.querySelectorAll('input').forEach((i) => (i.disabled = true));
  if (e.answers) box.querySelector('.btns')?.replaceWith(meta(verdict, 'ok')); // keep the questions visible
  else box.replaceChildren(meta(verdict, e.allow ? 'ok' : 'warn'));
  box.classList.add('settled');
  const card = box.closest('.tool');
  card?.classList.remove('asking');
  const g = card && view.groups.get(card.dataset.id);
  if (g) refreshGroup(g);
}

// ---------------------------------------------------------------- new session / history

async function reopen({ claudeSessionId, cwd, title, color }) {
  wantNonce = nonce();
  const r = await call('resume', { claudeSessionId, cwd, title, color, nonce: wantNonce }); // a reattached session keeps its /color
  if (r?.existing) { wantNonce = null; select(r.sid); }
  if (r) closeModal();
  return r;
}

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

// Past sessions of one folder (or, with no folder, of the whole host).
async function openHistory(dir) {
  if (typeof dir !== 'string') dir = undefined;
  const box = openModal(dir ? `Past sessions · ${tilde(dir)}` : 'Past sessions on this host');
  const bar = h('div', 'hbar');
  const filter = h('input', 'hfilter');
  filter.placeholder = dir ? 'Filter by title' : 'Filter by title or directory';
  const allLab = h('label', 'hall');
  const all = h('input');
  all.type = 'checkbox';
  allLab.append(all, ' include headless / automated runs');
  bar.append(filter, allLab);
  const rows = h('div', 'hlist');
  box.append(bar, rows);
  let list = [];
  const load = async () => {
    rows.replaceChildren(meta('loading…'));
    list = (await call('history', { all: all.checked, cwd: dir })) || [];
    draw();
  };
  const draw = () => {
    rows.innerHTML = '';
    const q = filter.value.toLowerCase();
    let shown = 0;
    for (const x of list) {
      if (q && !`${x.title} ${x.cwd}`.toLowerCase().includes(q)) continue;
      shown++;
      const row = h('div', 'hrow');
      const t = h('div', 't', x.title);
      if (x.openAs) t.prepend(h('span', 'tag', 'open'));
      const src = x.source === 'terminal' ? 'terminal' : x.fromUi ? 'this UI' : x.source;
      if (src) t.prepend(h('span', 'tag', src));
      row.append(t, h('div', 'm', [dir ? null : x.cwd || '(unknown directory)', x.gitBranch, ago(x.lastModified)].filter(Boolean).join(' · ')));
      row.onclick = () => {
        if (x.openAs && sessions[x.openAs] && !sessions[x.openAs].closed) { closeModal(); select(x.openAs); }
        else reopen(x);
      };
      rows.append(row);
    }
    if (!shown) rows.append(meta(list.length ? 'Nothing matches.' : dir ? 'No past sessions in this folder.' : 'No past sessions.'));
  };
  filter.oninput = draw;
  all.onchange = load;
  filter.focus();
  load();
}

// ---------------------------------------------------------------- plan usage page (not tied to a session)
let usageView = 'total'; // or 'delta'
async function showUsagePage() {
  closeBtw();
  document.querySelector('main').classList.add('usage-mode');
  $('usageView').hidden = false;
  $('usageBtn').classList.add('on');
  $('usageBody').replaceChildren(meta('loading…'));
  const [samples, forecast] = await Promise.all([call('usageHistory', { days: 8 }), call('usageForecast', {}, { quiet: true })]);
  if (!samples) return;
  const draw = () => $('usageBody').replaceChildren(usagePage(samples, { view: usageView, forecast, onView: (v) => { usageView = v; draw(); } }));
  draw();
}
function hideUsagePage() {
  document.querySelector('main').classList.remove('usage-mode');
  $('usageView').hidden = true;
  $('usageBtn').classList.remove('on');
}
$('usageBtn').onclick = () => ($('usageView').hidden ? showUsagePage() : hideUsagePage());
$('usageBack').onclick = hideUsagePage;

// ---------------------------------------------------------------- modal + file viewer

function openModal(title) {
  closeModal();
  const back = h('div', 'modal-back');
  back.id = 'modal';
  const m = h('div', 'modal');
  const head = h('div', 'modal-head');
  const x = h('button', null, '✕');
  x.onclick = closeModal;
  head.append(h('span', 'modal-title', title), x);
  const body = h('div', 'modal-body');
  m.append(head, body);
  back.append(m);
  back.onclick = (ev) => { if (ev.target === back) closeModal(); };
  document.body.append(back);
  return body;
}
function closeModal() {
  if (!$('modal')) return;
  $('modal').remove();
  $('input').focus();
}

// Paths Claude references: click copies the absolute path on the server (relative paths are taken
// from the session directory); ⌘/Ctrl/Shift-click opens it: text in the file viewer, images and
// videos in the Resources list.
function absPath(p) {
  const cwd = sessions[current]?.cwd || remoteHome || '/';
  let full = p;
  if (p === '~' || p.startsWith('~/')) full = (remoteHome || '~') + p.slice(1);
  else if (!p.startsWith('/')) full = `${cwd}/${p}`;
  const out = [];
  for (const seg of full.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return (full.startsWith('/') ? '/' : '') + out.join('/');
}

async function copyPathRef(el) {
  const abs = absPath(el.dataset.path);
  const text = abs + (el.dataset.line ? `:${el.dataset.line}` : '');
  try { await navigator.clipboard.writeText(text); } catch { return toast('Could not copy', el); }
  toast(`Copied ${text}`, el);
  const st = await call('stat', { sid: current, path: abs }, { quiet: true });
  if (st && !st.exists) toast(`Copied, but ${abs} does not exist on the server`, el);
}

async function openPathRef(el) {
  const st = await call('stat', { sid: current, path: absPath(el.dataset.path) });
  if (!st) return;
  if (!st.exists) return toast(`Not found on the server: ${st.path}`, el);
  if (st.dir) return toast(`${st.path} is a folder`, el);
  if (KIND(st.path)) resources.add(st.path, st.size);
  else viewFile(st.path);
}

const resources = createResources({ call, openModal: (t) => openModal(t), toast, listEl: $('reslist'), onAdd: () => showRailTab('resources') });

async function viewFile(p) {
  const s = sessions[current];
  const body = openModal(relPath(p, s?.cwd));
  body.append(meta('loading…'));
  const r = await call('readFile', { sid: current, path: p });
  if (!r) return closeModal();
  body.innerHTML = '';
  body.parentElement.querySelector('.modal-title').title = r.path;
  if (r.binary) return body.append(meta(`Binary file, ${fmtK(r.size)} bytes`));
  if (r.truncated) body.append(meta(`Showing the first 1 MB of ${fmtK(r.size)} bytes`, 'warn'));
  const html = r.text.length < 300000 ? highlight(r.text, langOf(r.path)) : esc(r.text);
  const n = r.text.split('\n').length;
  const wrap = h('div', 'fileview');
  const gutter = h('pre', 'gutter', Array.from({ length: n }, (_, i) => i + 1).join('\n'));
  const pre = h('pre', 'src');
  pre.innerHTML = `<code class="hljs">${html}</code>`;
  wrap.append(gutter, pre);
  body.append(wrap);
}

// On macOS, Control-click arrives as a context-menu click.
document.addEventListener('contextmenu', (ev) => {
  const ref = ev.target.closest('.path-ref, .file-link');
  if (ref?.dataset.path && ev.ctrlKey) { ev.preventDefault(); openPathRef(ref); }
});

document.addEventListener('click', async (ev) => {
  const ref = ev.target.closest('.path-ref, .file-link');
  if (ref?.dataset.path) {
    ev.preventDefault();
    return ev.metaKey || ev.ctrlKey || ev.shiftKey ? openPathRef(ref) : copyPathRef(ref);
  }
  const btn = ev.target.closest('.codeblock .copy');
  if (btn) {
    const code = btn.closest('.codeblock').querySelector('code').textContent;
    const label = btn.innerHTML;
    try { await navigator.clipboard.writeText(code); btn.textContent = 'Copied'; } catch { btn.textContent = 'Failed'; }
    setTimeout(() => (btn.innerHTML = label), 1200);
  }
});

// ---------------------------------------------------------------- slash commands handled here
// Commands the terminal shows as panels, or that the SDK can't run, open a dialog in the page.

const LOCAL_COMMANDS = {
  help: { desc: 'List commands and shortcuts', run: showHelp },
  usage: { desc: 'Plan limits and this session’s usage', run: showUsage },
  cost: { desc: 'Plan limits and this session’s usage', run: showUsage },
  context: { desc: 'What fills the context window', run: showContext },
  btw: { desc: 'Side question; doesn’t touch the conversation (no argument: list them)', hint: '<question>', run: askBtw },
  status: { desc: 'Session, account and MCP status', run: showStatus },
  mcp: { desc: 'MCP servers and their state', run: () => showStatus('mcp') },
  model: { desc: 'Pick the model for this session', run: showModelPicker, when: (args) => !args },
  resume: { desc: 'Reopen a past session of this folder', run: () => openHistory(sessions[current]?.cwd) },
  clear: { desc: 'Start a fresh session in the same directory', run: clearSession },
  branch: { desc: 'Branch this conversation into a new session (this one stays as it is)', hint: '[name]', run: (args) => branchSession(args || undefined) },
  rename: { desc: 'Rename this session', hint: '<title>', run: (args) => renameCurrent(args || undefined) },
  color: { desc: 'Colour of this session (page accent)', hint: '<red|orange|yellow|green|blue|purple|pink|cyan|default>', run: setColor },
  suggest: {
    desc: 'Grey next-prompt suggestions on or off', hint: 'on|off',
    run: async (args) => {
      const r = await call('setSuggest', { on: args.trim().toLowerCase() !== 'off' });
      if (r) showOutput('Suggestions', `Next-prompt suggestions are now **${r.suggest ? 'on' : 'off'}**. They come from a small model that sees only the last exchange.`);
    },
  },
};

function localCommand(text) {
  const m = /^\/([\w:.-]+)\s*([\s\S]*)$/.exec(text.trim());
  const c = m && LOCAL_COMMANDS[m[1]];
  if (!c || (c.when && !c.when(m[2].trim()))) return null;
  return () => c.run(m[2].trim());
}

async function showHelp() {
  const body = openModal('Commands and shortcuts');
  const cmds = await commandsFor(current);
  const table = (rows) => {
    const t = h('table', 'help');
    for (const [a, b] of rows) { const tr = h('tr'); tr.append(h('td', 'mono', a), h('td', null, b)); t.append(tr); }
    return t;
  };
  body.append(table([
    ...Object.entries(LOCAL_COMMANDS).map(([n, c]) => ['/' + n, c.desc]),
    ...cmds.filter((c) => !LOCAL_COMMANDS[c.name]).map((c) => ['/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : ''), c.description]),
  ]), h('h4', null, 'Keys'), table([['Enter', 'Send'], ['Shift+Enter', 'New line'], ['Esc', 'Interrupt / close a dialog'], ['Ctrl+C', 'Interrupt'], ['/', 'Commands'], ['@', 'Files'], ['Paste', 'Attach an image']]));
}

// A dialog that shows "loading…" until the command's data is in, then draw(data).
async function panelModal(title, type, draw) {
  const body = openModal(title);
  body.append(meta('loading…'));
  const data = await call(type, { sid: current });
  if (data) body.replaceChildren(draw(data)); else closeModal();
}
function showUsage() { return panelModal('Usage', 'usage', usagePanel); }
function showContext() { return panelModal('Context window', 'context', contextPanel); }

// /btw: side threads on a fork of the session. The answer streams into a floating card with a
// follow-up box; the conversation is untouched. Past threads are listed under the "btw" tab.
let btw = null; // open card: { bid, sid, messages, streaming, early, els }
// Closing only hides the window: the thread stays under the btw tab (and keeps answering on the server).
function closeBtw() {
  document.getElementById('btw')?.remove();
  btw = null;
}

function openBtwCard(thread) {
  document.getElementById('btw')?.remove();
  const card = h('div', 'btw');
  card.id = 'btw';
  const head = h('div', 'btw-head');
  const x = h('button', 'btw-close', '✕');
  x.title = 'Close (the thread stays under the btw tab)';
  x.onclick = closeBtw;
  const title = h('span', 'btw-q');
  head.append(h('span', 'btw-tag', 'BTW'), title, x);
  const body = h('div', 'btw-body');
  const follow = h('textarea', 'btw-input');
  follow.rows = 1;
  follow.placeholder = 'Follow up on the side…';
  follow.setAttribute('aria-label', 'Follow up');
  const send = h('button', 'primary btw-send');
  send.title = 'Send (Enter)';
  send.setAttribute('aria-label', 'Send');
  send.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>';
  const submit = () => {
    const text = follow.value.trim();
    if (text && btw && !btw.streaming) { follow.value = ''; btwSend(text); }
    follow.focus();
  };
  send.onclick = submit;
  follow.addEventListener('keydown', (ev) => {
    ev.stopPropagation(); // keep Esc/Enter away from the main composer shortcuts
    if (ev.key === 'Escape') { closeBtw(); return; }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); submit(); }
  });
  const pill = h('div', 'btw-pill');
  pill.append(follow, send);
  const foot = h('div', 'btw-foot');
  foot.append(pill);
  card.append(head, body, foot);
  document.body.append(card);
  btw = { bid: thread.bid || null, sid: current, messages: [...(thread.messages || [])], streaming: thread.busy ? '' : null, early: [], els: { title, body, follow } };
  drawBtw();
  follow.focus();
}

function drawBtw() {
  if (!btw) return;
  const { title, body, follow } = btw.els;
  title.textContent = `Side question · ${sessions[btw.sid]?.title || ''} · doesn't interrupt the session`;
  body.innerHTML = '';
  for (const m of btw.messages) {
    if (m.role === 'user') body.append(h('div', 'btw-user', m.text));
    else { const a = markdown(m.text); a.classList.add('btw-answer'); body.append(a); }
  }
  if (btw.streaming != null) {
    const a = btw.streaming ? markdown(btw.streaming) : meta('thinking…');
    a.classList.add('btw-answer', 'live');
    body.append(a);
  }
  if (btw.error) body.append(h('div', 'err', btw.error));
  follow.disabled = btw.streaming != null;
  body.scrollTop = body.scrollHeight;
}

async function btwSend(text) {
  btw.messages.push({ role: 'user', text });
  btw.streaming = '';
  btw.error = null;
  drawBtw();
  const mine = btw;
  const r = await call('btw', { sid: mine.sid, text, bid: mine.bid || undefined });
  if (!r) { mine.messages.pop(); mine.streaming = null; drawBtw(); return; }
  mine.bid = r.bid;
  for (const d of mine.early.filter((x) => x.bid === r.bid)) btwPartial(d);
  mine.early = [];
}

function askBtw(question) {
  if (!question) { showRailTab('btw'); return; }
  openBtwCard({});
  btwSend(question);
}

function btwPartial(d) {
  if (d.op === 'btw-done') refreshBtwList();
  if (!btw) return;
  if (!btw.bid) { btw.early.push(d); return; } // reply to our request not in yet
  if (d.bid !== btw.bid) return;
  if (d.op === 'btw') {
    btw.streaming = (btw.streaming || '') + d.text;
    if (!btw.raf) btw.raf = requestAnimationFrame(() => { btw && (btw.raf = 0, drawBtw()); });
    return;
  }
  if (d.error) btw.error = d.error;
  else btw.messages.push({ role: 'assistant', text: d.text });
  btw.streaming = null;
  drawBtw();
  btw.els.follow.focus();
}

// ---------------------------------------------------------------- btw list (right rail)

async function refreshBtwList() {
  const box = $('btwlist');
  if (!current) { box.replaceChildren(meta('Open a session first.')); return; }
  if (sessions[current]?.draft) { box.replaceChildren(h('div', 'side-empty', 'None yet. Side questions need a started session.')); return; }
  const threads = (await call('btwList', { sid: current }, { quiet: true })) || [];
  box.innerHTML = '';
  if (!threads.length) box.append(h('div', 'side-empty', 'None yet.'));
  for (const t of threads) {
    // Only an entry: the question, one line of the answer; the window holds the conversation.
    const row = h('div', 'btw-item' + (btw?.bid === t.bid ? ' active' : ''));
    const n = t.messages.filter((m) => m.role === 'user').length;
    const top = h('div', 'bi-top');
    top.append(h('span', 'btw-tag', 'BTW'), h('span', 't', t.messages[0]?.text || '(empty)'));
    const answer = t.messages.find((m) => m.role === 'assistant')?.text || '';
    row.append(top, h('div', 'bi-sum', answer.replace(/[#*`>_]/g, '').split('\n').find((l) => l.trim()) || (t.busy ? 'answering…' : '')),
      h('div', 'm', `${n} exchange${n > 1 ? 's' : ''} · ${ago(t.created)}${t.busy ? ' · answering…' : ''}`));
    row.onclick = () => openBtwCard(t);
    box.append(row);
  }
  box.append(h('div', 'side-hint', 'Start one with /btw in the message box.'));
}

async function showStatus(only) {
  const body = openModal(only === 'mcp' ? 'MCP servers' : 'Status');
  body.append(meta('loading…'));
  const st = await call('status', { sid: current });
  body.innerHTML = '';
  if (!st) return;
  if (only !== 'mcp') {
    const t = h('table', 'help');
    const acct = st.account || {};
    const rows = [
      ['Host', st.host], ['Directory', st.cwd], ['Model', st.model], ['Permission mode', MODES.find((m) => m[0] === st.mode)?.[1] || st.mode],
      ['Session', st.claudeSessionId], ['State', st.state],
      ['Account', [acct.email, acct.organization, acct.subscriptionType].filter(Boolean).join(' · ')],
    ];
    for (const [a, b] of rows) if (b) { const tr = h('tr'); tr.append(h('td', null, a), h('td', 'mono', String(b))); t.append(tr); }
    body.append(t);
  }
  const mcp = st.mcp || [];
  if (only !== 'mcp') body.append(h('h4', null, 'MCP servers'));
  if (!mcp.length) body.append(meta('none'));
  const t2 = h('table', 'help');
  for (const s of mcp) {
    const tr = h('tr');
    tr.append(h('td', 'mono', s.name), h('td', 'mcp-' + s.status, s.status), h('td', 'muted', s.error || s.serverInfo?.name || ''));
    t2.append(tr);
  }
  body.append(t2);
}

async function showModelPicker() {
  if (!modelList.length) await loadModels();
  const body = openModal('Model');
  const s = sessions[current];
  body.append(meta(`current: ${shortModel(s?.stats?.model || s?.model) || 'default'}`));
  for (const m of modelList) {
    const row = h('div', 'hrow');
    row.append(h('div', 't', m.displayName || m.value), h('div', 'm', m.description || m.value));
    row.onclick = async () => { closeModal(); $('model').value = m.value; $('model').dispatchEvent(new Event('change')); };
    body.append(row);
  }
}

// The ⋯ menu of a turn. Branch copies the conversation up to the end of this turn (so it needs the
// turn to have an answer); Rewind goes back to just before its message.
function turnMenu(e, turn, x, y) {
  contextMenu([
    { label: 'Branch from here', run: turn.lastUuid && (() => branchSession(undefined, turn.lastUuid)),
      title: turn.lastUuid ? 'New session with the conversation up to the end of this turn; this one stays as it is' : 'Available once this turn has an answer' },
    { label: 'Rewind to here', run: () => rewindTo(e), title: 'Back to just before this message: undo Claude\'s file changes since, drop this and later turns (asks first)' },
  ], x, y, { alignRight: true });
}

// Rewind (the terminal's Esc Esc): back to just before the message `e`. Asks first, saying which
// files would be restored; the message goes back into the input, as in the terminal.
async function rewindTo(e) {
  const sid = current, s = sessions[sid];
  if (!alive(s)) return alert('Reattach this session first (send a message or click Reattach), then rewind.');
  const at = { sid, uuid: e.uuid };
  const dry = await call('rewind', { ...at, dryRun: true });
  if (!dry) return;
  const n = dry.filesChanged?.length || 0;
  const files = n ? `\n\nFiles restored to how they were then (${n}${dry.insertions != null ? `, +${dry.insertions} −${dry.deletions}` : ''}):\n${dry.filesChanged.slice(0, 12).map((f) => '  ' + relPath(f, s.cwd)).join('\n')}${n > 12 ? `\n  … and ${n - 12} more` : ''}`
    : dry.canRewind === false && dry.error ? `\n\nFiles can't be restored: ${dry.error}` : '\n\nNo file changes to undo.';
  if (!confirm(`Rewind to before this message?\n\nThis message and everything after it leave the conversation (the message goes back into the input).${files}\n\nChanges made outside Claude's Edit/Write tools (e.g. by Bash) are not undone.`)) return;
  const r = await call('rewind', at);
  if (!r) return;
  if (current === sid && !input.value.trim()) { input.value = r.text || ''; fitInput(); updateGhost(); }
  toast(r.files.length ? `Rewound · ${r.files.length} file${r.files.length > 1 ? 's' : ''} restored` : 'Rewound', $('input'));
}

// A new session that starts as a copy of this conversation: all of it, or up to the assistant
// message `at` (a turn's "Branch from here"). The new session opens; the original is untouched.
async function branchSession(title, at) {
  const s = sessions[current];
  if (!s || s.draft) return;
  wantNonce = nonce();
  const r = await call('branch', { sid: current, claudeSessionId: s.claudeSessionId, cwd: s.cwd, title, at, nonce: wantNonce });
  if (!r) wantNonce = null;
}

// A fresh draft in the same folder, with the same mode and model.
function clearSession() {
  const s = sessions[current];
  if (s) newDraft(s.cwd, s);
}

// ---------------------------------------------------------------- composer: send, images, / and @ completion

const input = $('input');
let attachments = []; // { media_type, data (base64), url }

// ---- input history (↑/↓, like the terminal) and inline suggestions (→ to accept)

const HISTORY_KEY = 'iro-input-history';
let history = [];
try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch {}
let histIndex = null; // position while browsing with ↑/↓; null = editing a fresh draft
let histDraft = '';

function remember(text) {
  text = text.trim();
  if (!text) return;
  history = history.filter((h0) => h0 !== text);
  history.push(text);
  if (history.length > 500) history = history.slice(-500);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
  histIndex = null;
}

function setInput(v) {
  input.value = v;
  input.setSelectionRange(v.length, v.length);
  updateGhost();
  fitInput();
}

// Grey text after the caret: Claude's predicted next prompt when the box is empty,
// otherwise the most recent history entry that starts with what you typed.
let ghostText = '';
function updateGhost() {
  const v = input.value;
  ghostText = '';
  if (!input.disabled && popup.hidden && input.selectionStart === v.length && !v.includes('\n')) {
    if (!v) ghostText = sessions[current]?.suggestion || '';
    else {
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].length > v.length && history[i].startsWith(v) && !history[i].includes('\n')) { ghostText = history[i].slice(v.length); break; }
      }
    }
  }
  const g = $('ghost');
  g.replaceChildren(document.createTextNode(v), h('span', 'g', ghostText));
  g.scrollTop = input.scrollTop;
  input.placeholder = !v && ghostText ? '' : input.dataset.placeholder;
}
input.dataset.placeholder = input.placeholder;
input.addEventListener('scroll', () => { $('ghost').scrollTop = input.scrollTop; });
input.addEventListener('keyup', (ev) => { if (ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End') updateGhost(); });
input.addEventListener('click', updateGhost);

function acceptGhost() {
  if (!ghostText) return false;
  setInput(input.value + ghostText);
  updateCompletion();
  return true;
}

function historyKey(ev) {
  const v = input.value, caret = input.selectionStart;
  if (ev.key === 'ArrowUp' && !v.slice(0, caret).includes('\n')) {
    if (!history.length || histIndex === 0) return false;
    if (histIndex == null) { histDraft = v; histIndex = history.length; }
    histIndex--;
    setInput(history[histIndex]);
    return true;
  }
  if (ev.key === 'ArrowDown' && histIndex != null && !v.slice(caret).includes('\n')) {
    histIndex++;
    if (histIndex >= history.length) { histIndex = null; setInput(histDraft); }
    else setInput(history[histIndex]);
    return true;
  }
  return false;
}

let sending = false; // a send waiting for the server: Enter again must not send it twice
async function send() {
  const text = input.value;
  if (sending || (!text.trim() && !attachments.length) || !current) return;
  remember(text);
  const local = !attachments.length && localCommand(text);
  if (local) { input.value = ''; hidePopup(); updateGhost(); return local(); }
  const images = attachments.map(({ media_type, data }) => ({ media_type, data }));
  const body = text.trim() ? text : 'See the attached image.';
  const s = sessions[current];
  let ok;
  sending = true;
  try {
    if (s.draft) {
      // The first message is what creates the session.
      wantNonce = nonce();
      wantDraft = current;
      if (isCommand(text)) pendingCommand = { sid: null, text: text.trim() };
      ok = await call('new', { cwd: s.cwd, text: body, images, nonce: wantNonce, mode: s.modeSet ? s.mode : undefined, // else settings.json decides
        model: s.modelChoice || undefined, effort: s.effortSet ? s.effort : undefined });
      if (ok === undefined) { wantNonce = null; wantDraft = null; }
    } else {
      let sid = current;
      if (!alive(s)) {
        // Detached: reattach first, then send to the reattached session.
        const r = s.claudeSessionId && await reopen(s);
        if (!r) return;
        sid = r.sid;
      }
      if (isCommand(text)) pendingCommand = { sid, text: text.trim() };
      ok = await call('send', { sid, text: body, images });
    }
  } finally { sending = false; }
  if (ok !== undefined) { input.value = ''; attachments = []; renderAttachments(); hidePopup(); updateGhost(); inputExpanded = false; fitInput(); }
}
$('send').onclick = send;
$('stop').onclick = () => call('interrupt', { sid: current });

function addImageFile(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
  if (file.size > 5 * 1024 * 1024) return alert(`${file.name || 'image'} is larger than 5 MB`);
  if (attachments.length >= 5) return alert('At most 5 images per message');
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result;
    attachments.push({ media_type: file.type, data: url.slice(url.indexOf(',') + 1), url });
    renderAttachments();
  };
  reader.readAsDataURL(file);
}
function renderAttachments() {
  const row = $('attach');
  row.innerHTML = '';
  attachments.forEach((a, i) => {
    const t = h('div', 'thumb');
    const img = h('img');
    img.src = a.url;
    const x = h('button', null, '✕');
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    t.append(img, x);
    row.append(t);
  });
  row.hidden = !attachments.length;
}
input.addEventListener('paste', (ev) => {
  const files = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { ev.preventDefault(); files.forEach(addImageFile); }
});
$('composer').addEventListener('dragover', (ev) => ev.preventDefault());
$('composer').addEventListener('drop', (ev) => {
  ev.preventDefault();
  [...(ev.dataTransfer?.files || [])].forEach(addImageFile);
});

// Completion popup for /commands and @files
const popup = $('popup');
let pop = null; // { items, index, start, end }
let completeTimer = 0;

function hidePopup() { popup.hidden = true; pop = null; updateGhost(); }

function showPopup(items, start, end) {
  if (!items.length) return hidePopup();
  pop = { items, index: 0, start, end };
  drawPopup();
}
function drawPopup() {
  popup.innerHTML = '';
  pop.items.forEach((it, i) => {
    const row = h('div', 'pop-item' + (i === pop.index ? ' sel' : ''));
    row.append(h('span', 'pop-main', it.label));
    if (it.desc) row.append(h('span', 'pop-desc', it.desc));
    row.onmousedown = (ev) => { ev.preventDefault(); pop.index = i; acceptPopup(); };
    popup.append(row);
  });
  popup.hidden = false;
  popup.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  $('ghost').replaceChildren(document.createTextNode(input.value));
  ghostText = '';
}
function acceptPopup() {
  const it = pop.items[pop.index];
  const v = input.value;
  input.value = v.slice(0, pop.start) + it.insert + v.slice(pop.end);
  const caret = pop.start + it.insert.length;
  input.setSelectionRange(caret, caret);
  hidePopup();
  input.focus();
  if (it.again) updateCompletion(); // descended into a directory
}

async function commandsFor(sid) {
  const s = sessions[sid];
  if (!s) return [];
  if (s.draft) { // not running yet: borrow the list from a running session
    const other = Object.keys(sessions).find((k) => alive(sessions[k]));
    return other ? commandsFor(other) : [];
  }
  if (!s.commands) s.commands = (await call('commands', { sid }, { quiet: true })) || null;
  return s.commands || [];
}

let dismissed = null; // input text when the popup was closed with Esc; stays closed until it changes

async function updateCompletion() {
  if (!current) return hidePopup();
  const caret = input.selectionStart;
  const before = input.value.slice(0, caret);
  const stale = () => input.value.slice(0, input.selectionStart) !== before || input.value === dismissed; // typed on meanwhile
  if (input.value === dismissed) return hidePopup();
  dismissed = null;
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) {
    const q = slash[1].toLowerCase();
    const local = Object.entries(LOCAL_COMMANDS).map(([name, c]) => ({ name, description: c.desc, argumentHint: c.hint || '' }));
    const remote = (await commandsFor(current)).filter((c) => !LOCAL_COMMANDS[c.name]);
    const exact = (c) => c.name.toLowerCase() === q || !!c.aliases?.some((a) => a.toLowerCase() === q);
    const cmds = [...local, ...remote]
      .filter((c) => c.name.toLowerCase().startsWith(q) || c.aliases?.some((a) => a.toLowerCase().startsWith(q)))
      .sort((a, b) => exact(b) - exact(a)) // "/usage" must not pick "/usage-credits"
      .slice(0, 50)
      .map((c) => ({ label: '/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : ''), desc: c.description, insert: '/' + c.name + ' ', run: !c.argumentHint }));
    if (!stale()) showPopup(cmds, 0, caret);
    return;
  }
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) {
    const q = at[2];
    const start = caret - q.length - 1;
    clearTimeout(completeTimer);
    completeTimer = setTimeout(async () => {
      const paths = await call('complete', { sid: current, cwd: sessions[current]?.cwd, query: q }, { quiet: true });
      if (!paths || stale()) return;
      showPopup(paths.map((p) => ({ label: p, insert: '@' + p + (p.endsWith('/') ? '' : ' '), again: p.endsWith('/') })), start, caret);
    }, 120);
    return;
  }
  hidePopup();
}

input.addEventListener('input', () => {
  histIndex = null;
  if (!input.value) inputExpanded = false; // cleared: back to the small box
  updateCompletion(); updateGhost(); fitInput();
});

// The pill grows with its text up to about eight lines, then scrolls inside; the corner button
// (shown once the text wraps) opens a half-screen editor. No drag handle.
let inputExpanded = false;
function fitInput() {
  const line = parseFloat(getComputedStyle(input).lineHeight) || 21;
  const max = inputExpanded ? Math.round(window.innerHeight * 0.5) : Math.min(Math.round(line * 8 + 14), Math.round(window.innerHeight * 0.3));
  const min = Math.round(line + 14);
  input.style.transition = 'none';
  input.style.height = '0px'; // measure the text alone ('auto' can keep the previous height)
  const need = Math.max(min, input.scrollHeight + 2);
  requestAnimationFrame(() => { input.style.transition = ''; });
  input.style.height = `${inputExpanded ? max : Math.min(need, max)}px`;
  input.style.overflowY = need > max ? 'auto' : 'hidden';
  const btn = $('expandInput');
  btn.classList.toggle('expanded', inputExpanded);
  btn.classList.toggle('show', inputExpanded || need > min + 4); // only once the text wraps
  $('composer').classList.toggle('tall', inputExpanded || need > min + 4); // the pill becomes a rounded box
  btn.title = inputExpanded ? 'Shrink the input' : 'Expand the input (half screen)';
}
$('expandInput').onclick = () => { inputExpanded = !inputExpanded; fitInput(); input.focus(); };
window.addEventListener('resize', fitInput);
requestAnimationFrame(fitInput);

// The right rail can be dragged wider or narrower by its left edge; the width is remembered.
(() => {
  const rail = $('rail'), grip = $('railResize');
  const set = (w) => { rail.style.width = `${Math.min(Math.max(w, 170), Math.min(640, window.innerWidth * 0.5))}px`; };
  try { const w = Number(localStorage.getItem('iro-rail-width')); if (w) set(w); } catch {}
  grip.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    const startX = ev.clientX, startW = rail.offsetWidth;
    document.body.classList.add('resizing');
    const move = (e) => set(startW + (startX - e.clientX));
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      try { localStorage.setItem('iro-rail-width', String(rail.offsetWidth)); } catch {}
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  grip.addEventListener('dblclick', () => { rail.style.width = ''; try { localStorage.removeItem('iro-rail-width'); } catch {} });
})();
input.addEventListener('blur', () => setTimeout(hidePopup, 150));
input.addEventListener('keydown', (ev) => {
  if (pop && !popup.hidden) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); pop.index = (pop.index + 1) % pop.items.length; return drawPopup(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); pop.index = (pop.index + pop.items.length - 1) % pop.items.length; return drawPopup(); }
    if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.isComposing) {
      ev.preventDefault();
      // Like the terminal: Enter on a command that takes no arguments runs it; Tab only completes.
      const it = pop.items[pop.index];
      acceptPopup();
      if (ev.key === 'Enter' && it.run) send();
      return;
    }
    if (ev.key === 'Escape') { ev.preventDefault(); dismissed = input.value; return hidePopup(); }
  } else if (ev.key === 'Escape' && /^\/\S*$|(^|\s)@\S*$/.test(input.value)) {
    dismissed = input.value; // popup may still be on its way
    ev.preventDefault(); // …so this Esc is about the popup, not an interrupt
  }
  if (ev.isComposing || ev.keyCode === 229) return;
  if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.shiftKey && !ev.altKey && !ev.metaKey && historyKey(ev)) { ev.preventDefault(); return; }
  if ((ev.key === 'ArrowRight' || ev.key === 'Tab') && !ev.shiftKey && input.selectionStart === input.value.length && ghostText) {
    ev.preventDefault();
    acceptGhost();
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
});

// Esc outside the popup: close a dialog, otherwise interrupt the running turn (like the terminal).
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || ev.defaultPrevented) return;
  if ($('modal')) return closeModal();
  const s = sessions[current];
  if (s && (s.state === 'running' || s.state === 'waiting')) call('interrupt', { sid: current });
});
// Ctrl+C also stops the running turn (the terminal's other interrupt key). Only the Ctrl key: ⌘C still
// copies on a Mac, and elsewhere a Ctrl+C with text selected is left to copy it.
document.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() !== 'c' || !ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey || ev.defaultPrevented) return;
  const f = document.activeElement;
  const picked = String(window.getSelection() || '') || (f && 'selectionStart' in f && f.selectionStart !== f.selectionEnd);
  if (picked && !/Mac/.test(navigator.platform)) return;
  if ($('stop').disabled) return;
  ev.preventDefault();
  $('stop').click();
});
