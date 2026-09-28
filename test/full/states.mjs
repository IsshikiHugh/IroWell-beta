// Session states (busy/idle/detached), Running list, Detach/Reattach, status layout, /color.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, startSession, openFolderHistory, addFolder } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4782;
const WORK = path.join(S, 'work15');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
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
page.on('dialog', (d) => { console.log('DIALOG:', d.message().slice(0, 80)); d.accept(); });
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.getByText('connected · local').waitFor({ timeout: 10000 });
const dotClass = () => page.locator('.sess.active .dot').getAttribute('class');
async function waitResults(n) {
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const allow = page.locator('.approval .btns button.primary');
    if (await allow.count()) await allow.first().click();
    if ((await page.locator('.turn-foot .meta.result').count()) >= n) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

await startSession(page, WORK, 'Start this with Bash using run_in_background: node -e "setTimeout(() => console.log(9), 90000)". Do not wait for it. Reply with just: started');
check(/st-busy/.test(await dotClass()), 'working session is green (busy)');
check(await waitResults(1), 'turn finished');
await page.waitForTimeout(2500);
check(/st-busy/.test(await dotClass()), 'still busy after the turn: background shell running');
check(JSON.stringify(await page.locator('#railtabs button').allTextContents()).includes('Anchors') && (await page.locator('#railtabs button').allTextContents()).some((t) => t.startsWith('Tasks')), 'rail tabs: Anchors / btw / Tasks');
check(await page.locator('#runlist').isHidden(), 'Tasks pane is a tab, not stacked under the anchors');
check((await page.locator('#taskCount').textContent()) === '1', 'Tasks tab shows a count badge');
await page.click('#railtabs button[data-tab="tasks"]');
check(await page.locator('#runlist .run-item .run-kind', { hasText: 'shell' }).count() === 1, 'Running list shows the background shell');
check(/running for \d/.test(await page.locator('#runlist .run-item .run-sub').nth(1).textContent()), `task timing reads "running for …" (${await page.locator('#runlist .run-item .run-sub').nth(1).textContent()})`);
check((await page.locator('#runlist .run-item').first().textContent()).startsWith('main'), 'main is always listed first');
await page.screenshot({ path: path.join(S, 'states-busy.png') });

await page.locator('#runlist .run-item .run-stop').first().click();
await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-idle'), null, { timeout: 30000 }).catch(() => {});
check(/st-idle/.test(await dotClass()), 'stopping it makes the session yellow (idle)');
check(await page.locator('#runlist .run-item').count() === 1 && (await page.locator('#runlist .run-item').textContent()).includes('Idle'), 'Running list shows only "main · Idle"');

// status line layout
const rows = await page.evaluate(() => [...document.querySelectorAll('#statusbar .sb-row')].map((r) => [...r.children].filter((c) => !c.classList.contains('dd-native')).map((c) => c.id || c.className.split(' ')[0])));
console.log('  rows:', JSON.stringify(rows));
check(rows[0][0] === 'modelBtn' && rows[0][1] === 'dd-btn' && rows[0][2] === 'sb-ctx' && rows[0].includes('sb-dir') && rows[0].includes('sb-time'), 'row 1: model, mode, ctx, 5h, 7d, dir, tokens, cost, time');
check(rows[1].includes('sb-title') && rows[1][rows[1].length - 1] === 'sb-sid', 'row 2: session name … session id');
const divider = await page.evaluate(() => getComputedStyle(document.getElementById('sb-5h')).borderLeftStyle);
check(divider === 'solid', 'cells are separated by thin dividers');

// /color
await page.fill('#input', '/color blue');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#3d78c2', null, { timeout: 10000 }).catch(() => {});
const theme = await page.evaluate(() => ({ accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), send: getComputedStyle(document.getElementById('send')).backgroundColor, q: getComputedStyle(document.querySelector('.turn-q')).borderLeftColor }));
console.log('  theme:', JSON.stringify(theme));
check(theme.accent === '#3d78c2' && theme.send === 'rgb(61, 120, 194)' && theme.q === 'rgb(61, 120, 194)', '/color blue recolours Send and the question bars');
check(await page.locator('.turn').count() === 1, '/color adds no turn');
await page.screenshot({ path: path.join(S, 'states-color.png') });
await page.reload();
await page.getByText('connected · local').waitFor({ timeout: 10000 });
await page.waitForTimeout(800);
check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#3d78c2', 'colour survives a reload');
await page.fill('#input', '/color default');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForTimeout(1000);
check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) !== '#3d78c2', '/color default resets it');

