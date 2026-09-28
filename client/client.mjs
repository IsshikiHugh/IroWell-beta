#!/usr/bin/env node
// Local side: keeps an ssh stdio pipe to the remote daemon and serves the UI on
// 127.0.0.1. Nothing listens on the server; closing this process loses nothing.
//
//   node client.mjs deploy --host devbox     copy server/ to the host + npm install
//   node client.mjs --host devbox            open the UI for that host
//   node client.mjs --local                  daemon on this machine (for testing)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..', 'server');
const REMOTE_DIR = '.iro-coding'; // relative to the remote $HOME
// Don't set up LocalForward/RemoteForward entries from ~/.ssh/config on our connections.
const SSH_OPTS = ['-o', 'ClearAllForwardings=yes'];

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const host = flag('host');
const local = argv.includes('--local');
const port = Number(flag('port', 4777));
const remoteNode = flag('remote-node', 'node');
const usage = 'usage: node client.mjs [deploy] --host <ssh-host> | --local  [--port 4777] [--remote-node node]';

if ((!host && !local) || !Number.isInteger(port)) {
  console.error(usage);
  process.exit(1);
}

if (argv[0] === 'deploy') {
  if (!host) { console.error('deploy needs --host'); process.exit(1); }
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
  const files = ['package.json', 'package-lock.json', 'daemon.mjs', 'attach.mjs'].map((f) => path.join(SERVER_DIR, f));
  try {
    run('ssh', [...SSH_OPTS, host, `mkdir -p ${REMOTE_DIR}`]);
    run('scp', [...SSH_OPTS, ...files, `${host}:${REMOTE_DIR}/`]);
    // Login shell so node/npm from the user's profile are on PATH. Only `&&` here:
    // the remote shell may be fish, which has no ( ) subshells.
    run('ssh', [...SSH_OPTS, host, `exec "$SHELL" -lc 'cd ~/${REMOTE_DIR} && npm install --omit=dev --no-audit --no-fund'`]);
    // Restart the daemon so it runs the new code (running sessions are dropped).
    // pkill exits 1 when nothing matched; [.] keeps it from matching itself.
    try { execFileSync('ssh', [...SSH_OPTS, host, 'pkill -f "[.]iro-coding/daemon[.]mjs"'], { stdio: 'ignore' }); } catch {}
  } catch (e) {
    console.error(`deploy failed: ${e.message.split('\n')[0]}`);
    process.exit(1);
  }
  console.log(`deployed to ${host}:~/${REMOTE_DIR}`);
  process.exit(0);
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
let remoteHome = null;
const LOCAL_CODE = createHash('sha1').update(fs.readFileSync(path.join(SERVER_DIR, 'daemon.mjs'))).digest('hex').slice(0, 12);
const pending = new Map(); // request id -> { done, timer }
let nextId = 1;

const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const broadcast = (obj) => { for (const res of sse) send(res, obj); };
const status = () => ({
  type: 'transport', up, host: host || 'local', error: up ? '' : lastError, home: remoteHome,
  stale: up && stale ? `The server runs an older iro-coding than this client. Update it: node client/client.mjs deploy --host ${host}` : '',
});

function setUp(v) {
  up = v;
  broadcast(status());
}

function onLine(l) {
  let m;
  try { m = JSON.parse(l); } catch { return; } // e.g. noise printed by a login profile
  if (m.type === 'hello') {
    retry = 1000;
    stale = !local && m.code !== LOCAL_CODE;
    remoteHome = m.home || null;
    if (stale) console.error(`warning: ${host} runs different daemon code (${m.code || 'old'} vs ${LOCAL_CODE}); run: node client/client.mjs deploy --host ${host}`);
    if (m.boot !== boot) { // new daemon: its history replaces ours
      boot = m.boot;
      cache.length = 0;
      lastSeq = 0;
      broadcast({ type: 'reset' });
    }
    pipe.stdin.write(JSON.stringify({ type: 'sync', since: lastSeq, boot }) + '\n');
    setUp(true);
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

function connect() {
  const cmd = local
    ? [process.execPath, [path.join(SERVER_DIR, 'attach.mjs')]]
    : ['ssh', ['-T', ...SSH_OPTS, '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', host,
        `exec "$SHELL" -lc 'cd ~/${REMOTE_DIR} && exec ${remoteNode} attach.mjs'`]];
  const p = spawn(cmd[0], cmd[1], { stdio: ['pipe', 'pipe', 'pipe'] });
  pipe = p;
  let buf = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) onLine(l);
    }
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => {
    process.stderr.write(d);
    const last = d.trim().split('\n').pop();
    if (last) lastError = last;
  });
  p.on('error', (e) => { lastError = e.message; }); // e.g. ssh not installed; 'exit' still follows
  p.on('exit', (code) => {
    if (pipe === p) pipe = null;
    for (const [id, r] of pending) { clearTimeout(r.timer); r.done({ error: 'connection lost' }); pending.delete(id); }
    setUp(false);
    console.error(`transport exited (${code}); reconnecting in ${retry / 1000}s`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  });
  p.stdin.on('error', () => {});
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
const FORWARDED = new Set(['new', 'resume', 'send', 'approve', 'interrupt', 'setModel', 'setMode', 'commands', 'models',
  'complete', 'readFile', 'history', 'rename', 'close', 'status', 'usage', 'context', 'btw', 'btwList', 'btwClose', 'setSuggest', 'setEffort', 'stats', 'activity', 'overview', 'stopTask', 'killProc', 'setColor', 'stat', 'readChunk', 'usageHistory', 'prepareMedia',
  'folders', 'addFolder', 'removeFolder', 'ls', 'recentDirs']);
const MAX_BODY = 48 << 20; // pasted images

function request(cmd) {
  return new Promise((done) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      done({ error: stale ? 'No answer: the server runs an older iro-coding. Redeploy it (node client/client.mjs deploy --host …).' : 'Timed out waiting for the server.' });
    }, 30000);
    pending.set(id, { done, timer });
    pipe.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
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
      if (!FORWARDED.has(cmd?.type)) return res.writeHead(400).end();
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
  console.log(`iro-coding → http://127.0.0.1:${port}/  (${host ? `ssh ${host}` : 'local daemon'})`);
  connect();
});
