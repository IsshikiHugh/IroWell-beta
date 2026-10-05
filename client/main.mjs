// Local side (started by client.mjs): keeps an ssh stdio pipe to each remote daemon a tab shows and
// serves the UI on 127.0.0.1. Nothing listens on the server; closing this process loses nothing.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..', 'server');
const REMOTE_DIR = '.iro-coding'; // relative to the remote $HOME
// Fingerprint of server/daemon.mjs as it is now (what Update server installs), compared with the one the
// daemon's hello reports. Not taken once at start: after an edit or a pull while this client runs, a
// server updated to the new file would otherwise look outdated for good.
let codeSeen = { key: '', code: '' };
function localCode() {
  const file = path.join(SERVER_DIR, 'daemon.mjs');
  try {
    const st = fs.statSync(file), key = `${st.mtimeMs}:${st.size}`;
    if (key !== codeSeen.key) codeSeen = { key, code: createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12) };
  } catch {}
  return codeSeen.code;
}
// A host that doesn't answer, or a link that dies quietly (e.g. during an install's npm run), ends the
// command instead of leaving it waiting for hours.
const SSH_BASE = ['-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
// The short commands (install, scp, stop) set up none of the LocalForward/RemoteForward/DynamicForward
// entries of ~/.ssh/config: they would only clash with the long-lived connection's.
const SSH_OPTS = ['-o', 'ClearAllForwardings=yes', ...SSH_BASE];
// The long-lived connection to a host (attach.mjs) sets them up, as `ssh <host>` in a terminal does, for
// as long as the client is connected. A forward that can't be set up (its local port is taken, e.g. by
// a terminal ssh to the same host) is skipped with a warning rather than failing the connection.
const SSH_ATTACH = ['-o', 'ExitOnForwardFailure=no', ...SSH_BASE];
const NOT_INSTALLED = 86; // exit code of the ssh command when the host has no IroWell yet

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
// The server picked by the flags (an ssh host, or local: this machine); otherwise each tab picks one.
const host = flag('host') || null;
const local = !host && argv.includes('--local');
const port = Number(flag('port', 4777));
const remoteNode = flag('remote-node', 'node');
// The ssh command that runs attach.mjs on the host (exit NOT_INSTALLED when there is none).
const attachCmd = (args = '') => `test -f ~/${REMOTE_DIR}/attach.mjs || exit ${NOT_INSTALLED}; exec "$SHELL" -lc 'cd ~/${REMOTE_DIR} && exec ${remoteNode} attach.mjs${args}'`;
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

if (!Number.isInteger(port) || (argv.includes('--stop') && !host && !local)) {
  console.error('usage: node client.mjs [--host <ssh-host> | --local] [--port 4777] [--remote-node node] [--stop]');
  process.exit(1);
}

// Local: the daemon runs from this checkout and keeps its state in ~/.iro-coding of this machine.
// The client talks to its socket directly (no attach.mjs in between) and starts it when none runs.
const LOCAL_DIR = process.env.IRO_DIR || path.join(os.homedir(), REMOTE_DIR);
const LOCAL_SOCK = path.join(LOCAL_DIR, 'daemon.sock');
// A laptop is not a server: on the first local start, config.json gets the local defaults (the daemon
// reads it on the fly; see "local machines" in server/daemon.mjs). Edit it to change them.
function localDefaults() {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const cfg = path.join(LOCAL_DIR, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ detachIdleMinutes: 60, keepAwake: true }, null, 2) + '\n');
}

