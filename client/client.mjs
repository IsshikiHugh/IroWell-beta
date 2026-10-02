#!/usr/bin/env node
// Local side: keeps an ssh stdio pipe to the remote daemon and serves the UI on
// 127.0.0.1. Nothing listens on the server; closing this process loses nothing.
//
//   node client.mjs                          open the UI; pick the server there (this machine, or a host from ~/.ssh/config)
//   node client.mjs --host devbox            ... connected to that host right away (installs IroWell there the first time)
//   node client.mjs --local                  ... connected to this machine right away (no ssh)
//   node client.mjs --host devbox --stop     stop the server (also: --local --stop, or ⏻ in the UI)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..', 'server');
const REMOTE_DIR = '.iro-coding'; // relative to the remote $HOME
const LOCAL_CODE = createHash('sha1').update(fs.readFileSync(path.join(SERVER_DIR, 'daemon.mjs'))).digest('hex').slice(0, 12);
// Don't set up LocalForward/RemoteForward entries from ~/.ssh/config on our connections.
const SSH_OPTS = ['-o', 'ClearAllForwardings=yes'];
const NOT_INSTALLED = 86; // exit code of the ssh command when the host has no IroWell yet

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
// The server this client talks to: an ssh host, or (local) this machine. Picked in the page; the
// flags pick it from the start.
let host = flag('host') || null;
let local = !host && argv.includes('--local');
const port = Number(flag('port', 4777));
const remoteNode = flag('remote-node', 'node');
// The ssh command that runs attach.mjs on the host (exit NOT_INSTALLED when there is none).
const attachCmd = (args = '') => `test -f ~/${REMOTE_DIR}/attach.mjs || exit ${NOT_INSTALLED}; exec "$SHELL" -lc 'cd ~/${REMOTE_DIR} && exec ${remoteNode} attach.mjs${args}'`;
// A 'data' listener that calls `fn` with each complete, non-empty line.
function lines(fn) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) fn(l);
    }
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
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ files: 'folders', allow: [], detachIdleMinutes: 60, keepAwake: true }, null, 2) + '\n');
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
function targets() {
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
    current: local ? 'local' : host ? `ssh:${host}` : null,
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
async function ensurePackages(dir, { exit = true } = {}) {
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  const deps = Object.keys(lock.packages?.[''].dependencies || {});
  const installed = (name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version; } catch { return null; } };
  const pinned = (d) => lock.packages[`node_modules/${d}`]?.version;
  if (deps.every((d) => installed(d) && !newer(pinned(d), installed(d)))) return;
  console.log(`installing the packages of ${path.relative(process.cwd(), dir) || dir} (npm install)…`);
  try {
    await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir });
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
async function install() {
  const rel = `r${Date.now()}`;
  const dir = `${REMOTE_DIR}/releases/${rel}`;
  const files = ['package.json', 'package-lock.json', 'daemon.mjs', 'attach.mjs', 'install.sh'].map((f) => path.join(SERVER_DIR, f));
  await run('ssh', [...SSH_OPTS, host, `mkdir -p ${dir}`]);
  await run('scp', [...SSH_OPTS, ...files, `${host}:${dir}/`]);
  // Login shell so node/npm from the user's profile are on PATH; the script itself is plain sh.
  const out = await run('ssh', [...SSH_OPTS, host, `exec "$SHELL" -lc 'sh ~/${dir}/install.sh'`]);
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
async function updateLocalSdk() {
  if (!sdkBehind()) return '';
  try { await run('npm', ['install', '--no-save', '--no-audit', '--no-fund', `${SDK_PKG}@latest`], { cwd: SERVER_DIR }); return ''; }
  catch (e) { return `could not fetch the newest Claude Code: ${e.message}`; }
}
async function switchOver(rel) {
  if (rel && lastHello.release === rel) return; // nothing was running: attach just started this release
  const daemon = local ? path.join(SERVER_DIR, 'daemon.mjs') : `${lastHello.home}/${REMOTE_DIR}/current/daemon.mjs`;
  const r = await request({ type: 'retire', daemon });
  if (r.error != null) throw new Error(r.error);
}

let installed = true; // false once the host turned out to have no IroWell
let autoInstalled = false; // the first install happens on its own; a failed one waits for the button
let deploying = false, deployError = '';
async function deploy() {
  if (deploying) return;
  const fresh = !installed;
  deploying = true; deployError = '';
  broadcast(status());
  console.log(`${fresh ? 'installing IroWell on' : 'updating'} ${host || 'the local daemon'}…`);
  try {
    const { rel = null, sdkError } = local ? { sdkError: await updateLocalSdk() } : await install();
    if (fresh) { // attach starts the new release
      installed = true;
      retry = 1000;
      if (!pipe) connect();
    } else {
      if (!up || !lastHello) throw new Error('Not connected to the server');
      await switchOver(rel);
    }
    console.log(fresh ? `installed IroWell on ${host}` : `updated ${host || 'the local daemon'}: sessions move over as they go idle`);
    if (sdkError) { deployError = `${fresh ? 'Installed' : 'Updated'}, but ${sdkError}`; console.error(deployError); }
  } catch (e) {
    deployError = `${fresh ? 'Install' : 'Update'} failed: ${e.message}`;
    console.error(deployError);
    throw e;
  } finally {
    deploying = false;
    broadcast(status());
  }
}

// ---- transport: one long-lived ssh process, restarted when it dies ----
// We keep a local copy of the event log so browser tabs can (re)load instantly
// and never have to reconcile replayed vs live events themselves.
const token = randomBytes(16).toString('hex');
const sse = new Set();
const cache = [];
let boot = null;
let lastSeq = 0;
let pipe = null;
let up = false;
let lastError = '';
let retry = 1000;
let stale = false; // the server runs different daemon code than this checkout
let stopped = false; // the daemon was told to stop: don't reconnect (that would start a new one) until Start server
let sdk = null; // { version, cc, latest, latestCc } of the server's Agent SDK (and the Claude Code it ships)
const sdkBehind = () => !!sdk && newer(sdk.latest, sdk.version);
let remoteHome = null;
let remoteUser = ''; // the name behind the avatar on your messages
let lastHello = null;
const pending = new Map(); // request id -> { done, timer }
let nextId = 1;

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const broadcast = (obj) => { for (const res of sse) send(res, obj); };
const status = () => ({
  type: 'transport', up, target: local ? 'local' : host ? `ssh:${host}` : null, host: local ? 'local' : host, error: deployError || (up ? '' : lastError), home: remoteHome, user: remoteUser,
  stale: !up ? '' : stale ? (local ? 'The local daemon runs older code than this checkout.' : 'The server runs an older IroWell than this client.')
    : sdkBehind() ? `Claude Code ${sdk.latestCc || sdk.latest} is out (the server runs ${sdk.cc || sdk.version}).` : '',
  // The button in the UI: Install (a host without IroWell) or Update (older code, or a newer Agent SDK).
  deploy: installed ? 'update' : 'install', canDeploy: !installed || (up && (stale || sdkBehind())), deploying, stopped,
});
// Start server (after a stop): the next connection starts a daemon.
function start() {
  if (!stopped) return;
  stopped = false;
  retry = 1000;
  broadcast(status());
  if (!pipe) connect();
}

// Connect to another server (the page's picker, or the flags at start): the current connection and
// everything known about its server go; the page starts over with the new one.
let connGen = 0; // connections and reconnect timers of an earlier server check this and give up
let reconnectTimer = null;
async function selectTarget(id) {
  if (deploying) throw new Error('An install or update is running: wait for it to finish first');
  const next = id === 'local' ? { local: true, host: null }
    : /^ssh:[\w.@%:[\]+-]+$/.test(id || '') && !id.startsWith('ssh:-') ? { local: false, host: id.slice(4) } : null;
  if (!next) throw new Error(`Not a server: ${id}`);
  rememberTarget(id);
  if (next.local === local && next.host === host && (pipe || reconnectTimer)) return; // already on it
  const gen = ++connGen;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const old = pipe;
  pipe = null;
  old?.drop();
  for (const [rid, r] of pending) { clearTimeout(r.timer); r.done({ error: 'switched to another server' }); pending.delete(rid); }
  ({ local, host } = next);
  boot = null; cache.length = 0; lastSeq = 0; up = false; lastError = ''; retry = 1000;
  stale = false; stopped = false; sdk = null; remoteHome = null; remoteUser = ''; lastHello = null;
  installed = true; autoInstalled = false; deployError = '';
  console.log(`connecting to ${host || 'this machine'}`);
  broadcast({ type: 'reset', server: true });
  broadcast(status());
  if (local) {
    localDefaults();
    try { await ensurePackages(SERVER_DIR, { exit: false }); } catch (e) { lastError = e.message; return broadcast(status()); }
  }
  if (gen === connGen) connect();
}

function setUp(v) {
  up = v;
  broadcast(status());
}

function onLine(l) {
  let m;
  try { m = JSON.parse(l); } catch { return; } // e.g. noise printed by a login profile
  if (m.type === 'hello') {
    retry = 1000;
    stale = m.code !== LOCAL_CODE;
    remoteHome = m.home || null;
    remoteUser = m.user || '';
    lastHello = m;
    sdk = m.sdk || null;
    if (stale && !local) console.error(`warning: ${host} runs different daemon code (${m.code || 'old'} vs ${LOCAL_CODE}); click Update server in the UI`);
    if (m.boot !== boot) { // new daemon: its history replaces ours
      boot = m.boot;
      cache.length = 0;
      lastSeq = 0;
      broadcast({ type: 'reset' });
    }
    pipe.write(JSON.stringify({ type: 'sync', since: lastSeq, boot }) + '\n');
    setUp(true);
  } else if (m.type === 'shutdown') { // the daemon is stopping (asked to, by us or by another client)
    stopped = true;
    console.log(`the server on ${host || 'this machine'} was stopped; Start server in the UI starts it again`);
  } else if (m.type === 'partial' && m.op === 'sdk') {
    sdk = m.sdk;
    broadcast(status());
  } else if (m.type === 'reply') {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); p.done(m); }
  } else if (m.type === 'event') {
    if (m.seq <= lastSeq) return;
    lastSeq = m.seq;
    cache.push(m);
    broadcast(m);
  } else {
    broadcast(m);
  }
}

