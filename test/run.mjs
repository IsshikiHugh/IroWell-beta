#!/usr/bin/env node
// node test/run.mjs quick        no model calls, < 1 min; after small changes
// node test/run.mjs full         quick, then every end-to-end suite (real Claude turns, ~3 min)
// node test/run.mjs <name> …     just those suites (e.g. focus states)
// The end-to-end suites run IRO_TEST_JOBS at a time (default 3; each has its own port, daemon state and
// folders). quick runs first, on its own.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killDaemon } from './lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FULL = ['picker', 'protocol', 'ui', 'ui2', 'always', 'features', 'features2', 'focus', 'focus2', 'composer', 'statusbar', 'activity', 'dropdowns', 'states', 'update', 'rolling', 'rolling2', 'detach', 'queue', 'local', 'branch', 'rewind', 'archive', 'login'];
const args = process.argv.slice(2);
const mode = args[0] || 'quick';
const names = mode === 'quick' ? ['quick'] : mode === 'full' ? ['quick', ...FULL] : args;

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-test-'));
console.log(`screenshots and logs: ${out}`);
const JOBS = Math.max(1, Number(process.env.IRO_TEST_JOBS) || 3);
const results = [];
async function runSuite(name) {
  const file = name === 'quick' ? path.join(HERE, 'quick.mjs') : path.join(HERE, 'full', `${name}.mjs`);
  // A suite that crashed leaves its client running on its port; the next run's client then can't
  // listen there and the browser silently talks to the old one (old daemon state, old code).
  const port = /^const PORT = (\d+)/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
  const killClient = () => { if (port) spawnSync('pkill', ['-f', `client/client.mjs .*--port ${port}( |$)`]); };
  killClient();
  const t0 = Date.now();
  // Output goes straight to the log file: a suite that crashes can leave its client running, and
  // that process would hold a pipe open forever.
  const log = path.join(out, `${name}.log`);
  const fd = fs.openSync(log, 'w');
  const iroDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-dir-')); // the suite's own daemon state (test/lib.mjs)
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [file], { env: { ...process.env, IRO_TEST_OUT: out, IRO_DIR: iroDir }, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => p.kill(), 20 * 60 * 1000);
    p.on('exit', (status) => { clearTimeout(timer); resolve({ status }); });
  });
  fs.closeSync(fd);
  killClient();
  killDaemon(iroDir); // the suite's daemon outlives its client
  r.stdout = fs.readFileSync(log, 'utf8');
  r.stderr = '';
  const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL') || l.includes('TIMEOUT'));
  const ok = r.status === 0;
  results.push({ name, ok, secs: Math.round((Date.now() - t0) / 1000), fails });
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(10)} ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s${ok ? '' : '  ' + (fails.join(' | ') || (r.stderr || '').trim().split('\n').pop())}`);
}
for (const name of names) {
  const file = name === 'quick' ? path.join(HERE, 'quick.mjs') : path.join(HERE, 'full', `${name}.mjs`);
  if (!fs.existsSync(file)) { console.error(`no such suite: ${name}`); process.exit(2); }
}
const t0 = Date.now();
if (names.includes('quick')) await runSuite('quick');
const queue = names.filter((n) => n !== 'quick');
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => { while (queue.length) await runSuite(queue.shift()); }));
console.log(`(${Math.round((Date.now() - t0) / 1000)}s in all, ${JOBS} at a time)`);
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