// ---- the servers the page offers: this machine, then the ones connected to most recently, then the
// rest of ~/.ssh/config in its own order ----
// Host entries of ~/.ssh/config (and the files it Includes), without patterns (*, ?, !).
function sshHosts() {
  const out = [], seen = new Set();
  const sshDir = path.join(os.homedir(), '.ssh');
  const expand = (p) => {
    p = p.replace(/^~(?=$|\/)/, os.homedir());
    p = path.resolve(sshDir, p);
    if (!/[*?]/.test(path.basename(p))) return [p];
    const re = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    try { return fs.readdirSync(path.dirname(p)).filter((f) => re.test(f)).sort().map((f) => path.join(path.dirname(p), f)); } catch { return []; }
  };
  const read = (file, depth) => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    let block = []; // the entries the current Host line named
    for (const raw of text.split('\n')) {
      const m = /^\s*(\w+)\s*(?:=\s*|\s+)(.*)$/.exec(raw.replace(/(^|\s)#.*/, ''));
      if (!m) continue;
      const key = m[1].toLowerCase();
      const args = (m[2].match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
      if (key === 'include' && depth < 8) for (const a of args) for (const f of expand(a)) read(f, depth + 1);
      else if (key === 'host') {
        block = [];
        for (const a of args) {
          if (/[*?!]/.test(a) || seen.has(a)) continue;
          seen.add(a);
          const e = { host: a };
          out.push(e);
          block.push(e);
        }
      } else if (key === 'match') block = [];
      else if (key === 'hostname' || key === 'user') for (const e of block) e[key] ??= args[0];
    }
  };
  read(path.join(sshDir, 'config'), 0);
  return out;
}
// Servers picked in the page, newest first: ['local' | 'ssh:<host>'] (kept next to the local daemon's state).
const CLIENT_FILE = path.join(LOCAL_DIR, 'client.json');
const readClientState = () => { try { return JSON.parse(fs.readFileSync(CLIENT_FILE, 'utf8')); } catch { return {}; } };
function rememberTarget(id) {
  const st = readClientState();
  st.recent = [{ id, at: Date.now() }, ...(st.recent || []).filter((x) => x.id !== id)].slice(0, 30);
  try { fs.mkdirSync(LOCAL_DIR, { recursive: true }); fs.writeFileSync(CLIENT_FILE, JSON.stringify(st, null, 2) + '\n'); } catch {}
}
// `current`: the server of the tab asking (marked in its picker).
function targets(current) {
  const recent = readClientState().recent || [];
  const when = new Map(recent.map((x) => [x.id, x.at]));
  const config = sshHosts();
  const inConfig = new Set(config.map((e) => e.host));
  const ssh = [
    ...recent.filter((x) => x.id.startsWith('ssh:') && !inConfig.has(x.id.slice(4))).map((x) => ({ host: x.id.slice(4) })), // typed in by hand
    ...config,
  ].map((e) => ({ id: `ssh:${e.host}`, host: e.host, detail: e.hostname || e.user ? `${e.user ? e.user + '@' : ''}${e.hostname || e.host}` : '', lastUsed: when.get(`ssh:${e.host}`) || null }));
  const used = ssh.filter((t) => t.lastUsed).sort((a, b) => b.lastUsed - a.lastUsed);
  return {
    current: current || null,
    list: [{ id: 'local', local: true, host: os.hostname(), detail: 'this machine', lastUsed: when.get('local') || null }, ...used, ...ssh.filter((t) => !t.lastUsed)],
  };
}

// "0.3.284" > "0.3.283" (numeric parts; no pre-releases on this package's latest tag)
const newer = (a, b) => {
  if (!a || !b) return false;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
// Runs a command; resolves to its output, rejects with the last line of it when it fails.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (exit ${code})${out.trim() ? ': ' + out.trim().split('\n').pop() : ''}`))));
  });
}

