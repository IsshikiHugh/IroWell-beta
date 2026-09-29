// Sticky question contrast, command visibility, /usage /context panels, /btw.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, startSession, openFolderHistory, addFolder } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4788;
const WORK = path.join(S, 'work10');
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
const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => { console.log('ALERT:', d.message()); d.accept(); });
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });

const results = () => page.locator('.turn-foot .meta.result').count();
async function waitResults(n, timeout = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if ((await results()) >= n) return true; await page.waitForTimeout(200); }
  return false;
}
async function command(text) {
  await page.fill('#input', text);
  await page.press('#input', 'Escape');
  await page.press('#input', 'Enter');
}

await startSession(page, WORK, 'Remember the codeword PELICAN. Then list 30 numbered one-sentence facts about mountains.');
check(await waitResults(1), 'first turn');

const colors = await page.evaluate(() => {
  const q = getComputedStyle(document.querySelector('.turn-q'));
  const f = getComputedStyle(document.body);
  return { q: q.backgroundColor, body: f.backgroundColor, border: q.borderLeftColor };
});
check(colors.q !== colors.body, `question bar has its own colour (${colors.q} vs page ${colors.body})`);
await page.evaluate(() => { const f = document.getElementById('feed'); f.scrollTop = 600; });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(S, 'f2-sticky.png') });

// ---- functional commands leave no trace in the conversation ----
const turnsBefore = await page.locator('.turn').count();
await command('/usage');
await page.locator('.modal .meter-row').first().waitFor({ timeout: 30000 }).catch(() => {});
check(await page.locator('.modal .meter-row').count() >= 1, '/usage shows meters');
check(await page.locator('.modal .plan-badge').count() === 1, '/usage shows the plan');
await page.screenshot({ path: path.join(S, 'f2-usage.png') });
await page.keyboard.press('Escape');

await command('/context');
await page.locator('.modal .ctx-bar').waitFor({ timeout: 30000 }).catch(() => {});
check(await page.locator('.modal .ctx-seg').count() >= 2, '/context shows a stacked bar');
check(await page.locator('.modal .ctx-grid .sq').count() >= 50, '/context shows the square grid');
check(await page.locator('.modal .ctx-leg').count() >= 3, '/context shows a legend');
await page.screenshot({ path: path.join(S, 'f2-context.png') });
await page.keyboard.press('Escape');

await command('/agents'); // goes to the CLI, answers with text and no model turn
await page.locator('.modal .modal-title', { hasText: '/agents' }).waitFor({ timeout: 30000 }).catch(() => {});
check(await page.locator('.modal .modal-title', { hasText: '/agents' }).count() === 1, 'CLI command output opens in a dialog');
await page.keyboard.press('Escape');
await page.waitForTimeout(1500);
check(await page.locator('.turn').count() === turnsBefore && await page.locator('#outline .ol-item').count() === turnsBefore, 'none of these commands added a turn');
check(await page.locator('.cmd-chip').count() === 0, 'no command chips in the conversation');

// ---- /btw while the main turn is running ----
await page.fill('#input', 'Write 40 numbered one-sentence facts about rivers.');
await page.press('#input', 'Enter');
await page.locator('.md.assistant.live').waitFor({ timeout: 60000 }).catch(() => {});
await command('/btw what codeword did I ask you to remember?');
await page.locator('#btw').waitFor({ timeout: 5000 });
await page.waitForFunction(() => /PELICAN/i.test(document.querySelector('#btw .btw-body')?.textContent || ''), null, { timeout: 90000 }).catch(() => {});
check(/PELICAN/i.test(await page.locator('#btw .btw-body').textContent()), '/btw answered from the conversation');
const mainBusy = await page.evaluate(() => !document.getElementById('busy').hidden);
console.log('  main turn still running when btw answered:', mainBusy);
await page.screenshot({ path: path.join(S, 'f2-btw.png') });
check(await waitResults(2), 'main turn finished normally');
check(await page.locator('.turn').count() === turnsBefore + 1, 'btw did not add a turn');
const lastAnswer = await page.locator('.turn').last().textContent();
check(!/codeword/i.test(lastAnswer), 'btw is not in the main conversation');
await page.locator('#btw .btw-close').click();
check(await page.locator('#btw').count() === 0, 'btw card closes');
// Reopened from the btw tab, it goes away when the page changes (Usage here; switching sessions too)
await page.locator('#railtabs [data-tab=btw]').click();
await page.locator('.btw-item').first().click();
await page.locator('#btw').waitFor({ timeout: 5000 });
await page.locator('#usageBtn').click();
check(await page.locator('#btw').count() === 0, 'btw card closes when the Usage page opens');
await page.locator('#usageBack').click();

// Reload: history replay must not resurrect commands either
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
await page.waitForTimeout(800);
check(await page.locator('.turn').count() === turnsBefore + 1, 'after reload, still no command turns');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
