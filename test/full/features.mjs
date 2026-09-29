// Feature test: modes, models, / and @ completion, images, file viewer, rename, close, history/resume, Esc.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, startSession, openFolderHistory, addFolder } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4793;
const WORK = path.join(S, 'work6');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'src'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\nprint(add(2, 3))\n');
fs.writeFileSync(path.join(WORK, 'src', 'notes.md'), '# notes\n');
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k)) delete env[k];
const killDaemon = () => { try { execSync('pkill -f "IroWell/server/daemon.mjs"'); } catch {} };
killDaemon();
await new Promise((r) => setTimeout(r, 500));

let failures = 0;
const check = (ok, what) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };
const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let promptAnswer = null;
page.on('dialog', async (d) => {
  if (d.type() === 'prompt') await d.accept(promptAnswer ?? undefined);
  else if (d.type() === 'confirm') await d.accept();
  else { console.log('ALERT:', d.message()); await d.dismiss(); }
});
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });

const results = () => page.locator('.meta.result').count();
async function turn(text, { approve = true, timeout = 180000 } = {}) {
  const before = await results();
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (approve) {
      const allow = page.locator('.approval .btns button.primary');
      if (await allow.count()) { await allow.first().click(); await page.waitForTimeout(300); }
    }
    if ((await results()) > before) return true;
    await page.waitForTimeout(200);
  }
  return false;
}
const lastReply = async () => (await page.locator('.md.assistant').last().textContent()) || '';

// ---- new session in plan mode ----
await startSession(page, WORK, 'Reply with just: ready', { mode: 'plan' });
await page.locator('.meta.result').first().waitFor({ timeout: 120000 });
check(await page.inputValue('#mode') === 'plan', 'session created in plan mode');

// ---- switch mode from the header ----
await page.selectOption('#mode', 'acceptEdits');
await page.getByText('permission mode → Accept edits').waitFor({ timeout: 10000 });
check(await page.inputValue('#mode') === 'acceptEdits', 'mode switched to Accept edits');

