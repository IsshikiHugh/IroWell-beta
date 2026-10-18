// Long-lived daemon on the remote host. Owns every Claude session so they keep
// running when the laptop disconnects. Clients talk newline-delimited JSON over
// a Unix socket (reached through `ssh host node attach.mjs`, no TCP port).
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { query, listSessions, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';

const DIR = process.env.IRO_DIR || path.join(os.homedir(), '.iro-coding');
const SOCK = path.join(DIR, 'daemon.sock');
const BOOT = randomUUID(); // lets clients notice a daemon restart
// The node this daemon runs on is on PATH, for the npm it asks (checkSdk) and for what sessions run
// (`node …/progress.mjs`), also when the client's --remote-node named one the login shell's PATH doesn't
// have (set up in .bashrc only, say). Last on it: a project's own node still comes first.
{
  const bin = path.dirname(process.execPath), dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!dirs.includes(bin)) process.env.PATH = [...dirs, bin].join(path.delimiter);
}
// The release folder this daemon runs from (releases/r<time> on a host; see client/client.mjs).
const RELEASE = path.basename(path.dirname(fileURLToPath(import.meta.url)));
// What Claude is told about the web UI it is shown in: skills/, next to this file in a release (the client
// copies it there) and beside server/ in a checkout. system-prompt.md is appended to Claude Code's system
// prompt; the rest is a Claude Code plugin named irowell, whose skills (skills/<name>/SKILL.md) every
// session loads. Both are read as each session starts, so an edit in a checkout (the client's UI Skills
// page writes there) reaches the next session without a restart.
// (IRO_SKILLS_DIR: another folder, for the tests)
const SKILLS_DIR = process.env.IRO_SKILLS_DIR || [new URL('./skills/', import.meta.url), new URL('../skills/', import.meta.url)].map(fileURLToPath).find((d) => fs.existsSync(d));
const UI_PROMPT_FILE = SKILLS_DIR && path.join(SKILLS_DIR, 'system-prompt.md');
const readPrompt = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
// (remotePrompt: what a session is told besides while the user is on another computer; see "where the user is")
const uiPrompt = () => [readPrompt(UI_PROMPT_FILE), remotePrompt()].filter(Boolean).join('\n\n');
// Every file under `dir`, as paths relative to it, sorted.
const filesUnder = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? filesUnder(dir, path.join(rel, e.name)) : e.isFile() ? [path.join(rel, e.name)] : [])).sort();
// Fingerprint of this file as it started and of skills/ as it is now (what the next session gets): the
// client takes the same one of its checkout (client/main.mjs) to spot an outdated server.
// Every connection's hello has it, a skill script's too: taken again at most every CODE_MS, unless `fresh`.
const SOURCE = fs.readFileSync(new URL(import.meta.url));
const CODE_MS = 5000;
let codeTaken = null; // { at, code }
function code(fresh = false) {
  if (!fresh && codeTaken && Date.now() - codeTaken.at < CODE_MS) return codeTaken.code;
  const h = createHash('sha1').update(SOURCE);
  if (SKILLS_DIR) for (const f of filesUnder(SKILLS_DIR)) h.update(f + '\0').update(fs.readFileSync(path.join(SKILLS_DIR, f)));
  codeTaken = { at: Date.now(), code: h.digest('hex').slice(0, 12) };
  return codeTaken.code;
}
// The SDK ships its own Claude Code; it doesn't auto-update like the terminal's `claude`. The daemon
// compares it with the newest SDK on npm, and the UI offers "Update server" when it falls behind.
const SDK = { version: null, cc: null, latest: null, latestCc: null };
try {
  const pkg = JSON.parse(fs.readFileSync(new URL('./node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'));
  Object.assign(SDK, { version: pkg.version, cc: pkg.claudeCodeVersion || null });
} catch {}
// Whether that Claude Code is logged in here, asked of it (`claude auth status`): without a login every
// turn ends at once with "Not logged in", so the UI says so up front, with the command that logs in.
// `cmd` is the SDK's own binary: the host may have no `claude` on PATH (both share ~/.claude).
const AUTH = { loggedIn: null, cmd: '' };
// Which Claude account that login is (a fingerprint, not the address): plan usage belongs to an account, so
// two machines only compare their usage samples when this agrees. '' while unknown.
let ACCOUNT = process.env.IRO_TEST_ACCOUNT || '';
// The Claude Code the SDK starts: the binary of its platform package, looked up as the SDK looks it up (from
// the SDK's own folder; on Linux the glibc build first, or the musl one when Node runs on musl).
const CLAUDE_BIN = (() => {
  const { platform: p, arch: a } = process;
  const musl = p === 'linux' && process.report?.getReport?.().header?.glibcVersionRuntime === undefined;
  const names = p === 'android' ? [`linux-${a}-android`] : p === 'linux' ? (musl ? [`linux-${a}-musl`, `linux-${a}`] : [`linux-${a}`, `linux-${a}-musl`]) : [`${p}-${a}`];
  try {
    const sdk = createRequire(fs.realpathSync(new URL('./node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)));
    for (const n of names) {
      try { const f = sdk.resolve(`@anthropic-ai/claude-agent-sdk-${n}/claude${p === 'win32' ? '.exe' : ''}`); if (fs.existsSync(f)) return f; } catch {}
    }
  } catch {}
  return '';
})();
// Whether that Claude Code runs: '' when it does, else what is wrong. A copy of it can come out damaged with
// no error from cp or npm (on a host whose home is on NFS, 4 MB of one came out as zeros): it then runs as a
// bare Bun, which answers --version with Bun's own version, and every session fails at once with
// `error: Script not found "stream-json"`.
function checkCli() {
  if (!CLAUDE_BIN) return Promise.resolve('no Claude Code binary in node_modules (@anthropic-ai/claude-agent-sdk-<platform>)');
  return new Promise((resolve) => execFile(CLAUDE_BIN, ['--version'], { timeout: 60000 }, (e, out, err) => {
    if (/\(Claude Code\)/.test(out)) return resolve('');
    resolve(`Claude Code at ${CLAUDE_BIN} does not run (--version: ${`${out}\n${err}`.trim().split('\n').pop() || e?.message || 'no answer'})`);
  }));
}
// `node daemon.mjs --check-cli` (install.sh): exits 0 when this release's Claude Code runs, else 1 with what
// is wrong. Nothing else of the daemon runs.
if (process.argv[2] === '--check-cli') {
  const why = await checkCli();
  if (why) console.error(why);
  process.exit(why ? 1 : 0);
}
if (CLAUDE_BIN) AUTH.cmd = `${CLAUDE_BIN.startsWith(os.homedir() + path.sep) ? '~' + CLAUDE_BIN.slice(os.homedir().length) : CLAUDE_BIN} auth login`;
let authTimer = null, authAt = 0;
function checkAuth() {
  if (!CLAUDE_BIN) return;
  authAt = Date.now();
  execFile(CLAUDE_BIN, ['auth', 'status', '--json'], { timeout: 20000 }, (e, stdout) => {
    let loggedIn;
    try {
      const st = JSON.parse(stdout);
      loggedIn = st.loggedIn === true;
      if (!process.env.IRO_TEST_ACCOUNT) ACCOUNT = loggedIn && (st.email || st.orgId) ? createHash('sha1').update(`${st.email || ''}\n${st.orgId || ''}`).digest('hex').slice(0, 16) : '';
    } catch { // (it couldn't tell, e.g. it timed out: keep what we had, and while logged out ask again)
      if (AUTH.loggedIn === false) { clearTimeout(authTimer); authTimer = setTimeout(checkAuth, 15000); }
      return;
    }
    // Until it is logged in, ask again every 15 s, so the notice goes away soon after you log in.
    clearTimeout(authTimer);
    if (!loggedIn) authTimer = setTimeout(checkAuth, 15000);
    if (loggedIn === AUTH.loggedIn) return;
    AUTH.loggedIn = loggedIn;
    const l = line({ type: 'partial', sid: '', op: 'auth', auth: AUTH });
    for (const c of clients) c.write(l); // every client, also one between its hello and its sync
  });
}
// A client connecting for the UI (its sync) has it asked again, at most once a minute (it starts a ~250 MB
// CLI): a logout from a terminal since shows when the client connects. While logged out, checkAuth asks
// every 15 s itself. (A turn that answers "Not logged in" asks too: see addMessage.)
function recheckAuth() {
  if (AUTH.loggedIn !== false && Date.now() - authAt >= 60e3) checkAuth();
}
// Logging in from the page: it shows the link `claude auth login` prints, whose page gives you a code
// to paste back (from any browser). The CLI also opens a link through $BROWSER whose page calls back to
// a port on this host, so no code is needed: BROWSER is a script that only writes that link down (no
// browser starts here, e.g. over ssh's X11 forwarding), and the page uses it when it runs on this host.
const LOGIN_BROWSER = path.join(DIR, 'login-browser.sh');
let login = null; // { proc, console, out, link, local, cancelled, done }
const plainText = (s) => s.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
function stopLogin() {
  if (!login) return;
  login.cancelled = true;
  login.proc.kill();
  login = null;
}
async function startLogin(useConsole) {
  if (login && login.console === useConsole && login.link) return login; // (another tab, or the dialog opened again)
  stopLogin();
  if (!CLAUDE_BIN) throw new Error('No Claude Code on this server to log in with');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(LOGIN_BROWSER, '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$IRO_LOGIN_LINK"\n');
  fs.chmodSync(LOGIN_BROWSER, 0o755);
  const linkFile = path.join(DIR, `login-link-${process.pid}`);
  fs.rmSync(linkFile, { force: true });
  const proc = spawn(CLAUDE_BIN, ['auth', 'login', ...(useConsole ? ['--console'] : [])],
    { stdio: 'pipe', env: { ...process.env, BROWSER: LOGIN_BROWSER, IRO_LOGIN_LINK: linkFile } });
  const l = login = { proc, console: useConsole, out: '', link: '', local: '', cancelled: false };
  for (const s of [proc.stdout, proc.stderr]) { s.setEncoding('utf8'); s.on('data', (d) => { l.out += d; }); }
  proc.stdin.on('error', () => {}); // it has exited
  l.done = new Promise((done) => {
    const end = (ok, error) => {
      if (login === l) login = null;
      clearTimeout(l.timer);
      fs.rmSync(linkFile, { force: true });
      if (!l.cancelled) partial('', { op: 'login', ok, error }); // every tab: the dialog closes, or says why
      checkAuth();
      done({ ok, error });
    };
    proc.on('error', (e) => end(false, e.message));
    // A wrong code ends it too ("Login failed: …", after the prompt on the same line).
    proc.on('exit', (code, sig) => end(code === 0, code === 0 ? '' : plainText(l.out).trim().split('\n').pop().replace(/^.*?>\s*/, '') || `It ended (${sig || code})`));
  });
  // The link to show: the one whose page gives a code (not the one calling back to localhost).
  for (let t = 0; t < 200 && !l.link && login === l; t++) {
    l.link = (plainText(l.out).match(/https:\/\/\S+/g) || []).find((u) => !/localhost|127\.0\.0\.1/.test(decodeURIComponent(u))) || '';
    if (!l.link) await new Promise((r) => setTimeout(r, 100));
  }
  if (!l.link) {
    const why = login === l ? 'Claude Code printed no sign-in link' : (await l.done).error;
    if (login === l) stopLogin();
    throw new Error(why);
  }
  for (let t = 0; t < 10 && !l.local; t++) {
    try { l.local = fs.readFileSync(linkFile, 'utf8').trim(); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  l.timer = setTimeout(() => { if (login === l) stopLogin(); }, 15 * 60 * 1000).unref?.(); // (a dialog left open)
  return l;
}
// Who you are on this host, for the avatar on your messages: git's user.name, else the login name.
let USER_NAME = '';
try { USER_NAME = execFileSync('git', ['config', '--global', 'user.name'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(); } catch {}
if (!USER_NAME) try { USER_NAME = os.userInfo().username; } catch {}
const MAX_TOOL_OUTPUT = 20000; // chars kept per tool result in the event log
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const OURS_FILE = path.join(DIR, 'sessions.json'); // Claude session ids started from this UI

// State files are shared with a daemon of the previous version while it hands its sessions over (see
// "rolling updates"), so every write re-reads the file and changes only its own entry.
const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? dflt; } catch { return dflt; } };
// `text` into `file` by way of a file beside it, renamed over it: never a half-written file for a reader.
// Throws when it can't (and removes what it wrote).
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}
function writeJson(file, value) {
  try { writeFileAtomic(file, JSON.stringify(value)); } catch (e) { log('cannot save', file, e.message); }
}
// Read the file afresh, change it with `fn` (in place, or return the new value), and save it.
// `fn` returning false leaves the file as it was. Returns the value as saved (or as read).
function updateJson(file, dflt, fn) {
  const v = readJson(file, dflt);
  const r = fn(v);
  if (r === false) return v;
  writeJson(file, r ?? v);
  return r ?? v;
}
// A path as the user writes it: `~` is the home directory, a relative one is in `base` (default home).
const expandHome = (p) => String(p ?? '').replace(/^~(?=$|\/)/, os.homedir());
const userPath = (p, base = os.homedir()) => path.resolve(base, expandHome(p));
// A session's title as the UI gives one (its first message), for a session it lists from disk.
const titleOf = (x) => x.customTitle || x.firstPrompt?.trim().slice(0, 60) || x.summary || 'Session';
const ours = new Set(readJson(OURS_FILE, []));
function rememberOurs(id) {
  if (!id || ours.has(id)) return;
  updateJson(OURS_FILE, [], (all) => {
    for (const x of all) ours.add(x);
    ours.add(id);
    return [...ours].slice(-500);
  });
}

// The sidebar's sessions outlive the daemon: each folder remembers its RECENT_MAX most recently
// used sessions ({ dir: [{ id, title, t }] }, newest first). A restarted daemon lists them as detached.
const RECENT_FILE = path.join(DIR, 'recent.json');
const RECENT_MAX = 8;
let recent = readJson(RECENT_FILE, {});
// `bump`: the session was just used (a message, a reply, a reattach); otherwise only its title changed.
function touchRecent(s, bump = true) {
  const id = s.claudeSessionId;
  if (!id) return;
  if (bump) unarchive(id);
  recent = updateJson(RECENT_FILE, recent, (all) => {
    const list = all[s.cwd] || [];
    const old = list.find((x) => x.id === id);
    if (!old && !bump) return false;
    const entry = { id, title: s.title, t: bump || !old ? Date.now() : old.t };
    all[s.cwd] = [entry, ...list.filter((x) => x.id !== id)].sort((a, b) => b.t - a.t).slice(0, RECENT_MAX);
  });
}

// Sessions archived from the sidebar (Claude session ids): out of recent.json, and kept out when a
// restarted daemon re-seeds it. Using one again (a reopen from Past sessions, a message) unarchives it.
const ARCHIVED_FILE = path.join(DIR, 'archived.json');
function archive(id) {
  updateJson(ARCHIVED_FILE, [], (all) => !all.includes(id) && [...all, id].slice(-2000));
  recent = updateJson(RECENT_FILE, recent, (all) => { for (const dir of Object.keys(all)) all[dir] = all[dir].filter((x) => x.id !== id); });
}
function unarchive(id) {
  updateJson(ARCHIVED_FILE, [], (all) => all.includes(id) && all.filter((x) => x !== id));
}

// Each session's /color, by Claude session id: kept apart from recent.json so it survives the
// session dropping out of the top RECENT_MAX, a missing recent.json, detach, reattach and restarts.
const COLORS_FILE = path.join(DIR, 'colors.json');
let colors = readJson(COLORS_FILE, {});
function saveColor(s) {
  if (!s.claudeSessionId) return;
  colors = updateJson(COLORS_FILE, colors, (all) => { if (s.color) all[s.claudeSessionId] = s.color; else delete all[s.claudeSessionId]; });
}

// A rewound session nobody has written to since: its transcript still ends with the turns rewound
// away, so until its next message every resume must start at the rewind point (claude id -> uuid).
const REWINDS_FILE = path.join(DIR, 'rewinds.json');
const rewindPoint = (id) => (id && readJson(REWINDS_FILE, {})[id]) || undefined;
function setRewindPoint(id, uuid) {
  if (!id) return;
  updateJson(REWINDS_FILE, {}, (all) => {
    if (uuid) all[id] = uuid; else if (id in all) delete all[id]; else return false;
  });
}

// The transcripts under `root` (~/.claude/projects): <project>/<session id>.jsonl, and with `subagents` also
// what the subagents of each session wrote (<project>/<session id>/subagents/*.jsonl, after the project's own).
function transcriptFiles(root, { subagents = false } = {}) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch { continue; }
    const subs = [];
    for (const f of names) {
      if (f.endsWith('.jsonl')) out.push(path.join(root, d, f));
      else if (subagents) {
        const dir = path.join(root, d, f, 'subagents');
        try { for (const x of fs.readdirSync(dir)) if (x.endsWith('.jsonl')) subs.push(path.join(dir, x)); } catch {}
      }
    }
    out.push(...subs);
  }
  return out;
}
// Where each transcript lives: ~/.claude/projects/<project>/<session id>.jsonl
function transcriptIndex() {
  const index = new Map();
  for (const f of transcriptFiles(path.join(CLAUDE_DIR, 'projects'))) index.set(path.basename(f, '.jsonl'), f);
  return index;
}
// `len` bytes of `file` from `pos` on (zeros past its end).
function readRange(file, pos, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    return buf;
  } finally { fs.closeSync(fd); }
}

// cwd and entrypoint from the head of a transcript (listSessions() sometimes leaves cwd out).
// entrypoint: "cli" = terminal, "sdk-ts" = this UI (and other TypeScript SDK apps), "sdk-cli" = `claude -p` runs.
const metaCache = new Map(); // file -> { mtime, meta }
function transcriptMeta(file) {
  if (!file) return {};
  let st;
  try { st = fs.statSync(file); } catch { return {}; }
  const hit = metaCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.meta;
  let text;
  try { text = readRange(file, 0, Math.min(st.size, 256 << 10)).toString('utf8'); } catch { return {}; } // (unreadable: nothing known)
  const str = (key) => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
    return m ? JSON.parse(`"${m[1]}"`) : undefined;
  };
  const meta = { cwd: str('cwd'), entrypoint: str('entrypoint'), hasMessages: /"type":"(user|assistant)"/.test(text) };
  metaCache.set(file, { mtime: st.mtimeMs, meta });
  return meta;
}
const transcriptCwd = (id) => transcriptMeta(transcriptIndex().get(id)).cwd || null;

// What getSessionMessages() leaves out of each user entry of a transcript (uuid -> { t, origin, turnOrigin }):
// when it was written, and who it came from (the user, a background task, another session, a schedule).
// A schedule's prompt it leaves out altogether: those entries also carry their `content` and `next`, the
// uuid of the entry after them in the conversation.
function transcriptUsers(id) {
  const users = new Map();
  let text = '';
  try { text = fs.readFileSync(transcriptIndex().get(id) || '', 'utf8'); } catch { return users; }
  const lines = text.split('\n'), scheduled = new Map();
  for (const l of lines) {
    if (!l.includes('"type":"user"')) continue;
    try {
      const m = JSON.parse(l);
      if (m.type !== 'user' || !m.uuid) continue;
      const u = { t: Date.parse(m.timestamp) || null, origin: m.origin, turnOrigin: m.turnOrigin };
      if (m.turnOrigin === 'scheduled' && !m.isSidechain) { u.content = m.message?.content; scheduled.set(m.uuid, u); }
      users.set(m.uuid, u);
    } catch {}
  }
  if (scheduled.size) {
    for (const l of lines) {
      const parent = /^\{"parentUuid":"([^"]+)"/.exec(l)?.[1];
      const u = parent && scheduled.get(parent);
      if (!u || u.next) continue;
      try { u.next = JSON.parse(l).uuid; } catch {}
    }
  }
  return users;
}
// One user entry of a transcript, as written (null if it isn't there yet). Read from the end: it is recent.
function transcriptEntry(file, uuid) {
  try {
    const size = fs.statSync(file).size, n = Math.min(size, 1 << 20);
    const l = readRange(file, size - n, n).toString('utf8').split('\n').reverse().find((x) => x.includes(`"uuid":"${uuid}"`) && x.includes('"type":"user"'));
    return l ? JSON.parse(l) : null;
  } catch { return null; }
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

// ---- event log: every UI-visible change is an event with a global seq ----
const events = [];
let seq = 0;
const subscribers = new Set(); // clients that have synced and get live events

const line = (obj) => JSON.stringify(obj) + '\n';
// A 'data' listener that calls `fn` with each complete, non-empty line.
// Only the new chunk is searched: a 48 MB message (pasted images) arrives in ~750 chunks, and
// rescanning the whole buffer each time would stall the event loop for seconds.
function lines(fn) {
  let buf = '';
  return (chunk) => {
    let from = 0, i;
    while ((i = chunk.indexOf('\n', from)) >= 0) {
      const l = (buf + chunk.slice(from, i)).trim();
      buf = '';
      from = i + 1;
      if (l) fn(l);
    }
    buf += chunk.slice(from);
  };
}

// Streaming deltas are live-only: not logged, not replayed.
function partial(sid, p) {
  if (movedAway(sid)) return;
  const l = line({ type: 'partial', sid, ...p });
  for (const c of subscribers) c.write(l);
}

function emit(sid, ev) {
  if (movedAway(sid)) return; // the new daemon carries this session on, under the same sid
  const e = { type: 'event', seq: ++seq, sid, ts: Date.now(), ...ev };
  events.push(e);
  const l = line(e);
  for (const c of subscribers) c.write(l);
}

// ---- sessions ----
const sessions = new Map();
const alive = (s) => !!s && !s.closed && s.state !== 'ended'; // its CLI runs here (not detached)
const REWINDING = 'This session is rewinding: try again in a moment';

// A CLI started for one question (`args`: what query() takes) and closed after it: `ask(q)` asks it, and
// with `ms` it fails ("no answer in … s") once that has passed. query() itself can throw (no Claude Code to
// start, say): that fails the same way, so the caller's error handling covers it.
async function oneShot(args, ask, ms) {
  let q, timer;
  try {
    q = query(args);
    if (!ms) return await ask(q);
    return await Promise.race([ask(q), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer in ${ms / 1000} s`)), ms); })]);
  } finally {
    clearTimeout(timer);
    try { q?.close(); } catch {}
  }
}
// One message to the smallest model, with no tools and none of the user's settings.
const HAIKU_TURN = { model: 'haiku', tools: [], maxTurns: 1, persistSession: false, settingSources: [] };

// The model list when no session runs here yet (a new session's draft): a CLI started only to
// ask, closed before any message. Kept; a failure is retried after a minute.
let modelsProbe = null;
async function probeModels() {
  try {
    return await oneShot({ prompt: inbox(), options: { cwd: os.homedir(), persistSession: false } }, (q) => q.supportedModels(), 30e3);
  } catch (e) {
    log('model list', e.message);
    setTimeout(() => (modelsProbe = null), 60e3);
    return [];
  }
}

// Async-iterable queue feeding user messages into query() (streaming input mode).
function inbox() {
  const q = [];
  let wake = null;
  return {
    push(m) { q.push(m); wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (q.length) yield q.shift();
        await new Promise((r) => (wake = r));
      }
    },
  };
}

function setState(s, state) {
  if (s.state === state || s.state === 'ended') return;
  s.state = state;
  emit(s.id, { kind: 'state', state });
}

function askApproval(s, tool, input, opts = {}) {
  const { signal } = opts;
  if (signal?.aborted) return Promise.resolve({ behavior: 'deny', message: 'Request aborted' });
  const rid = randomUUID();
  // "Always allow" writes these permission rules; not offered when the CLI says it would grant too much.
  const suggestions = opts.suppressAlwaysAllowRule ? undefined : opts.suggestions?.length ? opts.suggestions : undefined;
  return new Promise((resolve) => {
    s.pending.set(rid, { resolve, input, suggestions });
    emit(s.id, {
      kind: 'approval', rid, tool, input,
      toolUseId: opts.toolUseID, agentId: opts.agentID,
      title: opts.title, description: opts.description, reason: opts.decisionReason,
      canAlways: !!suggestions,
    });
    setState(s, 'waiting');
    signal?.addEventListener('abort', () => {
      if (!s.pending.has(rid)) return;
      settle(s, rid, false);
    }, { once: true });
  });
}

function settle(s, rid, allow, { answers, always } = {}) {
  const p = s.pending.get(rid);
  if (!p) return;
  s.pending.delete(rid);
  always = !!(allow && always && p.suggestions);
  emit(s.id, { kind: 'approval_done', rid, allow, ...(allow && answers ? { answers } : {}), ...(always ? { always } : {}) });
  if (!s.pending.size) setState(s, 'running');
  p.resolve(allow
    ? {
        behavior: 'allow',
        updatedInput: answers ? { ...p.input, answers } : p.input,
        ...(always ? { updatedPermissions: p.suggestions } : {}),
      }
    : { behavior: 'deny', message: 'The user denied this action.' });
}

const clip = (t, n = MAX_TOOL_OUTPUT) => (t.length > n ? t.slice(0, n) + `\n… (${t.length - n} more chars)` : t);

// Keep the event log small: it is replayed over ssh on every reconnect.
function slim(s, m) {
  if (m.type === 'user') {
    const { tool_use_result, ...rest } = m;
    const blocks = Array.isArray(rest.message?.content) ? rest.message.content : null;
    const content = blocks
      ? blocks.map((b) => (b.type === 'tool_result' ? { ...b, content: clipResult(b.content) } : b))
      : rest.message?.content;
    const out = { ...rest, message: { ...rest.message, content } };
    // Edit/Write report a patch with real file line numbers; keep just that for the diff view.
    const tr = blocks?.find((b) => b.type === 'tool_result');
    const patch = tool_use_result?.structuredPatch;
    const toolName = tr && s.toolNames.get(tr.tool_use_id);
    // Subagent report without the harness framing the model sees.
    if ((toolName === 'Agent' || toolName === 'Task') && tool_use_result?.status) {
      const r = tool_use_result;
      out.agent = {
        status: r.status,
        text: Array.isArray(r.content) ? clip(r.content.map((c) => c.text || '').join('\n')) : undefined,
        toolUses: r.totalToolUseCount, durationMs: r.totalDurationMs, tokens: r.totalTokens,
      };
    }
    if (tr && Array.isArray(patch) && (toolName === 'Edit' || toolName === 'Write')) {
      let budget = 3000;
      out.patch = {
        filePath: tool_use_result.filePath,
        type: tool_use_result.type,
        hunks: patch.filter((h) => (budget -= h.lines.length) >= 0),
        truncated: budget < 0,
      };
    }
    return out;
  }
  if (m.type === 'assistant') {
    const content = [];
    for (const b of m.message.content) {
      if (b.type === 'tool_use') s.toolNames.set(b.id, b.name);
      if (b.type === 'redacted_thinking') continue;
      if (b.type === 'thinking') {
        if (b.thinking?.trim()) content.push({ type: 'thinking', thinking: clip(b.thinking) });
        continue;
      }
      content.push(b);
    }
    return { ...m, message: { ...m.message, content } };
  }
  return m;
}

function clipResult(c) {
  if (typeof c === 'string') return clip(c);
  if (!Array.isArray(c)) return c;
  return c.map((b) => (b.type === 'text' ? { ...b, text: clip(b.text) } : { type: 'text', text: `[${b.type}]` }));
}

// What each SDK message does to its session, by `type/subtype` (system messages) or `type`. A message
// no entry knows is left out. (Live activity, e.g. thinking tokens or tool progress: activity().)
const ON_MESSAGE = {
  'system/init'(s, m) {
    if (s.initDone) { // init repeats every turn
      selfStart(s); // a turn begins: one Claude started for a report it got?
      if (m.permissionMode && m.permissionMode !== s.mode) setMeta(s, { mode: m.permissionMode });
      return;
    }
    s.mode = m.permissionMode; // initial mode: shown by the init event itself
    s.initDone = true;
    if (s.resumeAt) setRewindPoint(s.claudeSessionId, null); // the transcript now goes on from the rewind point
    s.claudeSessionId = m.session_id;
    rememberOurs(m.session_id);
    touchRecent(s);
    if (s.color) saveColor(s); // coloured before its id was known
    emit(s.id, { kind: 'init', model: m.model, mode: m.permissionMode, claudeSessionId: m.session_id });
    refreshStats(s);
  },
  'system/session_state_changed'(s, m) {
    // Idle is authoritative when the CLI reports it (e.g. after an interrupt), but it comes after the
    // result: if the next queued message went in at that result, this idle is about the turn before it.
    if (m.state !== 'idle' || s.sentSinceResult) return;
    s.queued = 0;
    if (!s.pending.size) setState(s, 'idle');
    drainQueue(s);
  },
  'system/status'(s, m) {
    if (m.permissionMode && m.permissionMode !== s.mode) setMeta(s, { mode: m.permissionMode });
  },
  stream_event(s, m) { streamDelta(s, m.event, m.parent_tool_use_id); },
  // A hook that ran: shown in the turn when it said something or failed (silent successes are skipped).
  'system/hook_response'(s, m) {
    const out = String(m.stderr || m.stdout || m.output || '').trim();
    if (out || m.outcome !== 'success') emit(s.id, { kind: 'sys', subtype: 'hook', event: m.hook_event, name: m.hook_name, outcome: m.outcome, exit: m.exit_code, text: clip(out) });
  },
  'system/informational'(s, m) {
    if (m.level !== 'info') emit(s.id, { kind: 'sys', subtype: 'info', level: m.level, text: clip(String(m.content || '')) });
  },
  'system/compact_boundary'(s, m) {
    emit(s.id, { kind: 'sys', subtype: 'compact', trigger: m.compact_metadata?.trigger, pre: m.compact_metadata?.pre_tokens, post: m.compact_metadata?.post_tokens });
  },
  'system/api_retry'(s, m) {
    emit(s.id, { kind: 'sys', subtype: 'retry', attempt: m.attempt, max: m.max_retries, status: m.error_status, delay: m.retry_delay_ms });
  },
  'system/local_command_output'(s, m) { emit(s.id, { kind: 'sys', subtype: 'local', text: clip(String(m.content ?? '')) }); },
  user(s, m) {
    // The CLI repeats each message it takes in (--replay-user-messages): those sent from here are shown already;
    // the rest came from elsewhere (a report, another session).
    if (m.isReplay) {
      if (m.parent_tool_use_id || s.sent.has(m.uuid) || s.shownUuids.has(m.uuid)) return;
      const note = originNote(s, m.origin, null, m.message?.content);
      if (!note || (note.taskId && s.shownTasks.has(note.taskId))) return;
      const held = note.taskId && s.held.get(note.taskId); // what the task_notification knew that the message doesn't
      trigger(s, { ...held, ...Object.fromEntries(Object.entries(note).filter(([, v]) => v !== undefined && v !== '')), uuid: m.uuid });
      return;
    }
    const note = !m.parent_tool_use_id && parseNotification(m.message?.content);
    if (!note) return addMessage(s, m);
    if (!note.taskId || !s.shownTasks.has(note.taskId)) trigger(s, note);
  },
  // A command the CLI queued itself started: a schedule firing, a message from another session. The
  // transcript has its text and where it came from, written at about the same moment: looked for a few times.
  command_lifecycle(s, m) {
    const uuid = m.command_uuid;
    if (m.state !== 'started' || !uuid || s.sent.has(uuid) || s.shownUuids.has(uuid)) return;
    s.awaitCmd = uuid;
    for (const ms of [0, 100, 300, 1000, 3000]) setTimeout(() => commandNote(s, uuid), ms);
  },
  assistant: (s, m) => addMessage(s, m),
  result: (s, m) => addMessage(s, m),
};
// A conversation message: into the event log, and a result ends the turn (then the next queued one goes).
function addMessage(s, m) {
  const msg = slim(s, m);
  if (msg.type === 'assistant' && !msg.message.content.length) return; // thinking only
  // Claude can start a turn on its own (e.g. a background task finished).
  if (msg.type === 'assistant' && !msg.parent_tool_use_id) selfStart(s, true);
  if (msg.type === 'assistant' && s.state === 'idle') setState(s, 'running');
  emit(s.id, { kind: 'msg', msg });
  // A "<synthetic>" message is the CLI's own answer (a slash command, or "Not logged in"), not Claude's.
  if (msg.type === 'assistant' && msg.message.model === '<synthetic>') {
    if (/not logged in/i.test(msg.message.content.map((b) => b.text || '').join(' '))) checkAuth(); // e.g. logged out from a terminal
  } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
    s.turnText = (s.turnText || '') + msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (m.type !== 'result') return;
  touchRecent(s);
  s.sentSinceResult = false;
  s.turnShown = false;
  s.awaitCmd = null; // (a command whose transcript entry never showed: not looked for at every later message)
  s.shownTasks.clear();
  s.shownUuids.clear();
  if (--s.queued > 0) return;
  s.queued = 0;
  setState(s, 'idle');
  refreshStats(s, true);
  if (m.num_turns) predictNext(s);
  drainQueue(s);
}


// ---- the system prompt: Claude Code's own, or the user's text in its place (Settings → System prompt) ----
// Claude Code writes its prompt itself, for the model and the folder, and has no command that shows it.
// So it is asked the way a session asks: a CLI started only for this, with what a session's CLI gets,
// sends its first request to an API address of ours, which keeps the prompt and refuses the request.
// Nothing reaches Anthropic and nothing is spent. Hooks and MCP servers, which don't change the prompt,
// are left out of that CLI: it must not run the user's hooks or start their servers just to be read.
// (_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: for an API address that isn't Anthropic's the CLI leaves
// parts of the prompt out, as it does in the sessions of a user whose ANTHROPIC_BASE_URL names a gateway.
// `key`: see below.)
// Resolves to { model, blocks: the prompt's text blocks }.
// (COUNTER: a count of tokens left that Claude Code puts in the prompt in some launches and not in others,
// an experiment of its own; it is no part of the text, and adds it to any prompt itself.)
const COUNTER = /^<total_tokens>.*<\/total_tokens>\n*/gm;
async function sentPrompt(opts, key) {
  let got = null, seen;
  const asked = new Promise((r) => (seen = r));
  const api = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      try {
        const j = JSON.parse(Buffer.concat(parts).toString());
        // (the conversation's request has the tools; one for a title or a quota check has none)
        if (!got && Array.isArray(j.system) && j.tools?.length) {
          got = { model: j.model, blocks: j.system.map((b) => (b.text || '').replace(COUNTER, '')).filter((t) => t.trim() && !t.startsWith('x-anthropic-billing-header')) };
          seen();
        }
      } catch {}
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'IroWell only reads the system prompt here' } }));
    });
  });
  await new Promise((ok, no) => api.once('error', no).listen(0, '127.0.0.1', ok));
  const local = [process.env.NO_PROXY || process.env.no_proxy, '127.0.0.1'].filter(Boolean).join(',');
  const { env, ...rest } = harness();
  const options = {
    ...rest, ...opts, persistSession: false, strictMcpConfig: true, settings: { disableAllHooks: true },
    env: { ...env, ...(env.ANTHROPIC_BASE_URL ? {} : { _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1' }), ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`, NO_PROXY: local, no_proxy: local, ...(key ? { ANTHROPIC_API_KEY: key } : {}) },
    stderr: () => {},
  };
  // (its own answer, when it ends without having asked: "Not logged in", say)
  const ended = async (q) => { try { for await (const m of q) if (m.type === 'result') return String(m.result || ''); } catch (e) { return String(e?.message || e); } return ''; };
  let why;
  try {
    why = await oneShot({ prompt: '.', options }, (q) => Promise.race([asked, ended(q)]), 30e3);
  } catch (e) {
    why = String(e?.message || e);
  } finally {
    api.close();
    api.closeAllConnections();
  }
  if (got) return got;
  // Not logged in, the CLI asks nothing. With an API key it does (any: the request ends at our address).
  if (!key && !process.env.ANTHROPIC_API_KEY) return sentPrompt(opts, 'none');
  throw new Error(`Claude Code did not show its system prompt${why ? `: ${why}` : ''}`);
}
const ownPromptOption = (append = uiPrompt()) => ({ systemPrompt: { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) } });
// `text` in the place of Claude Code's own. The UI's part still follows it: there is no `append` beside a
// prompt of one's own, so it goes as the CLI flag. (With it the CLI also keeps its usual opening line.)
const userPromptOption = (text, append = uiPrompt()) => ({ systemPrompt: text, ...(append ? { extraArgs: { 'append-system-prompt': append } } : {}) });
// The user's text (no file: Claude Code's own prompt is used). In it {{memory_dir}} stands for the
// folder's memory folder, the one thing in Claude Code's prompt that differs from folder to folder.
const USER_PROMPT_FILE = path.join(DIR, 'system-prompt.md');
const MEMORY_DIR = '{{memory_dir}}';
const memoryDirIn = (text) => /`([^`\n]+[\\/]memory[\\/]?)`/.exec(text)?.[1] || '';

// Claude Code's prompt for a session in `cwd` on `model`, in the three parts a session is sent:
//   before  its opening line, which stays whatever replaces the rest
//   text    what Settings → System prompt shows and replaces (the memory folder written {{memory_dir}})
//   after   what always follows: what Claude Code adds to any prompt, then the UI's part (uiPrompt)
// Where `text` ends is asked of a second CLI, given a mark for a prompt: what it sends around the mark.
async function ownPrompt(cwd, model) {
  const append = uiPrompt(), mark = `irowell-${randomUUID()}`;
  const [own, marked] = await Promise.all([
    sentPrompt({ cwd, ...(model ? { model } : {}), ...ownPromptOption(append) }),
    sentPrompt({ cwd, ...(model ? { model } : {}), ...userPromptOption(mark, append) }),
  ]);
  const join = (blocks) => blocks.map((t) => t.trim()).join('\n\n');
  let before = own.blocks.length > 1 ? own.blocks[0].trim() : '';
  let text = join(own.blocks.slice(own.blocks.length > 1 ? 1 : 0));
  const around = join(marked.blocks.slice(marked.blocks.length > 1 ? 1 : 0)).split(mark);
  const [lead, tail] = around.length === 2 ? around.map((t) => t.trim()) : ['', ''];
  // (the UI's part alone: a CLI that answers the mark some other way)
  const after = [tail, append].find((t) => t && text.endsWith(t)) || '';
  text = text.slice(0, text.length - after.length).trimEnd();
  if (lead && text.startsWith(lead)) { text = text.slice(lead.length).trimStart(); before = [before, lead].filter(Boolean).join('\n\n'); }
  const dir = memoryDirIn(text);
  return { model: own.model, before, text: dir ? text.replaceAll(dir, MEMORY_DIR) : text, after };
}

// What a session's CLI is given for a prompt: Claude Code's own, or the user's text. null: that text
// names the folder's memory folder, and it has yet to be asked for (sessionPromptSoon).
const memoryDirs = new Map(); // folder -> its memory folder as Claude Code names it ('': it names none)
function sessionPrompt(s, asked = false) {
  const text = readPrompt(USER_PROMPT_FILE);
  if (!text) return ownPromptOption();
  if (!text.includes(MEMORY_DIR)) return userPromptOption(text);
  if (!memoryDirs.has(s.cwd) && !asked) return null;
  const dir = memoryDirs.get(s.cwd);
  if (dir) return userPromptOption(text.replaceAll(MEMORY_DIR, dir));
  emit(s.id, { kind: 'error', text: `Your system prompt (Settings → System prompt) names ${MEMORY_DIR}, and Claude Code did not say where this folder's memory folder is: this session runs on Claude Code's own prompt.` });
  return ownPromptOption();
}
// Asked once per folder (a second or two, during which the session has no CLI yet: what is sent to it waits).
async function sessionPromptSoon(s) {
  try {
    memoryDirs.set(s.cwd, memoryDirIn((await sentPrompt({ cwd: s.cwd, ...(s.model ? { model: s.model } : {}), ...ownPromptOption() })).blocks.join('\n')));
  } catch (e) { log(`[${s.id}] memory folder`, e.message); }
  return sessionPrompt(s, true);
}

// What a session's CLI is started with that decides which tools it has, and so what its system prompt
// says: the CLI that is only asked for that prompt (sentPrompt) gets the same.
// The Artifact tools and forked subagents, which a headless CLI leaves out, are turned on unless the
// environment says otherwise (CLAUDE_CODE_ARTIFACT=0 / _FORK_SUBAGENT=0). `plugins`: the skills for
// showing things in this UI, which the terminal's `claude` doesn't get.
const harness = () => ({
  ...(SKILLS_DIR ? { plugins: [{ type: 'local', path: SKILLS_DIR }] } : {}),
  // A comment sent to Claude on an artifact is first checked against the permission to reply. In auto
  // mode that check asks the classifier, which a headless CLI reports as unavailable, and the comment is
  // then dropped without a word: allowing the tool by rule lets the comment start a turn, as in the terminal.
  allowedTools: ['ArtifactComments'],
  env: { ...process.env, CLAUDE_CODE_ARTIFACT: process.env.CLAUDE_CODE_ARTIFACT ?? '1', CLAUDE_CODE_FORK_SUBAGENT: process.env.CLAUDE_CODE_FORK_SUBAGENT ?? '1' },
});

async function run(s) {
  // (at once, but for the first session of a folder under an edited system prompt: see sessionPrompt)
  const prompt = sessionPrompt(s) || await sessionPromptSoon(s);
  if (!alive(s) || moving.has(s.id)) return over(s); // closed, or handed to the next daemon, meanwhile
  // (query() itself throws when there is no Claude Code to start: that ends the session like a failed one)
  try {
    s.q = query({
      prompt: s.inbox,
      options: {
        cwd: s.cwd,
        // As close to the terminal's `claude` as a headless CLI gets: Claude Code's own system prompt
        // (without it the SDK sends an empty one), the permission mode from settings.json
        // (permissions.defaultMode; the SDK would force "default"), file checkpoints as the terminal
        // keeps them, and Stop sparing background tasks (the Tasks tab stops them one by one).
        // Bypass permissions can be picked (like `claude --allow-dangerously-skip-permissions`; the UI
        // asks first).
        // The prompt has, after Claude Code's (or the text Settings → System prompt put in its place),
        // what the terminal's prompt can't know about this UI (skills/system-prompt.md).
        ...prompt,
        ...harness(),
        // Each message the CLI takes in comes back on its stream, a report or another session's message too:
        // the UI shows what Claude answers (see trigger()).
        extraArgs: { ...prompt.extraArgs, 'replay-user-messages': null },
        resolvePermissionModeInCli: true,
        enableFileCheckpointing: true,
        perTaskStopAffordance: true,
        allowDangerouslySkipPermissions: true,
        // Hook runs and a one-line summary of what each subagent is doing, as the terminal shows them.
        includeHookEvents: true,
        agentProgressSummaries: true,
        // A branch: a copy of the conversation (up to `at`, an assistant message) under a new session id.
        ...(s.fork ? { forkSession: true } : {}),
        // A branch, or a rewind: the conversation only up to this assistant message.
        ...(s.fork?.at || s.resumeAt ? { resumeSessionAt: s.fork?.at || s.resumeAt } : {}),
        canUseTool: (tool, input, opts) => askApproval(s, tool, input, opts),
        // What the user changed in the session's progress list since Claude last read it goes with their message.
        // Where the session works (beside the title): a tool run in another worktree asks it whether it works there now.
        hooks: {
          UserPromptSubmit: [{ hooks: [async (input) => { s.workplaceAsked?.clear(); return progressNews(input.session_id); }] }],
          PostToolUse: [{ hooks: [async (input) => workplaceCheck(s, input)] }],
        },
        includePartialMessages: true,
        ...(s.model ? { model: s.model } : {}),
        ...(s.mode ? { permissionMode: s.mode } : {}),
        ...(s.effort ? { effort: s.effort } : {}),
        ...(s.resume ? { resume: s.resume } : {}),
        stderr: (d) => log(`[${s.id}] stderr`, d.trimEnd()),
      },
    });
    for await (const m of s.q) {
      s.lastMsgAt = Date.now();
      // A message this code can't handle must not end the session: the CLI is still running.
      try {
        if (activity(s, m)) continue;
        (ON_MESSAGE[`${m.type}/${m.subtype}`] || ON_MESSAGE[m.type])?.(s, m);
      } catch (e) {
        log(`[${s.id}] cannot handle ${m?.type}/${m?.subtype}`, e);
      }
    }
  } catch (e) {
    log(`[${s.id}] query failed`, e);
    emit(s.id, { kind: 'error', text: String(e?.message || e) });
  }
  over(s);
}
// The session's CLI is gone (or was never started).
function over(s) {
  for (const rid of [...s.pending.keys()]) settle(s, rid, false);
  if (!s.replaced) { // (a rewind restarts the CLI under the same sid: that session goes on)
    setState(s, 'ended');
    clearQueue(s);
    // Its tasks went with it: no Tasks tab or heartbeat for them any more.
    let ended = false;
    for (const t of s.tasks.values()) if (t.status === 'running' || t.status === 'pending') { t.status = 'stopped'; ended = true; }
    if (ended) sendTasks(s);
  }
  s.finished();
}

// ---- activity: what the session is doing right now (live only, not logged) ----
function taskView(t) {
  return { id: t.id, description: t.description, type: t.type, status: t.status, background: !!t.background,
    toolUses: t.toolUses, tokens: t.tokens, lastTool: t.lastTool, started: t.started, summary: t.summary };
}
const runningTasks = (s) => [...s.tasks.values()].filter((t) => t.status === 'running' || t.status === 'pending').map(taskView);
function sendTasks(s) {
  partial(s.id, { op: 'tasks', tasks: runningTasks(s), procs: s.procs || [] });
}

// Processes a session left running on its own (nohup/setsid/`&` from its Bash tool): they carry the
// session's CLAUDE_CODE_SESSION_ID in their environment but no longer descend from its CLI process.
// Linux only (/proc); scanned every 10 s.
const HAS_PROC = fs.existsSync('/proc/self/environ');
let bootTime = 0;
try { bootTime = Number(/btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]); } catch {}
function procStat(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(rest[1]), start: bootTime + Number(rest[19]) / 100 };
  } catch { return null; }
}
function descendsFrom(pid, ancestor) {
  for (let p = pid, i = 0; p > 1 && i < 64; i++) {
    if (p === ancestor) return true;
    p = procStat(p)?.ppid ?? 0;
  }
  return false;
}
function procScan() {
  if (!HAS_PROC) return;
  const byId = new Map();
  for (const s of sessions.values()) if (s.claudeSessionId) byId.set(s.claudeSessionId, s);
  if (!byId.size) return;
  const found = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync('/proc'); } catch { return; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    let env;
    try { env = fs.readFileSync(`/proc/${d}/environ`, 'latin1'); } catch { continue; }
    const m = /(?:^|\0)CLAUDE_CODE_SESSION_ID=([0-9a-f-]{36})/.exec(env);
    const s = m && byId.get(m[1]);
    if (!s) continue;
    const cli = Number(/(?:^|\0)CLAUDE_PID=(\d+)/.exec(env)?.[1] || 0);
    const pid = Number(d);
    if (cli && descendsFrom(pid, cli)) continue; // still under the CLI: a tool call or MCP server
    const st = procStat(pid);
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
    if (!found.has(s)) found.set(s, []);
    found.get(s).push({ pid, ppid: st?.ppid, cmd: cmd.slice(0, 300), started: st ? Math.round(st.start * 1000) : null });
  }
  for (const s of sessions.values()) {
    const all = found.get(s) || [];
    const pids = new Set(all.map((p) => p.pid));
    const roots = all.filter((p) => !pids.has(p.ppid)) // show each job once, by its top process
      .map((p) => ({ ...p, children: all.filter((c) => c.ppid === p.pid).length }));
    const key = roots.map((p) => p.pid).join(',');
    if (key !== (s.procKey || '')) {
      s.procKey = key;
      s.procs = roots;
      sendTasks(s);
    }
  }
}
setInterval(procScan, 10000);
// Returns true when the message is only activity information.
function activity(s, m) {
  if (m.type === 'system' && m.subtype === 'thinking_tokens') {
    partial(s.id, { op: 'act', what: 'thinking', tokens: m.estimated_tokens });
    return true;
  }
  if (m.type === 'tool_progress') {
    partial(s.id, { op: 'act', what: 'tool', toolUseId: m.tool_use_id, tool: m.tool_name, elapsed: m.elapsed_time_seconds, parent: m.parent_tool_use_id });
    return true;
  }
  if (m.type !== 'system') return false;
  const t = m.task_id && (s.tasks.get(m.task_id) || { id: m.task_id, started: Date.now(), status: 'running' });
  switch (m.subtype) {
    case 'task_started':
      Object.assign(t, { description: m.description, type: m.subagent_type || m.task_type || m.workflow_name || 'task', agent: !!m.subagent_type || /agent/.test(m.task_type || ''), background: !!m.is_backgrounded });
      break;
    case 'task_updated':
      if (m.patch?.status) t.status = m.patch.status;
      if (m.patch?.description) t.description = m.patch.description;
      if (m.patch?.is_backgrounded != null) t.background = m.patch.is_backgrounded;
      break;
    case 'task_progress':
      Object.assign(t, { description: m.description || t.description, toolUses: m.usage?.tool_uses, tokens: m.usage?.total_tokens, lastTool: m.last_tool_name, summary: m.summary || t.summary });
      break;
    case 'task_notification':
      t.status = m.status;
      // A background task reporting back: Claude reads it in the turn running, or starts one for it (see selfStart).
      if (t.background && !s.shownTasks.has(m.task_id)) s.held.set(m.task_id, taskNote(m, t));
      break;
    case 'background_tasks_changed': {
      const list = m.tasks || [];
      const alive = new Set(list.map((x) => x.task_id));
      for (const x of list) {
        const cur = s.tasks.get(x.task_id) || { id: x.task_id, started: Date.now(), status: 'running' };
        Object.assign(cur, { description: x.description, type: cur.type || x.task_type, background: true });
        s.tasks.set(x.task_id, cur);
      }
      for (const [id, x] of s.tasks) if (x.background && !alive.has(id) && x.status === 'running') x.status = 'completed';
      sendTasks(s);
      return true;
    }
    default:
      return false;
  }
  s.tasks.set(t.id, t);
  sendTasks(s);
  return true;
}

// A heartbeat for every busy session: proves the daemon is alive.
setInterval(() => {
  for (const s of sessions.values()) {
    if (!alive(s)) continue; // (its CLI is gone)
    const busy = s.state === 'running' || s.state === 'waiting';
    const bg = [...(s.tasks?.values() || [])].some((t) => t.status === 'running');
    if (!busy && !bg) continue;
    partial(s.id, { op: 'tick', turnStart: s.turnStart, at: Date.now() });
  }
}, 3000);

// model / permission mode / title changes
function setMeta(s, meta) {
  Object.assign(s, meta);
  emit(s.id, { kind: 'meta', ...meta });
  if ('title' in meta) touchRecent(s, false);
  if ('color' in meta) saveColor(s);
}

function streamDelta(s, ev, parent) {
  const p = parent ? { parent } : {};
  if (ev.type === 'content_block_start') {
    const t = ev.content_block?.type;
    if (t === 'text' || t === 'thinking') partial(s.id, { op: 'start', block: t, ...p });
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta;
    if (d?.type === 'text_delta') partial(s.id, { op: 'delta', block: 'text', text: d.text, ...p });
    else if (d?.type === 'thinking_delta') partial(s.id, { op: 'delta', block: 'thinking', text: d.thinking, ...p });
  }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function sendText(s, text, images = []) {
  try { s.predQ?.close(); } catch {} // a guess for the previous turn is useless now
  if (!(s.state === 'running' || s.state === 'waiting')) s.turnStart = Date.now();
  s.lastMsgAt = Date.now();
  s.lastUserText = text;
  s.turnText = '';
  s.turnNo = (s.turnNo || 0) + 1;
  images = (Array.isArray(images) ? images : [])
    .filter((im) => IMAGE_TYPES.has(im?.media_type) && typeof im.data === 'string' && im.data.length < 7_000_000)
    .slice(0, 5);
  const uuid = randomUUID(); // the CLI keeps it: a rewind names this message by it
  s.sent.add(uuid);
  if (s.sent.size > 500) s.sent.delete(s.sent.values().next().value);
  s.turnShown = true;
  s.held.clear(); // a report not answered yet goes in with this message
  emit(s.id, { kind: 'user_text', text, uuid, ...(images.length ? { images } : {}) });
  touchRecent(s);
  s.queued++;
  s.sentSinceResult = true;
  setState(s, s.pending.size ? 'waiting' : 'running');
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), { type: 'text', text }]
    : text;
  s.inbox.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null });
}

// ---- queued messages ----
// A message sent while Claude is busy waits here until the turn ends; handed to the CLI at once it
// would slip into the running turn. Each one becomes a turn of its own, in order. "Send now" moves
// one to the front and interrupts the turn (the terminal's Ctrl+X Ctrl+S).
const turnBusy = (s) => s.state === 'running' || s.state === 'waiting' || s.queued > 0;
function emitQueue(s) {
  emit(s.id, { kind: 'queue', items: s.outbox.map((m) => ({ qid: m.qid, text: m.text, images: m.images.length })) });
}
function enqueue(s, text, images = [], command) {
  (s.outbox ||= []).push({ qid: randomUUID().slice(0, 8), text, images: Array.isArray(images) ? images : [], ...(command ? { command } : {}) });
  emitQueue(s);
}
function drainQueue(s) {
  if (!s.outbox?.length || turnBusy(s) || s.holding || !alive(s)) return;
  const m = s.outbox.shift();
  emitQueue(s);
  if (m.command) return void runQueued(s, m.command);
  sendText(s, m.text, m.images);
}
// The commands that change the session wait their turn here like a message (the page runs them itself
// when nothing is going on), and are run here when it comes. The pages that have the session open are
// told what to open instead (live only: a replayed log must not move anyone).
const QUEUED = {
  // The session is archived. What was queued behind it goes on in a fresh session of the folder, with
  // the same model and mode (a command right behind it has nothing to act on there, and is dropped).
  clear(s) {
    const rest = s.outbox.splice(0);
    while (rest[0]?.command) rest.shift();
    let next = null;
    if (rest.length) {
      try {
        next = sessions.get(handlers.new(null, { cwd: s.cwd, text: rest[0].text, images: rest[0].images, model: s.model, mode: s.mode, effort: settings.defaults?.effort || undefined }).sid);
      } catch (e) {
        s.outbox = rest; // (the folder is gone, say: they stay here)
        throw e;
      }
      next.outbox = rest.slice(1);
      if (next.outbox.length) emitQueue(next);
    }
    partial(s.id, { op: 'cleared', next: next?.id || null });
    handlers.archive(null, { sid: s.id, claudeSessionId: s.claudeSessionId || null });
  },
  detach(s) { handlers.close(null, { sid: s.id }); },
  // Of the conversation as it is now: the next queued message is not part of the copy.
  async branch(s, title) {
    const at = events.findLast((e) => e.sid === s.id && e.kind === 'msg' && e.msg.type === 'assistant' && !e.msg.parent_tool_use_id && e.msg.uuid && e.msg.message.model !== '<synthetic>')?.msg.uuid;
    const make = (at) => handlers.branch(null, { sid: s.id, title: title || undefined, at });
    const { sid } = await make(at).catch(() => make()); // (a point its transcript doesn't have: all of it)
    partial(s.id, { op: 'branched', to: sid });
  },
};
const queuedCommand = (text) => {
  const m = /^\/([a-z]+)\s*([\s\S]*)$/.exec(String(text || '').trim());
  return m && Object.hasOwn(QUEUED, m[1]) ? { name: m[1], args: m[2].trim() } : null;
};
// Nothing else of the queue goes while one runs (a branch reads the transcript first).
async function runQueued(s, { name, args }) {
  s.holding = true;
  try {
    await QUEUED[name](s, args);
  } catch (e) {
    log(`[${s.id}] queued /${name} failed`, e);
    emit(s.id, { kind: 'error', text: `/${name}: ${String(e?.message || e)}` });
  }
  s.holding = false;
  drainQueue(s);
}
function clearQueue(s) {
  if (!s.outbox?.length) return;
  s.outbox = [];
  emitQueue(s);
}

// "~/x", "x" (relative to home) and "/abs/x" all work.
function resolveDir(input) {
  const dir = userPath((input || '').trim() || '~');
  try {
    // The real path, as the CLI records it in transcripts: symlinked spellings are the same folder.
    if (fs.statSync(dir).isDirectory()) return fs.realpathSync(dir);
  } catch {}
  return null;
}

// ---- what started a turn you didn't send ----
// Claude also starts a turn (or reads something in the middle of one) because a background task or a subagent
// reported back, another session sent a message, or a scheduled prompt fired. Each is a note the UI shows where
// it came in: { source: 'agent' | 'task' | 'session' | 'wakeup' | 'other', title, body, from, status, exit, … }.
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
const firstLine = (t) => String(t || '').trim().split('\n')[0].slice(0, 200);
const exitOf = (summary) => { const x = /exit code (\d+)/.exec(summary || ''); return x ? Number(x[1]) : undefined; };

// A background task or subagent reporting back, from the user message the CLI writes for it.
function parseNotification(content) {
  const text = textOf(content);
  if (!text.trimStart().startsWith('<task-notification>')) return null;
  const tag = (t) => (new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(text)?.[1] ?? '').trim();
  const num = (t) => { const v = tag(t); return v ? Number(v) : undefined; };
  const summary = tag('summary');
  const named = /^(Agent|Background command|Monitor|Workflow) "([\s\S]*)" \w+/.exec(summary); // Agent "Find X" finished
  return {
    source: named?.[1] === 'Agent' ? 'agent' : 'task', taskId: tag('task-id'), status: tag('status'),
    title: named?.[2] || summary, exit: exitOf(summary), body: clip(tag('result'), 8000) || undefined,
    tokens: num('subagent_tokens'), toolUses: num('tool_uses'), durationMs: num('duration_ms'),
  };
}

// The same, from the CLI's task_notification (`t`: the task as its task_* messages described it).
function taskNote(m, t) {
  const agent = t.agent ?? /agent/.test(t.type || '');
  let body;
  if (agent) body = clip(String(m.summary || ''), 8000); // a subagent's summary is its report
  else if (m.output_file) { // the end of what the command printed
    try {
      const size = fs.statSync(m.output_file).size, n = Math.min(size, 4000);
      body = (size > n ? '…' : '') + readRange(m.output_file, size - n, n).toString('utf8');
    } catch {}
  }
  return {
    source: agent ? 'agent' : 'task', taskId: m.task_id, status: m.status,
    title: t.description || /^\w[\w ]* "([\s\S]*)" \w+/.exec(m.summary || '')?.[1] || firstLine(m.summary),
    exit: exitOf(m.summary), body: body?.trim() ? body : undefined, tokens: m.usage?.total_tokens, toolUses: m.usage?.tool_uses,
    durationMs: m.usage?.duration_ms ?? (t.started ? Date.now() - t.started : undefined),
  };
}

// A note from a user message's provenance (`origin`; `turnOrigin`: the transcript's, 'scheduled' for a schedule
// firing); null for what you sent and for the CLI's own context (skills, image notes, reminders). `s`: the live
// session, whose tasks name a subagent (null when reading a transcript).
function originNote(s, origin, turnOrigin, content) {
  const text = textOf(content);
  const o = origin || {};
  if (o.kind === 'human') return null;
  if (turnOrigin === 'scheduled' || o.subkind === 'scheduled-trigger') return { source: 'wakeup', title: firstLine(text), body: clip(text, 8000) };
  const note = parseNotification(content);
  if (note) return note;
  // older transcripts carry no origin, only the envelope
  const env = !o.kind && /^Another Claude session sent a message:\s*<[\w-]+ ([^>]*)>\n?([\s\S]*?)<\/[\w-]+>/.exec(text);
  if (env) {
    const body = env[2].trim();
    return { source: 'session', from: /from-name="([^"]*)"/.exec(env[1])?.[1] || 'Another session', title: firstLine(body), body: clip(body, 8000) };
  }
  if (o.kind === 'peer') {
    const body = o.body ?? text;
    if (o.handback || o.senderTaskId) { // one of this session's subagents
      const report = o.handback ? body.replace(/^\[Subagent hand-back\][\s\S]*?The report follows:\n/, '').replace(/^ {2}/gm, '') : body;
      const t = s?.tasks?.get(o.senderTaskId);
      return { source: 'agent', taskId: o.senderTaskId, status: o.handback ? 'completed' : undefined, title: t?.description || o.name || 'Subagent', body: clip(report.trim(), 8000) };
    }
    return { source: 'session', from: o.name || 'Another session', title: firstLine(body), body: clip(body.trim(), 8000) };
  }
  if (o.kind === 'task-notification' && o.subkind === 'peer-send-message') return { source: 'session', from: 'Another session', title: firstLine(text), body: clip(text, 8000) };
  if (o.kind === 'coordinator') return { source: 'session', from: 'Coordinator', title: firstLine(text), body: clip(text, 8000) };
  if (o.kind === 'channel') return { source: 'other', from: o.server, title: firstLine(text), body: clip(text, 8000) };
  if (o.kind && o.kind !== 'unclassified' && text.trim()) return { source: 'other', title: firstLine(text), body: clip(text, 8000) };
  return null;
}

// The note for a command the CLI started itself (command_lifecycle), once its transcript entry is there.
function commandNote(s, uuid) {
  if (s.awaitCmd !== uuid) return; // shown, or another one started since
  s.transcript ||= s.claudeSessionId && transcriptIndex().get(s.claudeSessionId);
  const e = s.transcript && transcriptEntry(s.transcript, uuid);
  if (!e) return;
  s.awaitCmd = null;
  const note = originNote(s, e.origin, e.turnOrigin, e.message?.content);
  if (note && !s.shownUuids.has(uuid)) trigger(s, { ...note, uuid });
}

// Shows a note: a turn of its own when Claude was idle (it starts one for it), else in the turn running.
function trigger(s, note) {
  const idle = !(s.state === 'running' || s.state === 'waiting');
  if (note.taskId) { s.shownTasks.add(note.taskId); s.held.delete(note.taskId); }
  if (note.uuid) s.shownUuids.add(note.uuid);
  s.turnShown = true;
  if (idle) { s.turnStart = Date.now(); s.turnText = ''; }
  emit(s.id, { kind: 'notify', ...note, turn: idle });
  if (idle) setState(s, 'running');
}
// Claude started a turn nobody announced: the background reports it got meanwhile are what it answers;
// with none (`fallback`, at its first words), it still gets a head.
function selfStart(s, fallback) {
  if (s.awaitCmd) commandNote(s, s.awaitCmd);
  if (s.turnShown || s.state === 'running' || s.state === 'waiting') return;
  const held = [...s.held.values()];
  for (const note of held) trigger(s, note);
  if (!held.length && fallback) trigger(s, { source: 'other', title: '' });
}

// What the user typed, from a stored user message; '' for injected text; null for tool results.
function promptText(content) {
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && !content.some((b) => b.type === 'tool_result')) {
    text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const n = content.filter((b) => b.type === 'image').length;
    if (n) text = `[${n} image${n > 1 ? 's' : ''}] ${text}`;
  } else return null;
  // (each tag looked for on its own: other tags, e.g. <command-message>, sit between them)
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) return `${cmd[1]} ${/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] || ''}`.trim();
  if (/^\s*(<local-command-|<system-reminder>|Caveat: The messages below)/.test(text)) return '';
  return text;
}

// `id`: a session handed over by the previous daemon keeps the sid the UI knows it by.
function newSession({ cwd, title, model, mode, resume }, id = randomUUID().slice(0, 8)) {
  const s = {
    id, cwd, title, state: 'idle', queued: 0, model: model || undefined, mode: mode || undefined,
    resume, inbox: inbox(), pending: new Map(), toolNames: new Map(), tasks: new Map(), created: Date.now(),
    // what started each turn (see trigger()): the uuids of the messages sent from here, reports not shown yet
    // (task id -> note), what this turn has shown, and whether the turn the CLI is in has a head in the UI
    sent: new Set(), held: new Map(), shownTasks: new Set(), shownUuids: new Set(), turnShown: false,
  };
  s.done = new Promise((r) => (s.finished = r)); // run() has returned: its CLI is gone
  sessions.set(s.id, s);
  return s;
}

// ---- status line: model, effort, context, plan limits, session totals ----
const limitWindow = (x) => (x && x.utilization != null ? { pct: x.utilization, resets: x.resets_at } : null);
// The plan level, from the usage API's answer or the CLI's rate_limits (both name the windows alike).
const levelOf = (x) => ({ five: limitWindow(x.five_hour), week: limitWindow(x.seven_day) });
// What /usage shows (plan limits, session totals), asked of the CLI of query `q`: an API the SDK marks experimental.
async function cliUsage(q) {
  const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof fn !== 'function') throw new Error('This SDK version has no usage API');
  return fn.call(q, { skipBehaviors: true });
}

async function collectStats(s) {
  const out = {
    cwd: s.cwd, branch: gitPlace(s.cwd)?.branch ?? null, work: workplace(s), mode: s.mode, title: s.title, claudeSessionId: s.claudeSessionId,
  };
  if (!s.q || !alive(s)) return out;
  const q = s.q;
  const [ctx, cfg, use] = await Promise.all([
    q.getContextUsage({ detail: 'summary' }).catch(() => null),
    q.getSettings().catch(() => null),
    cliUsage(q).catch(() => null),
  ]);
  if (ctx) out.ctx = { used: ctx.totalTokens, max: ctx.maxTokens, pct: ctx.percentage };
  if (cfg?.applied) { out.model = cfg.applied.model; out.effort = cfg.applied.effort; }
  if (use?.session) {
    const u = use.session;
    let inTok = 0, outTok = 0;
    for (const m of Object.values(u.model_usage || {})) {
      inTok += (m.inputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0);
      outTok += m.outputTokens || 0;
    }
    out.session = { cost: u.total_cost_usd, durationMs: u.total_duration_ms, added: u.total_lines_added, removed: u.total_lines_removed, inTok, outTok };
  }
  if (use?.rate_limits) out.limits = levelOf(use.rate_limits);
  return out;
}

// ---- plan usage: the history (sampled on the hour and the half hour) and the level on screen ----
// The usage API is the endpoint the terminal status line uses, with the CLI's own OAuth token
// (Linux: ~/.claude/.credentials.json). It is asked at most once per USAGE_GAP, whoever asks (the
// sampler, a client coming back to the page), except that the sampler's first ask in a slot goes.
const USAGE_FILE = path.join(DIR, 'usage.jsonl');
const USAGE_KEEP = 35 * 24 * 3600 * 1000;
const USAGE_GAP = (Number(process.env.IRO_USAGE_GAP_MIN) || 5) * 60 * 1000;
// An older reading: from an earlier window, or lower within the same one (the level only rises).
function older(cur, prev) {
  if (cur?.pct == null || prev?.pct == null || !cur.resets || !prev.resets) return false;
  const d = new Date(cur.resets) - new Date(prev.resets);
  return d < -2 * 60 * 1000 || (Math.abs(d) < 2 * 60 * 1000 && cur.pct < prev.pct);
}
const isOlder = (l, than) => older(l.five, than?.five) || older(l.week, than?.week);
let lastRecord = readUsage().at(-1) || {}; // the newest sample on file
function recordUsage(limits) {
  if (!limits || (!limits.five && !limits.week)) return;
  if (process.env.IRO_NO_USAGE_RECORD) return; // a test that brings its own usage history (and asks no API)
  if (limits.t <= (lastRecord.t || 0) || isOlder(limits, lastRecord)) return;
  lastRecord = { t: limits.t, five: limits.five, week: limits.week };
  try { fs.appendFileSync(USAGE_FILE, JSON.stringify(lastRecord) + '\n'); } catch {}
}
// (IRO_TEST_USAGE_API: the tests' own usage API, which needs no login and has no CLI behind it.)
const USAGE_API = process.env.IRO_TEST_USAGE_API || 'https://api.anthropic.com/api/oauth/usage';
let retryUntil = 0; // (a 429's Retry-After: not asked before that)
async function usageFromApi() {
  let oauth = process.env.IRO_TEST_USAGE_API ? { accessToken: 'test' } : null;
  if (!oauth) try { oauth = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth; } catch {}
  // macOS keeps Claude Code's login in the Keychain, not in a file: without this a laptop records
  // nothing while no session is open.
  if (!oauth?.accessToken && process.platform === 'darwin' && !process.env.CLAUDE_CONFIG_DIR) {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', 'Claude Code-credentials', '-w'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      oauth = JSON.parse(raw).claudeAiOauth;
    } catch {}
  }
  // The token lives a few hours and only a running CLI renews it: once it has run out (no session
  // open all night) or the API says it is no good, a CLI is asked instead, and it renews the login as
  // it asks. Not when the API refuses otherwise (429 for hours on end, as it does): the CLI asks the
  // same API, so that is a second request for the same refusal.
  if (!oauth?.accessToken || (oauth.expiresAt && oauth.expiresAt < Date.now() + 60e3)) return usageFromCli();
  try {
    const r = await fetch(USAGE_API, {
      headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return { t: Date.now(), ...levelOf(await r.json()) };
    log('usage API', r.status);
    if (r.status === 401) return usageFromCli();
    const after = r.status === 429 ? Number(r.headers.get('retry-after')) || 0 : 0;
    if (after > 0) retryUntil = Date.now() + Math.min(after * 1000, 6 * 3600 * 1000);
  } catch (e) { log('usage API', e.message); }
  return null;
}
// The plan usage as /usage shows it, from a CLI started only to ask and closed before any message.
async function usageFromCli() {
  if (process.env.IRO_TEST_USAGE_API) return null;
  try {
    const u = await oneShot({ prompt: inbox(), options: { cwd: os.homedir(), persistSession: false, settingSources: [] } }, cliUsage, 30e3);
    if (!u?.rate_limits) { log('usage from CLI: none'); return null; }
    return { t: Date.now(), ...levelOf(u.rate_limits) };
  } catch (e) {
    log('usage from CLI', e.message);
    return null;
  }
}
// The plan usage without the usage API: the answer to any message carries it (the CLI passes it on as a
// rate_limit_event: a fraction, and the reset in seconds). So one message goes to the smallest model, and
// the CLI is closed as soon as the numbers are in. This spends a little of the plan, hence only for a slot
// the usage API gave nothing for (see sampleUsage).
// (IRO_TEST_USAGE_TURN: what the message brings back in the tests, with no CLI and no message.)
function eventLimits(info) {
  const win = (w) => (w && w.utilization != null ? { pct: Math.round(w.utilization * 100), resets: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null } : null);
  const five = win(info?.unifiedWindows?.five_hour), week = win(info?.unifiedWindows?.seven_day);
  return five || week ? { t: Date.now(), five, week } : null;
}
async function usageFromTurn() {
  if (process.env.IRO_TEST_USAGE_TURN) return eventLimits(JSON.parse(process.env.IRO_TEST_USAGE_TURN));
  try {
    const got = await oneShot({ prompt: 'El Psy Congroo', options: { cwd: os.homedir(), ...HAIKU_TURN } }, async (q) => {
      for await (const m of q) {
        const got = m.type === 'rate_limit_event' && eventLimits(m.rate_limit_info);
        if (got) return got;
        if (m.type === 'result') break;
      }
      return null;
    }, 60e3);
    if (got) return got;
  } catch (e) { log('usage from a message', e.message); return null; }
  log('usage from a message: none');
  return null;
}
// A query that brought nothing is made again USAGE_RETRY later: after 5 minutes, then 10, then 15, and
// then no more (until the sampler's next slot, which starts over).
const USAGE_RETRY = [1, 2, 3].map((n) => n * USAGE_GAP);
let askedAt = 0, asking = null, lastApi = null;
let fails = 0, nextAt = 0; // the queries in a row that brought nothing, and when the next one may go
const span = (t) => (t < 60000 ? `${Math.round(t / 1000)} s` : `${Math.round(t / 60000)} min`);
// The usage API, unless it was asked less than `gap` ago or is not due yet after a query that brought
// nothing: then the answer it gave last (or null).
function askUsage(gap = USAGE_GAP) {
  if (asking) return asking;
  const now = Date.now();
  if (now - askedAt < gap || now < Math.max(nextAt, retryUntil) || process.env.IRO_NO_USAGE_RECORD) return Promise.resolve(lastApi);
  askedAt = now;
  asking = usageFromApi().catch((e) => { log('usage API', e.message); return null; }).then((l) => {
    asking = null;
    if (l) { fails = 0; nextAt = 0; lastApi = l; setLimits(l); return lastApi; }
    nextAt = fails < USAGE_RETRY.length ? Date.now() + USAGE_RETRY[fails] : Infinity;
    fails++;
    const next = Math.max(nextAt, retryUntil);
    log(next === Infinity ? `usage: nothing after ${fails} queries, not asked again` : `usage: nothing, asked again in ${span(next - Date.now())}`);
    return lastApi;
  });
  return asking;
}
// One sample per interval (Settings: 30 minutes by default), taken on the local clock (:00 and :30).
// It looks every minute, so a slot a sleeping laptop, a restart or a failed query missed is filled as
// soon as it can be. A sample is stamped with its slot, even when it was filled late (the API refused at
// :30 and answered at :35), so the charts only ever show samples on the clock. While the API gives
// nothing, the level on screen will do, if it was read within the slot (a session's turn ended in it: its
// numbers came with the API calls it made). And once no query is left that would come before the slot
// ends (all three made again for nothing, or a slot too short for them, or a Retry-After past its end),
// a message is sent for the numbers (usageFromTurn), once per slot.
let slotNow = 0, slotTurn = 0; // the slot those queries are for, and the one a message went out for
async function sampleUsage() {
  if (retiring) return; // an update has begun: the new daemon keeps the history, one writer only
  const now = new Date();
  const every = settings.usageInterval;
  const slot = new Date(now).setMinutes(now.getMinutes() - (now.getMinutes() % every), 0, 0);
  if (slotNow !== slot) { slotNow = slot; fails = 0; nextAt = 0; }
  if ((lastRecord.t || 0) >= slot) return;
  const l = await askUsage(Math.min(USAGE_GAP, now - slot));
  let got = l && l.t >= slot ? l : limitsNow && limitsNow.t >= slot ? limitsNow : null;
  if (!got && slotTurn !== slot && Math.max(nextAt, retryUntil) >= slot + every * 60e3) {
    slotTurn = slot;
    log('usage: asked with a message');
    got = await usageFromTurn();
    setLimits(got);
  }
  if (got) recordUsage({ ...got, t: slot });
}

// The level the status line shows: one per account, the newest reading from the usage API or from
// a session that just finished a turn (its numbers came with the API call it just made). Every
// change is pushed to the clients; nothing on the page polls.
let limitsNow = null;
function setLimits(l) {
  if (!l || (!l.five && !l.week)) return;
  if (limitsNow && (l.t <= limitsNow.t || isOlder(l, limitsNow))) return;
  limitsNow = { t: l.t, five: l.five, week: l.week };
  const msg = line({ type: 'partial', op: 'limits', limits: limitsNow });
  for (const c of subscribers) c.write(msg);
}
if (lastRecord.t) limitsNow = { t: lastRecord.t, five: lastRecord.five, week: lastRecord.week };

// (every interval Settings offers is a multiple of 5 minutes, and so is every sample on the clock)
const onSlot = (t) => { const d = new Date(t); return d.getMinutes() % 5 === 0 && !d.getSeconds() && !d.getMilliseconds(); };
// The samples in usage.jsonl, oldest first (unreadable lines skipped).
function readUsage() {
  let lines = [];
  try { lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n'); } catch {}
  const out = [];
  for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
// The samples of the last `days` (at most 35), only those on the clock: an older daemon still running its
// busy sessions (see "rolling updates") wrote one at every turn end, and those would show as stray points in the charts.
function clockSamples(days) {
  const cut = Date.now() - Math.min(35, days) * 24 * 3600 * 1000;
  return readUsage().filter((x) => x.t >= cut && onSlot(x.t));
}
// Samples another machine took (same account: its daemon asks the same API on its own clock) for the slots
// this one has none for: asleep, off, or refused by the API at the time. client.mjs carries them over
// (usageDump / usageMerge). Returns how many were new.
function mergeUsage(samples) {
  if (retiring || !Array.isArray(samples)) return 0; // (an update has begun: the new daemon keeps the history)
  const now = Date.now();
  const all = readUsage();
  const have = new Set(all.map((x) => x.t));
  const win = (w) => (w && typeof w.pct === 'number' && w.pct >= 0 && (w.resets == null || !Number.isNaN(Date.parse(w.resets))) ? { pct: w.pct, resets: w.resets ?? null } : null);
  let added = 0;
  for (const x of samples) {
    if (!x || !Number.isFinite(x.t) || x.t > now || x.t < now - USAGE_KEEP || !onSlot(x.t) || have.has(x.t)) continue;
    const five = win(x.five), week = win(x.week);
    if (!five && !week) continue;
    all.push({ t: x.t, five, week });
    have.add(x.t);
    added++;
  }
  if (!added) return 0;
  all.sort((a, b) => a.t - b.t);
  writeFileAtomic(USAGE_FILE, all.map((x) => JSON.stringify(x) + '\n').join(''));
  lastRecord = all[all.length - 1];
  setLimits(lastRecord); // (when it is newer than the level on screen)
  log(`usage: ${added} sample(s) from another machine`);
  return added;
}
function pruneUsage() {
  if (retiring) return; // (an update has begun: the new daemon keeps the history, one writer only)
  const all = readUsage();
  const keep = all.filter((x) => x.t >= Date.now() - USAGE_KEEP);
  if (keep.length < all.length) try { writeFileAtomic(USAGE_FILE, keep.map((x) => JSON.stringify(x) + '\n').join('')); } catch {}
}
setTimeout(sampleUsage, 20 * 1000);
setInterval(sampleUsage, 60 * 1000);
// Once soon after the start as well: a daemon replaced by an update within 6 hours would never prune.
setTimeout(pruneUsage, 60 * 1000);
setInterval(pruneUsage, 6 * 3600 * 1000);

// `turnEnd`: the session has just made its API calls, so its plan limits are current.
async function refreshStats(s, turnEnd) {
  try {
    s.stats = await collectStats(s);
    if (turnEnd && s.stats.limits) setLimits({ t: Date.now(), ...s.stats.limits });
    emit(s.id, { kind: 'stats', ...s.stats });
  } catch (e) { log(`[${s.id}] stats failed`, e.message); }
}

// ---- folders in the sidebar ----
// The directories the UI lists. Removing one unregisters it here and detaches its live sessions; its
// sessions and Claude's memory of them stay on disk, so adding the folder back brings its history back too.
const FOLDERS_FILE = path.join(DIR, 'folders.json');
let folders = readJson(FOLDERS_FILE, null);
function changeFolders(fn) {
  let changed = false;
  folders = updateJson(FOLDERS_FILE, folders, (all) => { const r = fn(all ?? []); changed = r !== false; return r; }) ?? [];
  if (changed) partial('', { op: 'folders', folders });
}
const addFolder = (dir) => changeFolders((all) => !all.includes(dir) && [...all, dir]);
// Claude Code's settings files, strongest first: managed > local > project > user.
const claudeSettingFiles = (cwd) => [
  process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json',
  path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'), path.join(CLAUDE_DIR, 'settings.json'),
];
// A setting as the CLI resolves it: the first of those files that has it.
function claudeSetting(cwd, pick) {
  for (const f of claudeSettingFiles(cwd)) {
    const v = pick(readJson(f, {}));
    if (typeof v === 'string' && v) return v;
  }
}
const settingsDefaultMode = (cwd) => claudeSetting(cwd, (j) => j?.permissions?.defaultMode) || 'default';
// Directories of recent sessions on this host, newest first (for the folder picker, and the first start).
async function recentDirs(limit = 20, onlyOurs = false) {
  const seen = new Set();
  for (const x of await listSessions({ limit: 300 })) {
    if (onlyOurs && !ours.has(x.sessionId)) continue;
    const d = x.cwd;
    if (!d || seen.has(d) || !resolveDir(d)) continue;
    seen.add(d);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

// ---- next-prompt suggestions ----
// The SDK's own promptSuggestions bring nothing here: a headless session of this SDK started with them on
// got no prompt_suggestion message at all. So after each turn a small model guesses the next prompt from
// the last exchange only (cheap: no tools, no project context).
const SETTINGS_FILE = path.join(DIR, 'settings.json');
// `defaults`: what a new session starts with ({ model, effort, mode }; a missing one follows Claude's own
// settings). `usageInterval`: minutes between plan-usage samples (a divisor of 60, so samples sit on the clock).
const USAGE_INTERVALS = [5, 10, 15, 20, 30, 60];
const settings = { suggest: true, usageInterval: 30, defaults: {}, ...readJson(SETTINGS_FILE, {}) };
if (!USAGE_INTERVALS.includes(settings.usageInterval)) settings.usageInterval = 30;
const shownSettings = () => ({ suggest: settings.suggest, usageInterval: settings.usageInterval, defaults: settings.defaults, intervals: USAGE_INTERVALS });

async function predictNext(s) {
  if (!settings.suggest || !s.lastUserText || !s.turnText) return;
  const turn = s.turnNo;
  const prompt = 'This is the end of a session between a user and a coding assistant.\n\n'
    + `User: ${s.lastUserText.slice(-1500)}\n\nAssistant: ${s.turnText.slice(-3000)}\n\n`
    + 'Write the message the user will most likely send next: a natural follow-up request, at most 15 words, '
    + 'in the user\'s language, no quotes. Reply with only that message. Reply with just - only if the work is '
    + 'clearly finished and nothing would naturally follow.';
  let text = '';
  let q;
  try {
    try { s.predQ?.close(); } catch {}
    await oneShot({ prompt, options: { cwd: s.cwd, ...HAIKU_TURN } }, async (x) => {
      s.predQ = q = x;
      for await (const m of q) {
        if (m.type === 'assistant' && m.message.model !== '<synthetic>') text += m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (m.type === 'result') break;
      }
    });
  } catch (e) { if (s.turnNo === turn) log(`[${s.id}] suggestion failed`, e.message); return; }
  finally { if (s.predQ === q) s.predQ = null; }
  text = text.trim().split('\n')[0].replace(/^["'“]|["'”]$/g, '').trim();
  if (process.env.IRO_DEBUG) log(`[${s.id}] suggestion for turn ${turn} (now ${s.turnNo}, ${s.state}) from "${s.lastUserText.slice(0, 40)}": ${text}`);
  if (!text || text === '-' || s.turnNo !== turn || s.state !== 'idle') return; // the user moved on
  emit(s.id, { kind: 'suggest', text: text.slice(0, 200) });
}

// ---- /btw threads ----
// btw.json is shared with the other daemon of an update (see "rolling updates"): while a session is still on
// the previous daemon, its threads change there. So a save writes only its own thread into the file as it is
// now, and a thread not in use here (no process, no question running) is read from the file again when it is
// asked or listed.
const BTW_FILE = path.join(DIR, 'btw.json');
// bid -> { bid, claudeSessionId, cwd, created, messages: [{ role, text }], busy, proc }
const btwThreads = new Map(readJson(BTW_FILE, []).map((t) => [t.bid, t]));
function saveBtw(t) {
  const { bid, claudeSessionId, cwd, created, messages } = t;
  updateJson(BTW_FILE, [], (saved) => {
    const all = new Map(saved.map((x) => [x.bid, x])); // the other threads stay as saved (by either daemon)
    all.set(bid, { bid, claudeSessionId, cwd, created, messages });
    return [...all.values()].sort((a, b) => b.created - a.created).slice(0, 300);
  });
}
// The thread as the file has it (`saved`), unless it is in use here.
function btwFresh(saved) {
  const here = btwThreads.get(saved.bid);
  if (here?.proc || here?.busy) return here;
  if (here) return Object.assign(here, saved);
  btwThreads.set(saved.bid, saved);
  return saved;
}
function btwThread(bid) {
  const saved = readJson(BTW_FILE, []).find((x) => x.bid === bid);
  return saved ? btwFresh(saved) : btwThreads.get(bid);
}
const BTW_IDLE = 20 * 60 * 1000;

// One CLI process per open thread, fed through an inbox like a session. If it has gone
// (idle timeout, daemon restart) the thread is re-forked with its earlier Q&A in the prompt.
function btwAsk(t, text) {
  const out = (p) => partial(t.sid, { bid: t.bid, ...p });
  // (the live copy of the session first: one whose CLI ended is still listed before its reattached copy)
  const same = (x) => x.claudeSessionId === t.claudeSessionId;
  t.sid = ([...sessions.values()].find((x) => same(x) && alive(x)) || [...sessions.values()].find((x) => same(x) && !x.closed))?.id || t.sid;
  const PREFIX = '(Side question. Answer briefly from what you already know in this conversation; do not use tools.)\n\n';
  if (!t.proc) {
    const earlier = t.messages.slice(0, -1);
    const recap = earlier.length
      ? 'Earlier in this side discussion:\n' + earlier.map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${m.text}`).join('\n') + '\n\nNext question: '
      : '';
    const box = inbox();
    const proc = t.proc = { q: null, box, answer: '' };
    (async () => {
      try {
        // (query() itself throws when there is no Claude Code to start: the question fails as below)
        const q = proc.q = query({
          prompt: box,
          options: {
            cwd: t.cwd, resume: t.claudeSessionId, forkSession: true, persistSession: false,
            tools: [], includePartialMessages: true,
            stderr: (d) => log(`[btw ${t.bid}] stderr`, d.trimEnd()),
          },
        });
        for await (const m of q) {
          if (m.type === 'stream_event' && m.event.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
            out({ op: 'btw', text: m.event.delta.text });
          } else if (m.type === 'assistant') {
            proc.answer += m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
          } else if (m.type === 'result') {
            const answer = proc.answer || (m.subtype === 'success' ? String(m.result || '') : `(${m.subtype})`);
            proc.answer = '';
            t.messages.push({ role: 'assistant', text: answer, at: Date.now() });
            t.busy = false;
            saveBtw(t);
            out({ op: 'btw-done', text: answer });
            clearTimeout(proc.idle);
            proc.idle = setTimeout(() => {
              if (t.proc === proc) t.proc = null; // the next question starts a fresh process, not this closing one
              try { q.close(); } catch {}
            }, BTW_IDLE);
          }
        }
      } catch (e) {
        log(`[btw ${t.bid}] failed`, e);
        proc.error = String(e?.message || e);
      }
      clearTimeout(proc.idle);
      if (t.proc !== proc) return; // replaced by a newer process, which owns t.busy now
      t.proc = null;
      // Ended (crashed, closed) in the middle of an answer: without this the thread stays "answering" for good.
      if (t.busy) {
        t.busy = false;
        t.messages.pop(); // the question never got an answer; let it be asked again
        saveBtw(t);
        out({ op: 'btw-done', error: proc.error || 'The side conversation stopped before answering' });
      }
    })();
    box.push({ type: 'user', message: { role: 'user', content: PREFIX + recap + text }, parent_tool_use_id: null });
  } else {
    clearTimeout(t.proc.idle);
    t.proc.box.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }
}