// The packages of client/ (the page's Markdown, KaTeX, highlighting and diff libraries) and, for this
// machine, of server/ are installed whenever one that package-lock.json pins is missing or older (a
// newer one is kept: Update server installs the newest Agent SDK on top of the pinned one).
const npmRuns = new Map(); // dir -> the npm install running there
async function ensurePackages(dir, { exit = true } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  const deps = Object.keys(lock.packages?.[''].dependencies || {});
  const installed = (name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; } };
  const pinned = (d) => lock.packages[`node_modules/${d}`]?.version;
  if (deps.every((d) => installed(d) && !newer(pinned(d), installed(d)))) return;
  // Two at once in one folder (a second click while the first runs) would both write node_modules.
  if (!npmRuns.has(dir)) {
    console.log(`installing the packages of ${path.relative(process.cwd(), dir) || dir} (npm install)…`);
    npmRuns.set(dir, run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir }).finally(() => npmRuns.delete(dir)));
  }
  try {
    await npmRuns.get(dir);
  } catch (e) {
    const msg = `cannot install the packages of ${dir}: ${e.message}`;
    if (!exit) throw new Error(msg);
    console.error(msg);
    process.exit(1);
  }
}
// --stop: connect without starting a daemon, ask it to shut down, wait until it has gone.
async function stopServer() {
  const where = host || 'this machine';
  const io = local ? net.connect(LOCAL_SOCK) : spawn('ssh', ['-T', ...SSH_OPTS, host, attachCmd(' --no-start')], { stdio: ['pipe', 'pipe', 'inherit'] });
  const [input, output] = local ? [io, io] : [io.stdin, io.stdout];
  let closed = null;
  const done = await new Promise((resolve) => {
    output.setEncoding('utf8');
    output.on('data', lines((l) => {
      let m;
      try { m = JSON.parse(l); } catch { return; }
      if (m.type === 'hello') input.write(JSON.stringify({ type: 'shutdown', id: 1 }) + '\n');
      else if (m.type === 'reply' && m.id === 1) closed = m.data?.sessions ?? 0;
    }));
    io.on('error', () => {}); // no daemon (local): 'close' follows
    io.on(local ? 'close' : 'exit', resolve);
  });
  if (closed != null) console.log(`stopped the IroWell server on ${where}${closed ? ` (${closed} session${closed > 1 ? 's' : ''} closed; sending to one reattaches it)` : ''}`);
  else if (local || done === 3 || done === NOT_INSTALLED) console.log(`no IroWell server is running on ${where}`);
  else { console.error(`cannot reach ${where} (ssh exit ${done})`); process.exit(1); }
  process.exit(0);
}
if (argv.includes('--stop')) await stopServer();

await ensurePackages(HERE);

// ---- install and update the server: from the UI's button, and on its own on a host without IroWell ----
// Updates never interrupt a session. `install` copies server/ to a new release folder on the host
// (~/.iro-coding/releases/r<time>), installs its packages there and points ~/.iro-coding/current at
// it; the running daemon's files stay as they are. `switchOver` then asks the running daemon to
// retire: it starts the new release and hands each session over as soon as that session is quiet
// (server/daemon.mjs, "rolling updates"). On this machine the daemon restarts from this checkout the
// same way, after the newest Agent SDK is installed into it.
async function install(host) {
  const rel = `r${Date.now()}`;
  const dir = `${REMOTE_DIR}/releases/${rel}`;
  const files = ['package.json', 'package-lock.json', 'daemon.mjs', 'attach.mjs', 'install.sh'].map((f) => path.join(SERVER_DIR, f));
  await run('ssh', [...SSH_OPTS, host, `mkdir -p ${dir}`]);
  await run('scp', [...SSH_OPTS, ...files, `${host}:${dir}/`]);
  // Login shell so node/npm from the user's profile are on PATH; the script itself is plain sh.
  // IRO_NODE: the node that will run the daemon (--remote-node), which install.sh checks first.
  const out = await run('ssh', [...SSH_OPTS, host, `exec "$SHELL" -lc 'IRO_NODE=${remoteNode} sh ~/${dir}/install.sh'`]);
  return { rel, sdkError: sdkFetchError(out) };
}
// install.sh goes on with the pinned Agent SDK when it can't fetch the newest one; say why.
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const sdkFetchError = (out) => {
  if (!/could not fetch the newest Agent SDK/.test(out)) return '';
  const why = out.split('\n').map((l) => l.trim()).filter((l) => /^npm (error|ERR!)/.test(l)).slice(0, 2).join(' ');
  return `could not fetch the newest Claude Code (${SDK_PKG}@latest)${why ? ': ' + why : ''}`;
};
// This machine: the newest Agent SDK into server/node_modules (package.json and the lock file stay as
// they are), when a newer one is out.
async function updateLocalSdk(c) {
  if (!sdkBehind(c)) return '';
  try { await run('npm', ['install', '--no-save', '--no-audit', '--no-fund', `${SDK_PKG}@latest`], { cwd: SERVER_DIR }); return ''; }
  catch (e) { return `could not fetch the newest Claude Code: ${e.message}`; }
}
// Polls `pred` every 200 ms until it holds (true) or `ms` pass (false).
async function waitFor(pred, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (pred()) return true;
  return pred();
}
// Done once this client talks to the new daemon: until then the button stays "Updating…" (a click would
// only reach the retiring daemon), and a new daemon that never comes up is an error, not a quiet no-op.
async function switchOver(c, rel) {
  // (the install can take minutes: a connection that dropped meanwhile gets a moment to come back)
  if (!await waitFor(() => c.up && c.lastHello, 15000)) throw new Error('Not connected to the server');
  if (rel && c.lastHello.release === rel) return; // nothing was running: attach just started this release
  const daemon = c.local ? path.join(SERVER_DIR, 'daemon.mjs') : `${c.lastHello.home}/${REMOTE_DIR}/current/daemon.mjs`;
  const was = c.lastHello.boot;
  const r = await request(c, { type: 'retire', daemon });
  if (r.error != null) throw new Error(r.error);
  if (!await waitFor(() => c.stopped || (c.up && c.lastHello?.boot !== was), Number(process.env.IRO_TEST_TAKEOVER_MS) || 60000)) {
    throw new Error(`the new daemon did not take over (see ${c.local ? path.join(LOCAL_DIR, 'daemon.log') : `~/${REMOTE_DIR}/daemon.log on ${c.host}`}); click Update server to try again`);
  }
}

