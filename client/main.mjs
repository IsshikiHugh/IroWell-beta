// Local side (started by client.mjs): keeps an ssh stdio pipe to each remote daemon a tab shows and
// serves the UI on 127.0.0.1. Nothing listens on the server; closing this process loses nothing.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listSkills, savePrompt, saveSkill, newSkill, skillFile, writeAtomic } from './skills.mjs';
import { CODE_FILES, filesUnder, fingerprint, lines, reading, olderReading, weekForecast } from '../server/shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, '..', 'server');
const REMOTE_DIR = '.iro-coding'; // relative to the remote $HOME
// What Claude is told about the web UI (the system prompt and the irowell skills): a release gets a copy
// next to daemon.mjs.
const SKILLS_DIR = process.env.IRO_SKILLS_DIR || path.join(HERE, '..', 'skills'); // (another folder: the tests)
// The plugins (plugins/<name>/): what each adds to the page, its widget (client/ui/widgets.js). A plugin is a
// folder with plugin.json ({ title, description }) and ui.js, which the page imports; ui.css beside it, if
// there is one, styles it. The page reads them from here, so an edit shows with the next page load.
// Which servers each one shows on, and the order of the widgets, are the Plugins page's (Settings → Plugins),
// kept in plugins.json next to the local daemon's state: { where: { <name>: 'off' | [server ids] }, order:
// [names] }. One `where` doesn't name shows on every server; one `order` doesn't name comes after the
// others, by name.
const PLUGINS_DIR = process.env.IRO_PLUGINS_DIR || path.join(HERE, '..', 'plugins');
const PLUGIN_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/; // (a class name too: plugin-<name>)
const pluginsFile = () => path.join(LOCAL_DIR, 'plugins.json');
function readPluginsConfig() {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(pluginsFile(), 'utf8')); } catch {}
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { where: {}, order: [] };
  if (!('where' in j) && !('order' in j)) return { where: j, order: [] }; // (the first version: the where map alone)
  return { where: j.where && typeof j.where === 'object' ? j.where : {}, order: Array.isArray(j.order) ? j.order.filter((n) => typeof n === 'string') : [] };
}
function writePluginsConfig(cfg) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  writeAtomic(pluginsFile(), JSON.stringify(cfg, null, 2) + '\n');
}
// 'all', 'off', or the ids of the servers it shows on
const whereOf = (all, name) => (all[name] === 'off' || Array.isArray(all[name]) ? all[name] : 'all');
const showsOn = (where, target) => where === 'all' || (Array.isArray(where) && where.includes(target));
function listPlugins() {
  let dirs;
  try { dirs = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch { return []; }
  const { where, order } = readPluginsConfig();
  const rank = (name) => { const i = order.indexOf(name); return i < 0 ? Infinity : i; };
  return dirs.filter((e) => e.isDirectory() && PLUGIN_NAME.test(e.name) && fs.existsSync(path.join(PLUGINS_DIR, e.name, 'ui.js')))
    .map((e) => e.name).sort().sort((a, b) => rank(a) - rank(b)).map((name) => {
      const dir = path.join(PLUGINS_DIR, name);
      let files = [];
      try { files = filesUnder(dir); } catch {}
      const base = { name, where: whereOf(where, name), files };
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch (e) { return { ...base, title: name, error: `plugin.json: ${e.message}` }; }
      return { ...base, title: String(meta?.title || name), description: String(meta?.description || ''), css: fs.existsSync(path.join(dir, 'ui.css')) };
    });
}
// The Plugins page: every plugin, and the servers it can be shown on (the picker's list).
const pluginPage = (current) => ({ current, plugins: listPlugins(), servers: targets(current).list.map(({ id, host, detail }) => ({ id, host, detail })) });
function setPluginWhere({ name, where }) {
  if (!listPlugins().some((p) => p.name === name)) throw new Error(`No plugin named ${name}`);
  const ok = where === 'all' || where === 'off' || (Array.isArray(where) && where.every((id) => typeof id === 'string' && /^(local|ssh:.+)$/.test(id)));
  if (!ok) throw new Error('Show it on every server, on some ([server ids]), or off');
  const cfg = readPluginsConfig();
  if (where === 'all') delete cfg.where[name]; else cfg.where[name] = Array.isArray(where) ? [...new Set(where)] : where;
  writePluginsConfig(cfg);
}
// `names`: the plugins in the order their widgets go.
function setPluginOrder({ names }) {
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && PLUGIN_NAME.test(n))) throw new Error('The order is a list of plugin names');
  const cfg = readPluginsConfig();
  cfg.order = [...new Set(names)];
  writePluginsConfig(cfg);
}
// What a plugin keeps (its ui.js: load() and save(data), ui/widgets.js): one JSON value per plugin, in
// plugin-data/<name>.json on this computer, next to the local daemon's state. Never on a server.
const PLUGIN_DATA_MAX = 1 << 20;
const pluginDataFile = (name) => {
  if (!PLUGIN_NAME.test(name || '')) throw new Error('No such plugin');
  return path.join(LOCAL_DIR, 'plugin-data', `${name}.json`);
};
function pluginData({ name }) {
  try { return JSON.parse(fs.readFileSync(pluginDataFile(name), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function savePluginData({ name, data }) {
  const file = pluginDataFile(name), text = JSON.stringify(data ?? null, null, 2) + '\n';
  if (text.length > PLUGIN_DATA_MAX) throw new Error(`What ${name} keeps is over 1 MB`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, text);
}
// A web page's own icon (a plugin's api.siteIcon(url): the bookmarks'), fetched here because the page can't
// read another site: the <link rel="icon"> its HTML names, else /favicon.ico. A data: URL, or null when it
// has none we can get. Kept while this client runs (a miss for 10 minutes); `fresh` asks the page again
// (a bookmark just saved). IRO_SITE_ICONS_LOCAL=1 (the tests): only pages on this machine are asked.
const siteIcons = new Map(); // url → { at, p: Promise<string|null> }
const ICON_MAX = 512 << 10, ICON_MISS_MS = 10 * 60e3;
async function siteIcon({ url, fresh }) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (process.env.IRO_SITE_ICONS_LOCAL && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return null;
  const hit = siteIcons.get(u.href);
  if (hit && !fresh && (Date.now() - hit.at < ICON_MISS_MS || hit.found)) return hit.p;
  const entry = { at: Date.now(), found: false, p: null };
  entry.p = findIcon(u).catch(() => null).then((d) => { entry.found = d != null; return d; });
  siteIcons.set(u.href, entry);
  return entry.p;
}
async function getCapped(url, max) { // { res, bytes } of a GET, or null; at most `max` bytes are read
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Mozilla/5.0 (IroWell)', accept: '*/*' } });
  if (!res.ok || !res.body) return null;
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    chunks.push(c);
    n += c.length;
    if (n >= max) break; // (the start of an HTML page is enough; an icon this big is no icon)
  }
  return { res, bytes: Buffer.concat(chunks), whole: n < max };
}
// What an icon's bytes are, by their start (a server often says octet-stream, or text/html for a missing one).
function iconType(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'image/x-icon';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = b.subarray(0, 512).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}
async function findIcon(u) {
  const tries = [];
  const page = await getCapped(u.href, 256 << 10).catch(() => null);
  if (page && /html/i.test(page.res.headers.get('content-type') || '')) {
    const html = page.bytes.toString('utf8');
    const links = [];
    for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
      const attr = (k) => tag.match(new RegExp(`\\b${k}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))?.slice(1).find((x) => x != null);
      const rel = (attr('rel') || '').toLowerCase().split(/\s+/);
      const href = attr('href');
      if (!href || rel.includes('mask-icon') || !(rel.includes('icon') || rel.includes('apple-touch-icon'))) continue;
      const size = Math.max(0, ...(attr('sizes') || '').split(/\s+/).map((s) => parseInt(s, 10) || 0));
      // a plain icon before a touch icon; of those, the smallest one of 32px or more, then the biggest smaller one
      const rank = (rel.includes('icon') ? 0 : 10000) + (size >= 32 ? size : size ? 5000 - size : 4000);
      try { links.push({ href: new URL(href.replace(/&amp;/g, '&'), page.res.url).href, rank }); } catch {}
    }
    tries.push(...links.sort((a, b) => a.rank - b.rank).map((l) => l.href));
  }
  tries.push(new URL('/favicon.ico', (page?.res.url) || u.href).href);
  for (const href of [...new Set(tries)]) {
    if (href.startsWith('data:image/')) return href;
    if (!/^https?:/.test(href)) continue;
    const r = await getCapped(href, ICON_MAX).catch(() => null);
    const type = r?.whole && r.bytes.length ? iconType(r.bytes) : null;
    if (type) return `data:${type};base64,${r.bytes.toString('base64')}`;
  }
  return null;
}
// A file of a plugin's folder, to look at on the Plugins page.
function pluginFile({ name, file }) {
  const p = listPlugins().find((x) => x.name === name);
  if (!p || !p.files.includes(file)) throw new Error('No such file');
  const full = path.join(PLUGINS_DIR, name, file);
  if (fs.statSync(full).size > 1 << 20) throw new Error(`${file} is over 1 MB: open it in an editor`);
  return fs.readFileSync(full, 'utf8');
}
// Fingerprint of server/'s code (CODE_FILES) and skills/ as they are now (what an update installs),
// compared with the one the daemon's hello reports (both: fingerprint, server/shared.mjs). Not taken once
// at start: after an edit or a pull while this client runs, a server updated to the new files would
// otherwise look outdated for good.
let codeSeen = { key: '', code: '' };
function localCode() {
  try {
    const skills = fs.existsSync(SKILLS_DIR) ? SKILLS_DIR : null;
    const files = [...CODE_FILES.map((f) => path.join(SERVER_DIR, f)), ...(skills ? filesUnder(skills).map((f) => path.join(skills, f)) : [])];
    const key = files.map((f) => { const st = fs.statSync(f); return `${f}:${st.mtimeMs}:${st.size}`; }).join(' ');
    if (key !== codeSeen.key) codeSeen = { key, code: fingerprint(CODE_FILES.map((f) => [f, fs.readFileSync(path.join(SERVER_DIR, f))]), skills) };
  } catch {}
  return codeSeen.code;
}
// A host that doesn't answer, or a link that dies quietly (e.g. during an install's npm run), ends the
// command instead of leaving it waiting for hours. A RemoteCommand of ~/.ssh/config (e.g. one that attaches
// tmux) would make ssh refuse our command, and its LocalCommand would run on every call: neither is used.
const SSH_BASE = ['-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'RemoteCommand=none', '-o', 'PermitLocalCommand=no'];
// The short commands (install, copying a release, stop) set up none of the LocalForward/RemoteForward/DynamicForward
// entries of ~/.ssh/config: they would only clash with the long-lived connection's.
const SSH_OPTS = ['-o', 'ClearAllForwardings=yes', ...SSH_BASE];
// The long-lived connection to a host (attach.mjs) carries nothing else either, X11 included: ssh doesn't
// exit while a forwarded connection is still open (a TensorBoard tab, a GUI the daemon opened), so when
// attach ended (a daemon update or restart) its ssh stayed up with nothing behind it, and every command
// waited for an answer that never came. Bulk traffic through a forward also queued the commands behind it.
const SSH_ATTACH = ['-o', 'ClearAllForwardings=yes', '-o', 'ForwardX11=no', ...SSH_BASE];
// The forwards get an ssh of their own instead (keepForwards), up for as long as the client is connected
// to the host, as with `ssh <host>` in a terminal. A forward that can't be set up (its local port is taken,
// e.g. by a terminal ssh to the same host) is skipped with a warning rather than failing the others.
// It is a control master of its own (-M, with our socket): a port is added to it while it runs (see "ports").
// (Not on Windows, whose ssh has no connection sharing: there it only holds the config's forwards.)
const MUX = process.platform !== 'win32';
const SSH_FORWARDS = [...(MUX ? ['-M', '-o', 'ControlPersist=no'] : []), '-o', 'ExitOnForwardFailure=no', '-o', 'ForwardX11=no', ...SSH_BASE];
// The short commands to a host go through the forwards ssh while it runs, as `ssh -O forward` does:
// no connection of their own, which a host's firewall can be slow to take or refuse (a burst of them, as
// an update makes, timed out on a university host). With none running, ssh connects by itself as before.
const viaForwards = (c) => (MUX && c.fwd && fs.existsSync(c.ctl) ? ['-o', 'ControlMaster=no', '-o', `ControlPath=${c.ctl}`, '-o', 'ForwardX11=no'] : []);
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
// `s` as one word for a shell on the server, nothing in it expanded: as it is when nothing in it needs
// quotes, else single-quoted ('"'"' for a quote rather than '\'': fish reads a backslash inside single quotes too).
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`);
// --remote-node as a word of a command on the server: a path with spaces or quotes stays one, and a
// leading ~/ is still the server's home.
const remoteNode = ((n) => (n.startsWith('~/') ? `~/${shq(n.slice(2))}` : shq(n)))(flag('remote-node', 'node'));
// The ssh command that runs attach.mjs on the host (exit NOT_INSTALLED when there is none). The part
// for the login shell is quoted once more: the shell ssh runs it with reads it first.
const attachCmd = (args = '') => `test -f ~/${REMOTE_DIR}/attach.mjs || exit ${NOT_INSTALLED}; exec "$SHELL" -lc ${shq(`cd ~/${REMOTE_DIR} && exec ${remoteNode} attach.mjs${args}`)}`;
// A line of a daemon's as the object it is, or null. Text a login profile prints without a newline (a
// terminal title, a printf in .bash_profile) comes glued to the front of the daemon's first line, the
// hello: such a line is read from its first `{"`.
function parseLine(l) {
  let m = null;
  try { m = JSON.parse(l); } catch {
    const i = l.indexOf('{"');
    if (i > 0) try { m = JSON.parse(l.slice(i)); } catch {}
  }
  return m && typeof m === 'object' ? m : null;
}
// One command to a daemon over a connection of its own (`io`: the daemon's socket, or an ssh running
// attach.mjs), sent as id 1 once the daemon has said hello. Resolves to { hello, reply } when the reply
// has come; reply is null when the connection closed first, or `timeout` ms passed. `io` is left as it
// is. (`part`: as for `request`.)
function askDaemon(io, cmd, { timeout = 0, part } = {}) {
  const [input, output] = io.stdin ? [io.stdin, io.stdout] : [io, io];
  return new Promise((resolve) => {
    let hello = null, size = 0;
    const end = (reply) => { clearTimeout(timer); resolve({ hello, reply }); };
    const timer = timeout && setTimeout(() => end(null), timeout);
    output.setEncoding('utf8');
    output.on('data', lines((l) => {
      const m = parseLine(l);
      if (m?.type === 'hello') { hello = m; input.write(JSON.stringify({ ...cmd, id: 1, ...(part && { sized: true }) }) + '\n'); }
      else if (m?.type === 'replySize' && m.id === 1) size = m.size;
      else if (m?.type === 'reply' && m.id === 1) { if (size) part?.(size, size); end(m); } // (all in: a short one has its size too)
    }, (n) => { if (n && size) part?.(n, size); }));
    if (input !== io) input.on('error', () => {}); // (ssh gone: 'close' follows)
    io.on('error', () => {}); // no daemon (a socket), no ssh: 'close' follows
    io.on('close', () => end(null));
  });
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
  if (!fs.existsSync(cfg)) writeAtomic(cfg, JSON.stringify({ detachIdleMinutes: 60, keepAwake: true }, null, 2) + '\n');
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
    for (const raw of text.split(/\r?\n/)) { // (a config saved with CRLF endings too)
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
  try { fs.mkdirSync(LOCAL_DIR, { recursive: true }); writeAtomic(CLIENT_FILE, JSON.stringify(st, null, 2) + '\n'); } catch {}
}
// ✕ in the picker: the server leaves the recent list. One from ~/.ssh/config stays in the picker, back in its
// place there; one typed in by hand is gone.
function forgetTarget(id) {
  const st = readClientState();
  if (!(st.recent || []).some((x) => x.id === id)) return;
  st.recent = st.recent.filter((x) => x.id !== id);
  writeAtomic(CLIENT_FILE, JSON.stringify(st, null, 2) + '\n');
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
    // ('close', not 'exit': by then the output has all been read, its last line too)
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(Object.assign(new Error(`${cmd} failed (exit ${code})${out.trim() ? ': ' + out.trim().split('\n').pop() : ''}`), { output: out }))));
  });
}
// Copies the folder `from` into `dir` on a host (relative to its home; `ssh`: the ssh arguments up to the
// host) as a tar stream through ssh. Not scp: its sftp breaks on a host whose login shell prints something
// as it starts ("Received message too long"), and such a host would never get an install or an update.
// Rejects as `run` does, with what both sides said on stderr as its output.
// (COPYFILE_DISABLE, --no-xattrs: a Mac's tar would add ._ files and its extended attributes)
function tarTo(from, ssh, dir) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-c', '-f', '-', ...(process.platform === 'darwin' ? ['--no-xattrs'] : []), '-C', from, '.'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const remote = spawn('ssh', [...ssh, `mkdir -p ${dir} && tar -x -f - -C ${dir}`], { stdio: ['pipe', 'ignore', 'pipe'] });
    const err = { tar: '', ssh: '' }, codes = {};
    let left = 2;
    const done = (name, code) => {
      codes[name] = code;
      if (name === 'ssh' && tar.exitCode == null) tar.kill(); // (ssh gone: tar would wait on a full pipe)
      if (--left) return;
      // A tar that failed by itself (a file it could not read) leaves the remote one a broken stream:
      // the cause is the local one. A tar stopped by a signal went with ssh.
      const bad = codes.tar != null && codes.tar !== 0 ? 'tar' : codes.ssh !== 0 ? 'ssh' : codes.tar !== 0 ? 'tar' : null;
      if (!bad) return resolve();
      const said = err[bad].trim();
      reject(Object.assign(new Error(`${bad} failed (exit ${codes[bad]})${said ? ': ' + said.split('\n').pop() : ''}`), { output: err.tar + err.ssh }));
    };
    for (const [name, p] of [['tar', tar], ['ssh', remote]]) {
      p.stderr.on('data', (d) => (err[name] += d));
      p.on('error', (e) => { err[name] += `${e.message}\n`; });
      p.on('close', (code) => done(name, code));
    }
    remote.stdin.on('error', () => {}); // (ssh gone: its exit says why)
    tar.stdout.pipe(remote.stdin);
  });
}

// The packages of client/ (the page's Markdown, KaTeX, highlighting and diff libraries) and, for this
// machine, of server/ are installed whenever one that package-lock.json pins is missing or older (a
// newer one is kept: an update installs the newest Agent SDK on top of the pinned one).
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
  const gone = new Promise((resolve) => io.on('close', resolve)); // (ssh: its exit code, once the daemon's last line has been read)
  const { reply } = await askDaemon(io, { type: 'shutdown' });
  const done = await gone;
  const closed = reply ? reply.data?.sessions ?? 0 : null;
  if (closed != null) console.log(`stopped the IroWell server on ${where}${closed ? ` (${closed} session${closed > 1 ? 's' : ''} closed; sending to one reattaches it)` : ''}`);
  else if (local || done === 3 || done === NOT_INSTALLED) console.log(`no IroWell server is running on ${where}`);
  else { console.error(`cannot reach ${where} (ssh exit ${done})`); process.exit(1); }
  process.exit(0);
}
if (argv.includes('--stop')) await stopServer();

await ensurePackages(HERE);

// ---- install and update the server: from the UI's button, and on its own on a host without IroWell ----
// Updates never interrupt a session. `install` copies server/ to a new release folder on the host
// (~/.iro-coding/releases/r<time>) and installs its packages there; the running daemon, and
// ~/.iro-coding/current (the release a daemon started after a reboot runs), stay as they are.
// `switchOver` then asks the running daemon to retire: once the new release's Claude Code is known to
// run, it starts that release, which makes itself current and takes each session over as soon as that
// session is quiet (server/daemon.mjs, "rolling updates"). On this machine the daemon restarts from this
// checkout the same way, after the newest Agent SDK is installed into it.
async function install(c) {
  const { host } = c, opts = [...SSH_OPTS, ...viaForwards(c)];
  const rel = `r${Date.now()}`;
  const dir = `${REMOTE_DIR}/releases/${rel}`;
  // A full disk says so: its error is one line of many, and not always the last.
  const why = (e) => {
    const l = String(e.output || '').split('\n').find((x) => /Disk quota exceeded|No space left on device|EDQUOT|ENOSPC/.test(x));
    return l ? new Error(`the disk is full on ${host} (${/quota|EDQUOT/i.test(l) ? 'Disk quota exceeded' : 'No space left on device'}): an update needs about 350 MB free in ~/${REMOTE_DIR}`) : e;
  };
  // The release's files are put together in a scratch folder (skills/ under that name, wherever
  // SKILLS_DIR is; no editor litter) and sent as one tar stream.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-release-'));
  try {
    fs.chmodSync(stage, 0o755); // (the release folder gets its mode)
    for (const f of ['package.json', 'package-lock.json', ...CODE_FILES]) fs.copyFileSync(path.join(SERVER_DIR, f), path.join(stage, f));
    if (fs.existsSync(SKILLS_DIR)) for (const f of filesUnder(SKILLS_DIR)) {
      fs.mkdirSync(path.dirname(path.join(stage, 'skills', f)), { recursive: true });
      fs.copyFileSync(path.join(SKILLS_DIR, f), path.join(stage, 'skills', f)); // (with its mode, as scp did)
    }
    await tarTo(stage, [...opts, host], dir);
  } catch (e) {
    run('ssh', [...opts, host, `rm -rf ${dir}`]).catch(() => {}); // (install.sh removes it once it runs)
    throw why(e);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  // Login shell so node/npm from the user's profile are on PATH; the script itself is plain sh.
  // IRO_NODE: the node that will run the daemon (--remote-node), which install.sh checks first.
  const out = await run('ssh', [...opts, host, `exec "$SHELL" -lc ${shq(`IRO_NODE=${remoteNode} sh ~/${dir}/install.sh`)}`]).catch((e) => { throw why(e); });
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
  // (--prefer-offline: `fetchLocalSdk` has downloaded it already, so this only unpacks it)
  try { await run('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefer-offline', `${SDK_PKG}@latest`], { cwd: SERVER_DIR }); return ''; }
  catch (e) { return `could not fetch the newest Claude Code: ${e.message}`; }
}
// Ahead of the switch, the download only: the newest SDK installed into a scratch folder, which leaves it
// (and this platform's Claude Code binary) in npm's cache. Not into server/node_modules yet: the running
// daemon starts its CLIs from there, with the older SDK it has loaded. A failure here is not one: the
// switch fetches it then, and says so if it can't.
async function fetchLocalSdk() {
  const dir = path.join(LOCAL_DIR, 'sdk-fetch');
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ "private": true }\n');
    await run('npm', ['install', '--no-save', '--no-audit', '--no-fund', `${SDK_PKG}@latest`], { cwd: dir });
  } catch (e) { console.error(`could not fetch the newest Claude Code ahead: ${e.message}`); }
  fs.rmSync(dir, { recursive: true, force: true });
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
  const daemon = c.local ? path.join(SERVER_DIR, 'daemon.mjs') : `${c.lastHello.home}/${REMOTE_DIR}/releases/${rel}/daemon.mjs`;
  const was = c.lastHello.boot;
  step(c, 'start'); // ('connect' follows when the retiring daemon lets this connection go: setUp)
  const r = await request(c, { type: 'retire', daemon });
  if (r.error != null) throw new Error(r.error);
  if (!await waitFor(() => c.stopped || (c.up && c.lastHello?.boot !== was), Number(process.env.IRO_TEST_TAKEOVER_MS) || 60000)) {
    throw new Error(`the new daemon did not take over (see ${c.local ? path.join(LOCAL_DIR, 'daemon.log') : `~/${REMOTE_DIR}/daemon.log on ${c.host}`}); the update is tried again shortly`);
  }
}

// ---- updates: prepared on their own, then one click (Reconnect) switches ----
// When the server runs other code than this checkout, or a newer Agent SDK is out, the new release is
// installed on the host by itself (once the files have stopped changing for a moment), and the page
// offers Reconnect: only a click on it switches daemons (reloading the page doesn't). On this machine
// the newest SDK is only downloaded ahead (fetchLocalSdk): its daemon runs server/ itself, and the SDK
// put into server/node_modules early would be the CLI that the running daemon's older SDK starts. Either way
// the daemon code must parse first. `tried`: what was prepared last. A failure (preparing, or the
// switch) is tried again later, less and less often; a newest SDK the host can't fetch is not.
const AUTO_MS = Number(process.env.IRO_AUTO_UPDATE_MS) || 3000;
const ready = (c) => !!c.ready && c.ready.code === localCode() && (stale(c) || sdkBehind(c));
const failed = (c) => { c.failures++; c.failedAt = Date.now(); };
const retryDue = (c) => c.failures > 0 && Date.now() - c.failedAt >= Math.min(AUTO_MS * 20 * 2 ** (c.failures - 1), 30 * 60e3);
async function prepare(c) {
  const code = localCode();
  c.tried = { code, sdk: c.sdk?.latest || '' };
  // (the release's modules: one that doesn't parse would make a daemon that dies at start)
  for (const f of CODE_FILES.filter((x) => x.endsWith('.mjs'))) {
    await new Promise((resolve, reject) => execFile(process.execPath, ['--check', path.join(SERVER_DIR, f)], (e, _out, err) => {
      if (!e) return resolve();
      const why = String(err).split('\n').find((l) => /Error/.test(l)) || e.message;
      reject(new Error(`server/${f} does not parse (${why.trim()})`));
    }));
  }
  if (c.local) {
    if (sdkBehind(c)) await fetchLocalSdk();
    c.ready = { code, rel: null }; c.failures = 0; c.deployError = '';
    return;
  }
  const old = c.ready?.rel;
  const { rel, sdkError } = await install(c);
  c.ready = { code, rel, sdkError };
  c.failures = 0; c.deployError = ''; // (from the switch that failed before)
  // (a release prepared earlier and never switched to: replaced by this one)
  if (old && old !== c.lastHello?.release) run('ssh', [...SSH_OPTS, ...viaForwards(c), c.host, `rm -rf ${REMOTE_DIR}/releases/${old}`]).catch(() => {});
}
function autoPrepare(c) {
  if (c.gone || c.preparing || c.deploying || c.stopped || !c.installed || !c.up) return;
  const code = localCode();
  const again = retryDue(c);
  if (!(stale(c) && (code !== c.tried.code || again)) && !(sdkBehind(c) && (c.sdk.latest !== c.tried.sdk || again))) return;
  console.log(`preparing an update for ${c.host || 'the local daemon'}…`);
  c.prepareError = '';
  c.preparing = prepare(c)
    .then(() => console.log(`update ready for ${c.host || 'the local daemon'}: Reconnect in the UI switches to it`))
    .catch((e) => { failed(c); c.prepareError = `Preparing the update failed: ${e.message}`; console.error(c.prepareError); })
    .finally(() => { c.preparing = null; broadcast(c, status(c)); });
  broadcast(c, status(c));
}
let codeNow = null, codeAsking = false;
setInterval(async () => {
  if (codeAsking) return;
  const code = localCode();
  const changed = code !== codeNow;
  codeNow = code;
  // The daemons are asked their fingerprint again first: the local one hashes skills/ as it is now, so an
  // edit there from outside the UI Skills page (which asks too) is already its own, not an outdated server.
  if (changed) {
    codeAsking = true;
    await Promise.all([...conns.values()].filter((c) => c.up && c.lastHello && c.forwarded.has('serverCode')).map(async (c) => {
      const hello = c.lastHello;
      const r = await request(c, { type: 'serverCode' }).catch(() => null);
      if (typeof r?.data === 'string' && c.lastHello === hello) hello.code = r.data; // (not one that reconnected meanwhile)
    }));
    codeAsking = false;
  }
  // An edit shows at once (the button, or its going); the release is prepared once the files keep still.
  for (const c of conns.values()) changed ? broadcast(c, status(c)) : autoPrepare(c);
}, AUTO_MS).unref();

// What Reconnect goes through, for the page's progress bar: the steps this switch has, and the one it is at.
const STEPS = { install: 'Installing the new version', sdk: 'Installing the newest Claude Code', start: 'Starting the new version', connect: 'Connecting to it' };
const step = (c, name) => { if (c.steps?.includes(name)) { c.step = name; broadcast(c, status(c)); } };
async function deploy(c) {
  if (c.deploying) return;
  const fresh = !c.installed;
  c.deploying = true; c.deployError = ''; c.prepareError = '';
  c.steps = fresh ? null : [!ready(c) && !c.local && 'install', c.local && sdkBehind(c) && 'sdk', 'start', 'connect'].filter(Boolean);
  c.step = c.steps?.[0];
  broadcast(c, status(c));
  console.log(`${fresh ? 'installing IroWell on' : 'updating'} ${c.host || 'the local daemon'}…`);
  try {
    await c.preparing; // (it catches its own failure)
    // A stopped server is started first: preparing (over ssh) and the switch go through its connection.
    if (!fresh && c.stopped) {
      start(c);
      if (!await waitFor(() => c.up && c.lastHello, 30000)) throw new Error('Not connected to the server');
    }
    if (!fresh && !ready(c)) await prepare(c);
    const prepared = c.ready;
    c.ready = null; // (after a failed switch it is prepared again: the release may be what failed)
    step(c, 'sdk');
    const { rel = null, sdkError } = fresh ? await install(c) : c.local ? { sdkError: await updateLocalSdk(c) } : prepared;
    if (fresh) { // attach starts the new release
      c.installed = true;
      c.retry = 1000;
      if (!c.pipe && !c.gone) connect(c);
    } else await switchOver(c, rel);
    console.log(fresh ? `installed IroWell on ${c.host}` : `updated ${c.host || 'the local daemon'}: sessions move over as they go idle`);
    if (sdkError) { c.deployError = `${fresh ? 'Installed' : 'Updated'}, but ${sdkError}`; console.error(c.deployError); }
  } catch (e) {
    c.deployError = `${fresh ? 'Install' : 'Update'} failed: ${e.message}`;
    if (!fresh) failed(c);
    console.error(c.deployError);
    throw e;
  } finally {
    c.deploying = false; c.steps = null;
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
    lastHello: null, forwarded: new Set(), // what the page may ask its daemon: the commands its hello lists
    pending: new Map(), // request id -> { done, timer, part }
    installed: true, // false once the host turned out to have no IroWell
    packaged: false, // (this machine) its config.json and the packages of server/ are in place: see connect
    autoInstalled: false, // the first install happens on its own; a failed one waits for the button
    deploying: false, deployError: '', steps: null, step: '', // (steps: of a switch under way, see deploy)
    ready: null, preparing: null, prepareError: '', tried: { code: '', sdk: '' }, failures: 0, failedAt: 0, // an update installed ahead (above)
    fwd: null, fwdTimer: null, fwdRetry: 1000, // the ssh that holds the host's forwards (keepForwards)
    ctl: path.join(CTL_DIR, `iro-${process.pid}-${nextCtl++}.ctl`), // its control socket
    ports: new Map(), configPorts: [], config: null, // the host's ports this computer reaches as localhost (see "ports")
  };
  conns.set(id, c);
  rememberTarget(id);
  console.log(`connecting to ${c.host || 'this machine'}`);
  if (!c.local) c.config = configForwards(c.host).then((f) => {
    if (c.gone) return;
    c.configPorts = f.ports;
    if (f.any) keepForwards(c);
    if (f.ports.length) broadcast(c, status(c));
  });
  connect(c);
  return c;
}
function dropConn(c) {
  c.gone = true;
  conns.delete(c.id);
  clearTimeout(c.reconnectTimer); clearTimeout(c.dropTimer);
  const p = c.pipe;
  c.pipe = null;
  p?.drop();
  clearTimeout(c.fwdTimer);
  c.fwd?.kill();
  for (const [, r] of c.pending) { clearTimeout(r.timer); r.done({ error: 'disconnected' }); }
  c.pending.clear();
  console.log(`disconnected from ${c.host || 'this machine'} (no tab shows it)`);
}
// Arms (or disarms) the timer that lets an unshown connection go.
function idleCheck(c) {
  clearTimeout(c.dropTimer);
  if (c.gone || c.sse.size || c.id === lastTarget) return;
  c.dropTimer = setTimeout(() => (c.deploying || c.preparing ? idleCheck(c) : dropConn(c)), DROP_MS);
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
const why = (c) => !c.up ? '' : stale(c) ? (c.local ? 'The local daemon runs older code than this checkout.' : 'The server runs an older IroWell than this client.')
  : sdkBehind(c) ? `Claude Code ${c.sdk.latestCc || c.sdk.latest} is out (the server runs ${c.sdk.cc || c.sdk.version}).` : '';
const status = (c) => ({
  type: 'transport', up: c.up, target: c.id, host: c.local ? 'local' : c.host, error: c.deployError || c.prepareError || (c.up ? '' : c.lastError), home: c.home, user: c.user,
  // ready: an update is prepared, and Reconnect (or reloading the page) switches to it; `stale` says why.
  ready: !c.deploying && ready(c), stale: ready(c) ? why(c) : '',
  // An update that failed (preparing it, or the switch): the button stays, and a click tries it again.
  retry: !c.deploying && !c.preparing && !ready(c) && !!(c.deployError || c.prepareError) && c.installed && (stale(c) || sdkBehind(c)),
  // The button in the UI for a host without IroWell: Install (an update needs none: see `ready`).
  // Claude Code isn't logged in there: the command that logs it in, to run on the server (empty otherwise).
  login: c.up && c.auth?.loggedIn === false ? c.auth.cmd || 'claude auth login' : '',
  deploy: c.installed ? 'update' : 'install', canDeploy: !c.installed, deploying: c.deploying, stopped: c.stopped,
  // A server reached over ssh: its ports this computer reaches as localhost (the Ports dialog).
  ports: c.local ? null : [...c.configPorts, ...[...c.ports.values()].map((p) => ({ remote: p.remote, local: p.local, why: p.why, by: p.by, error: p.error, opening: !!p.opening }))],
  progress: c.deploying && c.steps ? { at: c.steps.indexOf(c.step) + 1, of: c.steps.length, text: STEPS[c.step] } : null,
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
  if (!v && c.step === 'start') c.step = 'connect'; // (a switch: the new daemon serves, and we connect to it)
  broadcast(c, status(c));
}

const warnLogin = (c) => { if (c.auth?.loggedIn === false) console.error(`Claude is not logged in on ${c.host || 'this machine'}: run \`${c.auth.cmd || 'claude auth login'}\` there`); };
function onLine(c, l) {
  const m = parseLine(l);
  if (!m) return; // e.g. noise printed by a login profile
  if (m.type === 'hello') {
    c.pipe.hello = true; // (from now on the heartbeat drops it when it goes quiet)
    c.retry = 1000;
    c.lastError = ''; // (an error from before this connection, e.g. "not installed", is over)
    c.home = m.home || null;
    c.user = m.user || '';
    c.lastHello = m;
    c.forwarded = new Set(Array.isArray(m.commands) ? m.commands : []);
    c.sdk = m.sdk || null;
    c.auth = m.auth || null;
    warnLogin(c);
    if (stale(c) && !c.local) console.error(`warning: ${c.host} runs different daemon code (${m.code || 'old'} vs ${localCode()}); the page offers Reconnect once the update is ready`);
    if (m.boot !== c.boot) { // new daemon: its history replaces ours
      c.boot = m.boot;
      c.cache.length = 0;
      c.lastSeq = 0;
      broadcast(c, { type: 'reset' });
    }
    c.pipe.write(JSON.stringify({ type: 'sync', since: c.lastSeq, boot: c.boot }) + '\n');
    // How the user reaches this daemon: its sessions are told (skills/remote/prompt.md), and one of them
    // can then ask for a port (portRequest below). A daemon from before this ignores it.
    c.pipe.write(JSON.stringify({ type: 'reach', remote: !c.local, ssh: c.host || '', ports: !c.local }) + '\n');
    setUp(c, true);
    // Whose usage it has is asked again (it may be logged in to another account now), soon.
    accountOf.delete(c.id);
    syncUsageSoon();
  } else if (m.type === 'shutdown') { // the daemon is stopping (asked to, by us or by another client)
    c.stopped = true;
    console.log(`the server on ${c.host || 'this machine'} was stopped; Start server in the UI starts it again`);
  } else if (m.type === 'partial' && m.op === 'sdk') {
    c.sdk = m.sdk;
    broadcast(c, status(c));
  } else if (m.type === 'partial' && m.op === 'auth') { // logged in or out: maybe to another account
    c.auth = m.auth;
    warnLogin(c);
    broadcast(c, status(c));
    accountOf.delete(c.id); // (until the sync has asked: its levels go to its pages as the daemon has them)
    syncUsageSoon();
  } else if (m.type === 'portRequest') { // a session on the server wants one of its ports reachable here
    const me = c.pipe;
    // (an error is worded for the page, where "this computer" is the user's: the session reads it on the server)
    openPort(c, m.port, 'claude', m.local).then((p) => ({ local: p.local, why: p.why }), (e) => ({ error: e.message.replace(/\bthis computer\b/g, 'the user\'s computer') }))
      .then((r) => { if (c.pipe === me) me.write(JSON.stringify({ type: 'portReply', rid: m.rid, ...r }) + '\n'); });
  } else if (m.type === 'replySize') { // the reply that follows, as long as this (asked for: see `request`)
    c.arriving = { id: m.id, size: m.size };
  } else if (m.type === 'reply') {
    const p = c.pending.get(m.id);
    // (all of it is in: said too, so a short reply, one chunk with no part said before, has its size known)
    if (c.arriving?.id === m.id) { p?.part?.(c.arriving.size, c.arriving.size); c.arriving = null; }
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
    // A daemon's level goes to the pages by way of the account's (see gotLevel): its own may be the older one.
    if (m.type === 'partial' && m.op === 'limits' && accountOf.has(c.id)) return gotLevel(accountOf.get(c.id), m.limits);
    broadcast(c, m);
  }
}

// Heartbeat: a connection that has said nothing for PING_MS is asked something (any answer will do: a
// daemon from before `ping` says it doesn't know it), and one still silent after three times that is
// dropped and made again. Whatever keeps a pipe open with nobody answering at the other end (an ssh
// waiting on a forwarded connection after attach ended, a daemon that hangs) then costs a reconnect,
// not a page where nothing answers until the client is restarted.
// Only once the daemon has said hello: before that ssh may be waiting for a password, a passphrase or a
// host key, or the login profile may take its time (conda on NFS), and a dead link is ended by ssh itself
// (ConnectTimeout, ServerAlive*: SSH_BASE). A hello that never comes (a login profile waiting for input)
// has a limit of its own, HELLO_MS since connecting: then it is dropped with an error, and made again.
const PING_MS = Number(process.env.IRO_PING_MS) || 15000;
const HELLO_MS = Number(process.env.IRO_HELLO_MS) || 180000;
function heartbeat(c, me) {
  const t0 = me.heard = Date.now();
  const beat = setInterval(() => {
    if (c.gone || c.pipe !== me) return clearInterval(beat);
    if (!me.hello) {
      if (Date.now() - t0 < HELLO_MS) return;
      const where = c.host || 'the local daemon';
      me.why = `No answer from ${where} in the ${Math.round(HELLO_MS / 1000)}s since connecting${c.local ? '' : ' (a login profile waiting for input?)'}`;
      console.error(`${me.why}: reconnecting`);
      clearInterval(beat);
      return me.drop();
    }
    const silent = Date.now() - me.heard;
    if (silent >= PING_MS * 3) {
      console.error(`no answer from ${c.host || 'the local daemon'} for ${Math.round(silent / 1000)}s: reconnecting`);
      clearInterval(beat);
      me.drop();
    } else if (silent >= PING_MS) me.write(JSON.stringify({ type: 'ping', id: 0 }) + '\n');
  }, Math.min(PING_MS, 5000));
}

// One connection to a daemon: an ssh process running attach.mjs on the host, or (local) the daemon's
// socket itself. Lines go to onLine; when it ends we reconnect with backoff.
function connect(c) {
  let me = null;
  // Output still buffered from a connection that was dropped is not ours any more.
  const onLines = lines((l) => { if (!c.gone && c.pipe === me) onLine(c, l); },
    (n) => { if (n && c.arriving && !c.gone && c.pipe === me) c.pending.get(c.arriving.id)?.part?.(n, c.arriving.size); });
  const onData = (d) => { if (me) me.heard = Date.now(); onLines(d); };
  const ended = (code) => {
    if (c.gone || c.pipe !== me) return;
    if (me?.why) c.lastError = me.why; // (not what ssh printed as it was killed)
    c.pipe = null;
    c.arriving = null;
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
    // The local defaults and the packages of server/, until they are in place: one that can't be installed
    // (offline on the first start, no npm) is an error on the page, and the next attempt tries it again.
    (c.packaged ? Promise.resolve() : (async () => { localDefaults(); await ensurePackages(SERVER_DIR, { exit: false }); c.packaged = true; })()).then(() => {
      if (c.gone) return;
      connectLocal((sock, err) => {
        if (c.gone) return sock?.destroy();
        if (!sock) { c.lastError = err; return ended(err); }
        me = c.pipe = { write: (s) => sock.write(s), drop: () => sock.destroy() };
        heartbeat(c, me);
        sock.setEncoding('utf8');
        sock.on('data', onData);
        sock.on('error', (e) => { c.lastError = e.message; });
        sock.on('close', () => ended('socket closed'));
      });
    }, (e) => { c.lastError = e.message; ended(e.message); });
    return;
  }
  const p = spawn('ssh', ['-T', ...SSH_ATTACH, c.host, attachCmd()], { stdio: ['pipe', 'pipe', 'pipe'] });
  me = c.pipe = { write: (s) => p.stdin.write(s), drop: () => p.kill() };
  heartbeat(c, me);
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', onData);
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => {
    process.stderr.write(d);
    const last = d.trim().split('\n').pop();
    if (last && !me.why) c.lastError = last;
  });
  p.on('error', (e) => { c.lastError = e.message; }); // e.g. ssh not installed; 'exit' still follows
  // attach has ended once ssh closes its output, even if ssh itself stays (some channel still open):
  // a moment for its exit status (NOT_INSTALLED), then it goes, and we reconnect.
  let linger = null;
  p.stdout.on('close', () => { linger = setTimeout(() => p.kill(), 2000); });
  p.on('exit', (code) => { clearTimeout(linger); ended(code); });
  p.stdin.on('error', () => {});
}

// The forwards ~/.ssh/config gives `host`: whether it has any (LocalForward, RemoteForward, DynamicForward),
// and the plain ones among them, a port of this computer to a port of the host itself.
const LOOPBACK = /^(localhost|127\.0\.0\.1|::1)$/;
const configForwards = (host) => new Promise((resolve) => execFile('ssh', ['-G', host], { timeout: 10000 }, (err, out) => {
  const ports = [];
  for (const [, listen, to] of String(err ? '' : out).matchAll(/^localforward (\S+) (\S+)$/gim)) {
    const l = /^(?:\[([^\]]*)\]:)?(\d+)$/.exec(listen), r = /^\[([^\]]*)\]:(\d+)$/.exec(to);
    if (l && r && (!l[1] || LOOPBACK.test(l[1])) && LOOPBACK.test(r[1])) ports.push({ remote: Number(r[2]), local: Number(l[2]), by: 'config' });
  }
  resolve({ any: !err && /^(local|remote|dynamic)forward /im.test(out), ports });
}));
// The ssh holding the host's forwards, restarted (with backoff) when it ends. Its remote command waits
// for our stdin to close, so it also goes when this client is killed, once its last forwarded connection
// has closed (ssh waits for those).
function keepForwards(c) {
  if (c.gone || c.fwd) return;
  clearTimeout(c.fwdTimer);
  const t0 = Date.now();
  fs.rmSync(c.ctl, { force: true }); // (left by one that was killed)
  const p = c.fwd = spawn('ssh', ['-T', ...SSH_FORWARDS, ...(MUX ? ['-S', c.ctl] : []), c.host, 'cat >/dev/null'], { stdio: ['pipe', 'ignore', 'pipe'] });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => process.stderr.write(d)); // e.g. a port that is taken
  p.on('error', () => {}); // 'exit' still follows
  p.stdin.on('error', () => {});
  p.on('exit', () => {
    if (c.fwd !== p) return;
    c.fwd = null;
    fs.rmSync(c.ctl, { force: true });
    if (c.gone) return;
    c.fwdRetry = Date.now() - t0 > 60000 ? 1000 : Math.min(c.fwdRetry * 2, 60000);
    c.fwdTimer = setTimeout(() => keepForwards(c), c.fwdRetry);
  });
  // The ports added while the last one ran went with it: each is asked of this one, on the local port it had.
  for (const x of c.ports.values()) if (x.local && !x.opening) track(c, x);
}

// ---- ports: a port of the host, reached from this computer as localhost ----
// Besides the forwards of ~/.ssh/config, a port can be added while the client runs: from the page (the
// Ports dialog next to the server's name), or by a session on the server that started something for you to
// open (skills/remote: its script asks the daemon, the daemon asks this client). The forwards ssh takes it
// as a control master does (`ssh -O forward`), so nothing reconnects and the open forwards carry on.
// A port lasts as long as this client's connection to the host.
// The control socket's folder: a Unix socket path is limited to ~100 bytes, and ssh adds 17 of its own.
const CTL_DIR = os.tmpdir().length <= 60 ? os.tmpdir() : '/tmp';
let nextCtl = 1;
const MAX_PORTS = 64; // per host
const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const onLoopback = (probe) => Promise.all(['127.0.0.1', '::1'].map(probe));
// Whether a listener could take `port` on this computer, on both loopback addresses (ssh listens on the two,
// and calls one of them a success). Nothing connects: a connection to a forward's port would go through it
// to the host.
const bindable = async (port) => (await onLoopback((host) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => resolve(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')); // (no IPv6 here)
  s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
}))).every(Boolean);
// Whether something on this computer answers on `port`.
const listening = async (port) => (await onLoopback((host) => new Promise((resolve) => {
  const s = net.connect({ port, host });
  s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
}))).some(Boolean);
// Whether nothing on this computer has `port`: it can be listened on, and nothing answers there either
// (where a listener on every address doesn't stop one on 127.0.0.1, as on macOS, the forward would take
// localhost:<port> away from it).
const portFree = async (port) => await bindable(port) && !await listening(port);
// What the Ports dialog shows beside each port: whether something has the local ports (`local`: e.g. their
// forward) or a forward could take them (`free`), and whether anything listens on the host's (`remote`; null
// when the server can't say: not connected, or from before it could).
async function portStatus(c, { local, remote, free }) {
  const nums = (xs) => [...new Set((Array.isArray(xs) ? xs : []).map(Number).filter(isPort))].slice(0, 100);
  const table = async (xs, fn) => Object.fromEntries(await Promise.all(nums(xs).map(async (p) => [p, await fn(p)])));
  const far = !c.local && c.pipe && c.up && nums(remote).length ? await request(c, { type: 'portsBusy', ports: nums(remote) }) : null;
  return { local: await table(local, async (p) => !await bindable(p)), free: await table(free, portFree), remote: far?.data && typeof far.data === 'object' ? far.data : null };
}
// The local port for the host's `remote`, and why it is another number: the same one when it is free here
// (''), else one the system picks ('taken'; 'low': a port below 1024 takes root to listen on).
async function localPortFor(remote) {
  if (remote >= 1024 && await portFree(remote)) return { local: remote, why: '' };
  for (let i = 0; i < 20; i++) {
    const port = await new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(0)); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
    if (port && await portFree(port)) return { local: port, why: remote < 1024 ? 'low' : 'taken' };
  }
  throw new Error('no free port on this computer');
}
// One request to the forwards ssh (no config file: ours would add the host's own forwards to the request).
const mux = (c, op, p) => run('ssh', ['-F', 'none', '-S', c.ctl, '-O', op, '-L', `localhost:${p.local}:localhost:${p.remote}`, 'x']);
async function forward(c, p) {
  keepForwards(c);
  if (!await waitFor(() => c.gone || (c.fwd && fs.existsSync(c.ctl)), 25000) || c.gone) throw new Error(`no ssh connection to ${c.host} to forward through`);
  // (p.local set: the forwards ssh restarted, and the URL already given names this local port)
  if (p.local) { if (!await portFree(p.local)) throw new Error(`localhost:${p.local} is taken on this computer now`); }
  else if (p.want) { // the local port was asked for: that one or none
    if (!await portFree(p.want)) throw new Error(`localhost:${p.want} is not free on this computer: pick another local port, or leave it out for a free one`);
    Object.assign(p, { local: p.want, why: p.want === p.remote ? '' : 'chosen' });
  } else Object.assign(p, await localPortFor(p.remote));
  try { await mux(c, 'forward', p); } catch (e) { throw new Error(`ssh could not forward localhost:${p.local} to port ${p.remote} of ${c.host} (${e.message})`); }
}
// Runs the forward of `p`, keeping its outcome on it (p.opening while it runs, p.error) for the page.
function track(c, p) {
  p.error = '';
  p.opening = forward(c, p).catch((e) => { p.error = e.message; console.error(`port ${p.remote} of ${c.host}: ${e.message}`); })
    .finally(() => { p.opening = null; if (!c.gone) broadcast(c, status(c)); });
  broadcast(c, status(c));
  return p.opening;
}
// `by`: 'user' (the page) or 'claude' (a session on the server). Resolves to { remote, local, why }: the
// host's port `remote` is at localhost:<local>, which need not be the same number (`why`: 'taken' or 'low',
// see localPortFor; 'chosen': `want`, the local port asked for; 'config'). One that is already forwarded
// (also by ~/.ssh/config) is answered as it is, and stays where it is.
async function openPort(c, remote, by, want) {
  remote = Number(remote);
  const any = want == null || want === '';
  want = any ? 0 : Number(want);
  if (c.local) throw new Error('This server is this machine: its ports are at localhost already');
  if (!isPort(remote)) throw new Error('A port is a number from 1 to 65535');
  if (!any && !isPort(want)) throw new Error('A local port is a number from 1 to 65535');
  const moved = (at) => new Error(`Port ${remote} of ${c.host} is at localhost:${at} already: remove that forward first to move it`);
  await c.config;
  if (!MUX && !c.configPorts.some((x) => x.remote === remote)) throw new Error('ssh on Windows cannot add a port to a running connection: give the host a LocalForward in ~/.ssh/config instead');
  const known = c.configPorts.find((x) => x.remote === remote);
  if (known) {
    if (want && want !== known.local) throw new Error(`Port ${remote} of ${c.host} is at localhost:${known.local} by ~/.ssh/config: change it there`);
    return { remote, local: known.local, why: known.local === remote ? '' : 'config' };
  }
  await c.ports.get(remote)?.opening;
  let p = c.ports.get(remote);
  if (!p) {
    if (c.ports.size >= MAX_PORTS) throw new Error(`${MAX_PORTS} ports of ${c.host} are forwarded already: close one first`);
    p = { remote, local: 0, want, why: '', by, error: '', opening: null };
    c.ports.set(remote, p);
    track(c, p);
  } else if (p.error) { // asked again: tried again (on another local port, when one is named)
    if (want && want !== p.local) Object.assign(p, { local: 0, want });
    track(c, p);
  } else if (want && want !== p.local) throw moved(p.local);
  await p.opening;
  if (p.error) {
    const msg = p.error;
    if (c.ports.get(remote) === p) { c.ports.delete(remote); broadcast(c, status(c)); }
    throw new Error(msg);
  }
  console.log(`port ${remote} of ${c.host} is at localhost:${p.local}${p.by === 'claude' ? ' (asked for by a session)' : ''}`);
  return { remote, local: p.local, why: p.why };
}
async function closePort(c, remote) {
  const p = c.ports.get(Number(remote));
  if (!p) throw new Error(c.configPorts.some((x) => x.remote === Number(remote)) ? 'This forward comes from ~/.ssh/config: remove it there' : 'No such port');
  await p.opening;
  c.ports.delete(p.remote);
  if (p.local && !p.error && c.fwd) await mux(c, 'cancel', p).catch(() => {});
  broadcast(c, status(c));
}

// SIGUSR2 drops the connections as a network failure would (the tests use it); they reconnect.
process.on('SIGUSR2', () => { for (const c of conns.values()) c.pipe?.drop(); });

// The machine whose daemon serves LOCAL_DIR, when it is another one sharing it (a home on NFS): its
// daemon can't be reached from here, and one started here would leave. '' otherwise. (As in server/attach.mjs.)
function elsewhere() {
  const file = path.join(LOCAL_DIR, 'daemon.host');
  try {
    const { host: there } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return there && there !== os.hostname() && Date.now() - fs.statSync(file).mtimeMs < 120e3 ? there : '';
  } catch { return ''; }
}
// The local daemon's socket, starting the daemon (detached: it outlives this client) when nothing
// listens there. Same steps as server/attach.mjs on a host.
function connectLocal(done, triesLeft = 40, started = false) {
  const sock = net.connect(LOCAL_SOCK);
  sock.once('connect', () => { sock.removeAllListeners('error'); done(sock); });
  sock.once('error', (e) => {
    sock.destroy();
    const there = elsewhere();
    if (there) return done(null, `IroWell already runs on ${there}, which shares ${LOCAL_DIR} with ${os.hostname()}: connect to ${there}, or stop it there first`);
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
  '/plugins/': PLUGINS_DIR,
  '/vendor/marked/': path.join(NM, 'marked/lib'),
  '/vendor/purify/': path.join(NM, 'dompurify/dist'),
  '/vendor/katex/': path.join(NM, 'katex/dist'),
  '/vendor/diff/': path.join(NM, 'diff/libesm'),
  '/vendor/hljs/': path.join(NM, '@highlightjs/cdn-assets'),
  '/vendor/mermaid/': path.join(NM, 'mermaid/dist'),
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
  res.writeHead(200, { 'content-type': type, 'cache-control': prefix === '/ui/' || prefix === '/plugins/' ? 'no-store' : 'max-age=86400' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res); // (unreadable after all: the request fails)
  return true;
}
const okHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const MAX_BODY = 48 << 20; // pasted images
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);


// `part(got, size)`: called as the reply arrives, with how much of its `size` has; for that the daemon is
// asked to say the size first (`sized`: one from before this doesn't, and `part` is never called).
function request(c, cmd, part) {
  return new Promise((done) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      c.pending.delete(id);
      done({ error: stale(c) ? 'No answer: the server runs an older IroWell. Reconnect once the page offers it.' : 'Timed out waiting for the server.' });
    }, 30000);
    c.pending.set(id, { done, timer, part });
    c.pipe.write(JSON.stringify({ ...cmd, id, ...(part && { sized: true }) }) + '\n');
  });
}
let nextId = 1;

// ---- plan usage, evened out between machines ----
// Every daemon samples its account's plan usage on its own clock, and each misses slots: asleep, off, or
// refused by the usage API for a while. So whenever a daemon connects, and every USAGE_SYNC_MS after, the
// daemons this client reaches (the servers it is connected to, and this machine's when one runs, also with
// no tab on it) show each other what they have, and a slot one lacks and another has is copied over. Only
// between daemons logged in to the same Claude account (usage belongs to the account); a daemon from before
// this (not updated yet) is left out.
const USAGE_SYNC_MS = Number(process.env.IRO_USAGE_SYNC_MS) || 15 * 60 * 1000;
let usageSyncing = false, usageSoon = null;
// A sync in a moment (several asked for in a row make one).
function syncUsageSoon() {
  clearTimeout(usageSoon);
  usageSoon = setTimeout(syncUsage, 3000);
}
// One command for this machine's daemon, over a connection of its own: { hello, reply }, or null when none runs.
// (`part`: as for `request`.)
async function localOnce(cmd, part) {
  const sock = net.connect(LOCAL_SOCK);
  const r = await askDaemon(sock, cmd, { timeout: 15000, part });
  sock.destroy();
  return r.reply ? r : null;
}
// The daemons to ask: those connected, and this machine's own even when no tab shows it. A connected one's
// answer also says whether its daemon has said hello again or logged in or out since it was asked (`moved`).
function usageStores() {
  const stores = [...conns.values()].filter((c) => c.up && c.lastHello)
    .map((c) => ({ id: c.id, name: c.host || 'this machine', ask: async (cmd, part) => {
      const { lastHello: hello, auth } = c;
      return { hello, reply: await request(c, cmd, part), moved: () => c.lastHello !== hello || c.auth !== auth };
    } }));
  if (!stores.some((s) => s.id === 'local')) stores.push({ id: 'local', name: 'this machine', ask: localOnce });
  return stores;
}
// A round: one question to each of `stores` (`ask(store, part)`, which doesn't reject), all put at once;
// the answers, in their order. The Usage page shows it as its sync bar while it runs: what the round is
// for (`text`), how far it is, and who hasn't answered yet. Rounds can overlap (a page asks while the
// machines are compared): the pages show the one that began first.
// How far: by the amount of data, not by the number of machines. A machine counts for the length of
// its answer, which its daemon says just before sending it (`part`, see `request`), and until then for
// the length of its last answer in such a round (`answered`), or as much as the others when it has never
// said (a daemon from before this never does: its share comes all at once). A round that sends instead
// (`toSend(store)`: the length of what goes to it) counts a machine once it has confirmed. The level
// never goes back: a machine that turns out to have more than last time only slows it.
const rounds = [];
const answered = new Map(); // `${the round's text}:${store id}` -> the length of its last answer
function level(r) {
  const guess = r.parts.map((p) => p.size || p.last).filter(Boolean);
  const even = guess.length ? guess.reduce((a, b) => a + b, 0) / guess.length : 1;
  let all = 0, got = 0;
  for (const p of r.parts) {
    const w = p.size || p.last || even;
    all += w;
    got += p.done ? w : p.size ? Math.min(p.got, p.size) : 0;
  }
  return (r.pct = Math.max(r.pct, Math.floor((got / all) * 100)));
}
const syncNow = () => (rounds[0] ? { text: rounds[0].text, pct: level(rounds[0]), waiting: rounds[0].parts.filter((p) => !p.done).map((p) => p.name) } : null);
let syncTold = '';
function tellSync() {
  const sync = syncNow(), now = JSON.stringify(sync);
  if (now === syncTold) return; // (a chunk that moved it by less than a percent)
  syncTold = now;
  for (const c of conns.values()) broadcast(c, { type: 'partial', op: 'usageSync', sync });
}
async function round(text, stores, ask, toSend) {
  if (!stores.length) return [];
  const r = { text, pct: 0, parts: stores.map((s) => ({ name: s.name, got: 0, size: toSend ? toSend(s) : 0, last: answered.get(`${text}:${s.id}`) || 0, done: false })) };
  rounds.push(r);
  tellSync();
  try {
    return await Promise.all(stores.map(async (s, i) => {
      const p = r.parts[i];
      const a = await ask(s, toSend ? undefined : (got, size) => { p.got = got; p.size = size; tellSync(); });
      p.done = true;
      if (!toSend && p.size) answered.set(`${text}:${s.id}`, p.size);
      tellSync();
      return a;
    }));
  } finally {
    rounds.splice(rounds.indexOf(r), 1);
    tellSync();
  }
}

// ---- what the work cost: every machine's totals, kept on this computer ----
// A daemon prices the answers in its own machine's transcripts, by half hour, and knows of no other
// machine. This client asks every daemon it reaches (when one connects, every USAGE_SYNC_MS after, and
// when a Usage page asks) and keeps the totals of them all here, by machine and with the Claude account
// each is logged in to and the price table that priced them: { machine: { account, prices, slots: { start
// of the half hour: $ }, tokens: { start of the half hour: [input, cache, output] } } }. So a machine's
// work stays on file while it is out of reach. A half hour's total only grows as its work goes on: the
// larger of two readings is the later one. (A daemon of a release before the token counts sends $ only.)
// A daemon counts the last SPAN_DAYS only (that is all a round brings); what is on file here is kept for good.
const COST_FILE = path.join(LOCAL_DIR, 'cost-machines.json');
const SPAN_DAYS = 14; // (server/daemon.mjs: KEEP_DAYS)
const COST_SPAN = SPAN_DAYS * 24 * 3600 * 1000, COST_SLOT = 30 * 60 * 1000;
const costMachine = new Map(); // connection id -> the machine its daemon is on (once it has said)
let costPull = null; // one round at a time: a second caller waits for the one under way
function pullCost() { return (costPull ||= pullCostNow().finally(() => { costPull = null; })); }
const costOnFile = () => { try { return JSON.parse(fs.readFileSync(COST_FILE, 'utf8')) || {}; } catch { return {}; } };
async function pullCostNow() {
  const stores = usageStores();
  const answers = await round('Reading what the work cost', stores, (s, part) => s.ask({ type: 'costDump', days: SPAN_DAYS }, part).then((a) => ({ s, d: a?.reply?.data }), () => null));
  const all = costOnFile();
  const now = Date.now();
  let changed = false;
  for (const r of answers) {
    const d = r?.d, rows = d?.slots;
    if (!d || !/^[\w-]{8,64}$/.test(d.machine || '') || !Array.isArray(rows)) continue;
    costMachine.set(r.s.id, d.machine);
    const m = (all[d.machine] ||= { account: '', slots: {} });
    if (d.account && m.account !== d.account) { m.account = d.account; changed = true; }
    // Priced by another table than the totals on file (its prices were mended or added since): the
    // machine's answers have all been priced again, so its totals are taken as they are, lower ones too.
    // (A half hour whose transcripts are gone keeps what it had.)
    const repriced = !!d.prices && m.prices !== d.prices;
    if (repriced) { m.prices = d.prices; changed = true; }
    const count = (a) => (a ? a[0] + a[1] + a[2] : -1);
    for (const row of rows) {
      const [t, usd, ...tok] = Array.isArray(row) ? row : [];
      if (!Number.isFinite(t) || t % COST_SLOT || t > now || t < now - COST_SPAN) continue;
      if (Number.isFinite(usd) && usd !== m.slots[t] && (repriced || usd >= (m.slots[t] || 0))) { m.slots[t] = usd; changed = true; }
      if (tok.length === 3 && tok.every((n) => Number.isFinite(n) && n >= 0) && count(tok) > count(m.tokens?.[t])) { (m.tokens ||= {})[t] = tok; changed = true; }
    }
  }
  for (const [id, m] of Object.entries(all)) if (!Object.keys(m.slots || {}).length && !Object.keys(m.tokens || {}).length) { delete all[id]; changed = true; }
  if (changed) {
    try { fs.mkdirSync(LOCAL_DIR, { recursive: true }); writeAtomic(COST_FILE, JSON.stringify(all)); } catch {}
  }
  return all;
}
// For the Usage page of connection `c`: $ and tokens by half hour on every machine of its Claude account,
// as [[start of the half hour, $, input, cache, output], …]; null when its daemon doesn't say which machine
// it is (an older one). `cached`: what is on file now, without asking the machines first (the page draws
// that at once, then the fresh totals).
async function costFor(c, { cached = false } = {}) {
  const all = cached ? costOnFile() : await pullCost();
  const mine = all[costMachine.get(c.id)];
  if (!mine) return null;
  const slots = new Map();
  const at = (t) => slots.get(t) || slots.set(t, [0, 0, 0, 0]).get(t);
  for (const m of Object.values(all)) {
    if (m !== mine && !(mine.account && m.account === mine.account)) continue;
    for (const [t, usd] of Object.entries(m.slots || {})) at(Number(t))[0] += usd;
    for (const [t, tok] of Object.entries(m.tokens || {})) tok.forEach((n, i) => { at(Number(t))[i + 1] += n; });
  }
  return [...slots].map(([t, v]) => [t, ...v]).sort((a, b) => a[0] - b[0]);
}

// ---- plan usage as the pages see it: one history and one level per Claude account, kept on this computer ----
// Every daemon samples its account's usage on its own clock and has its own latest reading, so two
// machines of one account differ: a slot one missed, a slot both took at different moments, a level one
// learned from a turn the other knows nothing of, and with them the estimate drawn through the samples.
// So a page doesn't read its daemon's own. This client collects the samples and the level of every
// daemon it reaches (when one connects, every USAGE_SYNC_MS after, and when a page asks), keeps the best
// reading of each slot and the newest level here, by account, and answers usageHistory, usageForecast
// and limits from that, whichever machine the page is on: every page of an account shows the same, and
// a machine's samples stay on file while it is out of reach. A daemon keeps (and a round brings) the last
// USAGE_SPAN only; the samples on file here are kept for good.
const USAGE_STORE = path.join(LOCAL_DIR, 'usage-accounts.json'); // { account: { samples: { t: { five, week } }, live: { t, five, week } | null } }
const USAGE_SPAN = SPAN_DAYS * 24 * 3600 * 1000;
let usageAll = {};
try { usageAll = JSON.parse(fs.readFileSync(USAGE_STORE, 'utf8')) || {}; } catch {}
const saveUsage = () => { try { fs.mkdirSync(LOCAL_DIR, { recursive: true }); writeAtomic(USAGE_STORE, JSON.stringify(usageAll)); } catch {} };
const accountOf = new Map(); // connection id -> the account its daemon is logged in to (once it has said)
const usageOf = (account) => (usageAll[account] ||= { samples: {}, live: null });
// (reading, olderReading and weekForecast: server/shared.mjs, which the daemons use too)
// The level of an account, as a daemon just gave it: kept when it is newer than the one on file, and
// then shown on the pages of all the account's machines.
function gotLevel(account, l) {
  const five = reading(l?.five), week = reading(l?.week);
  if (!account || !Number.isFinite(l?.t) || (!five && !week)) return;
  const a = usageOf(account);
  if (a.live && (l.t <= a.live.t || olderReading(five, a.live.five) || olderReading(week, a.live.week))) return;
  a.live = { t: l.t, five, week };
  saveUsage();
  for (const o of conns.values()) if (accountOf.get(o.id) === account) broadcast(o, { type: 'partial', op: 'limits', limits: a.live });
}
let usagePull = null; // one round at a time: a second caller waits for the one under way
function pullUsage() { return (usagePull ||= pullUsageNow().finally(() => { usagePull = null; })); }
// Resolves to what each daemon that says whose usage it has answered: [{ ...its store, hello, account, samples }].
async function pullUsageNow() {
  const stores = usageStores();
  const answers = await round('Reading the usage samples', stores, (s, part) => s.ask({ type: 'usageDump', days: SPAN_DAYS }, part).then((a) => ({ s, a, d: a?.reply?.data }), () => null));
  const now = Date.now();
  let changed = false;
  const got = [];
  for (const r of answers) {
    const d = r?.d;
    if (!d?.account || typeof d.account !== 'string' || !Array.isArray(d.samples)) continue;
    got.push({ ...r.s, hello: r.a.hello, account: d.account, samples: d.samples });
    if (!r.a.moved?.()) accountOf.set(r.s.id, d.account); // (else it may be another account's by now: the next sync asks)
    const a = usageOf(d.account);
    let last = null;
    for (const x of d.samples) {
      if (!x || !Number.isFinite(x.t) || x.t > now || x.t < now - USAGE_SPAN) continue;
      // a slot two machines took: the reading that is not the older one, limit by limit
      const had = a.samples[x.t], five = reading(x.five), week = reading(x.week);
      const next = { five: !had?.five || olderReading(had.five, five) ? five || had?.five || null : had.five, week: !had?.week || olderReading(had.week, week) ? week || had?.week || null : had.week };
      if (!next.five && !next.week) continue;
      if (!had || next.five !== had.five || next.week !== had.week) { a.samples[x.t] = next; changed = true; }
      if (!last || x.t > last.t) last = x;
    }
    if (last) gotLevel(d.account, last); // (a daemon's level is never behind its last sample)
  }
  if (changed) saveUsage();
  return got;
}
// A page's usageHistory, usageForecast or limits on connection `c`, answered from what is kept here;
// undefined when its daemon doesn't say whose usage it has (an older one, or not logged in: it answers itself).
// `cached`: what is on file now, without asking the machines first (whose it is not known: the daemon
// answers, from its own samples, as it does without `cached`).
async function usageFor(c, cmd) {
  if (cmd.cached && cmd.type !== 'limits') return accountOf.has(c.id) ? historyOf(usageOf(accountOf.get(c.id)), cmd) : undefined;
  if (cmd.type === 'limits' && accountOf.has(c.id)) { // the daemon is still asked: that is what makes it look the level up
    const r = await request(c, cmd), account = accountOf.get(c.id);
    if (r.error == null) gotLevel(account, r.data);
    return usageOf(account).live ?? r.data ?? null;
  }
  await pullUsage();
  const account = accountOf.get(c.id);
  if (!account) return undefined;
  const a = usageOf(account);
  if (cmd.type === 'limits') return usageFor(c, cmd);
  return historyOf(a, cmd);
}
// usageHistory (the samples of the last `days`, or all on file with `all`) or usageForecast (from the
// last SPAN_DAYS), from an account's samples on file.
function historyOf(a, cmd) {
  const cut = cmd.type !== 'usageHistory' ? Date.now() - USAGE_SPAN : cmd.all ? -Infinity : Date.now() - (Number(cmd.days) || 7) * 24 * 3600 * 1000;
  const samples = Object.entries(a.samples).map(([t, x]) => ({ t: Number(t), five: x.five, week: x.week })).filter((x) => x.t >= cut).sort((x, y) => x.t - y.t);
  return cmd.type === 'usageHistory' ? samples : weekForecast(samples);
}

async function syncUsage() {
  if (usageSyncing) return;
  usageSyncing = true;
  try {
    await pullCost().catch(() => null);
    // What each machine lacks, from the samples just read (no machine is asked twice).
    const seen = new Set(); // (a "server" may be this machine's own daemon: ssh to localhost)
    const got = (await pullUsage().catch(() => [])).filter((g) => {
      const key = `${g.hello?.boot}:${g.hello?.pid}`;
      return !seen.has(key) && seen.add(key);
    });
    const lacking = []; // the machines that miss samples another of their account has
    for (const account of new Set(got.map((g) => g.account))) {
      const group = got.filter((g) => g.account === account);
      if (group.length < 2) continue;
      const all = new Map();
      for (const g of group) for (const x of g.samples) if (!all.has(x.t)) all.set(x.t, x);
      for (const g of group) {
        const have = new Set(g.samples.map((x) => x.t));
        const missing = [...all.values()].filter((x) => !have.has(x.t));
        if (missing.length) lacking.push({ ...g, missing, from: group.filter((o) => o !== g).map((o) => o.name).join(', ') });
      }
    }
    await round('Copying the samples a machine missed', lacking, async (g) => {
      const r = await g.ask({ type: 'usageMerge', account: g.account, samples: g.missing }).catch(() => null);
      const added = r?.reply?.data?.added;
      if (added) console.log(`usage history: ${added} sample${added > 1 ? 's' : ''} ${g.name} had missed, copied from ${g.from}`);
    }, (g) => JSON.stringify(g.missing).length);
  } catch (e) {
    console.error(`usage history not compared: ${e.message}`);
  } finally {
    usageSyncing = false;
  }
}
setInterval(syncUsage, USAGE_SYNC_MS).unref();

// ---- videos the browser can't decode: converted here, on this computer ----
// The server only hands out a file's bytes. When the page finds it can't decode a video (e.g. OpenCV's
// 'mp4v', MPEG-4 Part 2), it posts the bytes it already has to POST /convert, reads ffmpeg's progress
// back as lines ("progress 0.42", then "done <id>" or "error <message>") and fetches the result from
// GET /converted?id=<id>. Nothing is needed on the server.
const MEDIA_TMP = path.join(os.tmpdir(), `iro-media-${process.pid}`);
const MAX_VIDEO = 512 << 20;
const converted = new Map(); // id -> file, until the page fetches it
process.on('exit', () => fs.rmSync(MEDIA_TMP, { recursive: true, force: true }));
// Ctrl+C, a kill, a closed terminal: an exit of our own (with the usual 128 + signal code), as Node's own
// for these runs no 'exit' handler, and the converted videos would stay in the temporary folder.
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(128 + os.constants.signals[s]));
// ffmpeg from PATH, Homebrew, conda or pip's imageio-ffmpeg; looked up on each use, so installing it needs no restart.
function findFfmpeg() {
  const home = os.homedir();
  const isExe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
  const ls = (d) => { try { return fs.readdirSync(d).map((f) => path.join(d, f)); } catch { return []; } };
  const conda = ['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge', '.conda'].map((d) => path.join(home, d));
  const prefixes = [...conda, ...conda.flatMap((d) => ls(path.join(d, 'envs'))), path.join(home, '.local')];
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, 'bin'), ...prefixes.map((d) => path.join(d, 'bin'))];
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return dirs.filter(Boolean).map((d) => path.join(d, exe)).find(isExe)
    || prefixes.flatMap((d) => ls(path.join(d, 'lib')).filter((x) => /python3/.test(x))) // imageio-ffmpeg's static build
      .flatMap((d) => ls(path.join(d, 'site-packages', 'imageio_ffmpeg', 'binaries'))).find((f) => /ffmpeg[^/\\]*$/.test(path.basename(f)) && isExe(f));
}
// target 'mp4' = H.264 + AAC; 'webm' = VP9 + Opus, for a browser without H.264 (some Chromium builds).
function convertVideo(req, res, target) {
  fs.mkdirSync(MEDIA_TMP, { recursive: true });
  const id = randomBytes(8).toString('hex');
  const src = path.join(MEDIA_TMP, `${id}.in`);
  const out = path.join(MEDIA_TMP, `${id}.${target}`);
  const line = (s) => res.write(s + '\n');
  let size = 0;
  const file = fs.createWriteStream(src);
  // Too big (413), or the upload can't be kept (500: the disk is full, no file can be opened): the rest of
  // it is read and dropped, and the answer goes once it has all arrived. A connection closed while the
  // browser still sends is reset, and the page would see that instead of the answer.
  let refused = 0;
  const answer = () => { if (!res.headersSent) res.writeHead(refused, { connection: 'close' }).end(); };
  const refuse = (status) => {
    if (refused) return;
    refused = status;
    req.unpipe(file);
    req.resume();
    file.destroy();
    fs.rmSync(src, { force: true });
    if (req.readableEnded) answer(); else req.once('end', answer);
  };
  req.on('data', (d) => { size += d.length; if (size > MAX_VIDEO) refuse(413); });
  file.on('error', (e) => {
    if (res.headersSent) return; // (all of it was written: ffmpeg has it)
    console.error(`cannot keep a video to convert: ${e.message}`);
    refuse(500);
  });
  req.pipe(file);
  // The page went away before all of it arrived: what was kept goes (once the file is closed, as the
  // stream may still be opening it), and no ffmpeg starts.
  req.on('close', () => {
    if (req.complete || refused) return;
    req.unpipe(file);
    const drop = () => fs.rmSync(src, { force: true });
    if (file.closed) drop(); else { file.once('close', drop); file.destroy(); }
  });
  file.on('finish', () => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    let ended = false; // (ffmpeg that can't start says so in 'error', and 'close' may follow)
    const end = (s) => { if (ended) return; ended = true; fs.rmSync(src, { force: true }); res.end(s + '\n'); };
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return end('error no-ffmpeg');
    const codec = target === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-f', 'webm']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4'];
    // An ffmpeg that can't run here (built for another processor, not a program at all) throws, or says
    // so in 'error': the page shows it, and opening the file again tries again.
    const broken = (e) => { fs.rmSync(out, { force: true }); end(`error ${ffmpeg} cannot run here (${e.code || e.message})`); };
    let ff;
    try {
      ff = spawn(ffmpeg, ['-y', '-nostdin', '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p', ...codec, out], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return broken(e); }
    ff.on('error', broken);
    if (!ff.stdout) return; // (no file descriptors left for its output: 'error' follows)
    let err = '', duration = 0, last = 0;
    ff.stderr.setEncoding('utf8');
    ff.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
      const m = !duration && /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
      if (m) duration = m[1] * 3600 + m[2] * 60 + Number(m[3]);
    });
    ff.stdout.setEncoding('utf8');
    ff.stdout.on('data', (d) => {
      const us = [...d.matchAll(/out_time_us=(\d+)/g)].pop();
      if (us && duration && Date.now() - last > 300) { last = Date.now(); line(`progress ${Math.min(0.99, us[1] / 1e6 / duration).toFixed(3)}`); }
    });
    res.on('close', () => { if (ff.exitCode == null) ff.kill(); }); // the page went away
    ff.on('close', (code) => {
      if (ended) return;
      if (code !== 0) { fs.rmSync(out, { force: true }); return end(`error ${err.trim().split('\n').pop() || `ffmpeg exited with ${code}`}`); }
      converted.set(id, out);
      setTimeout(() => { if (converted.delete(id)) fs.rmSync(out, { force: true }); }, 10 * 60_000); // never fetched
      end(`done ${id}`);
    });
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
    // Images only from here (render.js turns remote Markdown images into links; this backs it up).
    // And no page may show it in a frame: another site could cover it with its own and get clicks on approvals.
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "img-src 'self' data: blob:; frame-ancestors 'none'", 'x-frame-options': 'DENY' }).end(html());
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
    // How far each session has been looked at, ahead of the log (as the daemon sends it on sync)
    const ends = {};
    for (const e of c.cache) if (e.kind === 'seen') ends[e.sid] = e.end;
    if (Object.keys(ends).length) send(res, { type: 'seen', ends });
    for (const e of c.cache) send(res, e);
    send(res, status(c));
    send(res, { type: 'partial', op: 'usageSync', sync: syncNow() }); // (a round under way, or none: the page's sync bar)
    c.sse.add(res);
    clearTimeout(c.dropTimer);
    req.on('close', () => { c.sse.delete(res); idleCheck(c); });
    return;
  }
  // An image of a sent message (the event log names it by ref), as an image the page can load and cache.
  if (req.method === 'GET' && url.pathname === '/media') {
    if (url.searchParams.get('t') !== token) return res.writeHead(403).end();
    const c = conns.get(url.searchParams.get('target') || lastTarget);
    const ref = url.searchParams.get('ref') || '';
    const type = url.searchParams.get('type');
    if (!c?.pipe || !c.up || !/^[0-9a-f]{40}$/.test(ref) || !MEDIA_TYPES.has(type)) return res.writeHead(404).end();
    request(c, { type: 'media', ref }).then((r) => {
      if (r.error != null || typeof r.data?.data !== 'string') return res.writeHead(404).end();
      const bytes = Buffer.from(r.data.data, 'base64');
      // (named by its content: the same ref is always the same image)
      res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'private, max-age=31536000, immutable' }).end(bytes);
    });
    return;
  }
  if (url.pathname === '/convert' || url.pathname === '/converted') {
    if (req.headers['x-token'] !== token) return res.writeHead(403).end();
    if (req.method === 'POST' && url.pathname === '/convert') return convertVideo(req, res, url.searchParams.get('target') === 'webm' ? 'webm' : 'mp4');
    const file = req.method === 'GET' && converted.get(url.searchParams.get('id'));
    if (!file) return res.writeHead(404).end();
    converted.delete(url.searchParams.get('id'));
    res.writeHead(200, { 'content-type': file.endsWith('.webm') ? 'video/webm' : 'video/mp4', 'content-length': fs.statSync(file).size, 'cache-control': 'no-store' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res); // (the page then says the conversion failed)
    res.on('close', () => fs.rmSync(file, { force: true }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/cmd') {
    // Custom header => cross-site pages can't send this without a CORS preflight.
    if (req.headers['x-token'] !== token) return res.writeHead(403).end();
    let body = '';
    let size = 0, tooBig = false;
    req.setEncoding('utf8');
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; body = ''; return; } // (the rest is read and dropped: see convertVideo)
      body += c;
    });
    req.on('end', async () => {
      if (tooBig) return res.writeHead(413, { connection: 'close' }).end();
      let cmd;
      try { cmd = JSON.parse(body); } catch { return res.writeHead(400).end(); }
      const json = (out) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      if (cmd?.type === 'targets') return json({ data: targets(req.headers['x-target'] || lastTarget) });
      if (cmd?.type === 'forgetTarget') {
        try { forgetTarget(String(cmd.target)); return json({ data: targets(req.headers['x-target'] || lastTarget) }); } catch (e) { return json({ error: e.message }); }
      }
      // The widgets of the tab's server, and the Plugins page.
      const tabServer = req.headers['x-target'] || lastTarget;
      if (cmd?.type === 'plugins') return json({ data: listPlugins().filter((p) => showsOn(p.where, tabServer)) });
      if (cmd?.type === 'pluginPage') return json({ data: pluginPage(tabServer) });
      if (cmd?.type === 'pluginSet' || cmd?.type === 'pluginOrder') {
        try { (cmd.type === 'pluginSet' ? setPluginWhere : setPluginOrder)(cmd); return json({ data: pluginPage(tabServer) }); } catch (e) { return json({ error: e.message }); }
      }
      if (cmd?.type === 'siteIcon') return json({ data: await siteIcon(cmd) });
      if (cmd?.type === 'pluginFile') { try { return json({ data: pluginFile(cmd) }); } catch (e) { return json({ error: e.message }); } }
      if (cmd?.type === 'pluginData' || cmd?.type === 'pluginSave') {
        try { return json({ data: cmd.type === 'pluginData' ? pluginData(cmd) : (savePluginData(cmd), null) }); } catch (e) { return json({ error: e.message }); }
      }
      // The UI Skills page: this checkout's skills/ (a server gets them from here), and which servers run them.
      if (/^uiSkill/.test(cmd?.type || '')) {
        try {
          if (cmd.type === 'uiSkillFile') return json({ data: skillFile(SKILLS_DIR, cmd) });
          if (cmd.type === 'uiSkillSave') (cmd.name == null ? savePrompt : saveSkill)(SKILLS_DIR, cmd);
          else if (cmd.type === 'uiSkillNew') newSkill(SKILLS_DIR, cmd);
          else if (cmd.type !== 'uiSkills') return res.writeHead(400).end();
          // (asked again: the local daemon reads this skills/ itself, so an edit here is already its own)
          const live = [...conns.values()].filter((c) => c.lastHello);
          await Promise.all(live.filter((c) => c.up).map(async (c) => {
            const r = await request(c, { type: 'serverCode' }).catch(() => null);
            if (typeof r?.data === 'string') c.lastHello.code = r.data;
          }));
          const servers = live.map((c) => ({ id: c.id, host: c.local ? 'this machine' : c.host, current: !stale(c) }));
          return json({ data: { ...listSkills(SKILLS_DIR), servers } });
        } catch (e) { return json({ error: e.message }); }
      }
      if (cmd?.type === 'connect') { try { selectTarget(cmd.target); return json({ data: null }); } catch (e) { return json({ error: e.message }); } }
      // The tab's server (x-target); without one (scripts, tests), the one picked last.
      const id = req.headers['x-target'] || lastTarget;
      const c = id ? getConn(id) : null;
      if (id && !c) return res.writeHead(400).end();
      if (c && cmd?.type === 'deploy') return json(await deploy(c).then(() => ({ data: null }), (e) => ({ error: e.message }))); // handled here, not by the daemon
      if (c && cmd?.type === 'start') { start(c); return json({ data: null }); }
      // The host's ports at localhost: this client's own doing, like deploy.
      if (c && cmd?.type === 'portStatus') return json(await portStatus(c, cmd).then((data) => ({ data }), (e) => ({ error: e.message })));
      if (c && (cmd?.type === 'openPort' || cmd?.type === 'closePort')) {
        return json(await (cmd.type === 'openPort' ? openPort(c, cmd.port, 'user', cmd.local) : closePort(c, cmd.port)).then((data) => ({ data: data ?? null }), (e) => ({ error: e.message })));
      }
      // What the work cost is added up here, over the machines of the account (an older daemon answers for itself).
      if (c?.up && cmd?.type === 'usageCost') { const data = await costFor(c, cmd).catch(() => null); if (data || cmd.cached) return json({ data }); }
      // And so is the plan usage: one history, one estimate and one level per account, whichever machine the page is on.
      if (c?.up && ['usageHistory', 'usageForecast', 'limits'].includes(cmd?.type)) { const data = await usageFor(c, cmd).catch(() => undefined); if (data !== undefined) return json({ data }); }
      // Reconnecting (e.g. the daemon was just updated): wait a little rather than fail the command.
      for (let i = 0; i < 50 && c && !c.gone && !c.stopped && (!c.pipe || !c.up); i++) await new Promise((r) => setTimeout(r, 200));
      if (!c?.pipe || !c.up) return res.writeHead(503).end('not connected');
      if (!c.forwarded.has(cmd?.type)) return res.writeHead(400).end(); // (checked against the daemon it goes to)
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