// ---- files: @-mention completion and the file viewer ----
const fileCache = new Map(); // cwd -> { at, files }
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', 'dist', 'build', '.next', '.mypy_cache']);

function listFiles(cwd) {
  const hit = fileCache.get(cwd);
  if (hit && Date.now() - hit.at < 30000) return hit.files;
  let files;
  try {
    // Bounded: it runs on the event loop, and a hung network mount must not stop every session.
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd, maxBuffer: 64 << 20, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n').filter(Boolean).slice(0, 50000);
  } catch (e) {
    files = [];
    if (e.code === 'ETIMEDOUT') { log(`git ls-files in ${cwd} took over 5 s: no @ completion there for now`); fileCache.set(cwd, { at: Date.now(), files }); return files; }
    const walk = (dir, rel, depth) => {
      if (depth > 8 || files.length >= 20000) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (files.length >= 20000) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth + 1); }
        else if (e.isFile()) files.push(r);
      }
    };
    walk(cwd, '', 0);
  }
  const dirs = new Set();
  for (const f of files) for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
  const all = [...dirs, ...files];
  fileCache.set(cwd, { at: Date.now(), files: all });
  return all;
}

// Subsequence match; prefer hits in the file name, then shorter paths.
function fuzzy(paths, q, limit = 30) {
  q = q.toLowerCase();
  if (!q) return paths.filter((p) => !p.slice(0, -1).includes('/')).slice(0, limit);
  const scored = [];
  for (const p of paths) {
    const lp = p.toLowerCase();
    let i = 0, j = 0;
    while (i < lp.length && j < q.length) { if (lp[i] === q[j]) j++; i++; }
    if (j < q.length) continue;
    const base = lp.slice(lp.lastIndexOf('/', lp.length - 2) + 1);
    const score = (base.includes(q) ? 0 : lp.includes(q) ? 1000 : 2000) + p.length;
    scored.push([score, p]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}

// `/abs`, `~/x`, `./x`, `../x`: the entries of that folder, kept in the user's spelling.
function browse(cwd, q, limit = 50) {
  if (q === '~' || q === '..') q += '/';
  const cut = q.lastIndexOf('/') + 1;
  const head = q.slice(0, cut), name = q.slice(cut).toLowerCase();
  const dir = userPath(head, cwd);
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const isDir = (e) => e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; } })());
  const hits = ents
    .filter((e) => e.name.toLowerCase().startsWith(name) && (name.startsWith('.') || !e.name.startsWith('.')))
    .map((e) => head + e.name + (isDir(e) ? '/' : ''))
    .sort((a, b) => b.endsWith('/') - a.endsWith('/') || a.localeCompare(b));
  return hits.slice(0, limit);
}