async function deploy(c) {
  if (c.deploying) return;
  const fresh = !c.installed;
  c.deploying = true; c.deployError = '';
  broadcast(c, status(c));
  console.log(`${fresh ? 'installing IroWell on' : 'updating'} ${c.host || 'the local daemon'}…`);
  try {
    const { rel = null, sdkError } = c.local ? { sdkError: await updateLocalSdk(c) } : await install(c.host);
    if (fresh) { // attach starts the new release
      c.installed = true;
      c.retry = 1000;
      if (!c.pipe && !c.gone) connect(c);
    } else await switchOver(c, rel);
    console.log(fresh ? `installed IroWell on ${c.host}` : `updated ${c.host || 'the local daemon'}: sessions move over as they go idle`);
    if (sdkError) { c.deployError = `${fresh ? 'Installed' : 'Updated'}, but ${sdkError}`; console.error(c.deployError); }
  } catch (e) {
    c.deployError = `${fresh ? 'Install' : 'Update'} failed: ${e.message}`;
    console.error(c.deployError);
    throw e;
  } finally {
    c.deploying = false;
    broadcast(c, status(c));
  }
}

// ---- connections: one per server that some tab of the page shows ----
// Each tab picks its own server (its URL says which: ?server=local or ?server=ssh:<host>), so two
// tabs can show two servers at once. Tabs on the same server share one connection. A connection keeps
// a local copy of its server's event log so tabs can (re)load instantly and never have to reconcile
// replayed vs live events themselves. One that no tab has shown for DROP_MS is let go, except the
// server picked last: a tab opened without ?server= starts on it, and it stays connected with no tab open.
const token = randomBytes(16).toString('hex');
const conns = new Map(); // target id ('local' | 'ssh:<host>') -> connection
let lastTarget = null;   // the server picked last (or by the flags)
const DROP_MS = Number(process.env.IRO_DROP_MS) || 120000;
const parseTarget = (id) => id === 'local' ? { local: true, host: null }
  : /^ssh:[\w.@%:[\]+-]+$/.test(id || '') && !id.startsWith('ssh:-') ? { local: false, host: id.slice(4) } : null;

