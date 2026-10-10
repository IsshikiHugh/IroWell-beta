import { h, esc, fmtK, markdown, toolCard, highlight, langOf, relPath } from './render.js';
import { usagePanel, contextPanel } from './panels.js';
import { enhanceSelect } from './dropdown.js';
import { createResources } from './resources.js';
import { usagePage } from './usage.js';
import { openSettings } from './settings.js';
import { portsButton } from './ports.js';
import { createSkillsPage } from './skills.js';
import { openPicker, closePicker, pickerOpen } from './picker.js';
import { createShell, isShellToggle } from './shell.js';
import { showLayer, hideLayer, isLayer } from './layer.js';
import { ask, tell } from './dialog.js';
import { initDiagrams } from './diagram.js';
import { ACTIONS, SCOPES, keyOf, isDefault, setKey, resetKey, resetAll, onKeysChange, comboOf, matches, actionFor, problem, keyLabel, label } from './keys.js';

// The local client's token: a restarted client has a new one, which the page takes from it (newToken).
let TOKEN = document.querySelector('meta[name="token"]').content;
const $ = (id) => document.getElementById(id);

let sessions = {};            // sid -> { cwd, title, state, model, mode, claudeSessionId, events: [] }
const alive = (s) => !!s && !s.draft && !s.closed && s.state !== 'ended'; // started, and not detached
const inTurn = (s) => s.state === 'running' || s.state === 'waiting'; // a turn is going on (or waits for you)
// The Tasks list's names for the kinds of background task.
const TASK_KIND = { local_bash: 'shell', local_agent: 'subagent', monitor: 'monitor', workflow: 'workflow' };
const nonce = () => Math.random().toString(36).slice(2);
let syncedAt = 0; // when the event log last started replaying (connect, reconnect)
let lastSeq = 0, current = null, connected = false, wantNonce = null, wantFrom = null, restoreSid = null, restoreClaude = null;
const INPUT_PLACEHOLDER = document.getElementById('input').placeholder;
let wantDraft = null;         // the draft being turned into a real session by its first message
let folders = null;           // the sidebar's directories, registered on the server (null until loaded)
let remoteHome = null;        // $HOME on the server, for ~/ paths
let pendingCommand = null;    // { sid, text } of a slash command sent from this tab: its output pops up
// What is typed into each session's input (text and images) while another session is open; every
// session has its own. Keyed by the Claude session id once there is one, so it survives a reattach
// or a daemon restart (both give the session a new sid).
const buffers = {};           // key -> { text, attachments }
const bufKey = (sid) => sessions[sid]?.claudeSessionId || sid;

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

// The token of the client that serves the page now; true when it differs from ours (a restarted client).
let tokenAsk = null;
function newToken() {
  tokenAsk ||= fetch('/', { cache: 'no-store' }).then((r) => r.text()).then((html) => {
    const t = /name="token" content="([0-9a-f]+)"/.exec(html)?.[1];
    if (!t || t === TOKEN) return false;
    TOKEN = t;
    return true;
  }, () => false).finally(() => { tokenAsk = null; });
  return tokenAsk;
}
// Every command is a request: { data } or { error }.
async function post(type, body = {}, retried = false) {
  let r;
  try {
    r = await fetch('/cmd', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-token': TOKEN, ...(serverId && { 'x-target': serverId }) }, body: JSON.stringify({ type, ...body }),
    });
  } catch {
    return { error: 'Lost contact with the local client (client.mjs). Is it still running?' };
  }
  // The client was restarted since this page loaded: take its new token, pick up its stream, send again.
  if (r.status === 403 && !retried && await newToken()) { openStream(); return post(type, body, true); }
  if (!r.ok) return { error: r.status === 503 ? 'Not connected to the server right now.' : r.status === 413 ? 'Too large (images?)' : 'Command failed: ' + r.status };
  return r.json();
}
// Its data, or undefined after showing the error (`quiet`: no alert, and nothing sent while disconnected).
async function call(type, body = {}, { quiet = false } = {}) {
  if (quiet && !connected) return undefined; // background refreshes wait for the connection
  const out = await post(type, body);
  if (out.error != null) {
    if (!quiet) tell(out.error);
    return undefined;
  }
  return out.data ?? null;
}

// The open session's shells (the panel under the header); a draft has none until it starts.
const shell = createShell({
  post,
  session: () => { const s = sessions[current]; return s && !s.draft ? { sid: current, cwd: s.cwd } : null; },
  onHide: () => $('input').focus(),
});
const inShell = (ev) => !!ev.target?.closest?.('#shell'); // the terminal has the keys

// ---------------------------------------------------------------- event stream