// ---- models ----
await page.waitForFunction(() => document.getElementById('model').options.length > 1, null, { timeout: 15000 }).catch(() => {});
const models = await page.locator('#model option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
console.log('  models:', models.join(', '));
check(models.length > 0, 'model list loaded');
const cheap = models.find((m) => /haiku/i.test(m)) || models.find((m) => /sonnet/i.test(m));
if (cheap) {
  await page.selectOption('#model', cheap);
  await page.getByText(`model → ${cheap}`).waitFor({ timeout: 10000 });
  check(true, `model switched to ${cheap}`);
}

// ---- slash command completion ----
await page.fill('#input', '');
await page.type('#input', '/conf');
await page.locator('#popup .pop-item').first().waitFor({ timeout: 10000 });
const cmdItems = await page.locator('#popup .pop-main').allTextContents();
console.log('  /conf →', cmdItems.slice(0, 5).join(' | '));
check(cmdItems.length > 0 && cmdItems.every((t) => t.startsWith('/conf')), 'slash command popup filters');
await page.press('#input', 'Enter');
check(/^\/con\S* $/.test(await page.inputValue('#input')), `Enter inserts the command (${JSON.stringify(await page.inputValue('#input'))})`);
await page.fill('#input', '');

// ---- @ file completion ----
await page.type('#input', 'look at @cal');
await page.locator('#popup .pop-item').first().waitFor({ timeout: 10000 });
check((await page.locator('#popup .pop-main').first().textContent()) === 'calc.py', '@cal suggests calc.py first');
await page.press('#input', 'Tab');
check(await page.inputValue('#input') === 'look at @calc.py ', 'Tab inserts @calc.py');
await page.fill('#input', '');
await page.type('#input', '@sr');
await page.locator('#popup .pop-main', { hasText: 'src/' }).first().waitFor({ timeout: 10000 });
await page.press('#input', 'Enter');
await page.locator('#popup .pop-main', { hasText: 'src/notes.md' }).first().waitFor({ timeout: 10000 });
check(true, 'choosing a directory lists its files');
await page.press('#input', 'Escape');
check(await page.locator('#popup').isHidden(), 'Esc closes the popup');

// ---- send with @file ----
check(await turn('Read @calc.py and reply with only the function name, one word.'), 'turn with @file finished');
check(/add/i.test(await lastReply()), `reply names the function (${JSON.stringify((await lastReply()).slice(0, 40))})`);

// ---- file viewer ----
const link = page.locator('.turn-foot .file-link, .tool .file-link:visible').first();
if (await link.count()) {
  await link.click({ modifiers: ['Meta'] });
  await page.locator('.modal .fileview .gutter').waitFor({ timeout: 10000 });
  check((await page.locator('.modal .fileview .gutter').textContent()).split('\n').length === 6, 'file viewer shows the file with line numbers');
  check(await page.locator('.modal .fileview .hljs-keyword').count() > 0, 'file viewer highlights code');
  await page.keyboard.press('Escape');
  check(await page.locator('.modal').count() === 0, 'Esc closes the file viewer');
} else console.log('  (no file card to click — Claude used @ content directly)');

// ---- image paste ----
await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ff0000'; g.fillRect(0, 0, 64, 64);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'red.png', { type: 'image/png' }));
  document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.locator('#attach .thumb img').waitFor({ timeout: 5000 });
check(true, 'pasted image shows as a thumbnail');
check(await turn('What single color fills this image? Answer with one word.'), 'turn with image finished');
check(/red/i.test(await lastReply()), `model saw the image (${JSON.stringify((await lastReply()).slice(0, 30))})`);
check(await page.locator('.turn-q .thumbs img').count() === 1, 'image shown in the sent message');

// ---- acceptEdits: an edit needs no approval ----
const approvalsBefore = await page.locator('.approval').count();
check(await turn('Use the Edit tool to change the print line in calc.py to print(add(4, 5)). Reply with just: edited', { approve: false }), 'edit turn finished without clicking anything');
check(await page.locator('.approval').count() === approvalsBefore, 'no approval asked in Accept edits mode');
check(fs.readFileSync(path.join(WORK, 'calc.py'), 'utf8').includes('add(4, 5)'), 'file edited');

// ---- rename ----
promptAnswer = 'Calc session';
await page.click('#title');
await page.locator('.sess.active .t', { hasText: 'Calc session' }).waitFor({ timeout: 10000 });
check((await page.textContent('#title')) === 'Calc session', 'rename updates header and list');

// ---- Esc interrupts ----
await page.fill('#input', 'Run this exact bash command in the foreground (do not use run_in_background): node -e "setTimeout(() => console.log(1), 60000)"');
await page.press('#input', 'Enter');
await page.locator('.tool.running .tool-name', { hasText: 'Bash' }).waitFor({ timeout: 120000 });
await page.waitForTimeout(1500);
await page.locator('#feed').click({ position: { x: 5, y: 5 } }); // focus away from the input
const tEsc = Date.now();
await page.keyboard.press('Escape');
await page.locator('.meta.result', { hasText: 'stopped' }).last().waitFor({ timeout: 20000 });
check(Date.now() - tEsc < 15000, 'Esc interrupted the running command');

// ---- restart the daemon, then reopen from History ----
killDaemon();
await page.waitForFunction(() => /reconnecting/.test(document.getElementById('conn').textContent), null, { timeout: 10000 }).catch(() => {});
await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
await page.locator('.sess').first().waitFor({ timeout: 5000 }).catch(() => {});
const afterRestart = await page.locator('.sess').evaluateAll((rows) => rows.map((r) => r.classList.contains('detached')));
check(afterRestart.length >= 1 && afterRestart.every(Boolean), `after a daemon restart the sessions stay listed, detached (${afterRestart.length})`);
await openFolderHistory(page, WORK);
await page.locator('.hrow').first().waitFor({ timeout: 20000 });
await page.fill('.hfilter', 'Calc session');
const row = page.locator('.hrow', { hasText: 'Calc session' }).first();
check(await row.count() === 1, 'History lists the renamed session');
await row.click();
await page.getByText('earlier conversation above').waitFor({ timeout: 30000 });
check(await page.locator('.turn-q', { hasText: 'Read @calc.py' }).count() === 1, 'reopened session shows earlier messages');
check(await page.locator('table.diff').count() >= 1, 'earlier tool cards re-rendered (diff)');
check(await turn('Without using any tools: what function did we look at? One word.'), 'turn in reopened session finished');
check(/add/i.test(await lastReply()), `context carried over (${JSON.stringify((await lastReply()).slice(0, 30))})`);

// ---- close ----
await page.click('#closeSess');
await page.waitForTimeout(800);
check(await page.locator('.sess.active.detached').count() === 1, 'Detach leaves the session listed as detached');

await page.screenshot({ path: path.join(S, 'features.png') });
check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