const MAX_VIEW = 1 << 20;

// A path from the conversation: `~` is the home directory, a relative one is in the session's directory.
const sessionPath = (sid, p) => userPath(p, sessions.get(sid)?.cwd);

function readForView(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Not a file');
  const buf = readRange(file, 0, Math.min(st.size, MAX_VIEW));
  if (buf.subarray(0, 8000).includes(0)) return { path: file, size: st.size, binary: true };
  return { path: file, size: st.size, text: buf.toString('utf8'), truncated: st.size > MAX_VIEW };
}

// Reopen a past Claude Code session (from this daemon, the terminal, anywhere on this host).
const resuming = new Map(); // claudeSessionId -> promise of the resume in progress
// A transcript as the events the UI draws (earlier conversation of a resumed or detached session).
async function historyEvents(claudeSessionId, dir) {
  const history = await getSessionMessages(claudeSessionId, { dir });
  if (!history.length) throw new Error('This session has no readable messages');
  const users = transcriptUsers(claudeSessionId);
  // the schedules that fired, which the messages leave out: each goes before the message that came after it
  const ids = new Set(history.map((m) => m.uuid)), before = new Map();
  for (const [uuid, u] of users) {
    if (!('content' in u) || ids.has(uuid)) continue;
    let next = u.next;
    while (next && !ids.has(next) && users.get(next)?.next) next = users.get(next).next; // (several in a row)
    if (next && ids.has(next)) before.set(next, [...(before.get(next) || []), { kind: 'notify', ...originNote(null, u.origin, u.turnOrigin, u.content), sent: u.t }]);
  }
  const out = [];
  const s = { toolNames: new Map() };
  for (const m of history) {
    out.push(...(before.get(m.uuid) || []));
    // `sent`: when the message was written, not when it is replayed (`ts`); null when the transcript doesn't say
    const u = users.get(m.uuid);
    const sent = u?.t ?? null;
    const note = m.type === 'user' && !m.parent_tool_use_id && originNote(null, u?.origin, u?.turnOrigin, m.message?.content);
    if (note) { out.push({ kind: 'notify', ...note, sent }); continue; }
    const prompt = m.type === 'user' && !m.parent_tool_use_id ? promptText(m.message?.content) : null;
    if (prompt === '') continue; // harness-injected text, not something the user typed
    if (prompt != null) {
      out.push({ kind: 'user_text', text: prompt, uuid: m.uuid, sent });
    } else if (m.type === 'user' || m.type === 'assistant') {
      const msg = slim(s, { type: m.type, uuid: m.uuid, message: m.message, parent_tool_use_id: m.parent_tool_use_id });
      if (msg.type === 'assistant' && !msg.message.content.length) continue;
      out.push({ kind: 'msg', msg });
    }
  }
  return out;
}