// Each tab shows one server, named in its URL (?server=local or ?server=ssh:<host>), so tabs can show
// different servers at once. A tab opened without one starts on the server picked last.
let serverId = new URLSearchParams(location.search).get('server') || '';
// The UI Skills page (Settings → UI skills): the system prompt and skills that tell Claude about this UI.
const skillsPage = createSkillsPage({ call, post, openModal, ask, serverId: () => serverId });
let serverName = '';     // "local", or the remote host's name, for the tab's title
let es = null;
let pageLoad = true; // until the first transport status: this page was just (re)loaded
function openStream() {
  es?.close();
  const me = es = new EventSource('/events?t=' + TOKEN + (serverId ? '&target=' + encodeURIComponent(serverId) : ''));
  // Closed for good: the client was restarted (a new token). The page carries on with it, typed text
  // and the open session kept; until it answers, it asks again every 2 s.
  me.onerror = async () => {
    if (me.readyState !== EventSource.CLOSED || me !== es) return;
    setConn(false, 'local client restarted: reconnecting…');
    while (me === es) {
      if (await newToken()) return openStream();
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  me.onmessage = (m) => { if (me === es) onStream(JSON.parse(m.data)); };
}
function showServer() {
  const u = new URL(location.href);
  if (serverId) u.searchParams.set('server', serverId); else u.searchParams.delete('server');
  window.history.replaceState(window.history.state, '', u); // (window.: `history` here is the input history)
}
// The picker connected this tab to `id`: nothing of the previous server carries over.
function switchServer(id) {
  if (id === serverId) return;
  serverId = id;
  showServer();
  forgetServer();
  openStream();
}
const pickServer = (required = false) => openPicker({ post, required, onPick: switchServer });

function onStream(d) {
  if (d.type === 'reset') {
    // History follows as separate messages; reselect the open session when it reappears.
    // Drafts live only in this page, so they survive a reconnect.
    // (a stand-in the server already has a session for is replayed as that session)
    const keep = sessions[current]?.draft && !sessions[current].pending?.sid ? current : null;
    restoreSid = keep ? null : sessions[current]?.pending?.sid || current;
    restoreClaude = keep ? null : sessions[current]?.claudeSessionId; // a restarted daemon lists it under a new sid
    sessions = Object.fromEntries(Object.entries(sessions).filter(([, s]) => s.draft && !s.pending?.sid));
    lastSeq = 0; current = keep; syncedAt = Date.now();
    renderList(); renderFeed(); shell.reset();
    // Nothing open to come back to (a fresh page, a client restart): the plan usage page, not whichever
    // session the history happens to list first.
    if (!keep && !restoreSid && !restoreClaude && $('usageView').hidden) showUsagePage({ quiet: true });
  } else if (d.type === 'transport') {
    if (d.target && d.target !== serverId) { serverId = d.target; showServer(); } // (the server picked last)
    // Reloading the page while Reconnect shows is the same as clicking it (a failure shows under the status).
    if (pageLoad) { pageLoad = false; if (d.ready) post('deploy'); }
    if (d.home && d.home !== remoteHome) { remoteHome = d.home; renderList(); }
    // Your initial on your messages (the first letter of the host's user name; "Y" for "you" without one).
    const initial = [...(d.user || '').trim()][0]?.toUpperCase() || 'Y';
    document.documentElement.style.setProperty('--me', JSON.stringify(initial));
    serverName = d.target ? d.host : ''; // "local" for this machine, not its host name
    updateTabTitle();
    const doing = d.deploy === 'install' ? `installing IroWell on ${d.host}…` : `updating ${d.host}…`;
    setConn(d.up, !d.target ? 'no server picked' : d.deploying ? doing : d.up ? d.host : d.stopped ? `server stopped on ${d.host}` : d.deploy === 'install' ? `IroWell is not on ${d.host} yet` : `reconnecting to ${d.host}…`, d.error, d);
    // No server yet: the picker, which can't be dismissed until one is picked.
    if (!d.target && !pickerOpen()?.dataset.required) pickServer(true);
    else if (d.target && pickerOpen()?.dataset.required) closePicker();
    if (d.up) { setTimeout(loadOverview, 500); loadFolders(); loadLimits(); loadSettings(); }
  } else if (d.type === 'event' && d.seq > lastSeq) {
    lastSeq = d.seq;
    apply(d);
  } else if (d.type === 'partial') {
    if (d.op === 'act' || d.op === 'tick' || d.op === 'tasks') onActivity(d);
    else if (d.op === 'folders') { folders = d.folders; renderList(); }
    else if (d.op === 'limits') gotLimits(d.limits);
    else if (d.op === 'settings') gotSettings(d.settings);
    else if (d.op === 'btw' || d.op === 'btw-done') btwPartial(d);
    else if (d.op === 'login') loginEnded(d);
    else if (d.op === 'shell' || d.op === 'shells') shell.onPartial(d);
    else if (d.op === 'start' || d.op === 'delta') { keepStream(d); if (view && d.sid === view.sid) livePartial(d); }
  } else if (d.type === 'error') {
    tell(d.text);
  }
}
showServer();
openStream();

// The browser tab: "IroWell at <server>", with a bell in front while any session waits on you
// (a question or an approval), so a tab in the background shows it.
function updateTabTitle() {
  const asking = Object.values(sessions).some((s) => s.state === 'waiting' && !s.closed);
  const t = (asking ? '\u{1F514} ' : '') + 'IroWell' + (serverName ? ' at ' + serverName : '');
  if (document.title !== t) document.title = t;
}

function setConn(up, text, error, t = {}) {
  const was = connected;
  connected = up;
  if (up && !was && current && sessions[current]?.dormant) loadTranscript(current); // asked for before the connection was up
  if (up && !was && !$('usageView').hidden && !redrawUsagePage) showUsagePage({ quiet: true }); // (opened before it was)
  const c = $('conn');
  c.innerHTML = '';
  // One line under the name: the dot and the server (cut short when it does not fit), then the buttons.
  // The server is itself the button that picks another one (the look of Model and Effort in the status line).
  const line = h('div', 'conn-line');
  const label = h('span', 'conn-text', text);
  const server = h(t.target ? 'button' : 'span', t.target ? 'dd-btn conn-server' : 'conn-server');
  server.append(h('span', 'dot ' + (up ? 'up' : 'down')), label);
  if (t.target) {
    server.id = 'switchServer';
    server.type = 'button';
    server.title = `${text}\nConnect to another server (this machine, or a host from ~/.ssh/config)`;
    server.onclick = () => pickServer();
  } else label.title = text;
  line.append(server);
  c.append(line);
  // A server reached over ssh: its ports at localhost on this computer (ui/ports.js).
  const ports = portsButton(t, { openModal, closeModal, post, onClose: (fn) => { onModalClose = fn; } });
  if (ports) line.append(ports);
  if (up && !t.deploying) {
    const b = h('button', 'conn-icon conn-stop', '⏻');
    b.id = 'stopServer';
    b.title = 'Stop the server (closes every session; they reattach when you send to them)';
    b.setAttribute('aria-label', 'Stop the server');
    b.onclick = stopServer;
    line.append(b);
  }
  if (t.stopped) {
    const b = h('button', 'conn-update', 'Start server');
    b.id = 'startServer';
    b.onclick = () => call('start');
    c.append(b);
  }
  // Install (a host without IroWell; the client tries once by itself), or Reconnect: an update (newer
  // code in this client, or a newer Claude Code) is installed by the client on its own, and this one
  // click (or reloading the page) switches to it.
  // The switch under way: its steps as a bar (done, the one it is at, to come) and what that step is.
  if (t.deploying && t.progress) {
    const p = h('div', 'uc-meter conn-progress');
    p.id = 'updateProgress';
    const top = h('div', 'uc-top');
    top.append(h('span', null, t.progress.text + '…'), h('span', 'uc-pct', `${t.progress.at}/${t.progress.of}`));
    const bar = h('div', 'conn-steps');
    for (let i = 1; i <= t.progress.of; i++) {
      const seg = h('span', 'uc-bar');
      if (i <= t.progress.at) seg.append(h('span', 'uc-fill' + (i === t.progress.at ? ' now' : '')));
      bar.append(seg);
    }
    p.append(top, bar);
    c.append(p);
  } else if (t.canDeploy || t.ready || t.deploying) {
    const install = t.deploy === 'install';
    const b = h('button', 'conn-update', t.deploying ? (install ? 'Installing…' : 'Reconnecting…') : install ? 'Install server' : 'Reconnect to update');
    b.id = 'updateServer';
    b.disabled = !!t.deploying;
    b.title = install ? 'Install IroWell (this client’s server code and the newest Claude Code) on the host'
      : `${t.stale || 'A new version is ready.'} Running sessions move over as they go idle.`;
    b.onclick = () => call('deploy');
    c.append(b);
  }
  if (error && !t.deploying) c.append(h('div', 'conn-err', error));
  // Claude Code isn't logged in on the server: every turn would end at once with "Not logged in".
  // Log in logs it in from here; the command (the server's own Claude Code) does it in a terminal there.
  // This notice goes once the daemon sees the login.
  loginNeeded = !!t.login;
  if (t.login) {
    const box = h('div', 'conn-login');
    box.id = 'loginNotice';
    const cmd = h('code', null, t.login);
    cmd.title = 'Click to copy';
    cmd.onclick = async () => { try { await navigator.clipboard.writeText(t.login); toast('Copied', cmd); } catch { toast('Could not copy', cmd); } };
    const btn = h('button', 'primary', 'Log in');
    btn.id = 'loginBtn';
    btn.onclick = () => showLogin();
    box.append(h('b', null, 'Claude is not logged in'), h('span', null, ` on ${t.host === 'local' ? 'this machine' : t.host}.`), btn,
      h('span', 'muted', 'Or run this there in a terminal; this notice goes away by itself:'), cmd);
    c.append(box);
  }
  renderControls();
}
async function stopServer() {
  const running = Object.values(sessions).filter(alive).length;
  if (!await ask(`Stop the server?${running ? ` Its ${running} running session${running > 1 ? 's are' : ' is'} closed (a turn in progress is cut off); each stays listed and reattaches when you send to it.` : ''} Start it again from here, or by starting the client.`)) return;
  await call('shutdown');
}
// Another server was picked: its sessions, folders, models and limits replace this one's.
function forgetServer() {
  closeBtw();
  hideUsagePage();
  skillsPage.hide();
  closeFloating(false); closeModal(); hidePopup();
  resources.reset();
  attachments = []; renderAttachments(); pendingCommand = null;
  for (const k of Object.keys(buffers)) delete buffers[k];
  sessions = {};
  current = null; restoreSid = null; restoreClaude = null; wantNonce = null; wantDraft = null;
  lastSeq = 0; folders = null; remoteHome = null;
  modelList = []; defaultModel = ''; modelsLoaded = false; $('model').length = 1; appSettings = null;
  lastLimits = null; lastLimitsAt = 0;
  input.value = ''; fitInput();
  renderList(); renderFeed(); shell.reset();
}

function apply(e) {
  if (e.kind === 'created') {
    sessions[e.sid] = { cwd: e.cwd, title: e.title, state: 'idle', model: e.model, mode: e.mode, effort: e.effort, claudeSessionId: e.claudeSessionId, events: [],
      dormant: !!e.dormant, lastActive: e.lastActive || e.ts, color: e.color };
    if (wantNonce && e.nonce === wantNonce) {
      wantNonce = null;
      // A session shown before the server had it (a new one, a branch) becomes this one once its first
      // message or copied conversation is in too (openPending): no half-drawn page in between.
      if (sessions[wantDraft]?.pending) sessions[wantDraft].pending.sid = e.sid;
      // It opens only if you are still where you asked for it: a session you moved to meanwhile (a
      // new draft with text in it, say) keeps the page and the input.
      else if (current === wantFrom) current = e.sid;
      wantDraft = null;
    } else if (restoreClaude && e.claudeSessionId === restoreClaude) { current = e.sid; restoreClaude = null; }
    else if (e.sid === restoreSid) current = e.sid;
  }
  if (e.kind === 'archived') { // every copy of the row goes, live or detached
    for (const [k, x] of Object.entries(sessions)) {
      if (k !== e.sid && !(e.claudeSessionId && x.claudeSessionId === e.claudeSessionId)) continue;
      delete buffers[bufKey(k)];
      delete sessions[k];
      if (current === k) current = null;
    }
    if (!current) renderFeed();
    schedule();
    return;
  }
  const s = sessions[e.sid];
  if (!s) return;
  if (s.streams) dropStreams(s, e);
  if (e.kind === 'state') s.state = e.state;
  if (e.kind === 'suggest') { s.suggestion = e.text; if (e.sid === current) updateGhost(); return; }
  if (e.kind === 'stats') { const { type, seq, sid: _, ts, kind, ...st } = e; s.stats = st; s.statsAt = ts; if (e.sid === current) renderControls(); return; }
  if (e.kind === 'queue') { s.queue = e.items; if (e.sid === current) renderQueue(); return; }
  if (e.kind === 'user_text') { s.suggestion = null; s.lastActive = e.ts; }
  if (e.kind === 'msg' && e.msg.type === 'result') s.lastActive = e.ts;
  if (e.kind === 'init') {
    if (buffers[e.sid] && e.claudeSessionId) { buffers[e.claudeSessionId] = buffers[e.sid]; delete buffers[e.sid]; } // now keyed by it
    s.claudeSessionId = e.claudeSessionId; s.model = e.model; if (e.mode) s.mode = e.mode; }
  if (e.kind === 'meta') {
    if ('title' in e) s.title = e.title;
    if ('mode' in e) s.mode = e.mode;
    if ('model' in e) s.modelChoice = e.model;
    if ('color' in e) s.color = e.color;
  }
  if (e.kind === 'closed') s.closed = true;
  // A reattached or branched session first gets its earlier conversation, up to the divider: not new messages
  if (e.kind === 'created') s.pastLoading = !!e.resumed;
  // its `ts` is when it was replayed; a daemon from before `sent` gives no time it was sent: show none
  if (s.pastLoading && (e.kind === 'user_text' || e.kind === 'notify') && !('sent' in e)) e.sent = null;
  if (e.kind === 'sys' && (e.subtype === 'resumed' || e.subtype === 'branched')) s.pastLoading = false;
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
    else {
      pendingUi.stick ??= following();
      appendEvent(e);
      // a new message is pinned at the top (not the log replayed right after a (re)connect, nor the earlier
      // conversation of a reattached session: that scrolled smoothly past every turn, for seconds)
      if (e.kind === 'user_text' && !s.pastLoading && view?.turn?.seq === e.seq && Date.now() - syncedAt > 2000) {
        // The scroll to the bottom of a just reattached session's log is still waiting for the next frame, and the
        // feed sits at the top: start from where that scroll ends (its last turn), so it does not cross the whole log
        const prev = view.turns.at(-2)?.sec;
        if (pendingUi.stick && prev) { fitFeedPad(); feed().scrollTop = pinTop(feed(), prev); }
        jumpToTurn(view.turn.sec); pendingUi.stick = false;
      }
    }
    pendingUi.controls = true;
    if (e.kind === 'user_text') { const a = actOf(e.sid); a.turnStart ??= Date.now(); a.tickAt = Date.now(); a.tokens = 0; a.thinkingAt = 0; }
    if (e.kind === 'msg' && e.msg.type === 'result') actOf(e.sid).turnStart = null;
  }
  if (e.kind === 'user_text' || (e.kind === 'sys' && e.subtype === 'branched')) {
    const stand = Object.keys(sessions).find((k) => sessions[k].pending?.sid === e.sid);
    if (stand) openPending(stand, e.sid);
  }
}

// ---- sessions shown before the server has them
// A new session (its first message sent) and a branch show at once, as a stand-in: a draft with
// `pending` ({ kind: 'new' | 'branch', text, images, at, sid }), drawn as the session will look. When the
// server's session is ready, it takes the stand-in's place; if the server refuses, the stand-in goes
// (a new session back to a draft with its message in the input again).
function openPending(stand, sid) {
  if (buffers[stand]) { buffers[bufKey(sid)] = buffers[stand]; delete buffers[stand]; }
  delete sessions[stand];
  if (current === stand) {
    current = sid;
    renderFeed();
    refreshBtwList(); pollStats(); loadActivity(sid);
  }
  schedule();
}
// The server said yes, but what it opens with never came (a reconnect in between, say): open it anyway.
function openPendingLate(stand, sid) {
  setTimeout(() => { if (sessions[stand]?.pending && sid && sessions[sid]) openPending(stand, sid); }, 1500);
}
function failPending(stand, back) {
  const d = sessions[stand];
  if (!d?.pending) return;
  if (d.pending.kind === 'new') {
    const { text, attachments: sent } = d.pending;
    d.pending = null; d.title = 'New session';
    if (current === stand) {
      input.value = input.value.trim() ? `${text}\n\n${input.value}` : text;
      attachments = [...sent, ...attachments].slice(0, 5);
      renderAttachments(); fitInput(); updateGhost();
      renderFeed();
    } else buffers[stand] = { text, attachments: sent };
    return renderList();
  }
  delete sessions[stand];
  if (current !== stand) return renderList();
  current = null;
  if (sessions[back]) select(back); else { renderList(); renderFeed(); }
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
  if (controls) renderControls(); // first: it can change the feed's height
  if (view) { fitFeedPad(); holdPin(); } // the reply fills the blank space below
  if (stick && !pinned) scrollDown();
}

// ---------------------------------------------------------------- sidebar / header

// Three states: busy (green: working, or anything still running in the background), idle (yellow:
// alive with nothing running, safe to detach), detached (grey: no Claude process here any more).
function sessionStatus(s) {
  if (s.draft) return s.pending ? 'busy' : 'draft';
  if (!alive(s)) return 'detached';
  const a = s.act;
  if (inTurn(s) || a?.tasks?.length || a?.procs?.length) return 'busy';
  return 'idle';
}

// Two clocks per session, from the event log:
//   user  – since you last sent Claude a message;
//   agent – since Claude's main process last finished a turn (yours or one it started itself,
//           e.g. a background report); '…' while it is in the middle of one.
function waits(s) {
  let userSent = null, agentEnd = null, working = false;
  for (const e of s.events) {
    if (e.kind === 'user_text') { userSent = e.ts; working = true; }
    else if (e.kind === 'notify') working = true;
    else if (e.kind === 'msg' && e.msg.type === 'result') { agentEnd = e.ts; working = false; }
  }
  return { userSent, agentEnd, working: working && inTurn(s) };
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
  renderUsageCard();
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
  // the sidebar's waiting times: you (a person) and the agent (a robot)
  user: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="5.2" r="2.7"/><path d="M2.8 14c.6-2.9 2.7-4.4 5.2-4.4s4.6 1.5 5.2 4.4"/></svg>',
  agent: '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5" width="11" height="8.5" rx="2.2"/><path d="M8 5V2.4"/><circle cx="8" cy="2" r=".6" fill="currentColor"/><circle cx="5.8" cy="9.2" r=".9" fill="currentColor" stroke="none"/><circle cx="10.2" cy="9.2" r=".9" fill="currentColor" stroke="none"/></svg>',
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
  updateTabTitle();
  const list = $('list');
  list.innerHTML = '';
  const groups = new Map();
  // Each folder lists its sessions by last use, newest first: every live one, and detached ones
  // while the folder has fewer than SIDEBAR_MAX rows (the server remembers that many across restarts).
  // A stand-in (pending) is listed; the server's session it is about to become is not, until it does.
  const standIns = new Set(Object.values(sessions).map((s) => s.pending?.sid).filter(Boolean));
  const byUse = Object.entries(sessions).filter(([sid, s]) => (!s.draft || s.pending) && !standIns.has(sid) && folderShown(s.cwd))
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
  // A draft (a new session, before its first message) has no row: it shows up once that message starts it.
  for (const s of Object.values(sessions)) if (s.draft && !s.pending && !groups.has(s.cwd)) groups.set(s.cwd, []);
  if (!groups.size) list.append(h('div', 'side-empty', folders ? 'No folders yet. Add one with the button above.' : ''));
  // Folders stay put: sorted by path, never by what is open or used last.
  for (const [dir, rows] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const folder = h('div', 'folder' + (collapsedDirs.has(dir) ? ' collapsed' : ''));
    folder.dataset.dir = dir;
    const head = h('div', 'folder-head');
    const name = tilde(dir);
    const n = rows.length;
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
      // Flip the class on this element rather than rebuild the list: a fresh element has nothing to animate from.
      folder.classList.toggle('collapsed', collapsedDirs.has(dir));
    };
    head.oncontextmenu = (ev) => { ev.preventDefault(); folderMenu(dir, ev.clientX, ev.clientY); };
    folder.append(head);
    if (!rows.length) folder.append(h('div', 'folder-empty', 'Nothing open here'));
    for (const [sid, s] of rows) {
      const st = sessionStatus(s);
      const row = h('div', `sess ${st}` + (sid === current ? ' active' : ''));
      const color = sessionColor(s.color);
      // its leading bar; the default accent otherwise. A detached row not open goes grey whatever its colour (style.css).
      if (color && !(st === 'detached' && sid !== current)) row.style.setProperty('--sc', color);
      const t = h('div', 't');
      // Waiting on you (a question or an approval): a yellow dot that breathes and sends out rings.
      const asking = s.state === 'waiting' && !s.closed;
      t.append(h('span', asking ? 'dot st-ask' : `dot st-${st}` + (s.state === 'running' || s.pending ? ' spinning' : '')), h('span', 'sess-title', s.title));
      // Second line, symbols only (the dot already says busy / idle / detached / waiting on you):
      // the waiting times (person: you, robot: the agent) on the left, ⚙ and how many things run in the background on the right.
      const w = waits(s);
      const bg = (s.act?.tasks?.length || 0) + (s.act?.procs?.length || 0);
      const bgEl = h('span', 'sess-bg', bg ? `\u2699\uFE0E${bg}` : '');
      if (bg) bgEl.title = `${bg} running in the background (subagents, shells)`;
      const times = h('span', 'waits');
      const wait = (cls, icon, text, title) => {
        const el = h('span', cls);
        el.innerHTML = ICONS[icon];
        el.append(h('span', 'wait-t', text));
        el.title = title;
        return el;
      };
      times.append(
        wait('wait-user', 'user', since(w.userSent), 'You: time since you last sent Claude a message'),
        wait('wait-agent', 'agent', w.working ? '…' : since(w.agentEnd), w.working
          ? 'Agent: Claude is working on something right now'
          : 'Agent: time since Claude\'s main process last finished a turn'));
      const m = h('div', 'm');
      m.append(times, bgEl);
      row.append(t, m);
      row.onclick = () => select(sid);
      row.oncontextmenu = (ev) => { ev.preventDefault(); if (!s.pending) sessionMenu(sid, ev.clientX, ev.clientY); };
      folder.append(row);
    }
    list.append(folder);
  }
  syncDots(list);
}
// The sidebar is rebuilt on every update, many times a minute while a session works, and each new dot
// would start its animation over: the breathing and the rings jumped back mid-way. Every dot animation
// runs on one clock instead (from the page's time origin), so a rebuilt dot carries on where the old one was.
function syncDots(root) {
  for (const a of root.getAnimations({ subtree: true })) if (a.animationName?.startsWith('dot-')) a.startTime = 0;
}
const saveCollapsed = () => { try { localStorage.setItem('iro-collapsed-dirs', JSON.stringify([...collapsedDirs])); } catch {} };

