#!/usr/bin/env node
// node test/run.mjs quick        no model calls, < 1 min; after small changes (quick.mjs, as four parts
//                                quick-A … quick-D at once; `node test/run.mjs quick-B` runs one)
// node test/run.mjs full         quick and every end-to-end suite (real Claude turns)
// node test/run.mjs <name> …     just those suites (e.g. focus states)
// node test/run.mjs quick <name> …  quick, then those suites too (and so with full)
// The suites run IRO_TEST_JOBS at a time (default JOBS below; each has its own port, daemon state and
// folders), quick among them, the longest first (as long as they took last time), so no long one
// starts last and leaves the others' slots idle.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT, killDaemon } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FULL = ['picker', 'protocol', 'ui', 'ui2', 'always', 'features', 'features2', 'focus', 'focus2', 'composer', 'statusbar', 'activity', 'dropdowns', 'states', 'update', 'rolling', 'rolling2', 'detach', 'queue', 'local', 'branch', 'rewind', 'archive', 'login', 'usagesync', 'ports', 'progress', 'workplace', 'triggers'];
const args = process.argv.slice(2);
const tier = args[0] === 'quick' ? ['quick'] : args[0] === 'full' ? ['quick', ...FULL] : null;
const names = [...new Set((tier ? [...tier, ...args.slice(1)] : args.length ? args : ['quick']).flatMap((n) => (n === 'quick' ? ['A', 'B', 'C', 'D'].map((p) => `quick-${p}`) : [n])))];
const part = (name) => /^quick-([A-D])$/.exec(name)?.[1];
const fileOf = (name) => (part(name) ? path.join(HERE, 'quick.mjs') : path.join(HERE, 'full', `${name}.mjs`));

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-test-'));
console.log(`screenshots and logs: ${out}`);
const JOBS = Math.max(1, Number(process.env.IRO_TEST_JOBS) || 5);
// How long each suite took last time (kept outside the repo; a suite never timed counts as long).
const TIMES = path.join(os.tmpdir(), 'iro-test-times.json');
const readTimes = () => { try { return JSON.parse(fs.readFileSync(TIMES, 'utf8')); } catch { return {}; } };
const times = readTimes(), took = {};
const results = [];
// The suite's client is found by this checkout's path: another checkout's run (a clone testing on the
// same port) is left alone.
const clientPattern = CLIENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function runSuite(name) {
  const file = fileOf(name);
  // A suite that crashed leaves its client running on its port; the next run's client then can't
  // listen there and the browser silently talks to the old one (old daemon state, old code).
  const code = fs.readFileSync(file, 'utf8');
  const port = part(name) ? new RegExp(`^const PORTS = \\{.*\\b${part(name)}: (\\d+)`, 'm').exec(code)?.[1] : /^const PORT = (\d+)/m.exec(code)?.[1];
  const killClient = () => { if (port) spawnSync('pkill', ['-f', `${clientPattern} .*--port ${port}( |$)`]); };
  killClient();
  const t0 = Date.now();
  // Output goes straight to the log file: a suite that crashes can leave its client running, and
  // that process would hold a pipe open forever.
  const log = path.join(out, `${name}.log`);
  const fd = fs.openSync(log, 'w');
  const iroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-dir-')); // the suite's own daemon state (test/lib.mjs)
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { env: { ...process.env, IRO_TEST_OUT: out, IRO_DIR: iroDir, ...(part(name) ? { IRO_QUICK_PART: part(name) } : {}) }, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => p.kill(), 12 * 60 * 1000); // (inside CI's 15-minute job limit)
    p.on('exit', (status) => { clearTimeout(timer); resolve({ status }); });
  });
  fs.closeSync(fd);
  killClient();
  killDaemon(iroDir); // the suite's daemon outlives its client
  // Its log goes next to the suite's (CI keeps only `out`), and its state dir goes.
  const daemonLog = path.join(iroDir, 'daemon.log');
  if (fs.existsSync(daemonLog)) fs.copyFileSync(daemonLog, path.join(out, `${name}-daemon.log`));
  fs.rmSync(iroDir, { recursive: true, force: true, maxRetries: 3 });
  r.stdout = fs.readFileSync(log, 'utf8');
  const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL') || l.includes('TIMEOUT'));
  const ok = r.status === 0;
  results.push({ name, ok, secs: Math.round((Date.now() - t0) / 1000), fails });
  if (ok) took[name] = Math.round((Date.now() - t0) / 1000);
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(10)} ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s${ok ? '' : '  ' + (fails.join(' | ') || r.stdout.trim().split('\n').pop())}`);
}
for (const name of names) {
  if (!fs.existsSync(fileOf(name))) { console.error(`no such suite: ${name}`); process.exit(2); }
}
const t0 = Date.now();
const queue = [...names].sort((a, b) => (times[b] ?? 999) - (times[a] ?? 999));
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => { while (queue.length) await runSuite(queue.shift()); }));
console.log(`(${Math.round((Date.now() - t0) / 1000)}s in all, ${JOBS} at a time)`);
try { fs.writeFileSync(TIMES, JSON.stringify({ ...readTimes(), ...took })); } catch {} // (another run may have written meanwhile)
// The suites' Claude sessions ran in folders under `out`: Claude Code keeps their transcripts in
// ~/.claude/projects/<folder path with every non-alphanumeric as ->. They are only test leftovers.
const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const tag = path.basename(out).replace(/[^a-zA-Z0-9]/g, '-');
let swept = 0;
try {
  for (const d of fs.readdirSync(projects)) if (d.includes(`-${tag}-`) || d.endsWith(`-${tag}`)) { fs.rmSync(path.join(projects, d), { recursive: true, force: true }); swept++; }
} catch {}
if (swept) console.log(`removed the ${swept} test session transcript folder(s) from ${projects}`);
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} suites failed (logs in ${out})` : `\nall ${results.length} suites passed`);
process.exit(bad.length ? 1 : 0);