// A rewound session nobody has written to since: its transcript's tail is not the conversation.
function upToRewind(claudeSessionId, history) {
  const at = rewindPoint(claudeSessionId);
  const cut = at ? history.findIndex((e) => e.kind === 'msg' && e.msg.uuid === at) : -1;
  return cut >= 0 ? history.slice(0, cut + 1) : history;
}

async function resumeSession({ claudeSessionId, cwd, title, color, nonce }) {
  // The CLI finds a transcript by its project directory, so resume in the original one.
  const original = cwd || transcriptCwd(claudeSessionId);
  if (!original) throw new Error('Cannot tell which directory this session was started in');
  const dir = resolveDir(original);
  if (!dir) throw new Error(`The session's directory no longer exists: ${original}`);
  const history = upToRewind(claudeSessionId, await historyEvents(claudeSessionId, dir));
  addFolder(dir);
  const s = newSession({ cwd: dir, title: title || 'Resumed session', resume: claudeSessionId });
  s.claudeSessionId = claudeSessionId;
  s.resumeAt = rewindPoint(claudeSessionId);
  // A reattached session keeps its /color: the UI passes the detached copy's, else the remembered one.
  s.color = (typeof color === 'string' && color) || colors[claudeSessionId];
  emit(s.id, { kind: 'created', cwd: dir, title: s.title, nonce, resumed: true, claudeSessionId, ...(s.color ? { color: s.color } : {}) });
  if (s.color && colors[claudeSessionId] !== s.color) saveColor(s);
  touchRecent(s);
  for (const ev of history) emit(s.id, ev);
  emit(s.id, { kind: 'sys', subtype: 'resumed' });
  run(s); // the CLI waits for the next message
  return { sid: s.id };
}

