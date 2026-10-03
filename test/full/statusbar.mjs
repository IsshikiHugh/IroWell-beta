// Status line under the composer; btw list in the right rail; btw Q/A styling.
import { outDir, startSession, check, finish, startSuite } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4785;
const WORK = path.join(S, 'work12');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
execSync('git init -q -b feature-x && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: WORK });
const { client, browser, page, errors } = await startSuite(PORT);

await startSession(page, WORK, 'Remember the codeword PELICAN. Reply with just: ok', { mode: 'default' }); // (not settings.json's defaultMode)
await page.locator('.turn-foot .meta.result').first().waitFor({ timeout: 120000 });
await page.waitForFunction(() => /\d%/.test(document.getElementById('sb-5h').textContent) && !document.getElementById('sb-ctx').hidden, null, { timeout: 30000 }).catch(() => {});
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
const tip = async (id) => (await page.locator('#' + id).getAttribute('title')) || '';
check(/5-hour window\d+%/.test(await txt('sb-5h')) && /resets in \d\dh\d\dm/.test(await tip('sb-5h')), `5-hour limit in the usage card, countdown on hover (${await txt('sb-5h')} / ${await tip('sb-5h')})`);
check(/Weekly\d+%/.test(await txt('sb-7d')) && /resets in \d\dd\d\dh/.test(await tip('sb-7d')), `weekly limit in the usage card, countdown on hover (${await txt('sb-7d')} / ${await tip('sb-7d')})`);
const sep = await page.evaluate(() => { const e = document.getElementById('sb-sid'), r = e.getBoundingClientRect(), prev = document.getElementById('sb-time').getBoundingClientRect(); const b = getComputedStyle(e, '::before'); return { content: b.content, abs: b.position === 'absolute', gap: r.left - prev.right }; });
check(sep.content === '"·"' && sep.abs && sep.gap > 12, `the separator before the session id sits outside its hover box (${JSON.stringify(sep)})`);
await page.locator('#sb-sid').hover(); await page.locator('header .head-sub').screenshot({ path: path.join(S, 'sid-hover.png') });
check(/^[0-9a-f]{8}$/.test((await txt('sb-sid')).trim()), `session id, first 8 characters (${await txt('sb-sid')})`);
check((await txt('title')).includes('codeword'), `session name in the header (${await txt('title')})`);

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
finish();
