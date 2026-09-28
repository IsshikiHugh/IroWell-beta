// Styled dropdowns (mode/model/effort), session id toast, quiet meters.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, startSession, openFolderHistory, addFolder } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4783;
const WORK = path.join(S, 'work14');
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
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => { console.log('ALERT:', d.message()); d.accept(); });
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.getByText('connected · local').waitFor({ timeout: 10000 });

await startSession(page, WORK, 'Reply with just: ok');
await page.locator('.turn-foot .meta.result').first().waitFor({ timeout: 120000 });
await page.waitForFunction(() => !document.getElementById('sb-7d').hidden, null, { timeout: 30000 }).catch(() => {});

check(await page.locator('#statusbar select:visible').count() === 0 || await page.evaluate(() => [...document.querySelectorAll('#statusbar select')].every((s) => getComputedStyle(s).opacity === '0')), 'native selects are hidden');
check(await page.locator('#statusbar .dd-btn').count() === 2, 'two pickers: mode, and model+effort');
const rows = await page.evaluate(() => [...document.querySelectorAll('#statusbar .sb-row')].map((r) => [...r.querySelectorAll('[id]')].map((e) => e.id).join(',')));
console.log('  rows:', JSON.stringify(rows));
check(rows[0].startsWith('model,effort,modelBtn,mode') && rows[0].includes('sb-ctx') && rows[1].endsWith('sb-sid'), 'rows: model, mode, meters… / name … session id last');
check(await page.locator('header #stop, header #closeSess').count() === 0 && await page.locator('.send-group #stop').count() === 1 && await page.locator('.send-group #closeSess').count() === 1, 'Stop and Close sit next to Send');
check(await page.locator('#statusbar .dd-modepick .mode-dot').count() === 1, 'mode picker shows a coloured dot');
check(await page.locator('#modelBtn .bars > span').count() === 5 && /Opus|Sonnet|Haiku|Fable/.test(await page.locator('#modelBtn').textContent()), 'one button shows model and effort');
await page.locator('#statusbar').screenshot({ path: path.join(S, 'dd-status.png') });

// the button opens the same panel as ⌥M; → raises effort, Enter applies
const effBefore = await page.inputValue('#effort');
await page.locator('#modelBtn').click();
await page.locator('.model-pop').waitFor({ timeout: 3000 });
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
const effAfter = await page.inputValue('#effort');
console.log('  effort', effBefore, '→', effAfter);
await page.waitForFunction((v) => document.getElementById('effort').title === 'Effort: ' + v, effAfter, { timeout: 15000 }).catch(() => {});
check(effAfter !== effBefore && await page.locator('#effort').getAttribute('title') === 'Effort: ' + effAfter, 'button → panel → raises effort (confirmed by the CLI)');

// ⌥M toggles: open, then ⌥M again closes (applying ←)
await page.click('#input');
await page.keyboard.press('Alt+KeyM');
await page.locator('.model-pop').waitFor({ timeout: 3000 }).catch(() => {});
check(await page.locator('.model-pop .dd-item').count() >= 2 && await page.locator('.model-pop input[type=range]').count() === 1, '⌥M opens models + effort');
await page.screenshot({ path: path.join(S, 'dd-option-m.png') });
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('Alt+KeyM');
check(await page.locator('.model-pop').count() === 0, '⌥M again closes the panel');
await page.waitForFunction((v) => document.getElementById('effort').title === 'Effort: ' + v, effBefore, { timeout: 15000 }).catch(() => {});
check(await page.locator('#effort').getAttribute('title') === 'Effort: ' + effBefore, '… and applies the change');
await page.keyboard.press('Alt+KeyM');
await page.locator('.model-pop').waitFor({ timeout: 3000 }).catch(() => {});
await page.keyboard.press('Escape');
check(await page.locator('.model-pop').count() === 0, 'Esc closes it too');

// ⇧Tab cycles the mode
await page.click('#input');
await page.keyboard.press('Shift+Tab');
await page.getByText('permission mode → Accept edits').waitFor({ timeout: 10000 }).catch(() => {});
check(await page.inputValue('#mode') === 'acceptEdits', '⇧Tab: Ask before edits → Accept edits');
check(await page.locator('.toast').count() === 1, '⇧Tab shows a toast');
await page.keyboard.press('Shift+Tab');
await page.getByText('permission mode → Plan mode').waitFor({ timeout: 10000 }).catch(() => {});
check(await page.inputValue('#mode') === 'plan', '⇧Tab again: → Plan mode');
check(await page.evaluate(() => document.activeElement.id) === 'input', 'focus stays in the input');

// mode picker menu still works
await page.locator('#statusbar .dd-modepick').click();
await page.locator('.dd-menu .dd-item').first().waitFor({ timeout: 3000 });
await page.locator('.dd-menu .dd-item', { hasText: 'Accept edits' }).click();
await page.getByText('permission mode → Accept edits').last().waitFor({ timeout: 10000 }).catch(() => {});
check(await page.inputValue('#mode') === 'acceptEdits', 'mode menu picks Accept edits');

// clicking outside closes a menu
await page.locator('#statusbar .dd-modepick').click();
await page.locator('.dd-menu').waitFor({ timeout: 3000 });
await page.mouse.click(1300, 400);
check(await page.locator('.dd-menu').count() === 0, 'clicking outside closes the menu');

// session id toast
await page.locator('#sb-sid').click();
await page.locator('.toast', { hasText: 'Session ID copied' }).waitFor({ timeout: 3000 }).catch(() => {});
const toastText = await page.locator('.toast').allTextContents(); console.log('  toasts:', JSON.stringify(toastText)); check(toastText.includes('Session ID copied'), 'copying the session ID shows a toast');
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
check(/^[0-9a-f-]{36}$/.test(clip), 'the ID is on the clipboard');
await page.waitForTimeout(2000);
check(await page.locator('.toast').count() === 0, 'toast fades away');

// quiet meters
const m = await page.evaluate(() => ['sb-ctx', 'sb-5h', 'sb-7d'].map((id) => { const e = document.getElementById(id); return `${id}:${e.className}:${e.textContent}`; }));
console.log('  meters:', m.join(' | '));
check(!m[0].includes('/'), 'ctx shows only the percentage');
const okFill = await page.evaluate(() => getComputedStyle(document.querySelector('.sb-meter.ok .mini-fill') || document.body).backgroundColor);
console.log('  ok fill colour:', okFill);

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