// One connection to the daemon: an ssh process running attach.mjs on the host, or (--local) the
// daemon's socket itself. Lines go to onLine; when it ends we reconnect with backoff.
function connect() {
  const gen = connGen;
  const onData = lines(onLine);
  let me = null;
  const ended = (code) => {
    if (gen !== connGen || pipe !== me) return;
    pipe = null;
    for (const [id, r] of pending) { clearTimeout(r.timer); r.done({ error: 'connection lost' }); pending.delete(id); }
    setUp(false);
    if (stopped) { lastError = ''; return broadcast(status()); }
    if (code === NOT_INSTALLED) {
      installed = false;
      lastError = `IroWell is not installed on ${host}`;
      broadcast(status());
      if (!autoInstalled) { autoInstalled = true; deploy().catch(() => {}); } // it connects once installed
      return; // otherwise the Install button tries again
    }
    console.error(`transport exited (${code}); reconnecting in ${retry / 1000}s`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (gen === connGen) connect(); }, retry);
    retry = Math.min(retry * 2, 15000);
  };
  if (local) {
    connectLocal((sock, err) => {
      if (gen !== connGen) return sock?.destroy();
      if (!sock) { lastError = err; return ended(err); }
      me = pipe = { write: (s) => sock.write(s), drop: () => sock.destroy() };
      sock.setEncoding('utf8');
      sock.on('data', onData);
      sock.on('error', (e) => { lastError = e.message; });
      sock.on('close', () => ended('socket closed'));
    });
    return;
  }
  const p = spawn('ssh', ['-T', ...SSH_OPTS, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', host,
    attachCmd()], { stdio: ['pipe', 'pipe', 'pipe'] });
  me = pipe = { write: (s) => p.stdin.write(s), drop: () => p.kill() };
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', onData);
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => {
    process.stderr.write(d);
    const last = d.trim().split('\n').pop();
    if (last) lastError = last;
  });
  p.on('error', (e) => { lastError = e.message; }); // e.g. ssh not installed; 'exit' still follows
  p.on('exit', ended);
  p.stdin.on('error', () => {});
}