// Detach → grey, stays listed; Reattach
await page.click('#closeSess');
await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-detached'), null, { timeout: 15000 }).catch(() => {});
check(/st-detached/.test(await dotClass()), 'Detach turns it grey and keeps it in the list');
check(await page.locator('#input').isDisabled(), 'composer is disabled while detached');
check(await page.locator('.detached-note button', { hasText: 'Reattach' }).count() === 1, 'a Reattach button is offered');
await page.screenshot({ path: path.join(S, 'states-detached.png') });
await page.locator('.detached-note button', { hasText: 'Reattach' }).click();
await page.getByText('earlier conversation above').waitFor({ timeout: 30000 });
// the sidebar is redrawn on the next animation frame, after the conversation
await page.waitForFunction(() => document.querySelectorAll('.sess').length === 1 && !document.querySelector('.sess.active .st-detached'), null, { timeout: 2000 }).catch(() => {});
check(!/st-detached/.test(await dotClass()) && await page.locator('.sess').count() === 1, 'Reattach brings it back (listed once)');

// the input box lines up with the Send/Stop/Detach stack; the expand bar spans its top edge
const align = await page.evaluate(() => {
  const w = document.querySelector('.input-wrap').getBoundingClientRect(), g = document.querySelector('.send-group').getBoundingClientRect();
  const bar = document.getElementById('expandInput').getBoundingClientRect(), box = document.getElementById('input').getBoundingClientRect();
  return { wrapH: Math.round(w.height), groupH: Math.round(g.height), barW: Math.round(bar.width), boxW: Math.round(box.width), barVisible: bar.height > 0 };
});
console.log('  align:', JSON.stringify(align));
check(Math.abs(align.wrapH - align.groupH) <= 2, 'input box is as tall as the button stack');
check(align.barVisible && Math.abs(align.barW - align.boxW) <= 2, 'expand bar is always there, full width of the box');
// the right rail can be dragged wider, and keeps its width
const rw0 = await page.evaluate(() => document.getElementById('rail').offsetWidth);
const gr = await page.locator('#railResize').boundingBox();
await page.mouse.move(gr.x + 3, gr.y + 200);
await page.mouse.down();
await page.mouse.move(gr.x - 120, gr.y + 200, { steps: 5 });
await page.mouse.up();
const rw1 = await page.evaluate(() => document.getElementById('rail').offsetWidth);
check(rw1 > rw0 + 100, `dragging the rail edge widens it (${rw0} → ${rw1}px)`);
await page.reload();
await page.getByText('connected · local').waitFor({ timeout: 10000 });
check(Math.abs((await page.evaluate(() => document.getElementById('rail').offsetWidth)) - rw1) <= 1, 'rail width is remembered');
await page.locator('#railResize').dblclick();
await page.locator('.sess:not(.detached)').first().click();
await page.waitForTimeout(500);

// the input grows with its text, then offers a half-screen editor
const h0 = await page.evaluate(() => document.getElementById('input').offsetHeight);
await page.fill('#input', 'line\n'.repeat(4));
const h1 = await page.evaluate(() => document.getElementById('input').offsetHeight);
check(h1 > h0, `input grows with its text (${h0}px → ${h1}px)`);
check(await page.evaluate(() => getComputedStyle(document.getElementById('input')).resize) === 'none', 'no drag handle');
await page.fill('#input', 'line\n'.repeat(60));
check(await page.locator('#expandInput').isVisible(), 'a long text shows the expand arrow');
await page.click('#expandInput');
const h2 = await page.evaluate(() => document.getElementById('input').offsetHeight / window.innerHeight);
check(h2 > 0.45, `expanded to about half the screen (${Math.round(h2 * 100)}%)`);
await page.fill('#input', '');
check(await page.evaluate(() => document.getElementById('feed').scrollWidth <= document.getElementById('feed').clientWidth + 1), 'no sideways scrolling in the conversation');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