// The connection to `id`, opened when there is none yet (null: not a server).
function getConn(id) {
  let c = conns.get(id);
  if (c) return c;
  const t = parseTarget(id);
  if (!t) return null;
  c = {
    id, ...t,
    sse: new Set(), cache: [], boot: null, lastSeq: 0,
    pipe: null, up: false, lastError: '', retry: 1000, reconnectTimer: null, dropTimer: null, gone: false,
    stopped: false, // the daemon was told to stop: don't reconnect (that would start a new one) until Start server
    sdk: null, // { version, cc, latest, latestCc } of the server's Agent SDK (and the Claude Code it ships)
    home: null, user: '', // the name behind the avatar on your messages
    lastHello: null, forwarded: OLD_DAEMON_COMMANDS,
    pending: new Map(), // request id -> { done, timer }
    installed: true, // false once the host turned out to have no IroWell
    autoInstalled: false, // the first install happens on its own; a failed one waits for the button
    deploying: false, deployError: '',
  };
  conns.set(id, c);
  rememberTarget(id);
  console.log(`connecting to ${c.host || 'this machine'}`);
  (async () => {
    if (c.local) {
      localDefaults();
      try { await ensurePackages(SERVER_DIR, { exit: false }); } catch (e) { c.lastError = e.message; return broadcast(c, status(c)); }
    }
    if (!c.gone) connect(c);
  })();
  return c;
}
function dropConn(c) {
  c.gone = true;
  conns.delete(c.id);
  clearTimeout(c.reconnectTimer); clearTimeout(c.dropTimer);
  const p = c.pipe;
  c.pipe = null;
  p?.drop();
  for (const [, r] of c.pending) { clearTimeout(r.timer); r.done({ error: 'disconnected' }); }
  c.pending.clear();
  console.log(`disconnected from ${c.host || 'this machine'} (no tab shows it)`);
}
// Arms (or disarms) the timer that lets an unshown connection go.
function idleCheck(c) {
  clearTimeout(c.dropTimer);
  if (c.gone || c.sse.size || c.id === lastTarget) return;
  c.dropTimer = setTimeout(() => (c.deploying ? idleCheck(c) : dropConn(c)), DROP_MS);
}
// The picker in a tab picked `id` (or the flags did at start): the tab then reopens its stream on it.
function selectTarget(id) {
  if (!parseTarget(id)) throw new Error(`Not a server: ${id}`);
  const prev = conns.get(lastTarget);
  lastTarget = id;
  rememberTarget(id);
  const c = getConn(id);
  clearTimeout(c.dropTimer);
  if (prev && prev !== c) idleCheck(prev);
}

const stale = (c) => !!c.lastHello && c.lastHello.code !== localCode(); // the server runs different daemon code than this checkout
const sdkBehind = (c) => !!c.sdk && newer(c.sdk.latest, c.sdk.version);
const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const broadcast = (c, obj) => { for (const res of c.sse) send(res, obj); };
const NO_TARGET = { type: 'transport', up: false, target: null, host: null, error: '', stale: '' };
const status = (c) => ({
  type: 'transport', up: c.up, target: c.id, host: c.local ? 'local' : c.host, error: c.deployError || (c.up ? '' : c.lastError), home: c.home, user: c.user,
  stale: !c.up ? '' : stale(c) ? (c.local ? 'The local daemon runs older code than this checkout.' : 'The server runs an older IroWell than this client.')
    : sdkBehind(c) ? `Claude Code ${c.sdk.latestCc || c.sdk.latest} is out (the server runs ${c.sdk.cc || c.sdk.version}).` : '',
  // The button in the UI: Install (a host without IroWell) or Update (older code, or a newer Agent SDK).
  // Claude Code isn't logged in there: the command that logs it in, to run on the server (empty otherwise).
  login: c.up && c.auth?.loggedIn === false ? c.auth.cmd || 'claude auth login' : '',
  deploy: c.installed ? 'update' : 'install', canDeploy: !c.installed || (c.up && (stale(c) || sdkBehind(c))), deploying: c.deploying, stopped: c.stopped,
});
// Start server (after a stop): the next connection starts a daemon.
function start(c) {
  if (!c.stopped) return;
  c.stopped = false;
  c.retry = 1000;
  broadcast(c, status(c));
  if (!c.pipe) connect(c);
}

function setUp(c, v) {
  c.up = v;
  broadcast(c, status(c));
}

