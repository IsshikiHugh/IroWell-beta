// Status line under the composer; btw list in the right rail; btw Q/A styling.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, startSession, openFolderHistory, addFolder } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4785;
const WORK = path.join(S, 'work12');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
execSync('git init -q -b feature-x && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: WORK });
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k)) delete env[k];
try { execSync('pkill -f "IroWell/server/daemon.mjs"'); } catch {}
await new Promise((r) => setTimeout(r, 500));
let failures = 0;
const check = (ok, what) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };
const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => { console.log('ALERT:', d.message()); d.accept(); });
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.getByText('connected · local').waitFor({ timeout: 10000 });

await startSession(page, WORK, 'Remember the codeword PELICAN. Reply with just: ok');
await page.locator('.turn-foot .meta.result').first().waitFor({ timeout: 120000 });
await page.waitForFunction(() => !document.getElementById('sb-5h').hidden && !document.getElementById('sb-ctx').hidden, null, { timeout: 30000 }).catch(() => {});
const txt = async (id) => ((await page.locator('#' + id).textContent()) || '').trim();
check(await page.locator('#statusbar').isVisible(), 'status line is shown');
check(await page.inputValue('#mode') === 'default', `mode shown (${await page.inputValue('#mode')})`);
console.log('  model:', await page.locator('#model option').first().textContent(), '| effort:', await page.inputValue('#effort'));
check(!!(await page.inputValue('#effort')), 'effort shown');
check((await txt('sb-dir')).includes('work12'), `directory (${await txt('sb-dir')})`);
check((await txt('sb-dir')).includes('feature-x'), `git branch (${await txt('sb-dir')})`);
check(/↑\S+ ↓\S+/.test(await txt('sb-tokens')), `tokens (${await txt('sb-tokens')})`);
check(/^\$\d/.test(await txt('sb-cost')), `cost (${await txt('sb-cost')})`);
check(/%/.test(await txt('sb-ctx')), `context meter (${await txt('sb-ctx')})`);
check(/5h.*%.*\d\dh\d\dm/.test(await txt('sb-5h')), `5-hour limit + countdown (${await txt('sb-5h')})`);
check(/7d.*%.*\d\dd\d\dh/.test(await txt('sb-7d')), `weekly limit + countdown (${await txt('sb-7d')})`);
check(/[0-9a-f]{8}-/.test(await txt('sb-sid')), `session id (${await txt('sb-sid')})`);
check((await txt('sb-title')).includes('codeword'), `session name (${await txt('sb-title')})`);

await page.selectOption('#effort', 'low');
await page.waitForFunction(() => document.getElementById('effort').title === 'Effort: low', null, { timeout: 15000 }).catch(() => {});
check(await page.locator('#effort').getAttribute('title') === 'Effort: low', 'effort switched to low (confirmed by the CLI)');

// btw lives in the right rail, under the turns
await page.fill('#input', '/btw what codeword?');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('#btw .btw-answer:not(.live)').length >= 1, null, { timeout: 90000 });
await page.fill('#btw .btw-input', 'And backwards?');
await page.press('#btw .btw-input', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('#btw .btw-answer:not(.live)').length >= 2, null, { timeout: 90000 });
await page.click('#railtabs button[data-tab="btw"]');
await page.locator('#rail #btwlist .btw-item').first().waitFor({ timeout: 10000 });
check(await page.locator('#rail #btwlist .btw-item').count() === 1, 'btw thread listed in the right rail');
check(await page.locator('aside #tabs').count() === 0, 'no btw tab in the session sidebar any more');
const qa = await page.evaluate(() => {
  const q = getComputedStyle(document.querySelector('#btw .btw-user'));
  const a = getComputedStyle(document.querySelector('#btw .btw-answer'));
  return { qbg: q.backgroundColor, abg: a.backgroundColor, qb: q.borderLeftWidth };
});
check(qa.qbg !== qa.abg, `btw questions stand out from answers (${qa.qbg} vs ${qa.abg})`);
await page.screenshot({ path: path.join(S, 'statusbar.png') });
await page.locator('#statusbar').screenshot({ path: path.join(S, 'statusbar-only.png') });

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