// ---- shells: plain terminals a session opens in its folder ----
// Each runs your login shell in a pseudo-terminal made by python3 (on every macOS and Linux host; no
// native module to build): stdin and stdout are the terminal, fd 3 takes "<cols> <rows>" resizes, and
// the shell's pid comes first on stderr. It starts in the session's folder even when your startup files
// cd elsewhere (a config.fish's `cd ~`): fish runs `cd` with -C, after its config and before the first
// prompt; zsh and bash read your files through the small ones in SHELL_INIT, which cd last. Any other
// shell is sent ` cd '<folder>'` once its first prompt is up, unless you have typed by then.
// A shell outlives the page (a reload or another tab shows its recent output) but not the daemon:
// when the daemon goes (an update included) python3 sees its stdin close and hangs the shell up.
const PTY_PY = `
import os, pty, sys, select, fcntl, termios, struct, signal
cols, rows, home = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
def size(fd, c, r): fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
pid, fd = pty.fork()
if pid == 0:
    size(0, cols, rows)
    sh = os.environ.get('SHELL') or '/bin/sh'
    name, init, args = os.path.basename(sh), os.environ.pop('IRO_SHELL_INIT', ''), [sh, '-l']
    if name == 'fish':
        args = [sh, '-l', '-C', "cd '%s'" % home.replace('\\\\', '\\\\\\\\').replace("'", "\\\\'")]
    elif name == 'zsh' and init:
        os.environ.update(IRO_ZDOTDIR=os.environ.get('ZDOTDIR') or os.environ.get('HOME', ''), ZDOTDIR=init + '/zsh', IRO_CD=home)
    elif name == 'bash' and init:
        os.environ['IRO_CD'] = home
        args = [sh, '--rcfile', init + '/bashrc', '-i']
    os.execvp(sh, args)
sys.stderr.write('pid %d\\n' % pid); sys.stderr.flush()
def put(f, b):
    while b: b = b[os.write(f, b):]
watch, ctl = [0, fd, 3], b''
while True:
    try: ready = select.select(watch, [], [])[0]
    except InterruptedError: continue
    if fd in ready:
        try: b = os.read(fd, 65536)
        except OSError: b = b''
        if not b: break
        put(1, b)
    if 0 in ready:
        b = os.read(0, 65536)
        if not b:
            os.kill(pid, signal.SIGHUP); break
        put(fd, b)
    if 3 in ready:
        b = os.read(3, 4096)
        if not b: watch.remove(3)
        ctl += b
        while b'\\n' in ctl:
            l, ctl = ctl.split(b'\\n', 1)
            try:
                c, r = map(int, l.split()); size(fd, c, r)
            except ValueError: pass
try: st = os.waitpid(pid, 0)[1]
except ChildProcessError: st = 0
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))
`;
const SHELL_INIT = path.join(DIR, 'shell-init');
// zsh: ZDOTDIR points here; each file reads yours (from your ZDOTDIR, kept in IRO_ZDOTDIR), the last one cds.
const zshStage = (f) => `IRO_WRAP=$ZDOTDIR\nZDOTDIR=$IRO_ZDOTDIR\n[[ -f $ZDOTDIR/${f} ]] && source $ZDOTDIR/${f}\nIRO_ZDOTDIR=$ZDOTDIR\nZDOTDIR=$IRO_WRAP\n`;
const SHELL_INIT_FILES = {
  'zsh/.zshenv': zshStage('.zshenv'),
  'zsh/.zprofile': zshStage('.zprofile'),
  'zsh/.zshrc': zshStage('.zshrc'),
  'zsh/.zlogin': 'ZDOTDIR=$IRO_ZDOTDIR\n[[ -f $ZDOTDIR/.zlogin ]] && source $ZDOTDIR/.zlogin\nunset IRO_WRAP IRO_ZDOTDIR\n[[ -n $IRO_CD ]] && builtin cd -- $IRO_CD\nunset IRO_CD\n',
  // bash: an interactive shell's rcfile that reads what a login shell would, then cds.
  bashrc: '[ -f /etc/profile ] && . /etc/profile\n'
    + 'if [ -f ~/.bash_profile ]; then . ~/.bash_profile; elif [ -f ~/.bash_login ]; then . ~/.bash_login; elif [ -f ~/.profile ]; then . ~/.profile; elif [ -f ~/.bashrc ]; then . ~/.bashrc; fi\n'
    + '[ -n "$IRO_CD" ] && builtin cd -- "$IRO_CD"\nunset IRO_CD\n',
};
function shellInit() {
  try {
    for (const [f, text] of Object.entries(SHELL_INIT_FILES)) {
      const p = path.join(SHELL_INIT, f);
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text) continue;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    return SHELL_INIT;
  } catch (e) {
    log('shell init files', e.message);
    return '';
  }
}
const SHELL_KEEP = 200_000; // characters of recent output a (re)opened tab is shown
// Bytes waiting to go out to a page past which a shell's output waits until they have gone (a `yes` would
// fill the daemon's memory, and what Ctrl-C prints would queue behind it).
const SHELL_HIGH = 1 << 20;
const shells = new Map(); // tid -> { tid, sid, name, proc, buf, total, out, timer, exited, paused }
const shellView = (t) => ({ tid: t.tid, name: t.name, exited: t.exited ?? null });
const shellsOf = (sid) => [...shells.values()].filter((t) => t.sid === sid);
const sendShells = (sid) => partial(sid, { op: 'shells', shells: shellsOf(sid).map(shellView) });
function shellOf(sid, tid) {
  const t = shells.get(tid);
  if (!t || t.sid !== sid) throw new Error('No such shell');
  return t;
}
// Output reaches the page in small batches; `at` (characters so far) lets a tab that just read the
// recent output skip what that read already had.
function shellOut(t, d) {
  if (!t.settled) { clearTimeout(t.quiet); t.quiet = setTimeout(() => homeIn(t), 300); } // the first prompt is up when output pauses
  // (cut back only once it is half as long again: not a SHELL_KEEP copy for every chunk)
  t.buf += d;
  if (t.buf.length > SHELL_KEEP * 1.5) t.buf = t.buf.slice(-SHELL_KEEP);
  t.total += d.length;
  t.out += d;
  t.timer ??= setTimeout(() => {
    partial(t.sid, { op: 'shell', tid: t.tid, data: t.out, at: t.total });
    t.out = '';
    t.timer = null;
    shellHold(t);
  }, 8);
}
// The shell's output waits while a page's connection has more than SHELL_HIGH to send, until it has sent
// it or gone.
function shellHold(t) {
  const full = !t.paused && [...subscribers].find((c) => c.writableLength > SHELL_HIGH);
  if (!full) return;
  t.paused = true;
  t.proc.stdout.pause();
  const go = () => {
    full.off('drain', go).off('close', go);
    t.paused = false;
    t.proc.stdout.resume();
    shellHold(t); // (another page still behind)
  };
  full.on('drain', go).on('close', go);
}
function openShell(sid, cwd, cols, rows) {
  const n = shellsOf(sid).length;
  const base = path.basename(process.env.SHELL || 'sh');
  const t = { tid: randomUUID().slice(0, 8), sid, name: n ? `${base} ${n + 1}` : base, buf: '', total: 0, out: '', timer: null, exited: null };
  const size = (v, d) => String(Math.max(2, Math.min(1000, Math.floor(Number(v)) || d)));
  const home = fs.realpathSync(cwd);
  t.proc = spawn('python3', ['-c', PTY_PY, size(cols, 80), size(rows, 24), home], {
    cwd, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'IroWell', IRO_SHELL_INIT: shellInit() },
  });
  t.settled = ['fish', 'zsh', 'bash'].includes(base); // these start there themselves (above)
  t.proc.stdout.setEncoding('utf8');
  t.proc.stdout.on('data', (d) => shellOut(t, d));
  t.proc.stderr.setEncoding('utf8');
  t.proc.stderr.on('data', (d) => {
    const m = t.pid == null && /^pid (\d+)\n/.exec(d);
    if (m) { t.pid = Number(m[1]); d = d.slice(m[0].length); }
    if (d.trim()) log(`[shell ${t.tid}] ${d.trimEnd()}`);
  });
  t.dir = cwd;
  setTimeout(() => homeIn(t), 5000); // (a shell that has printed nothing by then)
  for (const s of [t.proc.stdin, t.proc.stdio[3]]) s.on('error', () => {}); // it has exited
  const ended = (code, why) => {
    if (t.exited != null) return;
    t.exited = code;
    shellOut(t, `\r\n\x1b[2m[${why}]\x1b[0m\r\n`);
    sendShells(sid);
  };
  t.proc.on('error', (e) => ended(-1, e.code === 'ENOENT' ? 'a shell needs python3 on this host' : e.message));
  t.proc.on('exit', (code, sig) => ended(code ?? -1, `exited${code ? ` with ${code}` : sig ? ` (${sig})` : ''}`));
  shells.set(t.tid, t);
  sendShells(sid);
  return t;
}
// The folder a process is in: /proc on Linux, lsof on a Mac.
function cwdOf(pid) {
  if (fs.existsSync(`/proc/${pid}/cwd`)) return Promise.resolve(fs.promises.realpath(`/proc/${pid}/cwd`).catch(() => null));
  return new Promise((done) => execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (e, out) => done(e ? null : /^n(.*)$/m.exec(out)?.[1] ?? null)));
}
async function homeIn(t) {
  if (t.settled) return;
  t.settled = true;
  clearTimeout(t.quiet);
  if (t.typed || t.exited != null || t.pid == null) return;
  const [now, want] = await Promise.all([cwdOf(t.pid), fs.promises.realpath(t.dir).catch(() => t.dir)]);
  if (now && now !== want && !want.includes("'") && !t.typed && t.exited == null) t.proc.stdin.write(` cd '${want}'\r`);
}
function closeShell(t) {
  shells.delete(t.tid);
  if (t.exited == null) { t.proc.stdin.end(); t.proc.kill('SIGHUP'); }
  sendShells(t.sid);
}

// ---- client commands ----
// A command with an `id` is a request: its return value (or thrown error) is sent back as a reply.
// ---- what the work would cost at API rates, read off the transcripts on this machine
// Every answer in a transcript carries its token counts, priced by the table below as it stood at the
// time of the answer. $ per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
// (checked 2026-10-17; the update-prices skill in .claude/skills keeps it current). A row: the model ids it
// covers (a pattern), input, output, cache read; `long`: the prices of a request whose prompt (input,
// cache read and cache write together) is over `over` tokens; `since`: when the prices took effect (UTC).
// An answer takes the first row that covers its model and had taken effect by then; a row with no `since`
// has always held. So a new price goes in as a row above the old one, its `since` the day it took effect
// or, when that isn't known, the day it was put in here (the work before keeps the old price); a wrong
// price is mended where it stands, which reprices the work before too.
// A cache write costs 1.25× the input price (kept 5 minutes) or 2× (kept an hour), fast mode twice the lot.
// A model no row covers costs nothing here. (IRO_TEST_PRICES: the tests' own table, as JSON.)
const PRICE_ROWS = process.env.IRO_TEST_PRICES ? JSON.parse(process.env.IRO_TEST_PRICES) : [
  { model: 'fable-5-1|mythos-5-1', input: 10, output: 50, read: 0.25 },
  { model: 'fable|mythos', input: 10, output: 50, read: 1 },
  { model: 'opus-5-5', input: 4, output: 20, read: 0.2 },
  { model: 'opus-(5|4-[5-8])', input: 5, output: 25, read: 0.5 },
  { model: 'opus', input: 15, output: 75, read: 1.5 },
  { model: 'sonnet-5-5', input: 2, output: 10, read: 0.1 },
  { model: 'sonnet-5', input: 2, output: 10, read: 0.2 },
  { model: 'sonnet', input: 3, output: 15, read: 0.3 },
  { model: 'haiku-5-5', input: 0.1, output: 0.5, read: 0.01, long: { over: 100000, input: 0.5, output: 2.5, read: 0.05 } },
  { model: 'haiku-4-5', input: 1, output: 5, read: 0.1 },
  { model: 'haiku', input: 0.8, output: 4, read: 0.08 },
];
const PRICES = PRICE_ROWS.map((r) => ({ ...r, re: new RegExp(r.model), from: r.since ? Date.parse(r.since) : -Infinity }));
// Which table priced the totals: the client takes a machine's totals as they are, lower ones too, when
// this changes (see costDump).
const PRICES_VERSION = createHash('sha1').update(JSON.stringify(PRICE_ROWS)).digest('hex').slice(0, 12);
function answerCost(model, u, t) {
  const p = u && PRICES.find((r) => r.re.test(model || '') && r.from <= t);
  if (!p) return 0;
  const w = u.cache_creation, written = u.cache_creation_input_tokens || 0;
  const hour = w ? w.ephemeral_1h_input_tokens || 0 : 0, five = w ? w.ephemeral_5m_input_tokens || 0 : written;
  const input = u.input_tokens || 0, read = u.cache_read_input_tokens || 0;
  const r = p.long && input + read + Math.max(written, five + hour) > p.long.over ? p.long : p;
  const usd = (input * r.input + (u.output_tokens || 0) * r.output + read * r.read + five * r.input * 1.25 + hour * r.input * 2) / 1e6;
  return u.speed === 'fast' ? usd * 2 : usd;
}
// An answer's tokens as [input, cache, output]: the input not cached, the cache read and written, the output.
function answerTokens(u) {
  const w = u?.cache_creation, written = Math.max(u?.cache_creation_input_tokens || 0, w ? (w.ephemeral_5m_input_tokens || 0) + (w.ephemeral_1h_input_tokens || 0) : 0);
  return [u?.input_tokens || 0, (u?.cache_read_input_tokens || 0) + written, u?.output_tokens || 0];
}
// The answers of one transcript as [message id, time, $, input, cache, output] (see answerTokens), read
// again only when the file has changed.
// An answer is written once per block of its content, with the counts so far: the last line of an id counts.
const COST_ROOT = process.env.IRO_COST_DIR || path.join(CLAUDE_DIR, 'projects'); // (the tests point it at their own transcripts)
const costCache = new Map(); // file -> { mtimeMs, size, rows }
async function costRows(file, st) {
  const had = costCache.get(file);
  if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had.rows;
  const byId = new Map();
  const rows = () => [...byId.values()].filter((r) => r[2] > 0 || r[3] + r[4] + r[5] > 0);
  try {
    for await (const l of readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
      if (!l.includes('"usage"') || !l.includes('"assistant"')) continue;
      let d;
      try { d = JSON.parse(l); } catch { continue; }
      const m = d.message, t = Date.parse(d.timestamp);
      if (d.type !== 'assistant' || !m?.usage || !t) continue;
      byId.set(m.id || d.uuid, [m.id || d.uuid, t, answerCost(m.model, m.usage, t), ...answerTokens(m.usage)]);
    }
  } catch (e) {
    log('cost: cannot read', file, e.message);
    return rows(); // (what was read, not kept: the file is read again next time)
  }
  const all = rows();
  costCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, rows: all });
  return all;
}
// $ and tokens per half hour on this machine over the last 35 days, as [[start of the half hour, $, input,
// cache, output], …] (those with any), oldest first. Sessions, and the subagents each ran (<session>/subagents/*.jsonl); an answer copied
// into another transcript (a resumed or branched session) counts once.
const COST_SLOT = 30 * 60 * 1000;
let costRun = null; // one scan at a time: a second caller waits for the one under way
function ownCost() {
  return (costRun ||= (async () => {
    const cut = Date.now() - 35 * 24 * 3600 * 1000;
    const files = [];
    for (const f of transcriptFiles(COST_ROOT, { subagents: true })) {
      try { const st = fs.statSync(f); if (st.mtimeMs >= cut) files.push([f, st]); } catch {}
    }
    const seen = new Set(), slots = new Map();
    for (const [file, st] of files) {
      for (const [id, t, ...v] of await costRows(file, st)) {
        if (t < cut || seen.has(id)) continue;
        seen.add(id);
        const slot = Math.floor(t / COST_SLOT) * COST_SLOT;
        const sum = slots.get(slot) || slots.set(slot, [0, 0, 0, 0]).get(slot);
        v.forEach((x, i) => { sum[i] += x; });
      }
    }
    const listed = new Set(files.map(([f]) => f));
    for (const f of costCache.keys()) if (!listed.has(f)) costCache.delete(f);
    return [...slots].map(([t, v]) => [t, ...v]).sort((a, b) => a[0] - b[0]);
  })().finally(() => { costRun = null; }));
}
// client.mjs collects these totals from every machine it connects to and keeps them all on the computer
// it runs on (costDump), under each machine's id: a daemon only ever counts its own machine.
const MACHINE_FILE = path.join(DIR, 'machine');
let MACHINE = '';
try { MACHINE = fs.readFileSync(MACHINE_FILE, 'utf8').trim(); } catch {}
if (!MACHINE) { MACHINE = randomUUID(); try { fs.writeFileSync(MACHINE_FILE, MACHINE + '\n'); } catch {} }