const warnLogin = (c) => { if (c.auth?.loggedIn === false) console.error(`Claude is not logged in on ${c.host || 'this machine'}: run \`${c.auth.cmd || 'claude auth login'}\` there`); };
function onLine(c, l) {
  let m;
  try { m = JSON.parse(l); } catch { return; } // e.g. noise printed by a login profile
  if (m.type === 'hello') {
    c.retry = 1000;
    c.lastError = ''; // (an error from before this connection, e.g. "not installed", is over)
    c.home = m.home || null;
    c.user = m.user || '';
    c.lastHello = m;
    c.forwarded = Array.isArray(m.commands) ? new Set(m.commands) : OLD_DAEMON_COMMANDS;
    c.sdk = m.sdk || null;
    c.auth = m.auth || null;
    warnLogin(c);
    if (stale(c) && !c.local) console.error(`warning: ${c.host} runs different daemon code (${m.code || 'old'} vs ${localCode()}); click Update server in the UI`);
    if (m.boot !== c.boot) { // new daemon: its history replaces ours
      c.boot = m.boot;
      c.cache.length = 0;
      c.lastSeq = 0;
      broadcast(c, { type: 'reset' });
    }
    c.pipe.write(JSON.stringify({ type: 'sync', since: c.lastSeq, boot: c.boot }) + '\n');
    setUp(c, true);
  } else if (m.type === 'shutdown') { // the daemon is stopping (asked to, by us or by another client)
    c.stopped = true;
    console.log(`the server on ${c.host || 'this machine'} was stopped; Start server in the UI starts it again`);
  } else if (m.type === 'partial' && m.op === 'sdk') {
    c.sdk = m.sdk;
    broadcast(c, status(c));
  } else if (m.type === 'partial' && m.op === 'auth') {
    c.auth = m.auth;
    warnLogin(c);
    broadcast(c, status(c));
  } else if (m.type === 'reply') {
    const p = c.pending.get(m.id);
    if (p) { c.pending.delete(m.id); clearTimeout(p.timer); p.done(m); }
  } else if (m.type === 'compact') { // the daemon trimmed its log: the next page load gets the same
    const gone = new Set(m.removed);
    const swap = new Map((m.replaced || []).map((e) => [e.seq, e]));
    const kept = c.cache.filter((e) => !gone.has(e.seq)).map((e) => swap.get(e.seq) || e);
    c.cache.length = 0;
    c.cache.push(...kept);
  } else if (m.type === 'event') {
    if (m.seq <= c.lastSeq) return;
    c.lastSeq = m.seq;
    c.cache.push(m);
    broadcast(c, m);
  } else {
    broadcast(c, m);
  }
}

// One connection to a daemon: an ssh process running attach.mjs on the host, or (local) the daemon's
// socket itself. Lines go to onLine; when it ends we reconnect with backoff.
function connect(c) {
  let me = null;
  // Output still buffered from a connection that was dropped is not ours any more.
  const onData = lines((l) => { if (!c.gone && c.pipe === me) onLine(c, l); });
  const ended = (code) => {
    if (c.gone || c.pipe !== me) return;
    c.pipe = null;
    for (const [id, r] of c.pending) { clearTimeout(r.timer); r.done({ error: 'connection lost' }); c.pending.delete(id); }
    setUp(c, false);
    if (c.stopped) { c.lastError = ''; return broadcast(c, status(c)); }
    if (code === NOT_INSTALLED) {
      c.installed = false;
      c.lastError = `IroWell is not installed on ${c.host}`;
      broadcast(c, status(c));
      if (!c.autoInstalled) { c.autoInstalled = true; deploy(c).catch(() => {}); } // it connects once installed
      return; // otherwise the Install button tries again
    }
    console.error(`transport to ${c.host || 'this machine'} exited (${code}); reconnecting in ${c.retry / 1000}s`);
    c.reconnectTimer = setTimeout(() => { c.reconnectTimer = null; if (!c.gone) connect(c); }, c.retry);
    c.retry = Math.min(c.retry * 2, 15000);
  };
  if (c.local) {
    connectLocal((sock, err) => {
      if (c.gone) return sock?.destroy();
      if (!sock) { c.lastError = err; return ended(err); }
      me = c.pipe = { write: (s) => sock.write(s), drop: () => sock.destroy() };
      sock.setEncoding('utf8');
      sock.on('data', onData);
      sock.on('error', (e) => { c.lastError = e.message; });
      sock.on('close', () => ended('socket closed'));
    });
    return;
  }
  const p = spawn('ssh', ['-T', ...SSH_ATTACH, c.host, attachCmd()], { stdio: ['pipe', 'pipe', 'pipe'] });
  me = c.pipe = { write: (s) => p.stdin.write(s), drop: () => p.kill() };
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', onData);
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => {
    process.stderr.write(d);
    const last = d.trim().split('\n').pop();
    if (last) c.lastError = last;
  });
  p.on('error', (e) => { c.lastError = e.message; }); // e.g. ssh not installed; 'exit' still follows
  p.on('exit', ended);
  p.stdin.on('error', () => {});
}

// SIGUSR2 drops the connections as a network failure would (the tests use it); they reconnect.
process.on('SIGUSR2', () => { for (const c of conns.values()) c.pipe?.drop(); });

