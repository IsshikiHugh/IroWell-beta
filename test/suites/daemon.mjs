// The daemon by itself (no client, no browser), each case in a state dir of its own, all at once: two started
// over a dead one's socket; --check-cli and a release whose Claude Code doesn't run; one folder shared by two
// machines (daemon.host); the idle exit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { REPO, check, until, wait, cleanEnv, finish } from '../lib.mjs';

const DAEMON = path.join(REPO, 'server', 'daemon.mjs');
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const exited = (p) => new Promise((r) => (p.exitCode != null || p.signalCode != null ? r() : p.once('exit', r)));
const stop = async (p) => { if (p.exitCode == null && p.signalCode == null) { p.kill(); await exited(p); } };

// ---- two daemons started at once over a dead daemon's socket: one runs, the other leaves ----
async function race() {
  const dir = tmp('iro-race-');
  const sock = path.join(dir, 'daemon.sock');
  fs.writeFileSync(sock, ''); // left behind (not listening)
  fs.writeFileSync(path.join(dir, 'daemon.lock'), '999999'); // and a dead daemon's lock
  const start = () => { const d = spawn(process.execPath, [DAEMON], { cwd: dir, env: cleanEnv({ IRO_DIR: dir }), stdio: 'ignore' }); d.on('exit', () => (d.gone = true)); return d; };
  const ds = [start(), start()];
  const lockPid = () => { try { return Number(fs.readFileSync(path.join(dir, 'daemon.lock'), 'utf8')); } catch { return 0; } }; // (moved aside for a moment while taken)
  let running = [], reachable = false;
  const settled = async () => {
    running = ds.filter((d) => !d.gone);
    reachable = await new Promise((r) => { const c = net.connect(sock); c.once('data', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
    return running.length === 1 && reachable && lockPid() === running[0].pid;
  };
  check(await until(settled, 15000),
    `two daemons at once: one runs and owns the socket, the other exits (${running.length} running, reachable: ${reachable})`);
  await Promise.all(ds.map(stop));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- a release whose Claude Code doesn't run (it answers like a bare Bun): --check-cli says so, and a daemon of it
// started to take over from a retiring one leaves; with no daemon to take over from it runs. (--check-cli looks at
// the real Claude Code in the SDK's packages: the fake stands in for its queries only.) ----
async function checkCli() {
  const dir = tmp('iro-cli-');
  const rel = path.join(dir, 'rel'), mods = path.join(REPO, 'server', 'node_modules'), at = path.join(rel, 'node_modules', '@anthropic-ai');
  fs.mkdirSync(at, { recursive: true });
  for (const f of ['daemon.mjs', 'shared.mjs', 'away.mjs', 'slack.mjs', 'machine.mjs']) fs.copyFileSync(path.join(REPO, 'server', f), path.join(rel, f));
  for (const f of fs.readdirSync(mods)) if (f !== '@anthropic-ai') fs.symlinkSync(path.join(mods, f), path.join(rel, 'node_modules', f));
  for (const f of fs.readdirSync(path.join(mods, '@anthropic-ai'))) { // (the SDK a copy: it looks for Claude Code in the release too)
    const from = path.join(mods, '@anthropic-ai', f);
    if (f === 'claude-agent-sdk') fs.cpSync(from, path.join(at, f), { recursive: true });
    else if (!f.startsWith('claude-agent-sdk-')) fs.symlinkSync(from, path.join(at, f));
    else {
      fs.mkdirSync(path.join(at, f));
      fs.copyFileSync(path.join(from, 'package.json'), path.join(at, f, 'package.json'));
      fs.writeFileSync(path.join(at, f, 'claude'), '#!/bin/sh\necho 1.4.3\n', { mode: 0o755 });
    }
  }
  const env = cleanEnv({ IRO_DIR: dir });
  const cliCheck = (file) => spawnSync(process.execPath, [file, '--check-cli'], { cwd: dir, env, encoding: 'utf8' });
  const good = cliCheck(DAEMON), bad = cliCheck(path.join(rel, 'daemon.mjs'));
  check(good.status === 0 && !good.stderr && bad.status === 1 && /^Claude Code at .*does not run \(--version: 1\.4\.3\)$/.test(bad.stderr.trim()) && fs.readdirSync(dir).join() === 'rel',
    `--check-cli: 0 for this checkout, 1 for a damaged Claude Code, and nothing of a daemon runs (${bad.stderr.trim()})`);
  const run = () => {
    const d = spawn(process.execPath, [path.join(rel, 'daemon.mjs')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    d.out = '';
    d.stdout.on('data', (b) => (d.out += b));
    d.on('exit', (code) => (d.code = code));
    return d;
  };
  const retiring = net.createServer((s) => s.end()); // a retiring daemon, still listening
  await new Promise((r) => retiring.listen(path.join(dir, 'old-12345678.sock'), r));
  const d = run();
  await until(() => d.code != null, 15000, 'the daemon that cannot take over exits');
  check(d.code === 1 && /not taking over the sessions: Claude Code at .*does not run/.test(d.out) && !fs.existsSync(path.join(dir, 'daemon.sock')),
    `a damaged Claude Code: it leaves the sessions to the retiring daemon, and takes no socket (exit ${d.code}; ${d.out.trim().split('\n').pop()})`);
  await new Promise((r) => retiring.close(r));
  fs.rmSync(path.join(dir, 'old-12345678.sock'), { force: true });
  fs.writeFileSync(path.join(dir, 'old-87654321.sock'), ''); // left by a daemon that died: no one to take over from
  const d2 = run();
  check(await until(() => fs.existsSync(path.join(dir, 'daemon.sock')), 10000) && d2.code == null, 'with no live daemon to take over from, it runs anyway');
  await stop(d2);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- one folder, one machine: while the daemon of another machine sharing the folder (a home on NFS) says it
// serves it, one started here leaves and attach says where IroWell runs; once that is stale (the other machine went
// away without a word), one starts here, says so itself, and lets go when it stops ----
async function host() {
  const dir = tmp('iro-host-');
  const hostFile = path.join(dir, 'daemon.host'), sock = path.join(dir, 'daemon.sock');
  fs.writeFileSync(hostFile, JSON.stringify({ host: 'otherbox', pid: 4242 }) + '\n');
  const env = cleanEnv({ IRO_DIR: dir });
  const d = spawnSync(process.execPath, [DAEMON], { cwd: dir, env, encoding: 'utf8', timeout: 15000 });
  check(d.status === 1 && /IroWell runs on otherbox, which shares /.test(d.stdout) && !fs.existsSync(sock), `another machine serves the folder: a daemon started here leaves (exit ${d.status}; ${d.stdout.trim()})`);
  const a = spawnSync(process.execPath, [path.join(REPO, 'server', 'attach.mjs')], { cwd: dir, env, encoding: 'utf8', timeout: 15000, input: '' });
  check(a.status === 1 && /^IroWell already runs on otherbox, which shares .*: connect to otherbox, or stop it there first$/.test(a.stderr.trim()) && !fs.existsSync(sock),
    `…and attach says where IroWell runs, and starts nothing (${a.stderr.trim()})`);
  const old = new Date(Date.now() - 10 * 60e3);
  fs.utimesSync(hostFile, old, old);
  const d2 = spawn(process.execPath, [DAEMON], { cwd: dir, env, stdio: 'ignore' });
  check(await until(() => fs.existsSync(sock) && JSON.parse(fs.readFileSync(hostFile, 'utf8')).host === os.hostname(), 10000) && JSON.parse(fs.readFileSync(hostFile, 'utf8')).pid === d2.pid,
    'once that is stale, a daemon starts here and says it serves the folder');
  { // this machine under another name (a laptop's changes with its network): its own daemon is no other machine
    const dir2 = tmp('iro-host-');
    fs.writeFileSync(path.join(dir2, 'daemon.host'), JSON.stringify({ host: 'thismac-before', pid: d2.pid }) + '\n');
    const d3 = spawn(process.execPath, [DAEMON], { cwd: dir2, env: cleanEnv({ IRO_DIR: dir2 }), stdio: 'ignore' });
    check(await until(() => fs.existsSync(path.join(dir2, 'daemon.sock')), 10000), 'a fresh record under another name whose daemon runs on this machine: it is this machine, and a daemon starts');
    await stop(d3);
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  const c = net.connect(sock);
  c.on('error', () => {});
  c.write(JSON.stringify({ type: 'shutdown', id: 1 }) + '\n');
  check(await Promise.race([exited(d2).then(() => true), wait(15000).then(() => false)]) && !fs.existsSync(hostFile), 'stopped, it lets the folder go (another machine may start one at once)');
  c.destroy();
  await stop(d2);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- idle exit: a daemon with an idle limit of 0.72 s (checked every second) stays while a client is attached,
// then exits ----
async function idle() {
  const dir = tmp('iro-idle-');
  const sock = path.join(dir, 'daemon.sock');
  const d = spawn(process.execPath, [DAEMON], { cwd: dir, env: cleanEnv({ IRO_DIR: dir, IRO_IDLE_HOURS: '0.0002' }), stdio: 'ignore' });
  let gone = false;
  d.on('exit', () => (gone = true));
  await until(() => fs.existsSync(sock), 10000, 'the idle daemon\'s socket');
  const c = net.connect(sock);
  c.on('error', () => {}); // (no socket: the checks below say so)
  await new Promise((r) => { c.once('data', r); c.once('error', r); }); // hello
  await wait(2200); // (past the limit, and two checks of it)
  check(!gone && fs.existsSync(sock), 'idle exit: the daemon stays while a client is attached');
  c.end();
  check(await until(() => gone, 5000) && !fs.existsSync(sock), 'idle exit: with no client it exits and removes its socket');
  await stop(d);
  fs.rmSync(dir, { recursive: true, force: true });
}

await Promise.all([race(), checkCli(), host(), idle()]);
finish();