const handlers = {
  // Shells: listed per session; opened in its folder; their recent output read back on (re)open.
  shellList(c, { sid }) { return shellsOf(sid).map(shellView); },
  shellOpen(c, { sid, cwd, cols, rows }) {
    const dir = resolveDir(sessions.get(sid)?.cwd || cwd);
    if (!sid || !dir) throw new Error('No folder to open a shell in');
    return shellView(openShell(sid, dir, cols, rows));
  },
  shellRead(c, { sid, tid }) { const t = shellOf(sid, tid); return { data: t.buf.slice(-SHELL_KEEP), at: t.total }; },
  shellInput(c, { sid, tid, data }) {
    const t = shellOf(sid, tid);
    if (t.exited == null && typeof data === 'string') { t.typed = true; t.proc.stdin.write(data); }
  },
  shellResize(c, { sid, tid, cols, rows }) {
    const t = shellOf(sid, tid);
    if (t.exited == null && cols > 0 && rows > 0) t.proc.stdio[3].write(`${Math.floor(cols)} ${Math.floor(rows)}\n`);
  },
  shellRename(c, { sid, tid, name }) {
    const t = shellOf(sid, tid);
    const v = String(name || '').trim().slice(0, 60);
    if (v) { t.name = v; sendShells(sid); }
  },
  shellClose(c, { sid, tid }) { closeShell(shellOf(sid, tid)); },
  // Logging Claude Code in on this host (see startLogin): the links, then the code from the sign-in page.
  async authLogin(c, { console: useConsole }) {
    const l = await startLogin(!!useConsole);
    return { link: l.link, local: l.local };
  },
  async authCode(c, { code }) {
    const l = login;
    if (!l) throw new Error('This sign-in has ended. Start again.');
    if (typeof code !== 'string' || !code.trim()) throw new Error('Paste the code from the sign-in page');
    const from = l.out.length;
    l.proc.stdin.write(code.trim() + '\n');
    // It ends (logged in, or "Login failed"), or it says the code is malformed and waits for another.
    for (let t = 0; t < 250; t++) {
      const r = await Promise.race([l.done, new Promise((done) => setTimeout(done, 100, null))]);
      if (r && !r.ok) throw new Error(r.error);
      if (r) return { ok: true };
      const again = /^.*invalid.*$/im.exec(plainText(l.out.slice(from)));
      if (again) return { ok: false, error: again[0].trim() };
    }
    throw new Error('Claude Code did not finish logging in');
  },
  authCancel() { stopLogin(); },
  // client.mjs's heartbeat: a connection that stops answering is dropped and made again (any reply
  // does; a daemon from before this answers "doesn't know").
  ping() { return null; },
  // Replay history, then start live events. Same tick => no gap, no reordering.
  sync(c, { since = 0, boot }) {
    if (boot !== BOOT) since = 0;
    // How far each session's turns have been looked at goes ahead of the log: a 'seen' comes long after the
    // turn end it covers, and a page drawing in between would show that turn as news for a moment.
    const ends = {};
    for (const e of events) if (e.kind === 'seen' && e.seq > since) ends[e.sid] = e.end;
    if (Object.keys(ends).length) c.write(line({ type: 'seen', ends }));
    for (const e of events) if (e.seq > since) c.write(line(e));
    subscribers.add(c);
    recheckAuth(); // (the UI's connection: not a skill's script, nor a one-off command's)
  },
  // `blank`: start without a first message (e.g. /clear).
  new(c, { cwd, text, nonce, model, mode, effort, images, blank }) {
    if (!blank && (typeof text !== 'string' || !text.trim())) throw new Error('First message is empty');
    const dir = resolveDir(cwd);
    if (!dir) throw new Error(`Not a directory on this host: ${cwd}`);
    const s = newSession({ cwd: dir, title: blank ? 'New session' : text.trim().slice(0, 60), model, mode });
    if (effort) s.effort = effort;
    addFolder(dir);
    emit(s.id, { kind: 'created', cwd: dir, title: s.title, nonce, model: s.model, mode: s.mode, effort: s.effort });
    run(s);
    if (!blank) sendText(s, text, images);
    return { sid: s.id };
  },
  async resume(c, args) {
    const { claudeSessionId } = args;
    for (const s of sessions.values()) {
      if (s.claudeSessionId === claudeSessionId && alive(s)) return { sid: s.id, existing: true };
    }
    for (const [sid, r] of remote) if (r.claudeSessionId === claudeSessionId && !r.closed) return { sid, existing: true }; // still on the previous daemon
    // A second click while the first is still waiting or reading the transcript joins it: two CLIs must
    // never run the same Claude session (both would append to one transcript).
    if (resuming.has(claudeSessionId)) return { ...(await resuming.get(claudeSessionId)), existing: true };
    // Closed just now (archive, Detach): its CLI may still be writing the transcript's last entries.
    const closing = [...sessions.values()].filter((s) => s.claudeSessionId === claudeSessionId && s.closed && s.done);
    const p = (async () => {
      if (closing.length) await Promise.race([Promise.all(closing.map((s) => s.done)), new Promise((r) => setTimeout(r, 10000))]);
      return resumeSession(args);
    })();
    resuming.set(claudeSessionId, p); // (before any wait: a resume meanwhile joins this one)
    try { return await p; } finally { resuming.delete(claudeSessionId); }
  },
  // Rewind (the terminal's Esc Esc): back to just before the user message `uuid`. Files Claude changed
  // since are restored from their checkpoints, and the conversation goes on from the end of the turn
  // before it: the CLI restarts under the same sid, resuming the transcript at that point (the later
  // turns stay in the transcript file, off the path, as the terminal leaves them). `dryRun` only says
  // which files would change.
  async rewind(c, { sid, uuid, dryRun }) {
    const s = live(sid);
    // The message, and the answer it follows, as events (not places in the log: compactEvents takes other
    // sessions' events out of it meanwhile).
    const i = uuid ? events.findIndex((e) => e.sid === sid && e.kind === 'user_text' && e.uuid === uuid) : -1;
    if (i < 0) throw new Error('That message can\'t be rewound to');
    const target = events[i];
    const prev = events.slice(0, i).filter((e) => e.sid === sid && e.kind === 'msg' && e.msg.type === 'assistant' && !e.msg.parent_tool_use_id && e.msg.uuid).pop();
    let files = await s.q.rewindFiles(uuid, { dryRun: true }).catch((e) => ({ canRewind: false, error: e.message }));
    if (dryRun) return files;
    if (s.rewinding || sessions.get(sid) !== s) throw new Error(REWINDING); // another rewind got here first
    if (!alive(s)) throw new Error('Session is not running'); // (detached meanwhile)
    if (!quiet(s)) throw new Error('Wait until nothing is running in this session (turn, question, queued message or background task), or stop it first');
    // From here until the CLI restarts, nothing else may use the session: a second rewind would
    // orphan the first one's CLI, a message would go to the CLI being closed, an update would move it.
    s.rewinding = true;
    try {
      if (files.canRewind && files.filesChanged?.length) files = { ...files, ...(await s.q.rewindFiles(uuid)) };
    } catch (e) { s.rewinding = false; throw e; }
    s.replaced = true;
    try { s.predQ?.close(); } catch {}
    try { s.q.close(); } catch {}
    await s.done;
    // Detached or archived meanwhile: it stays so, with no CLI started for it. The rewind holds as if the detach
    // had come right after it (a reattach goes on from the answer before the message); back to the first
    // message, though, it can't (that is a fresh session), and the caller is told.
    let n = null;
    if (s.closed) {
      s.replaced = false;
      s.rewinding = false;
      setState(s, 'ended'); // (as over() does for a session that isn't replaced)
      if (!prev) throw new Error(`The session was detached during the rewind: its conversation was not rewound${files.canRewind && files.filesChanged?.length ? ' (its files were)' : ''}`);
    } else {
      sessions.delete(sid);
      n = newSession({ cwd: s.cwd, title: s.title, model: s.model, mode: s.mode, resume: prev ? s.claudeSessionId : undefined }, sid);
      Object.assign(n, { claudeSessionId: prev ? s.claudeSessionId : undefined, color: s.color, effort: s.effort, stats: s.stats, resumeAt: prev?.msg.uuid, turnNo: s.turnNo });
    }
    if (prev) setRewindPoint(s.claudeSessionId, prev.msg.uuid);
    emit(sid, { kind: 'rewound', from: target.seq, files: files.filesChanged || [], insertions: files.insertions, deletions: files.deletions, fileError: files.canRewind ? undefined : files.error });
    if (n) run(n);
    return { text: target.text, files: files.filesChanged || [], ...(n ? {} : { closed: true }) };
  },
  // /branch and "Branch from here": a new session that starts as a copy of this one's conversation
  // (all of it, or up to the assistant message `at`); the original carries on unchanged. It runs as
  // the original runs now: the model and effort its CLI last reported (a `/model opus` typed to the
  // CLI included), else what it was started or last set with; the original not on this daemon
  // (detached, or still on the previous one): as the page last saw it (`model`, `mode`, `effort`).
  async branch(c, { sid, claudeSessionId, cwd, title, at, nonce, model, mode, effort }) {
    const src = sessions.get(sid);
    const id = src?.claudeSessionId || claudeSessionId;
    if (!id) throw new Error('Nothing to branch yet: send a message first');
    const dir = resolveDir(src?.cwd || cwd || transcriptCwd(id) || '');
    if (!dir) throw new Error('The session\'s directory no longer exists');
    let history = await historyEvents(id, dir);
    if (at) {
      const i = history.findIndex((e) => e.kind === 'msg' && e.msg.uuid === at);
      if (i < 0) throw new Error('That point of the conversation is not in its transcript');
      history = history.slice(0, i + 1);
    }
    const st = src?.stats?.model ? src.stats : null; // from its CLI: an effort of null is a model without one
    const s = newSession({ cwd: dir, title: String(title || '').trim().slice(0, 120) || `${src?.title || 'Session'} (branch)`, resume: id,
      model: st?.model || src?.model || model, mode: src?.mode || mode });
    s.fork = { at };
    s.effort = (st ? st.effort : src ? src.effort : effort) || undefined;
    emit(s.id, { kind: 'created', cwd: dir, title: s.title, nonce, resumed: true, model: s.model, mode: s.mode, effort: s.effort });
    for (const ev of history) emit(s.id, ev);
    emit(s.id, { kind: 'sys', subtype: 'branched' });
    run(s); // the CLI copies the conversation when the first message arrives
    return { sid: s.id };
  },
  // The earlier conversation of a session remembered from before a daemon restart (read only).
  async transcript(c, { claudeSessionId, cwd }) {
    const dir = resolveDir(cwd || transcriptCwd(claudeSessionId) || '');
    if (!dir) throw new Error('The session\'s directory no longer exists');
    return upToRewind(claudeSessionId, await historyEvents(claudeSessionId, dir));
  },
  send(c, { sid, text, images }) {
    const s = sessions.get(sid);
    if (!alive(s)) throw new Error('Session is not running');
    if (s.rewinding) throw new Error(REWINDING);
    if (typeof text !== 'string' || !text.trim()) return;
    if (turnBusy(s) || s.holding || s.outbox?.length) return enqueue(s, text, images);
    sendText(s, text, images);
  },
  // A queued message: 'now' sends it next, interrupting the turn; 'remove' takes it back (its text is returned).
  // 'add' queues a command of QUEUED (`text`), run here when its turn comes: at once if nothing is going on.
  queue(c, { sid, op, qid, text }) {
    const s = sessions.get(sid);
    if (op === 'add') {
      if (!alive(s)) throw new Error('Session is not running');
      if (s.rewinding) throw new Error(REWINDING);
      const command = queuedCommand(text);
      if (!command) throw new Error('That command can\'t be queued');
      enqueue(s, text.trim(), [], command);
      return drainQueue(s);
    }
    const i = s?.outbox?.findIndex((m) => m.qid === qid) ?? -1;
    if (i < 0) throw new Error('That message is no longer queued');
    const [m] = s.outbox.splice(i, 1);
    if (op === 'remove') { emitQueue(s); return { text: m.text, images: m.images }; }
    s.outbox.unshift(m);
    emitQueue(s);
    if (turnBusy(s)) s.q?.interrupt().catch((e) => log('interrupt failed', e));
    else drainQueue(s);
  },
  approve(c, { sid, rid, allow, answers, always }) {
    const s = sessions.get(sid);
    if (s) settle(s, rid, !!allow, { answers: answers && typeof answers === 'object' ? answers : undefined, always });
  },
  interrupt(c, { sid }) {
    sessions.get(sid)?.q?.interrupt().catch((e) => log('interrupt failed', e));
  },
  async setModel(c, { sid, model }) {
    const s = live(sid);
    await s.q.setModel(model || undefined);
    setMeta(s, { model: model || undefined });
    refreshStats(s);
  },
  async setMode(c, { sid, mode }) {
    const s = live(sid);
    await s.q.setPermissionMode(mode);
    setMeta(s, { mode });
    refreshStats(s);
  },
  async setEffort(c, { sid, effort }) {
    const s = live(sid);
    await s.q.applyFlagSettings({ effortLevel: effort || null });
    s.effort = effort || undefined;
    await refreshStats(s);
  },
  // What a session is busy with right now, for a page that just opened it.
  activity(c, { sid }) {
    const s = session(sid);
    return { state: s.state, turnStart: s.turnStart, tasks: runningTasks(s), procs: s.procs || [] };
  },
  // Background work per session, for the sidebar colours.
  async overview() {
    procScan();
    const mine = [...sessions.values()].map((s) => ({ sid: s.id, tasks: runningTasks(s).length, procs: (s.procs || []).length }));
    const theirs = await Promise.all([...links].map((l) => l.request({ type: 'overview' }).then((r) => r.data || [])));
    return [...mine, ...theirs.flat().filter((x) => remote.get(x.sid))];
  },
  async stopTask(c, { sid, taskId }) {
    await live(sid).q.stopTask(taskId);
  },
  killProc(c, { sid, pid }) {
    const s = sessions.get(sid);
    if (!s?.procs?.some((p) => p.pid === pid)) throw new Error('Not one of this session\'s background processes');
    process.kill(pid, 'SIGTERM');
    setTimeout(procScan, 1500);
  },
  // A page has shown the turn of this session that ended at `end` (its result's ts): no page shows it as news
  // any more (the sidebar dot's two rings), in any browser.
  seen(c, { sid, end }) {
    const s = session(sid);
    if (typeof end !== 'number' || end <= (s.seenEnd || 0)) return;
    s.seenEnd = end;
    emit(sid, { kind: 'seen', end });
  },
  setColor(c, { sid, color, claudeSessionId }) {
    const s = sessions.get(sid);
    if (s) return setMeta(s, { color: color || null });
    // A session remembered from before a restart has no process here: just record its colour.
    if (!claudeSessionId) throw new Error('No such session');
    saveColor({ claudeSessionId, color });
    emit(sid, { kind: 'meta', color: color || null });
  },
  // Fresh numbers for the status line (the UI polls this for the session on screen).
  async stats(c, { sid }) {
    const s = session(sid);
    s.stats = await collectStats(s);
    return s.stats;
  },
  async commands(c, { sid }) {
    const s = live(sid);
    return (s.commandsCache ??= await s.q.supportedCommands());
  },
  async models(c, { sid }) {
    const s = sid ? live(sid) : [...sessions.values()].find((x) => x.q && alive(x));
    if (!s && links.size) return (await [...links][0].request({ type: 'models' })).data || [];
    if (s) return (s.modelsCache ??= await s.q.supportedModels());
    return (modelsProbe ??= probeModels());
  },
  complete(c, { sid, cwd, query: q = '' }) {
    const dir = sessions.get(sid)?.cwd || (cwd && resolveDir(cwd)); // a draft has only its folder
    if (!dir) throw new Error('No such session');
    q = String(q);
    return /^(~|\.\.)$|^(~|\.{1,2})?\//.test(q) ? browse(dir, q) : fuzzy(listFiles(dir), q);
  },
  // A slice of a file, base64, for the file viewer (images, video, big text): read in chunks so a big
  // file streams over the ssh pipe with progress instead of one giant message.
  readChunk(c, { path: p, offset = 0, length = 1 << 20 }) {
    const file = userPath(p);
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Not a file');
    const n = Math.max(0, Math.min(Number(length) || 0, 4 << 20, st.size - offset));
    const buf = readRange(file, Number(offset) || 0, n);
    return { size: st.size, offset, data: buf.toString('base64'), eof: offset + n >= st.size };
  },
  // The level on screen now; asks the usage API too (at most once per USAGE_GAP), and a newer
  // answer is pushed when it comes.
  limits() {
    askUsage();
    return limitsNow;
  },
  usageHistory(c, { days = 7 } = {}) { return clockSamples(Number(days) || 7); },
  // What the work on this machine cost at API rates, by half hour, over the last 35 days. (The page asks
  // client.mjs, which adds up the machines of the account; costDump is the same for it, with whose totals they are.)
  usageCost() { return ownCost(); },
  // (`prices`: which table priced them; when it changes the client takes the totals as they are, lower ones too.)
  async costDump() { return { account: ACCOUNT, machine: MACHINE, prices: PRICES_VERSION, slots: await ownCost() }; },
  // For client.mjs, which evens out the usage history of the machines it is connected to: the samples on
  // file here with the account they belong to, and those another machine of that account has that this one
  // lacks (see mergeUsage). An account that isn't known, or not the same, merges nothing.
  usageDump(c, { days = 35 } = {}) { return { account: ACCOUNT, samples: clockSamples(Number(days) || 35) }; },
  usageMerge(c, { account, samples }) {
    if (!ACCOUNT || account !== ACCOUNT) throw new Error('The samples are of another Claude account');
    return { added: mergeUsage(samples) };
  },
  // Estimate for the rest of the weekly cycle: the line through the level now and the level 24 hours
  // before (read between the two samples around that moment; the window's first sample when the window
  // is younger than that), carried on to its reset. The UI draws it dashed, and backwards as well.
  usageForecast() {
    const xs = readUsage().filter((x) => x.week?.pct != null && x.week.resets);
    const last = xs[xs.length - 1];
    if (!last) return { week: null };
    const resets = new Date(last.week.resets).getTime();
    const win = xs.filter((x) => Math.abs(new Date(x.week.resets) - resets) < 2 * 60e3);
    const ago = last.t - 24 * 3600e3;
    const after = win.findIndex((x) => x.t > ago);
    const before = after > 0 ? win[after - 1] : null;
    const from = before ? { t: ago, pct: before.week.pct + ((win[after].week.pct - before.week.pct) * (ago - before.t)) / (win[after].t - before.t) } : { t: win[0].t, pct: win[0].week.pct };
    const slope = last.t - from.t >= 3600e3 ? Math.max(0, (last.week.pct - from.pct) / (last.t - from.t)) : 0; // percent per millisecond
    const pct = last.week.pct;
    const hitAt = pct >= 100 ? last.t : slope > 0 ? Math.round(last.t + (100 - pct) / slope) : null;
    const atReset = Math.min(100, pct + slope * Math.max(0, resets - last.t));
    return { week: { t: last.t, pct, resets: last.week.resets, slopePerHour: slope * 3600e3, hitAt: hitAt && hitAt <= resets ? hitAt : null, atReset } };
  },
  // Where a path mentioned in the conversation really is: relative ones are taken from the session directory.
  stat(c, { sid, path: p }) {
    const file = sessionPath(sid, p);
    try {
      const st = fs.statSync(file);
      return { path: file, exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
    } catch {
      return { path: file, exists: false };
    }
  },
  readFile(c, { sid, path: p }) {
    return readForView(sessionPath(sid, p));
  },
  // Terminal sessions and the ones from this UI by default; `all` adds headless `claude -p` / Python SDK runs.
  async history(c, { all = false, cwd } = {}) {
    const list = await listSessions(cwd ? { dir: cwd, includeWorktrees: false, limit: 400 } : { limit: all ? 150 : 400 });
    const index = transcriptIndex();
    const open = new Map([...sessions.values()].filter(alive).map((s) => [s.claudeSessionId, s.id]));
    for (const [sid, r] of remote) if (r.claudeSessionId && !r.closed) open.set(r.claudeSessionId, sid);
    const out = [];
    for (const x of list) {
      const meta = transcriptMeta(index.get(x.sessionId));
      if (!meta.hasMessages) continue; // empty stubs
      const headless = meta.entrypoint === 'sdk-cli' || meta.entrypoint === 'sdk-py';
      if (headless && !all && !ours.has(x.sessionId)) continue;
      if (cwd && resolveDir(x.cwd || meta.cwd) !== resolveDir(cwd)) continue; // not its subdirectories or worktrees
      out.push({
        claudeSessionId: x.sessionId, title: titleOf(x),
        cwd: x.cwd || meta.cwd, lastModified: x.lastModified, gitBranch: x.gitBranch,
        openAs: open.get(x.sessionId), fromUi: ours.has(x.sessionId) || meta.entrypoint === 'sdk-ts',
        source: meta.entrypoint === 'cli' ? 'terminal' : headless ? 'headless' : meta.entrypoint === 'sdk-ts' ? 'sdk' : meta.entrypoint,
      });
      if (out.length >= 150) break;
    }
    return out;
  },
  // Structured data behind /usage and /context, rendered as panels by the UI.
  async usage(c, { sid }) { return cliUsage(live(sid).q); },
  async context(c, { sid }) {
    return live(sid).q.getContextUsage({ detail: 'summary' });
  },
  // /btw: side conversations on a throwaway fork of the session (no tools, never saved as a session),
  // so they can run while the main turn is busy and never show up in it. Follow-ups continue the thread.
  btw(c, { sid, text, bid }) {
    const s = sessions.get(sid);
    if (!s?.claudeSessionId) throw new Error('/btw needs a conversation to ask about: send a message first');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Usage: /btw <question>');
    let t = bid && btwThread(bid);
    if (bid && !t) throw new Error('That side thread is gone');
    if (!t) {
      t = { bid: randomUUID().slice(0, 8), sid: s.id, claudeSessionId: s.claudeSessionId, cwd: s.cwd, created: Date.now(), messages: [] };
      btwThreads.set(t.bid, t);
    }
    if (t.busy) throw new Error('Still answering the previous question');
    t.messages.push({ role: 'user', text, at: Date.now() });
    t.busy = true;
    saveBtw(t);
    btwAsk(t, text);
    return { bid: t.bid };
  },
  btwList(c, { sid }) {
    const s = sessions.get(sid);
    const id = s?.claudeSessionId;
    if (id) for (const t of readJson(BTW_FILE, [])) if (t.claudeSessionId === id) btwFresh(t); // (some may be from the other daemon)
    return [...btwThreads.values()]
      .filter((t) => id && t.claudeSessionId === id)
      .sort((a, b) => b.created - a.created)
      .map(({ bid, created, messages, busy }) => ({ bid, created, messages, busy: !!busy }));
  },
  // The sidebar's folders. The first time, they are the directories of recent sessions from this UI.
  async folders() {
    folders = readJson(FOLDERS_FILE, folders); // (the other daemon may have changed them during an update)
    if (!folders) {
      const first = [...new Set([...sessions.values()].map((s) => s.cwd))];
      for (const d of await recentDirs(8, true).catch(() => [])) if (!first.includes(d)) first.push(d);
      changeFolders(() => first);
    }
    return folders;
  },
  addFolder(c, { path: p }) {
    const dir = resolveDir(p);
    if (!dir) throw new Error(`Not a directory on this host: ${p}`);
    addFolder(dir);
    return { path: dir, folders };
  },
  // Its live sessions are detached: nothing keeps running where the sidebar can't show it.
  removeFolder(c, { path: p }) {
    changeFolders((all) => all.filter((d) => d !== p));
    const own = liveOwn().filter((s) => s.cwd === p).map((s) => s.id);
    // (One still on the previous daemon is known here by its events only.)
    const theirs = [...remote].filter(([sid, r]) => !r.closed && events.some((e) => e.sid === sid && e.kind === 'created' && e.cwd === p)).map(([sid]) => sid);
    for (const sid of [...own, ...theirs]) dispatch(c, { type: 'close', sid });
    return { folders };
  },
  // Subdirectories of a directory, for the folder picker.
  ls(c, { path: p }) {
    const dir = resolveDir(p);
    if (!dir) throw new Error(`Not a directory on this host: ${p}`);
    let dirs = [];
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || (e.isSymbolicLink() && resolveDir(path.join(dir, e.name))))
        .map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 2000);
    } catch (e) { throw new Error(`Cannot list ${dir}: ${e.code || e.message}`); }
    return { path: dir, dirs };
  },
  recentDirs() { return recentDirs(20); },
  // What a new session starts with in `cwd` when Settings names no default: the mode and effort Claude's own settings give.
  claudeDefaults(c, { cwd }) {
    const dir = resolveDir(cwd) || os.homedir();
    // modelSettings: an effort per model, which beats the plain effortLevel.
    const modelEfforts = {};
    for (const f of claudeSettingFiles(dir).reverse()) {
      const ms = readJson(f, {})?.modelSettings;
      for (const [m, v] of Object.entries(ms && typeof ms === 'object' ? ms : {})) if (typeof v?.effortLevel === 'string') modelEfforts[m] = v.effortLevel;
    }
    return { mode: settingsDefaultMode(dir), effort: claudeSetting(dir, (j) => j?.effortLevel), modelEfforts };
  },
  getSettings() { return shownSettings(); },
  // Settings → System prompt. `own`: Claude Code's prompt as a new session gets it ({ model, before, text,
  // after }; null with `error` when it could not be had). `custom`: the text kept in its place (null: none).
  async claudePrompt() {
    const custom = readPrompt(USER_PROMPT_FILE) || null;
    try { return { custom, own: await ownPrompt(os.homedir(), settings.defaults.model) }; } catch (e) { return { custom, own: null, error: e.message }; }
  },
  // `text`: what sessions started from now on get in the place of Claude Code's prompt; none: Claude Code's own again.
  setClaudePrompt(c, { text }) {
    if (text != null && typeof text !== 'string') throw new Error('The system prompt is text');
    const custom = (text || '').trim();
    if (custom.length > 500000) throw new Error('That is too long for a system prompt');
    if (!custom) fs.rmSync(USER_PROMPT_FILE, { force: true });
    else writeFileAtomic(USER_PROMPT_FILE, custom + '\n'); // (a session starting meanwhile reads the old text or the new)
    return { custom: custom || null };
  },
  // The fingerprint as of now: a daemon that reads a checkout's skills/ follows its edits (see code()).
  serverCode() { return code(true); },
  // The defaults for new sessions ({ model, effort, mode }; null/'' clears one) and the usage sampling interval.
  setSettings(c, { defaults, usageInterval }) {
    if (defaults) {
      const next = { ...settings.defaults };
      for (const k of ['model', 'effort', 'mode']) {
        if (!(k in defaults)) continue;
        const v = defaults[k];
        if (v == null || v === '') delete next[k];
        else if (typeof v === 'string' && v.length < 100) next[k] = v;
        else throw new Error(`Bad default ${k}`);
      }
      settings.defaults = next;
    }
    if (usageInterval != null) {
      if (!USAGE_INTERVALS.includes(Number(usageInterval))) throw new Error(`The interval must be one of ${USAGE_INTERVALS.join(', ')} minutes`);
      settings.usageInterval = Number(usageInterval);
    }
    writeJson(SETTINGS_FILE, settings);
    const out = shownSettings();
    partial('', { op: 'settings', settings: out });
    if (usageInterval != null) sampleUsage(); // a shorter interval may already be due
    return out;
  },
  setSuggest(c, { on }) {
    settings.suggest = !!on;
    writeJson(SETTINGS_FILE, settings);
    return { suggest: settings.suggest };
  },
  async status(c, { sid }) {
    const s = session(sid);
    const out = { cwd: s.cwd, model: s.model, mode: s.mode, claudeSessionId: s.claudeSessionId, host: os.hostname(), state: s.state };
    if (s.q && alive(s)) {
      out.account = await s.q.accountInfo().catch(() => null);
      out.mcp = await s.q.mcpServerStatus().catch(() => null);
    }
    return out;
  },
  async rename(c, { sid, title, claudeSessionId }) {
    const s = sessions.get(sid);
    if (typeof title !== 'string' || !title.trim()) return;
    title = title.trim().slice(0, 120);
    if (s) {
      setMeta(s, { title });
      if (s.claudeSessionId) await renameSession(s.claudeSessionId, title, { dir: s.cwd }).catch((e) => log('rename failed', e));
      return;
    }
    // A session remembered from before a restart has no process here: its row, recent.json and its
    // transcript take the name (the SDK writes it there with no CLI running), so a reattach has it.
    if (typeof claudeSessionId !== 'string' || !claudeSessionId) return;
    const dir = Object.keys(recent).find((d) => recent[d].some((x) => x.id === claudeSessionId));
    if (dir) touchRecent({ claudeSessionId, cwd: dir, title }, false);
    emit(sid, { kind: 'meta', title });
    await renameSession(claudeSessionId, title, dir ? { dir } : undefined).catch((e) => log('rename failed', e));
  },
  close(c, { sid }) {
    const s = sessions.get(sid);
    if (!s || s.closed) return;
    s.closed = true;
    clearQueue(s);
    for (const rid of [...s.pending.keys()]) settle(s, rid, false);
    try { s.q?.close(); } catch {}
    emit(s.id, { kind: 'closed' });
  },
  // Archive a sidebar row: its CLI stops if it runs, and the row goes away (every copy of it, by Claude
  // session id). The transcript stays on disk, so Past sessions can reopen it.
  archive(c, { sid, claudeSessionId: id }) {
    const own = [...sessions.values()].filter((s) => s.id === sid || (id && s.claudeSessionId === id));
    for (const s of own) handlers.close(c, { sid: s.id });
    for (const x of new Set([sid, ...own.map((s) => s.id)])) for (const t of shellsOf(x)) closeShell(t); // its shells go with the row
    if (id) archive(id);
    for (const x of new Set([sid, ...own.map((s) => s.id)])) emit(x, { kind: 'archived', claudeSessionId: id || null });
  },
};

// ---- rolling updates: an update never interrupts a session ----
// The running daemon is told to retire (client/client.mjs, "Update server"): it moves its socket aside
// (old-<boot>.sock, still listening) and starts the new release, which takes the main socket.
// The new daemon relays the old one's live sessions (their events, and the commands for them), so the
// UI still sees one daemon. Each session moves over as soon as it is quiet (idle, nothing to approve,
// no background task of its CLI): the old daemon closes its CLI and the new one resumes the Claude
// session under the same sid. A busy session keeps running the old code until then, the way a terminal
// `claude` keeps its version until it is restarted. When none is left, the old daemon exits.
// Processes the session left running on their own (procScan) don't hold it back: they outlive its CLI,
// and the new daemon finds them again. (They used to: a session with a server or a training run in the
// background stayed on its daemon for days, through every later update.)
const MOVED = 'This session has moved to the new daemon';
const SENT = Symbol('reply already sent');
const clients = new Set(); // every connection (the UI's pipes, and a new daemon adopting our sessions)
const moving = new Map(); // sid -> promise, settled once the new daemon has been told
const movedAway = (sid) => moving.has(sid);
let retiring = null; // { sock, target: the new daemon's connection, ready }

const liveOwn = () => [...sessions.values()].filter((s) => alive(s) && !moving.has(s.id));
const btwBusy = (s) => [...btwThreads.values()].some((t) => t.busy && (!s || (t.claudeSessionId && t.claudeSessionId === s.claudeSessionId)));
// Its CLI is doing something: a turn, a question, a queued message, a background task.
const working = (s) => s.rewinding || s.state === 'running' || s.state === 'waiting' || s.pending.size || s.queued || s.outbox?.length || runningTasks(s).length;
// Something of the session is going on: that, or a process it left running.
const busy = (s) => working(s) || (s.procs || []).length;
const quiet = (s) => !busy(s) && !btwBusy(s);
const movable = (s) => !working(s) && !btwBusy(s);

async function handOver(s) {
  let told;
  moving.set(s.id, new Promise((r) => (told = r)));
  try { s.predQ?.close(); } catch {}
  try { s.q?.close(); } catch {}
  await s.done; // its CLI has exited: two CLIs must never write one transcript
  sessions.delete(s.id);
  const m = { type: 'handover', sid: s.id, claudeSessionId: s.claudeSessionId || null, cwd: s.cwd, title: s.title, color: s.color || null,
    model: s.model, mode: s.mode, effort: s.effort, stats: s.stats, fork: !s.claudeSessionId && s.fork ? { from: s.resume, at: s.fork.at } : undefined };
  if (retiring.target) reply(retiring.target, m);
  else log(`[${s.id}] closed while no new daemon was connected: it shows as detached there`);
  told();
  log(`[${s.id}] handed over`);
}

let handing = false;
async function tryHandover() {
  if (!retiring?.ready || handing) return;
  handing = true;
  try {
    // (each looked at again when its turn comes: one detached, archived or busy since the list was made stays)
    for (const s of liveOwn()) if (alive(s) && !moving.has(s.id) && movable(s) && retiring.ready) await handOver(s);
    if (retiring.ready && !liveOwn().length && !btwBusy()) {
      log('retired: every session has moved to the new daemon');
      fs.rmSync(retiring.sock, { force: true });
      reply(retiring.target, { type: 'retired' });
      setTimeout(() => process.exit(0), 300);
    }
  } finally { handing = false; }
}

// Whether the release of daemon.mjs `file` can run its Claude Code: '' if so, else why not (its
// --check-cli). With one that can't, every session it took over would fail at once. An install checks
// that, but a release can break after it. (A release from before --check-cli would start as a daemon
// instead: it is not asked. 25 s: the client gives up on a command after 30.) Of what it printed, the line
// that says why: its own, or the error a release that can't even load dies of (Node ends with its version).
const releaseCli = (file) => !fs.readFileSync(file, 'utf8').includes("'--check-cli'") ? Promise.resolve('')
  : new Promise((resolve) => execFile(process.execPath, [file, '--check-cli'], { cwd: path.dirname(file), timeout: 25000 }, (e, _out, err) => {
    const said = String(err).split('\n').map((l) => l.trim()).filter(Boolean);
    resolve(!e ? '' : said.find((l) => /^(\w*Error\b|Claude Code at|no Claude Code)/.test(l)) || said.filter((l) => !/^Node\.js v\d/.test(l)).pop()
      || (e.killed ? 'its Claude Code did not answer in 25 s' : e.message));
  }));