// The local daemon's socket, starting the daemon (detached: it outlives this client) when nothing
// listens there. Same steps as server/attach.mjs on a host.
function connectLocal(done, triesLeft = 40, started = false) {
  const sock = net.connect(LOCAL_SOCK);
  sock.once('connect', () => { sock.removeAllListeners('error'); done(sock); });
  sock.once('error', (e) => {
    sock.destroy();
    if (triesLeft <= 0) return done(null, `cannot reach the local daemon (${e.code}); see ${path.join(LOCAL_DIR, 'daemon.log')}`);
    if (!started) {
      const out = fs.openSync(path.join(LOCAL_DIR, 'daemon.log'), 'a');
      spawn(process.execPath, [path.join(SERVER_DIR, 'daemon.mjs')], { detached: true, stdio: ['ignore', out, out], cwd: LOCAL_DIR }).unref();
      fs.closeSync(out);
    }
    setTimeout(() => connectLocal(done, triesLeft - 1, true), 250);
  });
}

// ---- local HTTP: page, static assets, SSE stream, command POST ----
// Read on every request, so an updated page never pairs with a stale copy of index.html.
const html = () => fs.readFileSync(path.join(HERE, 'index.html'), 'utf8').replace('__TOKEN__', token)
  .replace('__TERM_FONT__', termFont.replace(/[&"<>]/g, (c) => `&#${c.charCodeAt(0)};`));
// The shell panel's font: the one your terminal uses (iTerm2's default profile, read once at start, on
// a Mac), so prompts drawn with Powerline / Nerd Font glyphs look as they do there. ui/shell.js falls
// back to the usual Nerd and Powerline fonts when there is none.
let termFont = '';
if (process.platform === 'darwin') {
  const jxa = `ObjC.import("AppKit");
    const d = $.NSUserDefaults.alloc.initWithSuiteName("com.googlecode.iterm2");
    const guid = ObjC.unwrap(d.stringForKey("Default Bookmark Guid"));
    const books = ObjC.deepUnwrap(d.arrayForKey("New Bookmarks")) || [];
    const b = books.find((x) => x.Guid === guid) || books[0] || {};
    const m = /^(.*) ([\\d.]+)$/.exec(b["Normal Font"] || "");
    const f = m && $.NSFont.fontWithNameSize(m[1], Number(m[2]));
    f && !f.isNil() ? ObjC.unwrap(f.familyName) : ""`;
  execFile('osascript', ['-l', 'JavaScript', '-e', jxa], { timeout: 5000 }, (err, out) => { if (!err) termFont = String(out).trim().slice(0, 100); });
}
const NM = path.join(HERE, 'node_modules');
const STATIC = { // url prefix -> directory; files are served only from inside these
  '/ui/': path.join(HERE, 'ui'),
  '/vendor/marked/': path.join(NM, 'marked/lib'),
  '/vendor/purify/': path.join(NM, 'dompurify/dist'),
  '/vendor/katex/': path.join(NM, 'katex/dist'),
  '/vendor/diff/': path.join(NM, 'diff/libesm'),
  '/vendor/hljs/': path.join(NM, '@highlightjs/cdn-assets'),
  '/vendor/xterm/': path.join(NM, '@xterm/xterm'),
  '/vendor/xterm-fit/': path.join(NM, '@xterm/addon-fit'),
};
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };

function serveStatic(pathname, res) {
  const prefix = Object.keys(STATIC).find((p) => pathname.startsWith(p));
  if (!prefix) return false;
  const base = STATIC[prefix];
  let rel;
  try { rel = decodeURIComponent(pathname.slice(prefix.length - 1)); } catch { rel = ''; } // malformed %-escape
  const file = path.resolve(base, '.' + rel);
  const type = MIME[path.extname(file)];
  if (!file.startsWith(base + path.sep) || !type || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end();
    return true;
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': prefix === '/ui/' ? 'no-store' : 'max-age=86400' });
  fs.createReadStream(file).pipe(res);
  return true;
}
const okHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
// What the page may ask the daemon: the commands its hello lists (the daemon keeps a few for client.mjs
// and other daemons only). A daemon from before that list (until it is updated) gets this fixed set.
const OLD_DAEMON_COMMANDS = new Set(['new', 'resume', 'transcript', 'send', 'queue', 'approve', 'interrupt', 'setModel', 'setMode', 'commands', 'models',
  'complete', 'readFile', 'history', 'rename', 'close', 'status', 'usage', 'context', 'btw', 'btwList', 'btwClose', 'setSuggest', 'setEffort', 'stats', 'activity', 'overview', 'stopTask', 'killProc', 'setColor', 'stat', 'readChunk', 'usageHistory', 'usageForecast', 'limits', 'prepareMedia',
  'folders', 'addFolder', 'removeFolder', 'archive', 'ls', 'recentDirs', 'defaultMode', 'branch', 'rewind', 'shutdown',
  'shellList', 'shellOpen', 'shellRead', 'shellInput', 'shellResize', 'shellRename', 'shellClose']);
const MAX_BODY = 48 << 20; // pasted images


function request(c, cmd) {
  return new Promise((done) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      c.pending.delete(id);
      done({ error: stale(c) ? 'No answer: the server runs an older IroWell. Click Update server.' : 'Timed out waiting for the server.' });
    }, 30000);
    c.pending.set(id, { done, timer });
    c.pipe.write(JSON.stringify({ ...cmd, id }) + '\n');
  });
}
let nextId = 1;