// SIGUSR2 drops the connection as a network failure would (the tests use it); it reconnects.
process.on('SIGUSR2', () => pipe?.drop());

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
const html = () => fs.readFileSync(path.join(HERE, 'index.html'), 'utf8').replace('__TOKEN__', token);
const NM = path.join(HERE, 'node_modules');
const STATIC = { // url prefix -> directory; files are served only from inside these
  '/ui/': path.join(HERE, 'ui'),
  '/vendor/marked/': path.join(NM, 'marked/lib'),
  '/vendor/purify/': path.join(NM, 'dompurify/dist'),
  '/vendor/katex/': path.join(NM, 'katex/dist'),
  '/vendor/diff/': path.join(NM, 'diff/libesm'),
  '/vendor/hljs/': path.join(NM, '@highlightjs/cdn-assets'),
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
const FORWARDED = new Set(['new', 'resume', 'transcript', 'send', 'queue', 'approve', 'interrupt', 'setModel', 'setMode', 'commands', 'models',
  'complete', 'readFile', 'history', 'rename', 'close', 'status', 'usage', 'context', 'btw', 'btwList', 'btwClose', 'setSuggest', 'setEffort', 'stats', 'activity', 'overview', 'stopTask', 'killProc', 'setColor', 'stat', 'readChunk', 'usageHistory', 'usageForecast', 'limits', 'prepareMedia',
  'folders', 'addFolder', 'removeFolder', 'archive', 'ls', 'recentDirs', 'defaultMode', 'branch', 'rewind', 'shutdown']);
const MAX_BODY = 48 << 20; // pasted images

function request(cmd) {
  return new Promise((done) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      done({ error: stale ? 'No answer: the server runs an older IroWell. Click Update server.' : 'Timed out waiting for the server.' });
    }, 30000);
    pending.set(id, { done, timer });
    pipe.write(JSON.stringify({ ...cmd, id }) + '\n');
  });
}

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
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html());
  }
  if (req.method === 'GET' && serveStatic(url.pathname, res)) return;
  if (req.method === 'GET' && url.pathname === '/events') {
    if (url.searchParams.get('t') !== token) return res.writeHead(403).end();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send(res, { type: 'reset' });
    for (const e of cache) send(res, e);
    send(res, status());
    sse.add(res);
    req.on('close', () => sse.delete(res));
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
      if (cmd?.type === 'deploy') { // handled here, not by the daemon
        const out = await deploy().then(() => ({ data: null }), (e) => ({ error: e.message }));
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      }
      const json = (out) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      if (cmd?.type === 'start') { start(); return json({ data: null }); }
      if (cmd?.type === 'targets') return json({ data: targets() });
      if (cmd?.type === 'connect') return json(await selectTarget(cmd.target).then(() => ({ data: null }), (e) => ({ error: e.message })));
      if (!FORWARDED.has(cmd?.type)) return res.writeHead(400).end();
      // Reconnecting (e.g. the daemon was just updated): wait a little rather than fail the command.
      for (let i = 0; i < 50 && !stopped && (local || host) && (!pipe || !up); i++) await new Promise((r) => setTimeout(r, 200));
      if (!pipe || !up) return res.writeHead(503).end('not connected');
      const r = await request(cmd);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r.error != null ? { error: r.error } : { data: r.data }));
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
  if (host || local) selectTarget(local ? 'local' : `ssh:${host}`).catch((e) => console.error(e.message));
});