Object.assign(handlers, {
  // From the client's update: start `daemon` (the new release) and hand every session over to it, once
  // its Claude Code is known to run (otherwise nothing changes, and this daemon goes on serving).
  // Asked again before a new daemon has adopted us (the last one died starting, say): start it again.
  // (One that is still starting keeps the lock or the socket, so the second one just exits.)
  async retire(c, { daemon }) {
    const file = fs.realpathSync(String(daemon || '')); // its release's own path, so `ps` shows which release runs
    if (retiring?.target) return { sock: retiring.sock, already: true };
    const why = await releaseCli(file);
    if (why) { log('not retiring:', why); throw new Error(why); }
    if (retiring?.target) return { sock: retiring.sock, already: true }; // (adopted meanwhile)
    if (!retiring) {
      claimHost(); // (under this machine's name as it is now: the new daemon compares it with its own)
      const sock = path.join(DIR, `old-${BOOT.slice(0, 8)}.sock`); // short: socket paths are limited to ~100 bytes
      fs.renameSync(SOCK, sock); // still listening, under the new name
      releaseLock(); // the main socket is the new release's now
      retiring = { sock, target: null, ready: false };
      setInterval(tryHandover, 1000);
    }
    const out = fs.openSync(path.join(DIR, 'daemon.log'), 'a');
    spawn(process.execPath, [file], { detached: true, stdio: ['ignore', out, out], cwd: DIR }).unref();
    fs.closeSync(out);
    log('retiring: started', file);
    return { sock: retiring.sock };
  },
  // From the new daemon: our live sessions and their history, then their live events.
  adopt(c, cmd) {
    if (!retiring) throw new Error('This daemon is not retiring');
    if (retiring.target && retiring.target !== c) retiring.target.end(); // replaced by a newer daemon
    retiring.target = c;
    retiring.ready = false;
    c.on('close', () => { if (retiring.target === c) { retiring.target = null; retiring.ready = false; } });
    const own = liveOwn();
    const ids = new Set(own.map((s) => s.id));
    reply(c, { type: 'reply', id: cmd.id, data: {
      sessions: own.map((s) => ({ sid: s.id, claudeSessionId: s.claudeSessionId || null })),
      events: events.filter((e) => ids.has(e.sid)),
    } });
    subscribers.add(c); // right after the snapshot: no event falls in between
    return SENT;
  },
  // The new daemon is serving: send the UI over to it, then start handing sessions over.
  adopted(c) {
    if (!retiring || retiring.target !== c) return;
    retiring.ready = true;
    for (const x of clients) if (x !== c) x.end();
    tryHandover();
  },
});

// The new daemon's side: one link per retiring daemon.
const links = new Set();
// sid -> { link, claudeSessionId, closed } for sessions still on a retiring daemon. `closed`: detached there
// (it never moves over); its commands still go there, but a reattach starts it here.
const remote = new Map();

function relayEvent(e, link) {
  if (link) link.seen = Math.max(link.seen, e.seq); // (its own numbering: a re-adoption skips what came already)
  const { type, seq: _, ...rest } = e;
  const ev = { type: 'event', seq: ++seq, ...rest };
  events.push(ev);
  const l = line(ev);
  for (const c of subscribers) c.write(l);
}

// An old daemon that doesn't answer within ADOPT_MS is left out: a new daemon never waits on one for good
// (the page would get no hello, and the update would never finish). Its sessions come back with the
// next update.
const ADOPT_MS = 15000;
function adoptFrom(sockPath, seen = 0) {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    const link = { sock, path: sockPath, pid: 0, seen, adopted: false, pending: new Map(), nextId: 1, adoptId: 0 };
    const timer = setTimeout(() => { log('no answer from', path.basename(sockPath), '(left out)'); sock.destroy(); resolve(); }, ADOPT_MS);
    link.request = (cmd) => new Promise((done) => {
      if (sock.destroyed) return done({ error: 'The previous daemon stopped' });
      const id = link.nextId++;
      link.pending.set(id, done);
      sock.write(line({ ...cmd, id }));
    });
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      links.add(link);
      link.adoptId = link.nextId++;
      link.pending.set(link.adoptId, (m) => {
        clearTimeout(timer);
        if (m.error) { log('cannot adopt from', path.basename(sockPath), m.error); sock.end(); return resolve(); }
        // Handled in line order (not after an await), so none of the live events that follow is missed.
        for (const x of m.data.sessions) remote.set(x.sid, { link, claudeSessionId: x.claudeSessionId });
        for (const e of m.data.events) if (e.seq > link.seen) relayEvent(e, link);
        link.adopted = true;
        log(`adopted ${m.data.sessions.length} running session(s) from ${path.basename(sockPath)}`);
        resolve();
      });
      sock.write(line({ type: 'adopt', id: link.adoptId }));
    });
    sock.on('data', lines((l) => fromUpstream(link, l)));
    sock.on('error', (e) => {
      log('cannot reach the retiring daemon at', path.basename(sockPath), e.code || e.message);
      if (e.code === 'ECONNREFUSED') fs.rmSync(sockPath, { force: true }); // left behind by a daemon that died
      clearTimeout(timer);
      resolve();
    });
    sock.on('close', () => { clearTimeout(timer); lostLink(link); resolve(); });
  });
}

function fromUpstream(link, l) {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  const r = m.sid && remote.get(m.sid);
  if (m.type === 'hello') link.pid = m.pid;
  else if (m.type === 'reply') {
    const done = link.pending.get(m.id);
    if (done) { link.pending.delete(m.id); done(m); }
  } else if (m.type === 'event' && r?.link === link) {
    if (m.kind === 'init' && m.claudeSessionId) r.claudeSessionId = m.claudeSessionId;
    if (m.kind === 'closed') r.closed = true;
    relayEvent(m, link);
  } else if (m.type === 'partial' && r?.link === link) {
    const out = line(m);
    for (const c of subscribers) c.write(out);
  } else if (m.type === 'handover' && r?.link === link) {
    remote.delete(m.sid);
    // Detached or archived there before it moved (a daemon of an older release hands those over too): it
    // stays so here, with no CLI for a row the page shows closed.
    if (r.closed) { log(`[${m.sid}] handed over detached: not started`); return; }
    const s = newSession({ cwd: m.cwd, title: m.title, model: m.model, mode: m.mode, resume: m.claudeSessionId || m.fork?.from || undefined }, m.sid);
    Object.assign(s, { claudeSessionId: m.claudeSessionId || undefined, color: m.color || undefined, effort: m.effort, stats: m.stats });
    if (!m.claudeSessionId && m.fork) s.fork = { at: m.fork.at }; // a branch nobody has written to yet
    s.resumeAt = rewindPoint(m.claudeSessionId);
    run(s); // like a reattach: the CLI waits for the next message
    log(`[${s.id}] taken over from the previous daemon`);
  } else if (m.type === 'retired') {
    setTimeout(pruneReleases, 2000);
  }
}

function lostLink(link) {
  if (!links.delete(link)) return;
  for (const done of link.pending.values()) done({ error: 'The previous daemon stopped' });
  link.pending.clear();
  const left = [...remote].filter(([, r]) => r.link === link);
  // The link broke but that daemon still runs its sessions (another daemon adopted it, say): they are not
  // detached, and a reattach must not start a second CLI on one of them. We adopt it again, unless we
  // are retiring ourselves (then the daemon after us does).
  if (link.adopted && link.pid && link.pid !== process.pid && pidAlive(link.pid) && left.some(([, r]) => !r.closed)) {
    log(`lost the link to ${path.basename(link.path)}, which still runs`);
    if (!retiring && !exiting) setTimeout(() => readopt(link, left), 1000);
    return;
  }
  // It went away with sessions still on it (killed, crashed): they show as detached, ready to reattach.
  for (const [sid, r] of left) { remote.delete(sid); if (!r.closed) emit(sid, { kind: 'closed' }); }
}
async function readopt(link, left) {
  if (retiring || exiting) return;
  await adoptFrom(link.path, link.seen);
  const now = [...links].find((l) => l.path === link.path && l.adopted);
  now?.sock.write(line({ type: 'adopted' }));
  // What it no longer runs (closed or ended meanwhile, or it's gone): detached.
  for (const [sid, r] of left) if (remote.get(sid) === r) { remote.delete(sid); if (!r.closed) emit(sid, { kind: 'closed' }); }
}

// A command for a session on a retiring daemon goes there; its reply comes back as ours.
async function forward(c, cmd, link) {
  const { id, ...rest } = cmd;
  const r = await link.request(rest);
  if (r.error === MOVED) return dispatch(c, cmd); // it moved here meanwhile (the handover came first)
  if (id != null) reply(c, { type: 'reply', id, ...(r.error != null ? { error: r.error } : { data: r.data ?? null }) });
  else if (r.error != null) reply(c, { type: 'error', text: r.error });
}

// Releases (client/client.mjs installs each into releases/r<time>): keep this one, the one `current`
// points to, any a running process uses, and the newest two. What a failed install could not remove
// (failed-r<time>, install.sh) goes too.
function pruneReleases() {
  const root = path.join(DIR, 'releases');
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  for (const n of names.filter((n) => /^failed-r\d+$/.test(n))) remove(root, n);
  names = names.filter((n) => /^r\d+$/.test(n)).sort();
  const keep = new Set(names.slice(-2));
  keep.add(RELEASE);
  try { keep.add(path.basename(fs.realpathSync(path.join(DIR, 'current')))); } catch {}
  let ps;
  try { ps = execFileSync('ps', ['-eo', 'args'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 }).toString(); } catch { return; }
  for (const n of names) if (ps.includes(`/releases/${n}/`)) keep.add(n);
  for (const n of names) if (!keep.has(n)) remove(root, n);
}
// (On an NFS home a folder can stay "not empty" for a moment after its files are removed: rm tries again;
// one that still fails is left for the next prune and doesn't stop the others.)
function remove(root, n) {
  try { fs.rmSync(path.join(root, n), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); log('removed old release', n); }
  catch (e) { log(`could not remove old release ${n} (${e.code || e.message}); trying again next time`); }
}

function session(sid) {
  const s = sessions.get(sid);
  if (!s) throw new Error('No such session');
  return s;
}
function live(sid) {
  const s = sessions.get(sid);
  if (!s?.q || !alive(s)) throw new Error('Session is not running');
  if (s.rewinding) throw new Error(REWINDING);
  return s;
}

function reply(c, obj) { c.write(line(obj)); }

function dispatch(c, cmd) {
  const r = cmd.sid && remote.get(cmd.sid);
  // (A branch is made here even from a session that still lives on the previous daemon: a session born
  // there would never reach us, its events being relayed only for sessions we adopted. It needs only the
  // transcript, which the page names.)
  if (r && cmd.type !== 'branch') return forward(c, cmd, r.link);
  let out;
  try {
    // A session being handed over answers "moved" once the new daemon knows it (which then runs the command).
    out = cmd.sid && moving.has(cmd.sid) ? moving.get(cmd.sid).then(() => { throw new Error(MOVED); }) : handlers[cmd.type](c, cmd);
  } catch (e) {
    out = Promise.reject(e);
  }
  if (out === SENT) return;
  if (cmd.id == null) {
    Promise.resolve(out).catch((e) => reply(c, { type: 'error', text: String(e?.message || e) }));
    return;
  }
  // `sized` (client.mjs, for an answer it shows arriving: the Usage page's sync bar): the length of the
  // reply's line goes right ahead of it.
  const answer = (obj) => {
    const l = line(obj);
    if (cmd.sized) c.write(line({ type: 'replySize', id: cmd.id, size: l.length }));
    c.write(l);
  };
  Promise.resolve(out).then(
    (data) => answer({ type: 'reply', id: cmd.id, data: data ?? null }),
    (e) => answer({ type: 'reply', id: cmd.id, error: String(e?.message || e) }),
  );
}

// ---- where the user is: on this machine, or on another computer that reaches it over ssh ----
// client.mjs says which on every connection (`reach`), and the last word is kept across restarts: a
// session can start with no client connected (one taken over in an update). A session that starts while
// the user is remote is told so: skills/remote/prompt.md is added to its system prompt, with {{ssh}} (the
// name the user's ssh knows this host by) and {{host}} (the host's own name) filled in. A session on the
// user's own machine gets none of it.
const REACH_FILE = path.join(DIR, 'reach.json');
let REACH = readJson(REACH_FILE, {}); // { remote, ssh } as last said
const reach = new Map(); // connection -> { remote, ssh, ports: it forwards a port when asked }
const REMOTE_PROMPT_FILE = SKILLS_DIR && path.join(SKILLS_DIR, 'remote', 'prompt.md');
function remotePrompt() {
  if (!REACH.remote) return '';
  const vars = { ssh: REACH.ssh, host: os.hostname() };
  return readPrompt(REMOTE_PROMPT_FILE).replace(/\{\{(ssh|host)\}\}/g, (_, k) => vars[k]);
}
const portWaits = new Map(); // rid -> a port asked of the clients: { left, errors, resolve, reject, timer }
const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
Object.assign(handlers, {
  reach(c, { remote: far, ssh, ports }) {
    const r = { remote: !!far, ssh: far && /^[\w.@%:[\]+-]{1,200}$/.test(ssh || '') ? ssh : '', ports: !!far && !!ports };
    reach.set(c, r);
    if (REACH.remote !== r.remote || REACH.ssh !== r.ssh) writeJson(REACH_FILE, REACH = { remote: r.remote, ssh: r.ssh });
  },
  // From a session here that serves something on `port` (skills/remote/port.mjs): the clients that reach
  // this host over ssh forward it, and the first that can says where it is on the user's computer
  // ({ local, why: why that is another number }). `local`: the local port to put it on, when it matters
  // which. `here`: the user is on this machine, and the port is at localhost as it is.
  portRequest(c, { port, local = null }) {
    port = Number(port);
    if (!isPort(port)) throw new Error('A port is a number from 1 to 65535');
    if (local != null && !isPort(local)) throw new Error('A local port is a number from 1 to 65535');
    const able = [...clients].filter((x) => reach.get(x)?.ports);
    if (!able.length) {
      // (with nobody connected: where the user was last)
      if (reach.size ? [...reach.values()].some((r) => !r.remote) : REACH.remote === false) return { here: true };
      throw new Error('No IroWell client that can forward a port is connected to this host right now');
    }
    const rid = randomUUID().slice(0, 8);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { portWaits.delete(rid); reject(new Error('The IroWell client did not answer')); }, 40000);
      portWaits.set(rid, { left: able.length, errors: [], resolve, reject, timer });
      for (const x of able) x.write(line({ type: 'portRequest', rid, port, local }));
    });
  },
  portReply(c, { rid, local, why, error }) {
    const w = portWaits.get(rid);
    if (!w) return;
    if (error == null && Number.isInteger(local)) w.resolve({ local, why: typeof why === 'string' ? why : '' });
    else {
      w.errors.push(String(error || 'The IroWell client could not forward the port'));
      if (--w.left > 0) return;
      w.reject(new Error(w.errors[0]));
    }
    clearTimeout(w.timer);
    portWaits.delete(rid);
  },
  // Whether something on this host has each of `ports` (at localhost, where a forward connects): the Ports
  // dialog shows it beside the port. Asked by trying to listen there, which a port in use refuses: no
  // connection is made to the program that has it, every few seconds while the dialog is open (and one to a
  // port that a forward on this same machine listens on would go round through that forward). Only where
  // listening says nothing (a listener on every address doesn't stop one on 127.0.0.1 on macOS; a port
  // below 1024) is the port connected to.
  async portsBusy(c, { ports }) {
    const list = [...new Set((Array.isArray(ports) ? ports : []).map(Number).filter(isPort))].slice(0, 100);
    const taken = (port, host) => new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', (e) => resolve(e.code === 'EADDRINUSE'));
      s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(false)));
    });
    const answers = (port, host) => new Promise((resolve) => {
      const s = net.connect({ port, host });
      s.setTimeout(1000, () => { s.destroy(); resolve(false); });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    const either = async (fn, port) => (await Promise.all(['127.0.0.1', '::1'].map((host) => fn(port, host)))).some(Boolean);
    return Object.fromEntries(await Promise.all(list.map(async (p) => [p, await either(taken, p) || await either(answers, p)])));
  },
  // What the next session is told on top of Claude Code's own prompt (the tests read it).
  uiPrompt: () => uiPrompt(),
  // The text blocks a CLI started now for this session would send as its system prompt (the tests read it).
  async promptSent(c, { sid }) {
    const s = session(sid);
    return (await sentPrompt({ cwd: s.cwd, ...(s.model ? { model: s.model } : {}), ...(sessionPrompt(s) || await sessionPromptSoon(s)) })).blocks;
  },
});