const server = http.createServer((req, res) => {
  // Any web page can make the browser request this port: nothing a request carries may throw.
  try { handle(req, res); } catch (e) {
    console.error('request failed:', e.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

function handle(req, res) {
  if (!okHost.has(req.headers.host)) return res.writeHead(403).end(); // DNS-rebinding guard
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    // Images only from here (render.js turns remote Markdown images into links; this backs it up).
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "img-src 'self' data: blob:" }).end(html());
  }
  if (req.method === 'GET' && serveStatic(url.pathname, res)) return;
  if (req.method === 'GET' && url.pathname === '/events') {
    if (url.searchParams.get('t') !== token) return res.writeHead(403).end();
    // The tab's server; a tab that has none yet starts on the one picked last.
    const id = url.searchParams.get('target') || lastTarget;
    const c = id ? getConn(id) : null;
    if (id && !c) return res.writeHead(400).end();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(res, { type: 'reset' });
    if (!c) return send(res, NO_TARGET); // its picker connects, and the tab reopens the stream
    for (const e of c.cache) send(res, e);
    send(res, status(c));
    c.sse.add(res);
    clearTimeout(c.dropTimer);
    req.on('close', () => { c.sse.delete(res); idleCheck(c); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/cmd') {
    // Custom header => cross-site pages can't send this without a CORS preflight.
    if (req.headers['x-token'] !== token) return res.writeHead(403).end();
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      body += c;
    });
    req.on('end', async () => {
      let cmd;
      try { cmd = JSON.parse(body); } catch { return res.writeHead(400).end(); }
      const json = (out) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      if (cmd?.type === 'targets') return json({ data: targets(req.headers['x-target'] || lastTarget) });
      if (cmd?.type === 'connect') { try { selectTarget(cmd.target); return json({ data: null }); } catch (e) { return json({ error: e.message }); } }
      // The tab's server (x-target); without one (scripts, tests), the one picked last.
      const id = req.headers['x-target'] || lastTarget;
      const c = id ? getConn(id) : null;
      if (id && !c) return res.writeHead(400).end();
      if (c && cmd?.type === 'deploy') return json(await deploy(c).then(() => ({ data: null }), (e) => ({ error: e.message }))); // handled here, not by the daemon
      if (c && cmd?.type === 'start') { start(c); return json({ data: null }); }
      // Reconnecting (e.g. the daemon was just updated): wait a little rather than fail the command.
      for (let i = 0; i < 50 && c && !c.gone && !c.stopped && (!c.pipe || !c.up); i++) await new Promise((r) => setTimeout(r, 200));
      if (!(c?.forwarded || OLD_DAEMON_COMMANDS).has(cmd?.type)) return res.writeHead(400).end(); // (checked against the daemon it would go to)
      if (!c?.pipe || !c.up) return res.writeHead(503).end('not connected');
      const r = await request(c, cmd);
      json(r.error != null ? { error: r.error } : { data: r.data });
    });
    return;
  }
  res.writeHead(404).end();
}

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${port} is in use; pick another with --port` : e.message);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`IroWell → http://127.0.0.1:${port}/  ${host ? `(ssh ${host})` : local ? '(this machine)' : '(pick a server in the page)'}`);
  if (host || local) { try { selectTarget(local ? 'local' : `ssh:${host}`); } catch (e) { console.error(e.message); } }
});
