// Focus layout + slash command dialogs.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, startSession, openFolderHistory, addFolder } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4789;
const WORK = path.join(S, 'work9');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
fs.writeFileSync(path.join(WORK, 'calc.py'), 'def add(a, b):\n    return a - b\n\n\nprint(add(2, 3))\n');
fs.writeFileSync(path.join(WORK, 'README.md'), '# demo\n\n' + 'Some text.\n'.repeat(80));
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

async function turn(text, timeout = 180000) {
  const before = await page.locator('.turn-foot .meta.result').count();
  await page.fill('#input', text);
  await page.locator('#popup').waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
  await page.press('#input', 'Enter');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const allow = page.locator('.approval .btns button.primary');
    if (await allow.count()) { await allow.first().click(); await page.waitForTimeout(300); }
    if ((await page.locator('.turn-foot .meta.result').count()) > before) return true;
    await page.waitForTimeout(150);
  }
  return false;
}

await startSession(page, WORK, 'Read calc.py and README.md, then fix the bug in calc.py with Edit, run it with Bash, and explain the fix in 3 short paragraphs.');
const t0 = Date.now();
let sawStepsWhileRunning = false;
while (Date.now() - t0 < 240000) {
  if (await page.locator('.steps.busy .steps-now').count()) sawStepsWhileRunning = true;
  const allow = page.locator('.approval .btns button.primary');
  if (await allow.count()) {
    check(await page.locator('.steps.open .tool.asking').count() >= 1, 'pending approval opens its steps group');
    await allow.first().click(); await page.waitForTimeout(300);
  }
  if (await page.locator('.turn-foot .meta.result').count()) break;
  await page.waitForTimeout(150);
}
check(await page.locator('.turn').count() === 1, 'one turn section');
check(await page.locator('.steps').count() >= 1 && await page.locator('.steps.open').count() === 0, 'tool calls collapsed into steps groups');
check(await page.locator('.steps-list .tool').count() >= 3, 'steps contain the tool cards');
console.log('  saw current-step line while running:', sawStepsWhileRunning);
check(await page.locator('.turn-foot .changed .file-link', { hasText: 'calc.py' }).count() === 1, 'turn footer lists changed files');
await page.screenshot({ path: path.join(S, 'focus-1.png') });

check(await turn('Now write a long answer: list 25 numbered facts about the sea, one sentence each.'), 'second turn');
await page.setViewportSize({ width: 1400, height: 520 });
check(await page.locator('.turn').count() === 2 && await page.locator('#outline .ol-item').count() === 2, 'outline lists both turns');
// Scroll into the middle of turn 2's answer: its question must stay pinned at the top.
await page.evaluate(() => { const f = document.getElementById('feed'); const t = document.querySelectorAll('.turn')[1]; f.scrollTop = t.offsetTop + 500; });
await page.waitForTimeout(300);
const pinned = await page.evaluate(() => {
  const f = document.getElementById('feed').getBoundingClientRect();
  const q = document.querySelectorAll('.turn-q')[1].getBoundingClientRect();
  return Math.abs(q.top - f.top) < 2;
});
check(pinned, "turn 2's question is pinned at the top while reading its answer");
check((await page.locator('#outline .ol-item.active').textContent()).startsWith('Now write'), 'outline highlights the turn being read');
await page.screenshot({ path: path.join(S, 'focus-2.png') });
await page.locator('#outline .ol-item').first().click();
await page.waitForTimeout(800);
await page.setViewportSize({ width: 1400, height: 520 });
check((await page.locator('#outline .ol-item.active').textContent()).startsWith('Read calc.py'), 'clicking the outline jumps to that turn');
// the last anchor also goes all the way to the top, even though there is not a screen of text below it
await page.setViewportSize({ width: 1400, height: 1300 });
await page.waitForTimeout(300);
await page.locator('#outline .ol-item').last().click();
await page.waitForTimeout(900);
const lastTop = await page.evaluate(() => { const f = document.getElementById('feed').getBoundingClientRect().top; const t = [...document.querySelectorAll('.turn')].at(-1).getBoundingClientRect().top; return Math.round(t - f); });
check(Math.abs(lastTop) <= 2, `the last anchor jumps to the very top (offset ${lastTop}px)`);
await page.locator('#outline .ol-item').first().click();
await page.waitForTimeout(800);
await page.locator('.steps-head').first().click();
check(await page.locator('.steps.open').count() === 1, 'clicking a steps line expands it');
await page.screenshot({ path: path.join(S, 'focus-3.png') });

// ---- slash commands ----
// typing the full name and pressing Enter while the popup is open picks the exact command
await page.fill('#input', '');
await page.type('#input', '/usage');
await page.locator('#popup .pop-item.sel').waitFor({ timeout: 10000 });
check((await page.locator('#popup .pop-item.sel .pop-main').textContent()).trim() === '/usage', 'exact match is preselected in the popup');
await page.fill('#input', '');
await page.setViewportSize({ width: 1400, height: 900 });
const turnsBeforeUsage = await page.locator('.turn').count();
await page.fill('#input', '/usage');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.locator('.modal .meter-row').first().waitFor({ timeout: 60000 }).catch(() => {});
check(await page.locator('.modal .modal-title', { hasText: 'Usage' }).count() === 1 && await page.locator('.modal .meter-row').count() > 0, '/usage opens the usage panel (not /usage-credits)');
await page.keyboard.press('Escape');
check(await page.locator('.modal').count() === 0, 'Esc closes it');
check(await page.locator('.turn').count() === turnsBeforeUsage, '/usage leaves no turn');

for (const [cmd, title, what] of [['/help', 'Commands and shortcuts', 'td.mono'], ['/status', 'Status', 'table.help td'], ['/mcp', 'MCP servers', '.modal-body'], ['/model', 'Model', '.modal .hrow']]) {
  const turnsBefore = await page.locator('.turn').count();
  await page.fill('#input', cmd);
  await page.locator('#popup').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.press('#input', 'Escape'); // close the completion popup first
  await page.press('#input', 'Enter');
  await page.locator('.modal .modal-title', { hasText: title }).waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  check(await page.locator('.modal .modal-title', { hasText: title }).count() === 1 && await page.locator(what).count() > 0, `${cmd} opens its dialog`);
  check(await page.locator('.turn').count() === turnsBefore, `${cmd} is handled in the page (no new turn)`);
  if (cmd === '/status') await page.screenshot({ path: path.join(S, 'focus-status.png') });
  await page.keyboard.press('Escape');
}

const nSess = await page.locator('.sess').count();
await page.fill('#input', '/clear');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForFunction((n) => document.querySelectorAll('.sess').length === n + 1, nSess, { timeout: 15000 }).catch(() => {});
check(await page.locator('.sess').count() === nSess + 1 && await page.locator('.turn').count() === 0, '/clear starts a fresh session in the same directory');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