// ---- progress lists: what a long task has to do and has done, kept by Claude and the user together ----
// One per Claude session (progress/<Claude session id>.json). The session starts it through the
// irowell:progress skill (skills/progress/progress.mjs → `progressCli`); from then on the page shows it at
// the foot of the rail, and the user edits it there (`progressEdit`). Every change is logged with who made
// it. `seen` is the last log entry Claude has been shown: what the user changed after it goes out with the
// next thing Claude reads, which is the script's output or the user's next message (a hook, see run()).
// The file is the only state, so a session still on the previous daemon shares it (see "rolling updates").
const PROGRESS_DIR = path.join(DIR, 'progress');
const PROGRESS_STATES = ['todo', 'doing', 'done'];
const PROGRESS_MAX = 200, PROGRESS_LOG = 300; // items in a list; log entries kept
function progressFile(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('No such session');
  return path.join(PROGRESS_DIR, `${id}.json`);
}
const progressView = (list) => list && { items: list.items };
// One change to a list by 'user' or 'agent', then saved and shown on every page. Throws on a change that
// can't be made (nothing is saved then).
//   { op: 'add', texts, after }   after: the id it goes below (0: the top; left out: the end)
//   { op: 'state', ids, state }   todo | doing | done
//   { op: 'edit', item, text }   (`item`: an item's id; `id` is the command's own)
//   { op: 'remove', ids }
//   { op: 'move', item, after }
function changeProgress(id, by, cmd, { create = false } = {}) {
  const file = progressFile(id);
  const list = readJson(file, null) || (create ? { items: [], next: 1, n: 0, seen: 0, log: [] } : null);
  if (!list) throw new Error('This session has no progress list');
  const at = Date.now();
  const note = (e) => list.log.push({ n: ++list.n, at, by, ...e });
  const item = (x) => {
    const it = list.items.find((i) => i.id === Number(x));
    if (!it) throw new Error(`The list has no item ${x}`);
    return it;
  };
  const textOf = (t) => {
    t = String(t ?? '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error('An item needs some text');
    return t.slice(0, 500);
  };
  // Where an item goes: below item `after`, at the top (0), or at the end (null).
  const spot = (after) => (after == null ? list.items.length : Number(after) === 0 ? 0 : list.items.indexOf(item(after)) + 1);
  // (each item once, however often its id is named)
  const ids = () => { if (!Array.isArray(cmd.ids) || !cmd.ids.length) throw new Error('Which item?'); return [...new Set(cmd.ids.map(item))]; };
  if (cmd.op === 'add') {
    const texts = (Array.isArray(cmd.texts) ? cmd.texts : []).map(textOf);
    if (!texts.length) throw new Error('An item needs some text');
    if (list.items.length + texts.length > PROGRESS_MAX) throw new Error(`A progress list holds at most ${PROGRESS_MAX} items`);
    let i = spot(cmd.after);
    for (const text of texts) {
      const it = { id: list.next++, text, state: 'todo' };
      note({ op: 'add', id: it.id, text, after: list.items[i - 1]?.id ?? 0 });
      list.items.splice(i++, 0, it);
    }
  } else if (cmd.op === 'state') {
    if (!PROGRESS_STATES.includes(cmd.state)) throw new Error(`A state is one of ${PROGRESS_STATES.join(', ')}`);
    for (const it of ids()) {
      if (it.state === cmd.state) continue;
      note({ op: 'state', id: it.id, text: it.text, from: it.state, to: cmd.state });
      it.state = cmd.state;
    }
  } else if (cmd.op === 'edit') {
    const it = item(cmd.item), text = textOf(cmd.text);
    if (it.text !== text) { note({ op: 'edit', id: it.id, from: it.text, to: text }); it.text = text; }
  } else if (cmd.op === 'remove') {
    for (const it of ids()) {
      note({ op: 'remove', id: it.id, text: it.text, state: it.state });
      list.items.splice(list.items.indexOf(it), 1);
    }
  } else if (cmd.op === 'move') {
    const it = item(cmd.item);
    if (Number(cmd.after) === it.id) throw new Error('An item can\'t go below itself');
    const from = list.items.indexOf(it);
    list.items.splice(from, 1);
    const to = spot(cmd.after ?? 0);
    list.items.splice(to, 0, it);
    if (to !== from) note({ op: 'move', id: it.id, text: it.text, after: list.items[to - 1]?.id ?? 0 });
  } else throw new Error(`Unknown change: ${cmd.op}`);
  list.log = list.log.slice(-PROGRESS_LOG);
  fs.mkdirSync(PROGRESS_DIR, { recursive: true });
  writeJson(file, list);
  partial('', { op: 'progress', claudeSessionId: id, list: progressView(list) });
  return list;
}
// ---- as Claude reads it
const PROGRESS_MARK = { todo: '[ ]', doing: '[~]', done: '[x]' };
const pad2 = (x) => String(x).padStart(2, '0');
const progressTime = (t) => { const d = new Date(t); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const progressWhere = (after) => (after ? `below ${after}` : 'at the top');
const PROGRESS_SAYS = {
  add: (e) => `added ${e.id} ${JSON.stringify(e.text)} ${progressWhere(e.after)}`,
  state: (e) => `marked ${e.id} ${e.to} (was ${e.from}): ${JSON.stringify(e.text)}`,
  edit: (e) => `reworded ${e.id}: ${JSON.stringify(e.from)} -> ${JSON.stringify(e.to)}`,
  remove: (e) => `removed ${e.id} (was ${e.state}): ${JSON.stringify(e.text)}`,
  move: (e) => `moved ${e.id} ${progressWhere(e.after)}: ${JSON.stringify(e.text)}`,
};
function progressLines(list) {
  if (!list.items.length) return ['Progress list: empty'];
  const done = list.items.filter((i) => i.state === 'done').length, w = String(Math.max(...list.items.map((i) => i.id))).length;
  return [`Progress list (${done} of ${list.items.length} done)`, ...list.items.map((i) => `  ${String(i.id).padStart(w)} ${PROGRESS_MARK[i.state]} ${i.text}`)];
}
// The user's changes that Claude has not been shown yet, as lines; they count as shown from here on.
function takeProgressNews(id, list = readJson(progressFile(id), null)) {
  const news = list ? list.log.filter((e) => e.by === 'user' && e.n > list.seen) : [];
  if (!list || list.seen === list.n) return [];
  list.seen = list.n;
  writeJson(progressFile(id), list);
  return news.map((e) => `  ${progressTime(e.at)}  ${PROGRESS_SAYS[e.op](e)}`);
}
// The list with the user's changes since Claude last read it: what the script prints after every command.
function progressText(id, list) {
  const news = takeProgressNews(id, list);
  return [...progressLines(list), ...(news.length ? ['', 'The user changed the list since you last read it:', ...news] : [])].join('\n');
}
// The same for the user's next message, when they changed the list meanwhile (a UserPromptSubmit hook's answer).
function progressNews(id) {
  try {
    const list = readJson(progressFile(id), null), news = takeProgressNews(id, list);
    if (!news.length) return {};
    const text = ['The user changed this session\'s progress list (the irowell:progress skill) since you last read it:', ...news, '', ...progressLines(list)].join('\n');
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
  } catch (e) {
    log('progress list', id, e.message);
    return {};
  }
}
Object.assign(handlers, {
  // The page: a session's list (null until the session has started one), and the user's change to it.
  progress(c, { claudeSessionId }) { return progressView(readJson(progressFile(claudeSessionId), null)); },
  progressEdit(c, { claudeSessionId, ...cmd }) { return progressView(changeProgress(claudeSessionId, 'user', cmd)); },
  // The session's own script. `show` and `log` change nothing; an `add` starts the list.
  progressCli(c, { session, ...cmd }) {
    const file = progressFile(session);
    if (cmd.op === 'show' || cmd.op === 'log') {
      const list = readJson(file, null);
      if (!list) return { text: 'This session has no progress list yet: `add` starts one.' };
      if (cmd.op === 'show') return { text: progressText(session, list) };
      return { text: list.log.map((e) => `${progressTime(e.at)}  ${e.by === 'user' ? 'user ' : 'you  '} ${PROGRESS_SAYS[e.op](e)}`).join('\n') || 'Nothing has changed yet.' };
    }
    return { text: progressText(session, changeProgress(session, 'agent', cmd, { create: cmd.op === 'add' })) };
  },
});

// ---- where a session works: the git worktree and branch shown beside its title ----
// The folder the session started in, until the session says otherwise through the irowell:workplace skill
// (skills/workplace/workplace.mjs → `workplaceCli`), kept per Claude session (workplace/<id>.json) like a
// progress list. The branch is always read from git, so a checkout shows without the session saying so.
// What keeps it current is a PostToolUse hook (see run()): a file written, or a shell left, in another
// worktree than the one shown makes the session be asked whether it works there now, once per worktree
// and turn.
const WORKPLACE_DIR = path.join(DIR, 'workplace');
const WORKPLACE_SCRIPT = SKILLS_DIR && path.join(SKILLS_DIR, 'workplace', 'workplace.mjs');
function workplaceFile(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw new Error('No such session');
  return path.join(WORKPLACE_DIR, `${id}.json`);
}
const gitCache = new Map(); // dir -> { at, place }
// The git working tree `dir` is in: { root, branch } (branch: the short commit when detached), or null.
function gitPlace(dir) {
  const hit = gitCache.get(dir);
  if (hit && Date.now() - hit.at < 15000) return hit.place;
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  let place = null;
  try {
    const root = git('rev-parse', '--show-toplevel');
    let branch = git('branch', '--show-current');
    if (!branch) try { branch = git('rev-parse', '--short', 'HEAD'); } catch {}
    place = { root: fs.realpathSync(root), branch: branch || null };
  } catch {}
  gitCache.set(dir, { at: Date.now(), place });
  return place;
}
// What the title shows: { root, branch, other (not the session folder's own checkout), set (by the session) }.
function workplace(s) {
  let set = null;
  try { set = s.claudeSessionId && readJson(workplaceFile(s.claudeSessionId), null); } catch {}
  const at = (set && fs.existsSync(set.dir) && gitPlace(set.dir)) || gitPlace(s.cwd);
  if (!at) return null;
  return { ...at, other: at.root !== gitPlace(s.cwd)?.root, set: !!set && at.root === set.dir };
}
// The PostToolUse hook: where the tool ran, when that is another worktree than the one shown.
const WRITES = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
function workplaceCheck(s, input) {
  try {
    if (!WORKPLACE_SCRIPT || input.agent_id) return {}; // (a subagent's own work, e.g. in a worktree of its own)
    const ti = input.tool_input || {};
    let dir;
    if (WRITES[input.tool_name]) dir = ti[WRITES[input.tool_name]] && path.dirname(path.resolve(input.cwd || s.cwd, ti[WRITES[input.tool_name]]));
    else if (input.tool_name === 'Bash') {
      dir = input.cwd; // where the shell is now
      // a checkout, a new worktree: the branch beside the title follows at once
      if (/\bgit\b.*\b(checkout|switch|worktree)\b/.test(ti.command || '')) { gitCache.clear(); refreshStats(s); }
    } else if (input.tool_name === 'EnterWorktree' || input.tool_name === 'ExitWorktree') { gitCache.clear(); dir = input.tool_response?.worktreePath || input.cwd; }
    const at = dir && fs.existsSync(dir) && gitPlace(dir);
    const shown = at && workplace(s);
    if (!at || !shown || at.root === shown.root) return {};
    s.workplaceAsked ||= new Set();
    if (s.workplaceAsked.has(at.root)) return {};
    s.workplaceAsked.add(at.root);
    const text = `This ran in the git worktree ${at.root}${at.branch ? ` (branch ${at.branch})` : ''}, but the user's screen shows this session working in ${shown.root}${shown.branch ? ` (branch ${shown.branch})` : ''} (the irowell:workplace skill). `
      + `If this session now mainly works there, run: node ${WORKPLACE_SCRIPT} set ${at.root}\nIf it was a one-off, carry on.`;
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
  } catch (e) {
    log(`[${s.id}] workplace`, e.message);
    return {};
  }
}
const workplaceText = (w) => (w ? `The title shows: ${w.root}${w.branch ? ` · branch ${w.branch}` : ''}${w.set ? '' : ' (the folder this session started in)'}` : 'Not in a git working tree: the title shows no worktree or branch.');
Object.assign(handlers, {
  // The session's own script: `show`, `set` (a directory in the worktree it works in now), `reset`.
  workplaceCli(c, { session, op, dir }) {
    const file = workplaceFile(session);
    // (the live copy first: a detached one stays listed, before the copy its reattach made)
    const same = (x) => x.claudeSessionId === session;
    const s = [...sessions.values()].find((x) => same(x) && alive(x)) ?? [...sessions.values()].find(same);
    if (op === 'set') {
      if (typeof dir !== 'string' || !fs.existsSync(dir)) throw new Error(`No such directory: ${dir}`);
      gitCache.clear();
      const at = gitPlace(dir);
      if (!at) throw new Error(`Not in a git working tree: ${dir}`);
      fs.mkdirSync(WORKPLACE_DIR, { recursive: true });
      writeJson(file, { dir: at.root, at: Date.now() });
    } else if (op === 'reset') fs.rmSync(file, { force: true });
    else if (op !== 'show') throw new Error(`Unknown command: ${op}`);
    if (!s) return { text: op === 'show' ? 'This session is not one of this IroWell daemon\'s.' : 'Saved.' };
    s.workplaceAsked?.clear();
    if (op !== 'show') refreshStats(s);
    return { text: workplaceText(workplace(s)) };
  },
});

function onClient(c) {
  clients.add(c);
  const drop = () => { subscribers.delete(c); clients.delete(c); reach.delete(c); };
  c.on('close', drop);
  c.on('error', drop);
  c.setEncoding('utf8');
  whenReady.then(() => serve(c)); // (unread data waits in the socket meanwhile)
}
// Commands between client.mjs and daemons only: the page can't send these (client.mjs forwards the
// page only what `hello` lists).
const INTERNAL = new Set(['sync', 'ping', 'retire', 'adopt', 'adopted', 'usageDump', 'usageMerge', 'costDump', 'reach', 'portRequest', 'portReply', 'portsBusy', 'uiPrompt', 'promptSent', 'progressCli', 'workplaceCli']);
function serve(c) {
  if (c.destroyed) return;
  reply(c, { type: 'hello', boot: BOOT, seq, pid: process.pid, host: os.hostname(), code: code(), home: os.homedir(), sdk: SDK, auth: AUTH, user: USER_NAME, release: RELEASE,
    usageSync: true, // (a client from before 2026-10-18 carries usage only to a daemon that says this)
    commands: Object.keys(handlers).filter((n) => !INTERNAL.has(n)) });
  c.on('data', lines((l) => {
    let cmd;
    try { cmd = JSON.parse(l); } catch (e) { log('bad command', l.slice(0, 200), e); return; }
    if (Object.hasOwn(handlers, cmd.type)) dispatch(c, cmd);
    else if (cmd.id != null) reply(c, { type: 'reply', id: cmd.id, error: `The server doesn't know "${cmd.type}": click Update server in the UI` });
  }));
}

// Newest SDK, checked at start and every 6 hours (quietly skipped when offline). Asked of npm, from this
// release's folder: the registry Update server installs from (a mirror in ~/.npmrc can lag behind
// registry.npmjs.org, and a version it doesn't have yet would keep the button up after every update).
async function checkSdk() {
  try {
    let pkg;
    if (process.env.IRO_TEST_SDK_LATEST) pkg = { version: process.env.IRO_TEST_SDK_LATEST }; // tests: no network
    else {
      const out = await new Promise((resolve, reject) => execFile('npm', ['view', '@anthropic-ai/claude-agent-sdk@latest', 'version', 'claudeCodeVersion', '--json'],
        { cwd: path.dirname(fileURLToPath(import.meta.url)), timeout: 60000 }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
      const v = JSON.parse(out);
      pkg = typeof v === 'string' ? { version: v } : v; // (just the version when the other field is missing)
      if (!pkg?.version) return;
    }
    if (pkg.version === SDK.latest) return;
    Object.assign(SDK, { latest: pkg.version, latestCc: pkg.claudeCodeVersion || null });
    partial('', { op: 'sdk', sdk: SDK });
  } catch {}
}
setTimeout(checkSdk, 3000);
checkAuth();
setInterval(checkSdk, 6 * 3600 * 1000).unref?.();

// ---- start: refuse to run twice, clean up a stale socket ----
fs.mkdirSync(DIR, { recursive: true });
// Sessions started from this UI that recent.json doesn't know yet (e.g. from before it existed, or
// from a daemon that stopped before recording them) are added from their transcripts, so a folder
// never loses its recent sessions to a restart.
async function seedRecent() {
  let list = [];
  try { list = await listSessions({ limit: 400 }); } catch (e) { log('cannot list sessions', e.message); }
  const index = transcriptIndex();
  const archived = new Set(readJson(ARCHIVED_FILE, []));
  const found = [];
  for (const x of list) {
    if (!ours.has(x.sessionId) || archived.has(x.sessionId)) continue;
    const meta = transcriptMeta(index.get(x.sessionId));
    if (!meta.hasMessages) continue;
    const cwd = x.cwd || meta.cwd;
    const dir = cwd && resolveDir(cwd); // (an empty path would resolve to ~)
    if (dir) found.push([dir, { id: x.sessionId, title: titleOf(x), t: x.lastModified || 0 }]);
  }
  recent = updateJson(RECENT_FILE, recent, (all) => {
    let added = 0;
    for (const [dir, e] of found) if (!(all[dir] || []).some((x) => x.id === e.id)) { (all[dir] ||= []).push(e); added++; }
    if (!added) return false;
    for (const dir of Object.keys(all)) all[dir] = all[dir].sort((a, b) => b.t - a.t).slice(0, RECENT_MAX);
  });
}
await seedRecent();
// The remembered sessions come back as detached rows (oldest first, like the event log), except the
// ones still running on a retiring daemon: those are live rows.
function emitDormant() {
  const running = new Set([...remote.values()].filter((r) => !r.closed).map((r) => r.claudeSessionId).filter(Boolean));
  for (const [dir, list] of Object.entries(recent)) {
    for (const x of [...list].reverse()) {
      if (running.has(x.id)) continue;
      const sid = randomUUID().slice(0, 8);
      emit(sid, { kind: 'created', cwd: dir, title: x.title || 'Session', claudeSessionId: x.id, dormant: true, lastActive: x.t, ...(colors[x.id] ? { color: colors[x.id] } : {}) });
      emit(sid, { kind: 'closed' });
    }
  }
}
// The release this daemon runs becomes the one new daemons start from (`current`: after a reboot, a crash
// or an idle exit), and its attach.mjs the one clients run. install.sh leaves both alone for an update, which
// may be prepared and never switched to. (Not in a checkout: it has no releases.)
function makeCurrent() {
  const rel = path.join(DIR, 'releases', RELEASE), cur = path.join(DIR, 'current'), attach = path.join(DIR, 'attach.mjs');
  try { if (fs.realpathSync(path.dirname(fileURLToPath(import.meta.url))) !== fs.realpathSync(rel)) return; } catch { return; }
  try { if (fs.readlinkSync(cur) === `releases/${RELEASE}`) return; } catch {}
  try { // (each put in place by a rename: never a moment without one)
    fs.rmSync(`${cur}.${process.pid}`, { force: true });
    fs.symlinkSync(`releases/${RELEASE}`, `${cur}.${process.pid}`);
    fs.renameSync(`${cur}.${process.pid}`, cur);
    writeFileAtomic(attach, fs.readFileSync(path.join(rel, 'attach.mjs')));
    log('current release:', RELEASE);
  } catch (e) { log('cannot make this release current:', e.message); }
}

// Clients are served once the sessions of any retiring daemon are adopted and the log is complete.
let ready;
const whenReady = new Promise((r) => (ready = r));
async function start() {
  makeCurrent();
  for (const f of fs.readdirSync(DIR)) if (/^old-[0-9a-f]{8}\.sock$/.test(f)) await adoptFrom(path.join(DIR, f));
  emitDormant();
  ready();
  for (const l of links) l.sock.write(line({ type: 'adopted' }));
  pruneReleases();
}
// ---- stopping: Stop server in the UI, `client.mjs --stop`, or idle exit ----
// Every session is closed (they come back as detached rows, resumable) and the socket removed, so the
// next attach starts a fresh daemon. Clients are told first: a stop they asked for is no connection
// loss, so they don't reconnect (which would start a new daemon right away).
let exiting = false;
async function stopDaemon(why) {
  if (exiting) return;
  exiting = true;
  log(`${why}: exiting`);
  server?.close();
  fs.rmSync(retiring?.sock || SOCK, { force: true });
  releaseLock(); // the next daemon may start while this one closes its sessions
  releaseHost(); // (on another machine too)
  for (const c of clients) c.write(line({ type: 'shutdown' }));
  for (const l of links) l.request({ type: 'shutdown' }); // a daemon still finishing sessions of an older release
  const own = liveOwn();
  for (const s of own) {
    for (const rid of [...s.pending.keys()]) settle(s, rid, false);
    try { s.predQ?.close(); } catch {}
    try { s.q?.close(); } catch {}
  }
  for (const t of btwThreads.values()) try { t.proc?.q.close(); } catch {}
  await Promise.race([Promise.all(own.map((s) => s.done)), new Promise((r) => setTimeout(r, 10000))]);
  setTimeout(() => process.exit(0), 200); // (lets the last writes go out)
}
handlers.shutdown = () => {
  const n = liveOwn().length + [...remote.values()].filter((r) => !r.closed).length;
  setImmediate(() => stopDaemon('asked to stop')); // after the reply
  return { sessions: n };
};

// An unused daemon exits after IRO_IDLE_HOURS (72 by default; 0 = never). Unused means no client
// attached and nothing going on: no turn, question waiting for approval, queued message, background
// task or process, btw answer, or job in a shell.
const IDLE_MS = Number(process.env.IRO_IDLE_HOURS ?? 72) * 3600e3;
let lastActive = Date.now();
// Whether a shell runs something (a training run started there): its shell process has a child, which one
// at its prompt has not. What a prompt keeps running beside the shell doesn't count: powerlevel10k's
// gitstatusd, and the shell's own workers (zsh-async, say, a zsh under the zsh). Asked of /proc on Linux,
// else of pgrep (a Mac); only when nothing else is going on.
const PROMPT_HELPER = /^-?(gitstatusd.*|zsh|bash|fish|sh|dash)$/;
function shellJobs() {
  const pids = [...shells.values()].filter((t) => t.exited == null && t.pid != null).map((t) => t.pid);
  if (!pids.length) return false;
  const job = (name) => !PROMPT_HELPER.test(path.basename(name.trim()));
  if (HAS_PROC) {
    const shellPids = new Set(pids);
    const comm = (d) => { try { return fs.readFileSync(`/proc/${d}/comm`, 'utf8'); } catch { return ''; } };
    try { return fs.readdirSync('/proc').some((d) => /^\d+$/.test(d) && shellPids.has(procStat(d)?.ppid) && job(comm(d))); } catch { return false; }
  }
  // (`pgrep -l`: "pid name" a line; it exits 1 for none)
  try { return execFileSync('pgrep', ['-l', '-P', pids.join(',')], { encoding: 'utf8', timeout: 3000 }).split('\n').some((l) => l.trim() && job(l.trim().replace(/^\d+\s+/, ''))); } catch { return false; }
}
function idleCheck() {
  if (exiting) return;
  if (clients.size || links.size || retiring || moving.size || btwBusy() || liveOwn().some(busy) || shellJobs()) { lastActive = Date.now(); return; }
  if (Date.now() - lastActive >= IDLE_MS) stopDaemon(`idle for ${+(IDLE_MS / 3600e3).toFixed(3)} h`);
}
if (IDLE_MS > 0) setInterval(idleCheck, Math.max(1000, Math.min(10 * 60e3, IDLE_MS / 4)));

// ---- the event log stays as big as the live sessions ----
// A session whose CLI is gone keeps only what draws its sidebar row: its 'created' (turned into a
// detached row that reads its conversation from the transcript when opened, as after a restart),
// title changes, its last state and 'closed'. A row superseded by a reattach (same Claude session,
// newer sid) or archived goes entirely. Only deletes, never reorders: a client's `since` stays valid.
// Clients that synced earlier keep what they have; client.mjs trims its cache from 'compact'.
const COMPACT_MS = Number(process.env.IRO_COMPACT_MS) || 60_000;
function compactEvents() {
  const info = new Map(); // sid -> { created, cid, archived, state }
  for (const e of events) {
    const x = info.get(e.sid) || info.set(e.sid, {}).get(e.sid);
    if (e.kind === 'created') x.created = e;
    if (e.kind === 'init' || (e.kind === 'created' && e.claudeSessionId)) x.cid = e.claudeSessionId;
    if (e.kind === 'archived') x.archived = true;
    if (e.kind === 'state') x.state = e;
    if (e.kind === 'user_text' || (e.kind === 'msg' && e.msg.type === 'result')) x.last = e.ts; // as the page counts activity
  }
  const newest = new Map(); // Claude session id -> seq of its newest row's 'created'
  for (const [sid, x] of info) {
    const cid = sessions.get(sid)?.claudeSessionId || x.cid;
    if (cid && x.created && x.created.seq > (newest.get(cid) ?? 0)) newest.set(cid, x.created.seq);
  }
  const drop = new Set(), stub = new Map(); // sid -> the kept 'state' event
  for (const [sid, x] of info) {
    if (!sid || alive(sessions.get(sid)) || remote.has(sid) || moving.has(sid)) continue;
    const cid = sessions.get(sid)?.claudeSessionId || x.cid;
    // (no 'created' left: an earlier pass dropped the row, and this came in after, e.g. its CLI's end)
    if (!x.created || x.archived || (cid && newest.get(cid) !== x.created.seq)) drop.add(sid);
    else stub.set(sid, x.state); // again for one trimmed before: what came in since goes too
  }
  if (!drop.size && !stub.size) return;
  const removed = [], replaced = [];
  const keep = events.filter((e) => {
    const ok = drop.has(e.sid) ? false
      : !stub.has(e.sid) || e.kind === 'created' || e.kind === 'meta' || e.kind === 'closed' || e === stub.get(e.sid);
    if (!ok) removed.push(e.seq);
    return ok;
  });
  for (const sid of stub.keys()) {
    const x = info.get(sid), s = sessions.get(sid);
    if (x.created.compacted) continue;
    Object.assign(x.created, { dormant: true, compacted: true, claudeSessionId: s?.claudeSessionId || x.cid, lastActive: x.last || x.created.lastActive || x.created.ts });
    delete x.created.resumed; // (its 'resumed' line went with the rest)
    delete x.created.nonce;
    if (s?.color) x.created.color = s.color;
    replaced.push(x.created);
  }
  if (!removed.length && !replaced.length) return;
  events.length = 0;
  events.push(...keep);
  const l = line({ type: 'compact', removed, replaced });
  for (const c of subscribers) c.write(l);
}
setInterval(compactEvents, COMPACT_MS);

// ---- local machines (config.json; client.mjs --local writes these defaults, a host has none) ----
// A laptop sleeps, shuts down daily and has little memory to spare:
//   detachIdleMinutes: 60   a session quiet for that long is detached (its CLI, ~400 MB, exits;
//                           sending a message reattaches it); 0 = never
//   keepAwake: true         macOS: no idle sleep while a session is busy (caffeinate -i; closing
//                           the lid still sleeps)
// Read on every use, so an edit applies without a restart.
const CONFIG_FILE = path.join(DIR, 'config.json');
// A file that is there but doesn't parse (a stray comma, a save half done) keeps the last good settings.
let goodConfig = null, badConfig = '';
function config() {
  let own = {};
  try {
    own = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!own || typeof own !== 'object' || Array.isArray(own)) throw new Error('not an object');
    goodConfig = own; badConfig = '';
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (badConfig !== e.message) log(`cannot read ${CONFIG_FILE} (${e.message}): using ${goodConfig ? 'the last good settings' : 'the defaults'}`);
      badConfig = e.message;
      own = goodConfig || {};
    }
  }
  return { detachIdleMinutes: 0, keepAwake: false, ...own };
}
setInterval(() => {
  const min = Number(config().detachIdleMinutes) || 0;
  if (min <= 0 || retiring) return;
  for (const s of liveOwn()) {
    if (!quiet(s) || Date.now() - Math.max(s.lastMsgAt || 0, s.created) < min * 60e3) continue;
    log(`[${s.id}] quiet for ${min} min: detached`);
    handlers.close(null, { sid: s.id });
  }
}, 10e3);
let awake = null; // the caffeinate process while one is wanted
setInterval(() => {
  const want = process.platform === 'darwin' && !!config().keepAwake && (liveOwn().some(busy) || btwBusy());
  if (want && !awake) {
    const p = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }); // -w: it ends with this daemon
    p.on('error', () => {});
    p.on('exit', () => { if (awake === p) awake = null; });
    awake = p;
  } else if (!want && awake) {
    awake.kill();
    awake = null;
  }
}, 5000);

// Who owns the main socket: daemon.lock holds that daemon's pid. Two daemons started at once (two
// attaches after a reboot left a dead socket behind) both find nothing listening; without the lock the
// second would remove the first one's fresh socket, and the first would run on unreachable. A lock is
// stale when its daemon is gone, or when it never got listening (30 s: a pid can be reused).
const LOCK = path.join(DIR, 'daemon.lock');
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function takeLock() {
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let pid, age;
    try { pid = Number(fs.readFileSync(LOCK, 'utf8')); age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { continue; }
    if (pid && pidAlive(pid) && age < 30e3) return false;
    // Stale: moved aside, then checked. If what moved was not that stale lock, another daemon took
    // the lock in between: it goes back, and that daemon starts.
    const aside = `${LOCK}.${process.pid}`;
    try { fs.renameSync(LOCK, aside); } catch { continue; }
    if (Number(fs.readFileSync(aside, 'utf8')) !== pid) { try { fs.renameSync(aside, LOCK); } catch {} return false; }
    fs.rmSync(aside, { force: true });
  }
  return false;
}
function releaseLock() {
  try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK); } catch {}
}
process.on('exit', releaseLock);

// ---- one folder, one machine ----
// Several machines can share this folder (a home on NFS, as on a lab's machines), but a daemon serves it
// from one of them: its socket can't be reached from another, its lock's pid means nothing there, and a
// second daemon on another machine would take the first one's socket and delete the releases it runs. So
// the daemon serving the folder says where it runs (daemon.host, rewritten every 20 s while it serves),
// and one started on another machine while that is fresh leaves (attach.mjs tells the client where it runs).
const HOST_FILE = path.join(DIR, 'daemon.host');
const HOST_FRESH_MS = 120e3; // (NFS may show another machine's write up to a minute late)
function hostElsewhere() {
  try {
    const { host, pid } = JSON.parse(fs.readFileSync(HOST_FILE, 'utf8'));
    if (!host || host === os.hostname() || Date.now() - fs.statSync(HOST_FILE).mtimeMs >= HOST_FRESH_MS) return '';
    // (or this machine under its earlier name: a laptop's changes with the network it is on)
    const here = pidAlive(pid) && /daemon\.mjs/.test(execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
    return here ? '' : host;
  } catch { return ''; }
}
function claimHost() {
  if (retiring || exiting) return; // (a retiring daemon's successor claims it)
  try { fs.writeFileSync(HOST_FILE, JSON.stringify({ host: os.hostname(), pid: process.pid }) + '\n'); } catch {}
}
function releaseHost() {
  try { const h = JSON.parse(fs.readFileSync(HOST_FILE, 'utf8')); if (h.host === os.hostname() && h.pid === process.pid) fs.rmSync(HOST_FILE); } catch {}
}
process.on('exit', releaseHost);

// Whether a daemon listens on socket `p`.
const listening = (p) => new Promise((resolve) => {
  const c = net.connect(p);
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('error', () => resolve(false));
});

let server;
const probe = net.connect(SOCK);
probe.on('connect', () => { log('daemon already running'); process.exit(0); });
probe.on('error', async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const elsewhere = hostElsewhere();
  if (elsewhere) { log(`IroWell runs on ${elsewhere}, which shares ${DIR} with this machine: not starting here`); process.exit(1); }
  // Started to take over from a retiring daemon (an update), this one first checks that its Claude Code
  // runs: with one that doesn't, every session it took would fail at once, so it leaves them where they
  // are. (The retiring daemon asked the same before it retired, unless it is older than that question.)
  // A socket left by a daemon that died is no one to take over from.
  const retiringSocks = fs.readdirSync(DIR).filter((f) => /^old-[0-9a-f]{8}\.sock$/.test(f)).map((f) => path.join(DIR, f));
  if ((await Promise.all(retiringSocks.map(listening))).some(Boolean)) {
    const why = await checkCli();
    if (why) { log('not taking over the sessions:', why); process.exit(1); }
  }
  if (!takeLock()) { log('another daemon is starting'); process.exit(0); }
  fs.rmSync(SOCK, { force: true }); // left by a daemon that died (we hold the lock: nobody else listens there)
  server = net.createServer(onClient);
  server.on('error', (e) => { log('cannot listen on', SOCK, e.message); process.exit(1); });
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o600);
    log('daemon listening on', SOCK, 'pid', process.pid);
    claimHost();
    setInterval(claimHost, 20e3);
    start().catch((e) => { log('start failed', e); ready(); });
  });
});
