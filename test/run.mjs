#!/usr/bin/env node
// node test/run.mjs quick        no model calls, < 1 min; after small changes
// node test/run.mjs full         quick + every end-to-end suite (real Claude turns, ~5 min)
// node test/run.mjs <name> …     just those suites (e.g. focus states)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FULL = ['protocol', 'ui', 'ui2', 'always', 'features', 'features2', 'focus', 'focus2', 'composer', 'statusbar', 'activity', 'dropdowns', 'states'];
const args = process.argv.slice(2);
const mode = args[0] || 'quick';
const names = mode === 'quick' ? ['quick'] : mode === 'full' ? ['quick', ...FULL] : args;

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-test-'));
console.log(`screenshots and logs: ${out}`);
const results = [];
for (const name of names) {
  const file = name === 'quick' ? path.join(HERE, 'quick.mjs') : path.join(HERE, 'full', `${name}.mjs`);
  if (!fs.existsSync(file)) { console.error(`no such suite: ${name}`); process.exit(2); }
  const t0 = Date.now();
  // Output goes straight to the log file: a suite that crashes can leave its client running, and
  // that process would hold a pipe open forever.
  const log = path.join(out, `${name}.log`);
  const fd = fs.openSync(log, 'w');
  const r = spawnSync(process.execPath, [file], { env: { ...process.env, IRO_TEST_OUT: out }, stdio: ['ignore', fd, fd], timeout: 20 * 60 * 1000 });
  fs.closeSync(fd);
  r.stdout = fs.readFileSync(log, 'utf8');
  r.stderr = '';
  const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL') || l.includes('TIMEOUT'));
  const ok = r.status === 0;
  results.push({ name, ok, secs: Math.round((Date.now() - t0) / 1000), fails });
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(10)} ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s${ok ? '' : '  ' + (fails.join(' | ') || (r.stderr || '').trim().split('\n').pop())}`);
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} suites failed (logs in ${out})` : `\nall ${results.length} suites passed`);
process.exit(bad.length ? 1 : 0);