// A new session starts with the defaults from Settings (model, effort, permission mode, kept on the
// server); one of them left unset follows Claude's own settings, as the terminal does. What you pick in
// a draft (`modeSet`, `modelSet`, `effortSet`) stays; the defaults only fill in what you have not touched.
// A session cleared or branched from another one starts with that one's mode and model.
let appSettings = null; // from the server: { defaults: { model, effort, mode }, usageInterval, intervals }
function fillDraft(d) {
  const def = appSettings?.defaults || {};
  if (!d.modelSet) d.modelChoice = def.model || undefined;
  if (!d.modeSet) d.mode = def.mode || d.claudeMode || d.mode;
  if (!d.effortSet) {
    // Else the effort Claude's settings give the model it will run (modelSettings), or in general (effortLevel).
    const m = (modelList.find((x) => x.value === d.modelChoice)?.resolvedModel || d.modelChoice || defaultModel || '').replace(/\[.*\]$/, '');
    d.effort = def.effort || (m && d.claudeEfforts?.[m]) || d.claudeEffort || d.effort;
  }
}
async function loadSettings() {
  const st = await call('getSettings', {}, { quiet: true });
  if (st) gotSettings(st);
}
function gotSettings(st) {
  const interval = appSettings?.usageInterval;
  appSettings = st;
  for (const d of Object.values(sessions)) if (d.draft) fillDraft(d);
  if (sessions[current]?.draft) renderControls();
  // Its charts follow the sampling interval. On a fresh page the usage page may be drawn before the
  // settings arrive: it then assumed 30 minutes.
  if ((interval || 30) !== st.usageInterval && !$('usageView').hidden) showUsagePage({ quiet: true });
}
function newDraft(dir, from) {
  let sid = Object.keys(sessions).find((k) => sessions[k].draft && !sessions[k].pending && sessions[k].cwd === dir);
  if (!sid) {
    sid = 'draft-' + nonce().slice(0, 8);
    sessions[sid] = { draft: true, cwd: dir, title: 'New session', state: 'draft', events: [],
      mode: from?.mode, modeSet: !!from?.mode, modelChoice: from?.modelChoice, modelSet: !!from?.modelChoice, effortSet: false };
    fillDraft(sessions[sid]);
    // Where Settings has no default, the terminal's: this folder's settings.json permissions.defaultMode and effortLevel.
    call('claudeDefaults', { cwd: dir }, { quiet: true }).then((c) => {
      const d = sessions[sid];
      if (!c || !d?.draft) return;
      d.claudeMode = c.mode; d.claudeEffort = c.effort; d.claudeEfforts = c.modelEfforts;
      fillDraft(d);
      if (current === sid) renderControls();
    });
  }
  if (collapsedDirs.delete(dir)) saveCollapsed();
  select(sid);
}
// A small menu at (x, y); `alignRight` puts its right edge there. Items: { label, run, title, cls }
// (no `run`: disabled), or 'sep'. A click outside or Esc closes it.
function contextMenu(items, x, y, { alignRight = false } = {}) {
  const m = h('div', 'ctx-menu');
  const close = () => { if (isLayer(m)) hideLayer(); };
  const onEsc = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  for (const it of items) {
    if (it === 'sep') { m.append(h('div', 'ctx-sep')); continue; }
    const b = h('button', 'ctx-item' + (it.cls ? ' ' + it.cls : ''), it.label);
    if (it.title) b.title = it.title;
    if (it.run) b.onclick = () => { close(); it.run(); }; else b.disabled = true;
    m.append(b);
  }
  showLayer(m, { onClose: () => { m.remove(); document.removeEventListener('keydown', onEsc, true); } });
  document.body.append(m);
  m.style.left = `${Math.max(8, Math.min(alignRight ? x - m.offsetWidth : x, window.innerWidth - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.min(y, window.innerHeight - m.offsetHeight - 8)}px`;
  document.addEventListener('keydown', onEsc, true);
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

// Right-click on a session.
function sessionMenu(sid, x, y) {
  contextMenu([
    { label: 'Archive', run: () => archiveSession(sid), cls: 'danger', title: 'Hide it from the sidebar; Past sessions can reopen it' },
  ], x, y);
}

// Stops it if it runs and drops the row; the transcript stays, so Past sessions can reopen it.
async function archiveSession(sid) {
  const s = sessions[sid];
  if (!s) return;
  if (alive(s)) {
    const busy = sessionStatus(s) === 'busy' ? ' It is busy (working or running something in the background); background shells it started may stop too.' : '';
    if (!await ask(`Archive "${s.title}"?\n\nIts Claude process stops and it leaves the sidebar.${busy}\n\nNothing is deleted: Past sessions can reopen it.`)) return;
  }
  await call('archive', { sid, claudeSessionId: s.claudeSessionId || null });
}

// Only unregisters the folder: its sessions keep running and Claude's memory of it stays on disk.
async function removeFolder(dir) {
  const open = Object.values(sessions).filter((s) => alive(s) && s.cwd === dir).length;
  const msg = `Remove ${tilde(dir)} from the sidebar?\n\nNothing on the server is deleted: past sessions and Claude's memory of this folder stay, and adding the folder again brings them back.`
    + (open ? `\n\n${open} open session${open > 1 ? 's' : ''} here keep${open > 1 ? '' : 's'} running, hidden until you add the folder again.` : '');
  if (!await ask(msg)) return;
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
  skillsPage.hide();
  if (btw && btw.sid !== sid) closeBtw(); // the side window belongs to the session it asks about
  // Each session keeps its own input: what you typed here waits for you to come back, and the
  // session you open shows its own (empty if nothing). An empty draft goes away when you leave it.
  if (current !== sid) {
    const empty = !input.value.trim() && !attachments.length;
    if (current) {
      if (empty) delete buffers[bufKey(current)];
      else buffers[bufKey(current)] = { text: input.value, attachments };
      if (empty && sessions[current]?.draft && !sessions[current].pending) delete sessions[current];
    }
    const b = buffers[bufKey(sid)];
    input.value = b?.text || ''; attachments = b?.attachments || [];
    histIndex = null; inputExpanded = false;
    renderAttachments(); hidePopup();
  }
  current = sid;
  const s = sessions[sid];
  fitInput(); updateGhost();
  renderList();
  renderFeed();
  refreshBtwList();
  if (!s?.draft) { pollStats(); loadActivity(sid); }
  shell.render();
  if (!shell.isOpen()) $('input').focus();
}

// A session remembered from before a daemon restart has no events here: show its earlier
// conversation, read from the transcript (sending a message reattaches it).
async function loadTranscript(sid) {
  const s = sessions[sid];
  if (!s || s.transcript) return;
  s.transcript = 'loading';
  const evs = await call('transcript', { claudeSessionId: s.claudeSessionId, cwd: s.cwd }, { quiet: true });
  // e.g. the transcript is gone: the row still reattaches. Not connected yet (a reload replays the
  // event log before the connection status arrives): asked again once it is up.
  if (!evs) { s.transcript = connected ? 'failed' : null; return; }
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
  shell.render(); // its button shows once the session has started
  const live = connected && (s?.draft || alive(s));
  if (s?.draft) fillDraft(s); // (the model it will run decides the effort Claude's settings give)
  // A detached session still takes input: sending reattaches it first.
  const detached = !!s && !s.draft && !alive(s);
  const canReattach = connected && detached && !!s.claudeSessionId;
  $('input').disabled = $('send').disabled = !(live || canReattach);
  if (s?.pending) $('send').disabled = true; // typing is fine; it sends once the session has started
  $('input').dataset.placeholder = canReattach ? 'Detached · sending a message reattaches it first' : INPUT_PLACEHOLDER; // updateGhost() shows it
  $('stop').disabled = !(live && inTurn(s));
  $('model').disabled = $('mode').disabled = $('effort').disabled = !live || !!s?.pending;
  // One button: Detach while live, Reattach once detached.
  $('closeSess').textContent = detached ? 'Reattach' : 'Detach';
  $('closeSess').title = detached ? 'Reattach: resume this session here' : 'Detach: stop this session here (reattach any time)';
  $('closeSess').disabled = !s || s.draft || (detached ? !canReattach : !live);
  renderActivity();
  const title = $('title'), renamable = !!s && !s.draft;
  if (document.activeElement !== title) title.textContent = s ? s.title : 'No session selected'; // never under the caret
  title.contentEditable = renamable ? 'plaintext-only' : 'false';
  title.parentElement.classList.toggle('renamable', renamable);
  title.title = s ? (s.draft ? s.cwd : `${s.cwd}\n(click to rename)`) : '';
  $('mode').value = s?.mode || 'default';
  updateGhost();
  $('model').options[0].textContent = shortModel(s?.stats?.model || s?.model || defaultModel) || 'Default';
  $('model').value = s?.modelChoice && [...$('model').options].some((o) => o.value === s.modelChoice) ? s.modelChoice : '';
  if (live && !modelsLoaded) loadModels();
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
    x.title = 'Take it back into the input';
    x.setAttribute('aria-label', 'Remove from the queue');
    x.onclick = async () => {
      const sid = current;
      const r = await call('queue', { sid, op: 'remove', qid: q.qid });
      if (r && current === sid) { putBack(r.text, r.images); input.focus(); }
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
  if (color && !SESSION_COLORS[color] && !/^#[0-9a-f]{6}$/.test(color)) return tell(`Unknown colour "${arg}". Try: ${Object.keys(SESSION_COLORS).join(', ')}, default, or #rrggbb.`);
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
  const busy = !!s && inTurn(s) && connected;
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
  // Alive? The daemon ticks every 3s while busy. (A quiet CLI is normal during a long tool; not shown.)
  if (busy && a.tickAt && Date.now() - a.tickAt > 12000) {
    meta.textContent += ' · no heartbeat from the server for ' + fmtSecs((Date.now() - a.tickAt) / 1000);
    meta.className = 'bad';
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
      h('span', 'muted', [TASK_KIND[t.type] || t.type, t.lastTool && `last: ${t.lastTool}`, t.toolUses != null && `${t.toolUses} tools`, t.started && fmtSecs((Date.now() - t.started) / 1000)].filter(Boolean).join(' · ')));
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
  if (tab === 'anchors') placeNewestAnchorSoon();
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
  if (inTurn(s)) {
    row('main', s.state === 'waiting' ? waitingLabel() : ($('act-label').textContent || 'Working…'), a.turnStart ? `running for ${fmtSecs((Date.now() - a.turnStart) / 1000)}` : 'running');
  } else {
    row('main', st === 'detached' ? 'Detached' : st === 'draft' ? 'Not started' : 'Idle',
      st === 'detached' ? 'no Claude process here' : st === 'draft' ? 'starts when you send the first message' : 'waiting for your next message');
  }
  rows[0].classList.add('main-' + (inTurn(s) ? 'busy' : st));
  // Tasks that were running and are gone have finished: the last few stay listed, quietly.
  const kindOf = (t) => TASK_KIND[t.type] || (t.type && t.type !== 'task' ? 'subagent' : 'task');
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
      alive(s) ? { title: 'Stop this task', run: async () => await ask(`Stop "${t.description || t.id}"?`) && call('stopTask', { sid: current, taskId: t.id }) } : null);
  }
  for (const p of a.procs || []) {
    row('process', p.cmd || `pid ${p.pid}`,
      [p.started && `running for ${fmtSecs((Date.now() - p.started) / 1000)}`, `pid ${p.pid}`, p.children && `${p.children} child process${p.children > 1 ? 'es' : ''}`].filter(Boolean).join(' · '),
      { title: 'Send SIGTERM to this process', run: async () => await ask(`Stop pid ${p.pid}?\n${p.cmd}`) && call('killProc', { sid: current, pid: p.pid }) });
  }
  if (btw?.streaming != null && btw.sid === current) row('btw', btw.messages[0]?.text || 'side question', 'answering…');
  for (const f of s.finishedTasks || []) {
    row(f.kind, f.title, `finished · ${ago(f.ended)}`);
    rows[rows.length - 1].classList.add('run-done');
  }
  box.append(...rows);
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
  const name = opt && opt.value ? opt.textContent : shortModel(s0?.stats?.model || s0?.model || defaultModel) || 'Default';
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

// The open popover (the model panel): { el, anchor, key(ev), onClose(apply) }. A click elsewhere
// closes it and applies; another menu opening closes it without.
let floating = null;
function closeFloating(apply) {
  if (floating) hideLayer(!!apply);
}
function openFloating(el, anchor, opts = {}) {
  const f = { el, anchor, ...opts };
  showLayer(el, { anchor, onClose: (how) => {
    if (floating === f) floating = null;
    el.remove();
    anchor.classList.remove('open');
    f.onClose?.(how === true || how === 'outside');
  } });
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.max(8, r.top - el.offsetHeight - 8)}px`;
  el.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - el.offsetWidth - 8)}px`;
  anchor.classList.add('open');
  floating = f;
}

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
  const running = s.stats?.model || s.model || defaultModel; // (a draft has not started: "Default" runs defaultModel)
  let index = $('model').value ? choices.findIndex((m) => m.value === $('model').value) : -1;
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
      const act = actionFor(ev, 'model');
      if (act === 'model.next' || act === 'model.prev') { index = (index + (act === 'model.next' ? 1 : choices.length - 1)) % choices.length; mark(); rows[index].scrollIntoView({ block: 'nearest' }); return true; }
      if (act === 'effort.down' || act === 'effort.up') { effort = slider.step(act === 'effort.down' ? -1 : 1); return true; }
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

// ⌥M is a dead key on some layouts (US Extended: an accent waiting for the next letter). The
// system starts composing it into the focused field before the page sees keydown, so
// preventDefault can't stop it. A composition that starts right after ⌥M is ended at once and
// the field put back as it was; otherwise the accent lands in the input, and keys pressed while it
// is pending (← → in the panel) reach the page twice.
let deadKey = null; // { el, value, start, end, until }
function guardDeadKey() {
  const el = document.activeElement;
  if (!el || !('selectionStart' in el) || el.readOnly) return;
  if (!(deadKey?.el === el && deadKey.composing)) deadKey = { el, value: el.value, start: el.selectionStart, end: el.selectionEnd };
  deadKey.until = Date.now() + 100; // it arrives with the key press, not later (later is typing)
}
document.addEventListener('compositionstart', (ev) => {
  if (deadKey?.el !== ev.target) return;
  deadKey.composing = true;
  if (Date.now() > deadKey.until) { deadKey = null; return; }
  setTimeout(() => { const el = deadKey?.el; if (el && document.activeElement === el) { el.blur(); el.focus(); } }); // commits it
}, true);
document.addEventListener('compositionend', (ev) => {
  const g = deadKey;
  if (g?.el !== ev.target) return;
  deadKey = null;
  setTimeout(() => {
    if (g.el.value === g.value) return;
    g.el.value = g.value;
    g.el.setSelectionRange(g.start, g.end);
    g.el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}, true);

// Each press of a key acts once in a popover: a keydown that isn't a repeat counts only after a
// keyup of that key (a pending composition can deliver one press twice).
const keysDown = new Set();
document.addEventListener('keyup', (ev) => keysDown.delete(ev.code), true);
window.addEventListener('blur', () => keysDown.clear());

document.addEventListener('keydown', (ev) => {
  if (isShellToggle(ev)) { ev.preventDefault(); ev.stopPropagation(); shell.toggle(); return; }
  if (inShell(ev)) return; // ⇧Tab, ⌥M and the rest belong to the shell there
  if (floating?.key && !matches('model.panel', ev)) {
    const again = !ev.repeat && keysDown.has(ev.code);
    keysDown.add(ev.code);
    if (again && /^Arrow/.test(ev.key)) { ev.preventDefault(); ev.stopPropagation(); return; }
    if (floating.key(ev)) { ev.preventDefault(); ev.stopPropagation(); return; }
  }
  if (matches('model.panel', ev)) {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.altKey) guardDeadKey();
    if (floating?.anchor === $('modelBtn')) closeFloating(true); // ⌥M again closes (and applies)
    else openModelPanel();
    return;
  }
  // Not while typing somewhere else (btw's follow-up, an answer box, the title): ⇧Tab moves focus there.
  const t = ev.target;
  const elsewhere = t !== input && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if (matches('mode.cycle', ev) && !$('modal') && !elsewhere) { ev.preventDefault(); cycleMode(); }
  const step = matches('anchor.prev', ev) ? -1 : matches('anchor.next', ev) ? 1 : 0;
  if (step && !$('modal') && !floating && !elsewhere) { ev.preventDefault(); stepAnchor(step); }
}, true);

const dd = { mode: enhanceSelect($('mode'), { className: 'dd-modepick', button: modeView, item: modeItem }) };

const fmtDur = (ms) => { const s = Math.round((ms || 0) / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m` : `${Math.floor(s / 60)}m ${s % 60}s`; };
function countdown(iso, days) {
  if (!iso) return '';
  const s = Math.max(0, (new Date(iso) - Date.now()) / 1000);
  const pad = (n) => String(Math.floor(n)).padStart(2, '0');
  return days ? `${pad(s / 86400)}d${pad((s % 86400) / 3600)}h` : `${pad(s / 3600)}h${pad((s % 3600) / 60)}m`;
}
// How far into its window a limit is, 0..1, from the reset time and the window's length. Local time
// on the page's minute clock; the reset time is set again by each new reading (every 5 minutes).
function windowElapsed(iso, windowMs) {
  if (!iso) return null;
  const left = new Date(iso) - clockNow;
  return Number.isFinite(left) ? Math.min(1, Math.max(0, 1 - left / windowMs)) : null;
}
// The sidebar's usage card: one row per limit, the number and a thin bar, with a small triangle
// under the bar for how far the reset window has run.
function usageMeter(el, label, pct, extra, title, elapsed) {
  el.innerHTML = '';
  el.className = 'uc-meter' + (pct == null ? ' none' : pct >= 85 ? ' hot' : pct >= 50 ? ' warm' : '');
  const top = h('span', 'uc-top');
  top.append(h('span', null, label), h('span', 'uc-pct', pct == null ? '—' : `${Math.round(pct)}%`));
  const bar = h('span', 'uc-bar');
  const fill = h('span', 'uc-fill');
  fill.style.width = `${Math.min(100, pct || 0)}%`;
  bar.append(fill);
  const time = h('span', 'uc-time');
  if (pct != null && elapsed != null) {
    const tick = h('span', 'uc-tick');
    tick.style.left = `${elapsed * 100}%`;
    time.append(tick);
  }
  el.append(top, bar, time);
  el.title = [title, extra && `resets in ${extra}`].filter(Boolean).join('\n');
}
// A window whose reset time has passed is over: nothing used in it yet (until a new number arrives).
const windowNow = (w) => (w?.resets && new Date(w.resets) <= clockNow ? { pct: 0 } : w);
function renderUsageCard() {
  const s = sessions[current];
  // A server from before the account-wide level (no `limits` call) leaves the open session's numbers.
  const limits = lastLimits || s?.stats?.limits;
  const five = windowNow(limits?.five), week = windowNow(limits?.week);
  usageMeter($('sb-5h'), '5-hour window', five?.pct, countdown(five?.resets, false), '5-hour limit', windowElapsed(five?.resets, 5 * 3600e3));
  usageMeter($('sb-7d'), 'Weekly', week?.pct, countdown(week?.resets, true), 'weekly limit', windowElapsed(week?.resets, 7 * 86400e3));
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
  if ($('effort').value !== (eff || '')) $('effort').value = eff || ''; // (never the last session's)
  $('effort').title = eff ? `Effort: ${eff}` : 'Effort';
  dd.mode.refresh(); refreshModelBtn();
  setItem('sb-dir', `${tilde(st.cwd || s.cwd || '')}${st.branch ? ' · ' + st.branch : ''}`, `${st.cwd || s.cwd}${st.branch ? '\ngit branch: ' + st.branch : ''}`);
  const se = st.session;
  setItem('sb-tokens', se ? `↑${fmtK(se.inTok)} ↓${fmtK(se.outTok)}` : '', 'tokens in / out this session');
  setItem('sb-cost', se ? `$${(se.cost || 0).toFixed(2)}` : '', 'this session at API rates');
  setItem('sb-time', se ? `⏱ ${fmtDur(se.durationMs)}` : '', 'session duration');

  const ctx = st.ctx;
  miniMeter($('sb-ctx'), 'Context', ctx?.pct, ctx ? `${fmtK(ctx.used)} / ${fmtK(ctx.max)}` : '', ctx ? `context window: ${fmtK(ctx.used)} of ${fmtK(ctx.max)} tokens · click for details` : '');
  const sid = $('sb-sid');
  const id = st.claudeSessionId || s.claudeSessionId;
  sid.innerHTML = '';
  sid.hidden = !id;
  sid.title = id ? `Session ID ${id} (click to copy)` : '';
  if (id) {
    const dot = h('span', 'sid-dot');
    dot.style.background = sessionColor(s.color) || 'var(--base-fill)'; // the session's colour, as in the sidebar
    const copy = h('span', 'sid-copy');
    copy.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';
    sid.append(dot, h('span', null, id.slice(0, 8)), copy); // the short form; the copy is the full id
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

// Plan limits are per account, not per session: the server keeps one level and pushes every newer
// one (a session finishing a turn, its samples). The page also asks every 5 minutes while in view,
// and on coming back to it; the server checks the usage API at most once per 5 minutes.
let lastLimits = null, lastLimitsAt = 0;
let redrawUsagePage = null; // set while the plan usage page is open
function gotLimits(l) {
  if (!l || l.t <= lastLimitsAt) return;
  lastLimits = l; lastLimitsAt = l.t;
  renderUsageCard();
  redrawUsagePage?.();
}
async function loadLimits() { gotLimits(await call('limits', {}, { quiet: true })); }
const STALE_LIMITS = 5 * 60000;
const comeBack = () => { if (connected && document.visibilityState === 'visible' && Date.now() - lastLimitsAt > STALE_LIMITS) loadLimits(); };
document.addEventListener('visibilitychange', comeBack);
// While the page is in view, a new reading every 5 minutes: keeps the numbers and the reset times right.
setInterval(() => { if (connected && document.visibilityState === 'visible') loadLimits(); }, STALE_LIMITS);
window.addEventListener('focus', comeBack);
async function pollStats() {
  const sid = current;
  const s = sessions[sid];
  if (!connected || !alive(s)) return renderStatus();
  const st = await call('stats', { sid }, { quiet: true });
  if (st && sessions[sid]) { sessions[sid].stats = st; sessions[sid].statsAt = Date.now(); if (sid === current) renderControls(); }
}
setInterval(() => { if (current) renderStatus(); }, 30000); // countdowns

let modelsLoaded = false;
let modelList = [];
let defaultModel = ''; // what "Default" runs, for a session that has not said yet (a draft)
async function loadModels() {
  modelsLoaded = true;
  const list = await call('models', { sid: sessions[current]?.draft ? undefined : current }, { quiet: true });
  if (!list?.length) { modelsLoaded = false; return; }
  defaultModel = list.find((m) => m.value === 'default')?.resolvedModel || '';
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
  if (mode === 'bypassPermissions' && !await ask('Bypass permissions: Claude will run every tool without asking. Continue?')) return renderControls();
  if (sessions[current]?.draft) { Object.assign(sessions[current], { mode, modeSet: true }); return renderControls(); }
  await call('setMode', { sid: current, mode });
  renderControls();
};
$('model').onchange = async () => {
  if (sessions[current]?.draft) { Object.assign(sessions[current], { modelChoice: $('model').value || undefined, modelSet: true }); return renderControls(); }
  await call('setModel', { sid: current, model: $('model').value || undefined });
  renderControls();
};
// The title is edited in place: Enter or leaving it saves, Esc puts the old name back.
$('title').onkeydown = (ev) => {
  if (ev.isComposing) return;
  if (ev.key === 'Enter') { ev.preventDefault(); $('title').blur(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); $('title').textContent = sessions[current]?.title || ''; $('title').blur(); }
};
$('title').onblur = () => {
  const s = sessions[current], el = $('title');
  el.scrollLeft = 0;
  if (!s || s.draft) return;
  const t = el.textContent.replace(/\s+/g, ' ').trim();
  if (t && t !== s.title) renameCurrent(t);
  else el.textContent = s.title;
};
function renameCurrent(title) {
  const s = sessions[current];
  if (!s || s.draft) return;
  if (title === undefined) { // /rename with no name: put the caret in the title, its text selected
    const el = $('title');
    el.focus();
    getSelection().selectAllChildren(el);
    return;
  }
  if (title.trim()) call('rename', { sid: current, title: title.trim(), claudeSessionId: s.claudeSessionId }); // (a detached row is known by it)
}
$('closeSess').onclick = async () => {
  const s = sessions[current];
  if (!s || s.draft) return;
  if (!alive(s)) {
    if (s.claudeSessionId) reopen(s);
    return;
  }
  const msg = sessionStatus(s) === 'busy'
    ? 'This session is busy (working or running something in the background). Detach anyway? Its Claude process stops; background shells it started may stop too.'
    : 'Detach this session? Its Claude process stops; you can reattach any time (or just send a message).';
  const sid = current; // (the one asked about, whatever is open when you answer)
  if (!await ask(msg, { ok: 'Detach' })) return;
  call('close', { sid });
};

// ---------------------------------------------------------------- feed: turns

const feed = () => $('feed');
const nearBottom = () => { const f = feed(); return f.scrollHeight - f.scrollTop - f.clientHeight < 120; };
const scrollDown = () => { const f = feed(); f.scrollTop = f.scrollHeight; };

function renderFeed() {
  const f = feed();
  const last = view?.turns?.at(-1)?.sec;
  if (last) feedSizeObserver.unobserve(last);
  fitObserver.disconnect(); // the old feed's file lists go; the new one observes its own
  f.innerHTML = '';
  unpin();
  $('outline').innerHTML = '';
  const s = sessions[current];
  renderQueue(); // first: the queue above the composer is this session's, even if drawing the feed fails below
  view = s ? {
    sid: current, tools: new Map(), groups: new Map(), approvals: new Map(), live: new Map(),
    turns: [], turn: null, preamble: h('div', 'preamble'),
    pendingCmd: null, // a slash command whose turn is shown only if the model actually runs
  } : null;
  if (!s) { f.append(h('div', 'empty', 'Pick a session on the left, or start one with + on a folder.')); return renderControls(); }
  if (s.draft && !s.pending) {
    const intro = h('div', 'draft-intro');
    intro.append(h('div', 'di-t', 'New session'), h('div', 'di-dir', tilde(s.cwd)));
    f.append(intro);
    return renderControls();
  }
  f.append(view.preamble);
  if (s.dormant && !s.transcript) loadTranscript(current);
  if (!s.draft) refreshBtwList();
  for (const e of s.events) appendEvent(e);
  resumeLive(s);
  if (s.pending?.kind === 'new' && !isCommand(s.pending.text)) startTurn({ text: s.pending.text, images: s.pending.images, ts: s.pending.at });
  if (s.pending) putText(meta(s.pending.kind === 'new' ? 'starting the session…' : 'starting the branch…', 'note pending-note'));
  fitFeedPad();
  scrollDown();
  markActiveTurn();
  renderControls();
}

const meta = (text, cls = '') => h('div', 'meta ' + cls, text);
const isCommand = (text) => /^\/[\w:.-]+(\s|$)/.test((text || '').trim());

// Like the terminal's fullscreen mode, any question can be scrolled up to the very top: the feed
// always ends with enough blank space for the last one, which its reply then fills. Anchors scroll a
// question there, and so does each new message, whose reply then grows below it (no following the
// bottom) until you scroll yourself.
//
// While a turn is pinned, nothing else moves the feed: the reply streaming in, the composer or the
// activity line changing the feed's height, the blank space shrinking. Any scroll of your own unpins it.
const FEED_PAD = 24;
let pinned = null;    // the turn section held at the top
let smoothing = null; // { timer } while jumpToTurn's smooth scroll runs
const pinTop = (f, sec) => Math.max(0, sec.offsetTop - (parseFloat(getComputedStyle(f).getPropertyValue('--fade')) || 0)); // its card just below the header's fade
const following = () => !pinned && nearBottom(); // keep the bottom in view as the reply grows
function fitFeedPad() {
  const f = feed(), last = view?.turns?.at(-1)?.sec;
  // measured with the current padding in place: removing it first would clamp the scroll position (a jump)
  const content = f.scrollHeight - (parseFloat(getComputedStyle(f).paddingBottom) || 0);
  const pad = `${Math.max(FEED_PAD, last?.isConnected ? pinTop(f, last) + f.clientHeight - content : 0)}px`;
  if (f.style.paddingBottom !== pad) f.style.paddingBottom = pad;
}
// Puts the pinned turn back at the top, e.g. after the feed grew taller and the browser clamped the
// scroll position. Not during the smooth scroll there: setting scrollTop would cut it short.
function holdPin() {
  if (!pinned || smoothing) return;
  if (!pinned.isConnected) { pinned = null; return; }
  const f = feed(), top = pinTop(f, pinned);
  if (Math.abs(f.scrollTop - top) > 1) f.scrollTop = top;
}
function endSmooth() {
  if (!smoothing) return;
  clearTimeout(smoothing.timer);
  smoothing = null;
  fitFeedPad();
  holdPin(); // it may have stopped short: the feed changed size while it ran
}
function jumpToTurn(sec) {
  const f = feed();
  fitFeedPad();
  pinned = sec;
  const top = pinTop(f, sec);
  if (smoothing) clearTimeout(smoothing.timer);
  smoothing = null;
  if (Math.abs(f.scrollTop - top) <= 1) return markActiveTurn(); // already there: no scroll, so no scrollend either
  smoothing = { timer: setTimeout(endSmooth, 1500) }; // in case scrollend never comes
  f.scrollTo({ top, behavior: 'smooth' });
}
function unpin() {
  pinned = null;
  if (smoothing) { clearTimeout(smoothing.timer); smoothing = null; }
}
$('feed').addEventListener('scrollend', endSmooth);
// Scrolling yourself (wheel, touch, keys, the scrollbar, find in page) lets go of the pinned turn.
$('feed').addEventListener('wheel', unpin, { passive: true });
$('feed').addEventListener('touchmove', unpin, { passive: true });
$('feed').addEventListener('pointerdown', (ev) => { if (ev.target === feed() || ev.button === 1) unpin(); }); // the scrollbar, middle-click autoscroll
// Our own scrolling keeps the pinned turn at its spot, so a scroll that moved it elsewhere was yours, except
// when the browser clamped it: the feed grew taller (the activity line went away) with the old blank space,
// and the layout was read before the ResizeObserver could refit it. That scroll ends at the very bottom, above
// the pin, where scrolling yourself (up: not at the bottom; down: past the pin) never does.
$('feed').addEventListener('scroll', () => {
  if (!pinned || smoothing || !pinned.isConnected) return;
  const f = feed(), top = pinTop(f, pinned);
  if (Math.abs(f.scrollTop - top) <= 2) return;
  if (f.scrollTop < top && f.scrollHeight - f.clientHeight - f.scrollTop <= 1) { fitFeedPad(); holdPin(); }
  else unpin();
});
// The feed's height (window, composer, activity line) and the last turn's height change outside the
// event flow too, e.g. while the reply streams in: refit the blank space and hold the pin before the
// frame is painted, so neither shows as a jump.
const feedSizeObserver = new ResizeObserver(() => { if (view) { fitFeedPad(); holdPin(); } });
feedSizeObserver.observe($('feed'), { box: 'border-box' }); // not its padding, which fitFeedPad sets
// A question box leaves room for the conversation (style.css, .turn-q): it shows up to four lines, fewer
// when that card (24px a line, 30px around them) would take over a third of the feed's height, and an
// opened one stops short of the feed's. Not a size container query: that would make #feed the containing
// block of the fixed popups inside it.
let questionLines = 4;
new ResizeObserver(() => {
  const f = feed(), h = f.clientHeight;
  const set = (name, value) => { if (f.style.getPropertyValue(name) !== value) f.style.setProperty(name, value); };
  questionLines = Math.max(1, Math.min(4, Math.floor((h / 3 - 30) / 24)));
  set('--feed-h', `${h}px`);
  set('--q-lines', String(questionLines));
  f.classList.toggle('q-one', questionLines === 1);
}).observe($('feed'));

// The time alone today, else with the date (and the year, when not this one).
function sentLabel(ms) {
  const d = new Date(ms), now = new Date();
  const opts = { hour: 'numeric', minute: '2-digit' };
  if (d.toDateString() !== now.toDateString()) Object.assign(opts, { month: 'short', day: 'numeric' }, d.getFullYear() !== now.getFullYear() && { year: 'numeric' });
  return d.toLocaleString([], opts);
}

// A request shows at most four lines (questionLines, above). A longer one is cut there (style.css) and
// gets the input's corner button, which opens it and closes it again. How many lines it takes changes
// with the column's width, so each one is measured whenever it is laid out anew.
const questionObserver = new ResizeObserver((entries) => {
  for (const { target: text } of entries) {
    const q = text.closest('.turn-q');
    if (!q) continue;
    const long = text.scrollHeight > questionLines * parseFloat(getComputedStyle(text).lineHeight) + 2; // the cut lines count too
    q.classList.toggle('long', long);
    if (!long && q.classList.contains('open')) q.querySelector('.turn-expand').click();
  }
});

function startTurn(e) {
  const sec = h('section', 'turn');
  const q = h('div', 'turn-q');
  const scroll = h('div', 'turn-q-scroll');
  q.append(scroll);
  const expand = h('button', 'turn-expand');
  expand.type = 'button';
  expand.append($('expandInput').firstElementChild.cloneNode(true)); // the same arrows: outwards, and inwards once open
  const setOpen = (open) => {
    q.classList.toggle('open', open);
    expand.title = open ? 'Show less' : 'Show the whole request';
    expand.setAttribute('aria-label', expand.title);
    expand.setAttribute('aria-expanded', String(open));
  };
  setOpen(false);
  expand.onclick = (ev) => {
    ev.stopPropagation();
    setOpen(!q.classList.contains('open'));
    scroll.scrollTop = 0;
    fitFeedPad(); holdPin(); // the card's height is part of the feed's
  };
  q.append(expand);
  const qText = h('div', 'turn-q-text', e.text);
  const cmd = isCommand(e.text) && /^\s*(\S+)/.exec(e.text);
  if (cmd) { // the /name stays code; what you wrote after it reads in serif like any request
    qText.textContent = e.text.slice(cmd[0].length);
    qText.prepend(h('span', 'turn-q-cmd', cmd[1]));
  }
  scroll.append(qText);
  questionObserver.observe(qText);
  if (e.images?.length) { // attached below the message
    const row = h('div', 'thumbs');
    for (const im of e.images) {
      const img = h('img');
      img.src = `data:${im.media_type};base64,${im.data}`;
      row.append(img);
    }
    scroll.append(row);
  }
  if (e.notify) {
    // Not something the user wrote: a background task or subagent reporting back.
    sec.classList.add('notify');
    const n = e.notify;
    scroll.prepend(h('div', 'notify-tag', n.summary?.startsWith('Agent') ? '↩ Subagent result' : '↩ Background task result'));
    q.title = 'A background task reported back; Claude continues from here';
    const facts = [n.status, n.toolUses != null && `${n.toolUses} tool calls`, n.durationMs != null && fmtSecs(n.durationMs / 1000), n.tokens != null && `${fmtK(n.tokens)} tokens`].filter(Boolean).join(' · ');
    if (facts) scroll.append(h('div', 'notify-facts', facts));
  }
  const body = h('div', 'turn-body');
  const foot = h('div', 'turn-foot');
  // The card sticks only within question + reply: at the end of the reply it is pushed up, so it
  // never covers the footer (the "done …" line that divides one turn from the next).
  const main = h('div', 'turn-main');
  main.append(q);
  // When it was sent, in this computer's time zone. A replayed transcript carries the original time
  // (`sent`, null if unknown); otherwise it is the event's own.
  const at = 'sent' in e ? e.sent : e.ts;
  if (at) {
    const time = h('time', 'turn-time', sentLabel(at));
    time.dateTime = new Date(at).toISOString();
    time.title = new Date(at).toLocaleString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    main.append(time);
  }
  main.append(body);
  sec.append(main, foot);
  feed().append(sec);
  feedSizeObserver.observe(sec); // its growth eats into the blank space below it
  const prev = view.turns.at(-1)?.sec;
  if (prev) feedSizeObserver.unobserve(prev);
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
  placeNewestAnchorSoon();
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
    // To an ordinary message it is the CLI's own error (e.g. "Not logged in"): shown in the turn.
    if (m.message.model === '<synthetic>' && !parentId) {
      const text = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      if (view.pendingCmd || view.turn?.command) return commandOutput(text);
      if (!text.trim()) return;
      materialize();
      return putText(meta(text, 'warn'));
    }
    if (!parentId) materialize();
    if (!parentId && view.turn && m.uuid) view.turn.lastUuid = m.uuid; // where "Branch from here" cuts
    for (const b of m.message.content) {
      if (b.type === 'text' && b.text.trim()) {
        const el = assistantText(b.text);
        putText(el, parentId);
        finishLive(parentId || '', el, b.text);
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

// Marks the changed-file paths cut short at their start (see .chg-path.cut), again whenever the width changes.
const fitObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    for (const p of target.querySelectorAll('.chg-path')) p.classList.toggle('cut', p.firstChild.offsetWidth > p.clientWidth + 0.5);
  }
});

function finishTurn(m) {
  const turn = view.turn;
  if (!turn) return;
  if (turn.command && !m.num_turns) { turn.foot.innerHTML = ''; return; } // local command: no model turn
  turn.foot.innerHTML = '';
  if (turn.changes.size) {
    // One file per line; over five, the first four and a line that shows the rest.
    const files = h('div', 'changed');
    const all = [...turn.changes.values()];
    files.append(h('div', 'muted', `Changed ${all.length} file${all.length > 1 ? 's' : ''}`));
    // The +/− counts stay at the end of the line; a long path is cut at its start ("…/name.ext").
    const rows = all.map((c) => {
      const row = h('div', 'chg');
      const f = h('span', 'file-link chg-path');
      f.append(h('bdi', null, relPath(c.file, sessions[view.sid]?.cwd)));
      f.dataset.path = c.file;
      row.append(f, h('span', 'chg-n', ''));
      row.lastChild.append(h('span', 'plus', `+${c.add}`), h('span', 'minus', ` −${c.del}`));
      return row;
    });
    const MAX = 5;
    files.append(...rows);
    if (rows.length > MAX) {
      const more = h('button', 'chg-more');
      const show = (all) => {
        rows.forEach((r, i) => { r.hidden = !all && i >= MAX - 1; });
        more.textContent = all ? 'Show less' : `Show ${rows.length - MAX + 1} more`;
        more.onclick = () => show(!all);
      };
      show(false);
      files.append(more);
    }
    turn.foot.append(files);
    fitObserver.observe(files);
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
function activeTurn() {
  if (!view?.turns.length) return null;
  const top = feed().getBoundingClientRect().top + 8;
  let active = pinned && view.turns.find((t) => t.sec === pinned); // the one you jumped to, even if the turns below are short
  if (!active) {
    if (nearBottom()) active = view.turns[view.turns.length - 1]; // the last turn may be too short to reach the top
    else for (const t of view.turns) if (t.sec.getBoundingClientRect().top <= top + 40) active = t;
  }
  return active || view.turns[0];
}
function markActiveTurn() {
  if (!view) return;
  const active = activeTurn();
  const was = $('outline').querySelector('.ol-item.active');
  for (const t of view.turns) t.outlineItem.classList.toggle('active', t === active);
  if (active && active.outlineItem !== was) revealInRail(active.outlineItem);
}
// ⌥↑ / ⌥↓: the anchor before or after the one you are reading (the first or last stays put).
function stepAnchor(dir) {
  const cur = activeTurn();
  const next = cur && view.turns[view.turns.indexOf(cur) + dir];
  if (!next) return;
  jumpToTurn(next.sec);
  markActiveTurn();
}
// Scrolls only the rail to show the item. scrollIntoView would also scroll every scrolling ancestor,
// and in Chrome it cuts short a smooth scroll still running in the feed.
function revealInRail(el) {
  const rail = $('rail');
  if (!el.offsetParent) return; // its pane is hidden
  if (el === $('outline').lastElementChild) return placeNewestAnchor();
  const r = el.getBoundingClientRect(), box = rail.getBoundingClientRect();
  const tabs = $('railtabs').getBoundingClientRect().bottom; // the sticky tabs cover the rail's top
  if (r.top < tabs) rail.scrollTop -= tabs - r.top;
  else if (r.bottom > box.bottom) rail.scrollTop += r.bottom - box.bottom;
}
// The newest anchor rests a third of the way down the rail (below the tabs): a new one pushes the list up,
// never down. A short list stays at the top. The blank space below the last anchor is just what it needs
// to reach that spot, and you can still scroll down into it.
function placeNewestAnchor() {
  const rail = $('rail'), list = $('outline'), last = list.lastElementChild;
  if (!last?.offsetParent) return; // no anchors, or the pane is hidden
  const box = rail.getBoundingClientRect();
  const tabs = $('railtabs').getBoundingClientRect().bottom - box.top;
  const spot = tabs + (rail.clientHeight - tabs) / 3;
  const top = last.getBoundingClientRect().top - box.top + rail.scrollTop; // in the rail's content
  const pad = top > spot ? `${Math.max(0, rail.clientHeight - spot - last.offsetHeight - (parseFloat(getComputedStyle(rail).paddingBottom) || 0))}px` : '';
  if (list.style.paddingBottom !== pad) list.style.paddingBottom = pad;
  rail.scrollTop = Math.max(0, top - spot);
}
function placeNewestAnchorSoon() { // a declaration: showRailTab calls it at startup, before this line runs
  placeNewestAnchorSoon.raf ||= requestAnimationFrame(() => { placeNewestAnchorSoon.raf = 0; placeNewestAnchor(); });
}
let scrollRaf = 0;
$('feed').addEventListener('scroll', () => {
  if (!scrollRaf) scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; markActiveTurn(); });
});

// ---------------------------------------------------------------- streaming (live, not logged)

// What each session is streaming right now, kept whichever session is open (s.streams: thread key ->
// { block, text }), so a session opened mid-reply shows it so far and types on from there.
function keepStream(d) {
  const s = sessions[d.sid];
  if (!s) return;
  const key = d.parent || '';
  if (d.op === 'start') (s.streams ??= {})[key] = { block: d.block, text: '' };
  else if (s.streams?.[key]?.block === d.block) s.streams[key].text += d.text;
}
// The event that ends a live block (as appendEvent / renderMsg end it) ends its kept stream too.
function dropStreams(s, e) {
  if (e.kind === 'closed' || e.kind === 'rewound') s.streams = null;
  else if (e.kind === 'user_text' || e.kind === 'notify' || (e.kind === 'msg' && e.msg.type === 'result')) delete s.streams[''];
  else if (e.kind === 'msg' && e.msg.type === 'assistant' && e.msg.message.content.some((b) => b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use')) delete s.streams[e.msg.parent_tool_use_id || ''];
}
// The open session's kept streams, drawn as they are so far (renderFeed: the feed was just rebuilt).
function resumeLive(s) {
  for (const [key, st] of Object.entries(s.streams || {})) {
    const live = makeLive(key, st.block);
    if (!live) continue;
    live.text = st.text;
    live.shown = st.text.length; // typing goes on from here: what came while away is not typed out again
    if (st.text) drawLive(live, performance.now());
  }
}

// One live block per thread: '' is the main conversation, otherwise the Agent tool_use id.
// From a remote server the text arrives in bursts (a sentence at a time): it is typed out at an even
// pace instead, each burst spread over about the time until the next one, so it never falls behind.
function makeLive(key, block) {
  dropLive(key);
  if (!key) materialize();
  const t = target(key || undefined);
  if (!t) return null;
  const el = block === 'thinking' ? thinkingBlock('') : h('div', 'md assistant live');
  if (block === 'thinking') el.classList.add('live');
  t.append(el);
  const live = { el, block, text: '', shown: 0, speed: 0, gap: 0, lastAt: 0, raf: 0, frameAt: 0, drawnAt: 0, cost: 0, final: null };
  view.live.set(key, live);
  return live;
}
function livePartial(d) {
  const key = d.parent || '';
  if (d.op === 'start') {
    const stick = following();
    if (!makeLive(key, d.block)) return;
    renderActivity();
    if (stick) scrollDown();
  } else if (d.op === 'delta') {
    const live = view.live.get(key);
    if (!live || live.block !== d.block) return;
    live.text += d.text;
    // Deltas that come in together (one network packet) are one burst; the gap is the one between bursts.
    const now = performance.now(), dt = now - live.lastAt;
    if (live.lastAt && dt > TYPE_SAME_BURST_MS) live.gap = live.gap ? live.gap * 0.7 + dt * 0.3 : dt;
    live.lastAt = now;
    const over = live.gap ? Math.min(TYPE_MAX_MS, Math.max(TYPE_MIN_MS, live.gap)) : TYPE_FIRST_MS;
    live.speed = (live.text.length - live.shown) / over; // chars per ms
    typeOn(live);
  }
}
// a burst is spread over the gap until the next one (the first over TYPE_FIRST_MS), within these bounds
const TYPE_SAME_BURST_MS = 15, TYPE_FIRST_MS = 200, TYPE_MIN_MS = 40, TYPE_MAX_MS = 600;

function typeOn(live) {
  if (document.hidden) live.shown = live.text.length; // no frames to animate in: all of it, drawn once the tab shows
  if (live.raf) return;
  live.frameAt = performance.now();
  live.raf = requestAnimationFrame((t) => typeFrame(live, t));
}
function typeFrame(live, t) {
  live.raf = 0;
  if (!live.el.isConnected) return; // the feed was redrawn
  const dt = Math.min(50, Math.max(0, t - live.frameAt));
  live.frameAt = t;
  live.shown = Math.min(live.text.length, live.shown + Math.max(1, live.speed * dt));
  const done = live.shown >= live.text.length;
  if (done && live.final) { // the finished message takes its place
    const stick = following();
    live.el.remove();
    live.final.style.display = '';
    if (stick) scrollDown();
    return;
  }
  // a long reply takes longer to draw: drawn less often, so typing never costs more than a third of the time
  if (done || t - live.drawnAt >= live.cost * 3) drawLive(live, t);
  if (!done) live.raf = requestAnimationFrame((t2) => typeFrame(live, t2));
}
function drawLive(live, t) {
  const t0 = performance.now();
  const stick = following();
  let n = Math.floor(live.shown);
  if (n < live.text.length && /[\uD800-\uDBFF]/.test(live.text[n - 1] || '')) n++; // never half a surrogate pair
  const rendered = markdown(live.text.slice(0, n));
  if (live.block === 'thinking') live.el.querySelector('.md').replaceWith(rendered);
  else live.el.innerHTML = rendered.innerHTML;
  if (stick) scrollDown();
  live.drawnAt = t;
  live.cost = performance.now() - t0;
}
// The text block's final message `el` (already in place, after the live one) arrived. Text still being
// typed out finishes first, quickly (within TYPE_MAX_MS), and then `el` replaces it.
function finishLive(key, el, text) {
  const live = view.live.get(key);
  if (!live || live.block !== 'text' || live.shown >= text.length || document.hidden || !live.el.isConnected || !el.isConnected) return dropLive(key);
  view.live.delete(key); // the next block gets its own; this one ends by itself
  live.text = text;
  live.final = el;
  live.speed = Math.max(live.speed, (text.length - live.shown) / TYPE_MAX_MS);
  el.style.display = 'none';
  el.before(live.el);
  typeOn(live);
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
    box.questions = e.input.questions;
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
      // Your own answer wraps and grows with what you type instead of scrolling sideways.
      const other = h('textarea', 'other');
      other.rows = 1;
      other.placeholder = 'Something else? Type your own answer';
      other.addEventListener('input', () => fitArea(other));
      other.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); yes.click(); } });
      // A single choice is either an option or your own text, never both.
      if (!q.multiSelect) {
        other.addEventListener('input', () => { if (other.value.trim()) opts.querySelectorAll('input:checked').forEach((i) => (i.checked = false)); });
        opts.addEventListener('change', () => { other.value = ''; fitArea(other); });
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
        if (a == null) return tell('Please answer: ' + e.input.questions[i].question);
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

// A textarea as tall as its text.
function fitArea(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + 'px';
}

// An answered question stays as you left it: the picked options stay selected, your own text stays
// (read-only). The selection is rebuilt from the answers, so a replayed history shows it too.
function showAnswers(box, questions, answers) {
  box.querySelectorAll('.q').forEach((qbox, qi) => {
    let rest = String(answers[questions[qi]?.question] ?? '');
    const has = (label) => (', ' + rest + ', ').includes(', ' + label + ', ');
    for (const inp of qbox.querySelectorAll('.opt input')) {
      inp.checked = !!inp.value && has(inp.value);
      if (inp.checked) rest = (', ' + rest + ', ').replace(', ' + inp.value + ', ', ', ').slice(2, -2);
    }
    const other = qbox.querySelector('.other');
    if (other) other.value = rest.trim();
  });
  box.querySelectorAll('input, textarea').forEach((i) => (i.disabled = true));
  box.querySelectorAll('.other').forEach(fitArea);
}

function finishApproval(e) {
  const box = view.approvals.get(e.rid);
  if (!box) return;
  const card = box.closest('.tool');
  if (e.answers && box.querySelector('.q')) {
    showAnswers(box, box.questions || [], e.answers);
    box.querySelector('.btns')?.remove();
    // Answered, it can fold away to its one-line head (never before: an open question must stay visible).
    if (card) {
      card.classList.add('answered');
      card.querySelector('.tool-head')?.append(h('span', 'ask-done', '✓ answered'));
      card.querySelector('.tool-head')?.addEventListener('click', () => card.classList.toggle('folded'));
    }
  } else {
    const verdict = !e.allow ? '✗ denied' : e.answers ? '✓ answered' : e.always ? '✓ always allowed' : '✓ allowed';
    box.replaceChildren(meta(verdict, e.allow ? 'ok' : 'warn'));
  }
  box.classList.add('settled');
  card?.classList.remove('asking');
  const g = card && view.groups.get(card.dataset.id);
  if (g) refreshGroup(g);
}

// ---------------------------------------------------------------- new session / history

async function reopen({ claudeSessionId, cwd, title, color }) {
  wantNonce = nonce(); wantFrom = current;
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
  allLab.append(all, 'include headless / automated runs');
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
let usagePos = { five: 0, cycle: 0, week: 0 }; // how far back each card is paged with its ‹ › (0: the latest)
// `quiet` (opened by itself, on a fresh page): no alert, and nothing asked until the server is connected.
async function showUsagePage({ quiet = false } = {}) {
  closeBtw();
  skillsPage.hide();
  document.querySelector('main').classList.add('usage-mode');
  $('usageView').hidden = false;
  $('usageBtn').classList.add('on');
  $('usageBody').replaceChildren(meta('loading…'));
  usagePos = { five: 0, cycle: 0, week: 0 };
  // (all the server keeps: the cards page back through it)
  const [samples, forecast] = await Promise.all([call('usageHistory', { days: 35 }, { quiet }), call('usageForecast', {}, { quiet: true })]);
  if (!samples || $('usageView').hidden) return; // (closed, or a session picked, while it loaded)
  const draw = () => $('usageBody').replaceChildren(usagePage(samples, { view: usageView, forecast, live: lastLimits, interval: appSettings?.usageInterval || 30, onView: (v) => { usageView = v; draw(); }, pos: usagePos }));
  redrawUsagePage = draw;
  draw();
}
function hideUsagePage() {
  redrawUsagePage = null;
  document.querySelector('main').classList.remove('usage-mode');
  $('usageView').hidden = true;
  $('usageBtn').classList.remove('on');
}
$('usageBtn').onclick = () => ($('usageView').hidden ? showUsagePage() : hideUsagePage());
$('usageBack').onclick = hideUsagePage;
function showSkillsPage() {
  closeModal();
  closeBtw();
  hideUsagePage();
  skillsPage.show();
}
$('settingsBtn').onclick = async () => {
  if (!appSettings) await loadSettings();
  if (!appSettings) return tell('Not connected to the server right now.');
  openSettings({
    openModal, call, openSkills: showSkillsPage, getSettings: () => appSettings, modes: MODES, efforts: EFFORTS.map(([v, label]) => [v, label]),
    models: async () => { if (!modelList.length) await loadModels(); return modelList; },
  });
};

// ---------------------------------------------------------------- modal + file viewer

// Image thumbnails (in a sent message, or attached in the composer): hovering shows a larger
// preview next to it, clicking opens it full size.
const isThumb = (el) => el?.tagName === 'IMG' && el.closest('.thumbs, .thumb');
let peek = null;
function hidePeek() { peek?.remove(); peek = null; }
document.addEventListener('mouseover', (ev) => {
  const img = isThumb(ev.target) ? ev.target : null;
  if (!img) return hidePeek();
  if (peek?.dataset.src === img.src) return;
  hidePeek();
  peek = h('div', 'img-peek');
  peek.dataset.src = img.src;
  const big = h('img');
  big.src = img.src;
  peek.append(big);
  document.body.append(peek);
  const place = () => { // below the thumbnail, or above it when there is no room
    if (!peek) return;
    const r = img.getBoundingClientRect(), p = peek.getBoundingClientRect();
    const top = r.bottom + 8 + p.height <= innerHeight ? r.bottom + 8 : Math.max(8, r.top - 8 - p.height);
    peek.style.left = `${Math.max(8, Math.min(r.left, innerWidth - p.width - 8))}px`;
    peek.style.top = `${top}px`;
  };
  if (big.complete) place(); else big.onload = place;
});
document.addEventListener('scroll', hidePeek, true);
document.addEventListener('click', (ev) => {
  if (!isThumb(ev.target)) return;
  ev.stopPropagation();
  hidePeek();
  const body = openModal('Image');
  body.classList.add('img-full');
  const img = h('img');
  img.src = ev.target.src;
  body.append(img);
}, true);


let onModalClose = null; // what closing the open dialog also does (e.g. stop a login it started)
function openModal(title) {
  closeModal();
  hideLayer();
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
  const then = onModalClose;
  onModalClose = null;
  then?.();
  $('modal').remove();
  $('input').focus();
}
initDiagrams(openModal); // mermaid diagrams: pan, zoom, source, a larger view

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

// Every file opens in Resources (text, images, video alike). A folder doesn't open: once known to be
// one, its reference only copies its path.
async function openPathRef(el) {
  if (el.classList.contains('path-dir')) return;
  const st = await call('stat', { sid: current, path: absPath(el.dataset.path) });
  if (!st) return;
  if (!st.exists) return toast(`Not found on the server: ${st.path}`, el);
  if (st.dir) return markDir(el);
  resources.add(st.path, st.size);
}
function markDir(el) {
  el.classList.add('path-dir');
  el.title = 'A folder · click: copy the absolute path';
}
// A reference is looked up the first time the pointer rests on it, so a folder never shows as openable.
document.addEventListener('mouseover', async (ev) => {
  const ref = ev.target.closest?.('.path-ref');
  if (!ref?.dataset.path || ref.dataset.checked) return;
  ref.dataset.checked = '1';
  if (/\/$/.test(ref.dataset.path)) return markDir(ref);
  const st = await call('stat', { sid: current, path: absPath(ref.dataset.path) }, { quiet: true });
  if (st?.dir) markDir(ref);
});

const resources = createResources({ call, openModal: (t) => openModal(t), toast, listEl: $('reslist'), onAdd: () => showRailTab('resources'), viewText, token: () => TOKEN });

async function viewText(p, load) {
  const s = sessions[current];
  const body = openModal(relPath(p, s?.cwd));
  body.append(meta('loading…'));
  const r = await load();
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
  const code = ev.target.closest('code.code-copy');
  if (code) {
    const text = code.textContent.trim();
    try { await navigator.clipboard.writeText(text); } catch { return toast('Could not copy', code); }
    return toast(`Copied ${text}`, code);
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
  keybindings: { desc: 'Change the keyboard shortcuts', run: showKeys },
  usage: { desc: 'Plan limits and this session’s usage', run: showUsage },
  cost: { desc: 'Plan limits and this session’s usage', run: showUsage },
  context: { desc: 'What fills the context window', run: showContext },
  btw: { desc: 'Side question; doesn’t touch the conversation (no argument: list them)', hint: '<question>', run: askBtw },
  status: { desc: 'Session, account and MCP status', run: showStatus },
  login: { desc: 'Log Claude in on this server (or switch accounts)', run: () => showLogin() },
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
  // One line per row: a long command or description ends in … and shows whole on hover.
  const table = (rows) => {
    const t = h('table', 'help oneline');
    for (const [a, b] of rows) {
      const tr = h('tr');
      tr.append(h('td', 'mono', a), h('td', null, b));
      tr.title = b ? `${a} — ${b}` : a;
      t.append(tr);
    }
    return t;
  };
  body.append(table([
    ...Object.entries(LOCAL_COMMANDS).map(([n, c]) => ['/' + n, c.desc]),
    ...cmds.filter((c) => !LOCAL_COMMANDS[c.name]).map((c) => ['/' + c.name + (c.argumentHint ? ' ' + c.argumentHint : ''), c.description]),
  ]), h('h4', null, 'Keys'), table([['Enter', 'Send'], ['Shift+Enter', 'New line'], ['Esc', 'Close a dialog'],
    ...ACTIONS.map((a) => [label(a.id), a.desc + (a.scope === 'global' ? '' : ` (${SCOPES[a.scope].toLowerCase()})`)]),
    ['/', 'Commands'], ['@', 'Files'], ['Paste', 'Attach an image']]));
  const edit = h('button', 'keys-edit', 'Change shortcuts…');
  edit.onclick = showKeys;
  body.append(edit);
}

// The keyboard shortcuts dialog (/keybindings): click a key, press the new one (Esc cancels).
// The choices stay in this browser (ui/keys.js).
let recording = null; // { id, btn, msg } while a key is being recorded
function showKeys() {
  const body = openModal('Keyboard shortcuts');
  const draw = () => {
    recording = null;
    body.replaceChildren();
    for (const [scope, title] of Object.entries(SCOPES)) {
      body.append(h('h4', null, scope === 'model' ? `${title} (${label('model.panel')})` : title));
      const t = h('table', 'help keys');
      for (const a of ACTIONS.filter((x) => x.scope === scope)) {
        const tr = h('tr');
        const btn = h('button', 'key-btn' + (isDefault(a.id) ? '' : ' changed'), label(a.id));
        btn.dataset.action = a.id;
        btn.title = 'Click, then press the new key';
        const msg = h('span', 'key-msg');
        btn.onclick = () => {
          if (recording) { recording.btn.classList.remove('rec'); recording.btn.textContent = label(recording.id); recording.msg.textContent = ''; }
          recording = { id: a.id, btn, msg };
          btn.classList.add('rec');
          btn.textContent = 'Press a key…';
        };
        const reset = h('button', 'key-reset', 'Default');
        reset.title = `Back to ${keyLabel(a.key)}`;
        reset.classList.toggle('off', isDefault(a.id));
        reset.onclick = () => {
          const why = resetKey(a.id);
          if (why) msg.textContent = `${keyLabel(a.key)}: ${why}`; else draw();
        };
        const cell = h('td'), act = h('td', 'key-act');
        cell.append(btn, msg);
        act.append(reset);
        tr.append(h('td', null, a.desc), cell, act);
        t.append(tr);
      }
      body.append(t);
    }
    const foot = h('div', 'keys-foot');
    const all = h('button', null, 'Restore all defaults');
    all.disabled = ACTIONS.every((a) => isDefault(a.id));
    all.onclick = () => { resetAll(); draw(); };
    foot.append(h('span', 'muted', 'Enter, Shift+Enter and Esc are fixed. Shortcuts are saved in this browser.'), all);
    body.append(foot);
  };
  draw();
}
// While recording, the next key press is the shortcut: it goes nowhere else (on window, so it runs
// before the page's other key handlers).
window.addEventListener('keydown', (ev) => {
  if (!recording) return;
  if (!$('modal') || !document.contains(recording.btn)) { recording = null; return; }
  ev.preventDefault();
  ev.stopImmediatePropagation();
  const { id, btn, msg } = recording;
  if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
    recording = null; btn.classList.remove('rec'); btn.textContent = label(id); msg.textContent = '';
    return;
  }
  const key = comboOf(ev);
  if (!key) return; // a modifier on its own: wait for the key
  const why = problem(id, key);
  if (why) { msg.textContent = `${keyLabel(key)}: ${why}`; return; }
  setKey(id, key);
  showKeys();
}, true);

// The key hints in the buttons' tooltips follow the shortcuts.
function keyHints() {
  $('shellBtn').title = `Shell (${label('shell.toggle')})`;
  $('modelBtn').title = `Model and effort (${label('model.panel')})`;
  $('mode').title = `Permission mode (${label('mode.cycle')} to cycle)`;
  $('stop').title = `Interrupt (${label('turn.interrupt')})`;
}
keyHints();
onKeysChange(keyHints);

// Logging Claude Code in on the server from here (the daemon runs `claude auth login`): its sign-in page
// opens in this browser, and the code that page shows is pasted back here. On this machine the page can
// finish by itself instead, calling back to a local port.
let loginNeeded = false; // the server says Claude isn't logged in
let loginView = null;     // the open login dialog: { ended(d) }
function showLogin(useConsole = false) {
  const body = openModal('Log in to Claude');
  body.classList.add('login');
  const where = serverName === 'local' ? 'this machine' : serverName || 'the server';
  const steps = h('div', 'login-steps');
  const kind = h('div', 'muted small');
  const other = h('button', 'linkish', useConsole ? 'Use a Claude subscription instead' : 'Use an Anthropic Console account (API billing) instead');
  other.onclick = () => showLogin(!useConsole);
  kind.append(useConsole ? 'Anthropic Console account (API billing). ' : 'Claude subscription (Pro, Max, Team or Enterprise). ', other);
  const intro = h('p');
  intro.append(`Logs Claude Code in on ${where}, as `, h('code', null, 'claude auth login'), ` does there.${loginNeeded ? '' : ' It is logged in already: this replaces that login.'}`);
  body.append(intro, kind, steps);
  const me = loginView = { finished: false };
  const open = () => loginView === me && document.contains(body);
  onModalClose = () => { if (loginView === me) loginView = null; if (!me.finished) post('authCancel'); };
  const fail = (error) => {
    if (!open()) return;
    const again = h('button', 'primary', 'Start again');
    again.onclick = () => showLogin(useConsole);
    steps.replaceChildren(h('div', 'login-err', error || 'The login did not finish.'), again);
  };
  me.ended = (d) => {
    if (!open() || me.finished) return;
    if (!d.ok) return fail(d.error);
    me.finished = true;
    closeModal();
    toast('Claude is logged in', $('conn'));
  };
  steps.append(meta('starting…'));
  post('authLogin', { console: useConsole }).then((r) => {
    if (!open()) return;
    if (r.error != null) return fail(r.error);
    const { link, local } = r.data;
    const here = serverName === 'local' && local; // the page calls back to this machine: no code to paste
    const a = h('a', 'login-open', 'Open the sign-in page ↗');
    a.href = here ? local : link;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const inp = h('input', 'login-code');
    inp.placeholder = 'Code from the sign-in page';
    inp.spellcheck = false;
    inp.autocomplete = 'off';
    const go = h('button', 'primary', 'Log in');
    const err = h('div', 'login-err');
    const submit = async () => {
      if (!inp.value.trim()) return inp.focus();
      go.disabled = inp.disabled = true;
      err.textContent = '';
      go.textContent = 'Logging in…';
      const res = await post('authCode', { code: inp.value });
      if (res.error != null) return fail(res.error); // (it has ended)
      if (res.data?.ok) return me.ended({ ok: true });
      err.textContent = res.data?.error || 'That code was not accepted.'; // a malformed code: it waits for another
      go.disabled = inp.disabled = false;
      go.textContent = 'Log in';
      inp.select();
    };
    go.onclick = submit;
    inp.onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); submit(); } };
    const row = h('div', 'login-row');
    row.append(inp, go);
    steps.replaceChildren(
      h('div', 'login-step', '1. Sign in and approve on the page this opens:'), a,
      h('div', 'login-step', here ? '2. That finishes the login by itself. If the page shows a code instead, paste it here:' : '2. Then paste the code the page shows:'), row, err);
    a.focus();
  });
}
// The login ended (a code, the page calling back, or an error): every tab hears it.
function loginEnded(d) { loginView?.ended(d); }

// A dialog that shows "loading…" until the command's data is in, then draw(data).
async function panelModal(title, type, draw) {
  const body = openModal(title);
  body.append(meta('loading…'));
  const data = await call(type, { sid: current });
  if (data) body.replaceChildren(draw(data)); else closeModal();
}
function showUsage() { return panelModal('Usage', 'usage', usagePanel); }
function showContext() { return panelModal('Context window', 'context', contextPanel); }
// The context meter under the composer opens the same panel as /context.
$('sb-ctx').onclick = () => { if (alive(sessions[current])) showContext(); };

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
  if (!alive(s)) return tell('Reattach this session first (send a message or click Reattach), then rewind.');
  const at = { sid, uuid: e.uuid };
  const dry = await call('rewind', { ...at, dryRun: true });
  if (!dry) return;
  const n = dry.filesChanged?.length || 0;
  const files = n ? `\n\nFiles restored to how they were then (${n}${dry.insertions != null ? `, +${dry.insertions} −${dry.deletions}` : ''}):\n${dry.filesChanged.slice(0, 12).map((f) => '  ' + relPath(f, s.cwd)).join('\n')}${n > 12 ? `\n  … and ${n - 12} more` : ''}`
    : dry.canRewind === false && dry.error ? `\n\nFiles can't be restored: ${dry.error}` : '\n\nNo file changes to undo.';
  if (!await ask(`Rewind to before this message?\n\nThis message and everything after it leave the conversation (the message goes back into the input).${files}\n\nChanges made outside Claude's Edit/Write tools (e.g. by Bash) are not undone.`)) return;
  const r = await call('rewind', at);
  if (!r) return;
  if (current === sid) putBack(r.text);
  toast(r.files.length ? `Rewound · ${r.files.length} file${r.files.length > 1 ? 's' : ''} restored` : 'Rewound', $('input'));
}

// A new session that starts as a copy of this conversation: all of it, or up to the assistant
// message `at` (a turn's "Branch from here"). The new session opens; the original is untouched.
// It keeps the original's model, effort and mode (what the page shows is only used when the server
// no longer runs the original: a detached one). It opens at once with the conversation as this page
// has it; the server's copy (read from the transcript) replaces it when ready.
async function branchSession(title, at) {
  const src = current, s = sessions[src];
  if (!s || s.draft) return;
  let evs = s.events;
  const cut = at ? evs.findIndex((e) => e.kind === 'msg' && e.msg.uuid === at) : -1;
  if (cut >= 0) evs = evs.slice(0, cut + 1);
  // what the server's copy holds: the messages, not the turns' results, approvals or notes (and no ⋯ menus: no sid)
  const copied = evs.filter((e) => e.kind === 'user_text' || e.kind === 'notify' || (e.kind === 'msg' && (e.msg.type === 'assistant' || e.msg.type === 'user')))
    .map(({ sid: _, seq: __, ...e }) => (e.kind === 'user_text' && !('sent' in e) ? { ...e, sent: e.ts } : e));
  const stand = 'draft-' + nonce().slice(0, 8);
  sessions[stand] = { draft: true, pending: { kind: 'branch', at: Date.now() }, cwd: s.cwd, state: 'draft', lastActive: Date.now(),
    title: String(title || '').trim().slice(0, 120) || `${s.title || 'Session'} (branch)`,
    mode: s.mode, modeSet: true, modelChoice: s.modelChoice, modelSet: true, effort: s.effort, effortSet: true, model: s.stats?.model || s.model,
    events: [{ kind: 'created', resumed: true }, ...copied, { kind: 'sys', subtype: 'branched' }] };
  select(stand);
  wantNonce = nonce(); wantFrom = stand; wantDraft = stand;
  const r = await call('branch', { sid: src, claudeSessionId: s.claudeSessionId, cwd: s.cwd, title, at, nonce: wantNonce,
    model: s.stats?.model || s.model, mode: s.mode, effort: s.stats?.model ? s.stats.effort || undefined : s.effort });
  if (!r) {
    if (wantFrom === stand) { wantNonce = null; wantDraft = null; }
    failPending(stand, src);
  } else openPendingLate(stand, r.sid);
}

// A fresh draft in the same folder, with the same mode and model; the session it clears is archived
// (Past sessions can still reopen it). A busy one is only archived if you say so.
async function clearSession() {
  const sid = current, s = sessions[sid];
  if (!s) return;
  if (!s.draft && sessionStatus(s) === 'busy' && !await ask(`"${s.title}" is busy (working or running something in the background).\n\n/clear archives it, which stops it. Continue?`)) return;
  newDraft(s.cwd, s);
  if (!s.draft) await call('archive', { sid, claudeSessionId: s.claudeSessionId || null });
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
  if (sending || (!text.trim() && !attachments.length) || !current || sessions[current]?.pending) return;
  remember(text);
  const local = !attachments.length && localCommand(text);
  if (local) { input.value = ''; hidePopup(); updateGhost(); return local(); }
  const sent = [...attachments];
  const images = sent.map(({ media_type, data }) => ({ media_type, data }));
  const body = text.trim() ? text : 'See the attached image.';
  const s = sessions[current], from = bufKey(current);
  let ok;
  sending = true;
  try {
    if (s.draft) {
      // The first message is what creates the session. It shows as started at once (the message, its
      // row in the sidebar, titled as the server will title it); the server's session replaces it.
      const stand = current;
      wantNonce = nonce(); wantFrom = stand;
      wantDraft = stand;
      if (isCommand(text)) pendingCommand = { sid: null, text: text.trim() };
      s.pending = { kind: 'new', text: body, images, attachments: sent, at: Date.now() };
      s.title = body.trim().slice(0, 60);
      s.lastActive = Date.now();
      input.value = ''; attachments = []; inputExpanded = false;
      renderAttachments(); hidePopup(); fitInput(); updateGhost();
      renderList(); renderFeed();
      const r = await call('new', { cwd: s.cwd, text: body, images, nonce: wantNonce, mode: s.modeSet || appSettings?.defaults.mode ? s.mode : undefined, // else settings.json decides
        model: s.modelChoice || undefined, effort: s.effortSet || appSettings?.defaults.effort ? s.effort : undefined });
      if (r === undefined) {
        if (wantFrom === stand) { wantNonce = null; wantDraft = null; }
        failPending(stand);
      } else openPendingLate(stand, r?.sid);
      return;
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
  // Only what was sent leaves the input: the send can take seconds (a reattach first), and what was
  // typed or pasted meanwhile stays. Moved to another session meanwhile: it leaves that session's
  // kept input instead (a draft's is under its new sid by now).
  if (ok === undefined) return;
  if (bufKey(current) !== from && current !== ok?.sid) {
    for (const k of [from, ok?.sid]) {
      const b = k && buffers[k];
      if (!b?.text.startsWith(text)) continue;
      b.text = b.text.slice(text.length).replace(/^\s*\n/, '');
      b.attachments = b.attachments.filter((a) => !sent.includes(a));
      if (!b.text && !b.attachments.length) delete buffers[k];
    }
  } else if (input.value.startsWith(text)) {
    input.value = input.value.slice(text.length).replace(/^\s*\n/, '');
    attachments = attachments.filter((a) => !sent.includes(a));
    renderAttachments(); hidePopup(); updateGhost();
    if (!input.value) inputExpanded = false;
    fitInput();
  }
}
$('send').onclick = send;
$('stop').onclick = () => call('interrupt', { sid: current });

function addImageFile(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
  if (file.size > 5 * 1024 * 1024) return tell(`${file.name || 'image'} is larger than 5 MB`);
  if (attachments.length >= 5) return tell('At most 5 images per message');
  const reader = new FileReader(), into = attachments; // the session it was added to, even if you move on meanwhile
  reader.onload = () => {
    const url = reader.result;
    into.push({ media_type: file.type, data: url.slice(url.indexOf(',') + 1), url });
    if (into === attachments) renderAttachments();
  };
  reader.readAsDataURL(file);
}
// A message taken back (from the queue, or by a rewind) goes into the input, after anything already there.
function putBack(text = '', images = []) {
  if (text) input.value = input.value.trim() ? `${input.value.replace(/\s+$/, '')}\n\n${text}` : text;
  for (const im of images || []) {
    if (attachments.length >= 5) break;
    attachments.push({ media_type: im.media_type, data: im.data, url: `data:${im.media_type};base64,${im.data}` });
  }
  renderAttachments(); fitInput(); updateGhost();
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
// (shown from the third line on) opens a half-screen editor. No drag handle.
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
  const roomy = inputExpanded || need > min + line * 1.5; // three lines or more
  btn.classList.toggle('show', roomy); // two lines need no editor of their own
  $('composer').classList.toggle('tall', inputExpanded || need > min + 4); // once it wraps, the pill becomes a rounded box
  $('composer').classList.toggle('roomy', roomy);
  btn.title = inputExpanded ? 'Shrink the input' : 'Expand the input (half screen)';
}
document.querySelector('.input-box').addEventListener('mousedown', (ev) => { if (ev.target.closest('#input, #expandInput')) return; ev.preventDefault(); input.focus(); });
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
// A key that belongs to an input method (pinyin, kana…): Safari sends the Enter that commits a
// candidate after compositionend, with isComposing false but keyCode 229.
const imeKey = (ev) => ev.isComposing || ev.keyCode === 229;
input.addEventListener('keydown', (ev) => {
  if (pop && !popup.hidden) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); pop.index = (pop.index + 1) % pop.items.length; return drawPopup(); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); pop.index = (pop.index + pop.items.length - 1) % pop.items.length; return drawPopup(); }
    if ((ev.key === 'Enter' || ev.key === 'Tab') && !imeKey(ev)) {
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
    ev.preventDefault(); // …so this Esc is about the popup, not a dialog behind it
  }
  if (imeKey(ev)) return;
  if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.shiftKey && !ev.altKey && !ev.metaKey && historyKey(ev)) { ev.preventDefault(); return; }
  if ((ev.key === 'ArrowRight' || ev.key === 'Tab') && !ev.shiftKey && input.selectionStart === input.value.length && ghostText) {
    ev.preventDefault();
    acceptGhost();
    return;
  }
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
});

// Esc outside the popup closes a dialog. It does not interrupt the turn: Ctrl+C does that.
// Not the Esc that cancels an input method's candidates.
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape' || imeKey(ev) || ev.defaultPrevented || inShell(ev)) return;
  if ($('modal')) closeModal();
});
// Ctrl+C (by default; ui/keys.js) stops the running turn (the terminal's interrupt key). Only
// the Ctrl key: ⌘C still copies on a Mac, and elsewhere a Ctrl+C with text selected is left to copy it.
document.addEventListener('keydown', (ev) => {
  if (!matches('turn.interrupt', ev) || ev.defaultPrevented || inShell(ev)) return;
  const f = document.activeElement;
  const picked = String(window.getSelection() || '') || (f && 'selectionStart' in f && f.selectionStart !== f.selectionEnd);
  if (picked && keyOf('turn.interrupt') === 'Ctrl+KeyC' && !/Mac/.test(navigator.platform)) return;
  if ($('stop').disabled) return;
  ev.preventDefault();
  $('stop').click();
});
