// Browser-driven UI test: real clicks in the real page.
import { chromium } from 'playwright-core';
import { CLIENT, outDir, browserPath, cleanEnv, startSession, addFolder, killDaemon, check, finish } from '../lib.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4798;
const WORK = path.join(S, 'work3');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const env = cleanEnv();
killDaemon();
await new Promise((r) => setTimeout(r, 500));

const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1000));

const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
page.on('dialog', (d) => { console.log('ALERT:', d.message()); d.dismiss(); });
page.on('pageerror', (e) => check(false, 'page error: ' + e.message));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
check(true, 'page connects');

// a missing directory can't be added as a folder
await page.click('#addFolder');
await page.fill('.fp-input', '/nope/nope/');
await page.locator('.fp-where.err').waitFor({ timeout: 5000 });
await page.press('.fp-input', 'Meta+Enter');
await page.waitForTimeout(800);
check(await page.locator('.folder[data-dir="/nope/nope"]').count() === 0, 'a missing directory is not added');
await page.keyboard.press('Escape');
await page.locator('.modal-back').click({ position: { x: 5, y: 5 } }).catch(() => {});

// real session: + on the folder, then the first message
await startSession(page, WORK, 'Use the AskUserQuestion tool to ask me which color I prefer, with options Red and Blue. After I answer, create color.txt containing just that color, then reply with just: ok');
await page.waitForFunction(() => document.getElementById('input').value === '' && !document.querySelector('.draft-intro'), null, { timeout: 10000 }).catch(() => {});
check(await page.inputValue('#input') === '' && await page.locator('.draft-intro').count() === 0 && await page.locator('.sess.active').count() === 1, 'the draft becomes the session and the box clears');
await page.locator('.approval .q').first().waitFor({ timeout: 120000 });
await page.screenshot({ path: path.join(S, 'ui-question.png') });
// The text's place inside its option box (the feed itself may scroll meanwhile).
const blueOffset = () => page.locator('.approval label:has-text("Blue")').evaluate((lab) => {
  const a = lab.getBoundingClientRect(), b = lab.querySelector('.opt-label').getBoundingClientRect(), i = lab.querySelector('input').getBoundingClientRect();
  return [b.x - a.x, b.y - a.y, i.x - a.x, i.y - a.y, a.width, a.height].map((v) => Math.round(v * 100) / 100);
});
const before = await blueOffset();
await page.click('.approval label:has-text("Blue") input');
await page.waitForTimeout(200); // past the border transition
const after = await blueOffset();
check(before.every((v, i) => Math.abs(v - after[i]) < 0.05), `picking an option does not shift its text (${before} → ${after})`);
// Your own answer wraps and grows instead of scrolling sideways (then cleared: it would replace Blue).
const other = page.locator('.approval .other');
const oneLine = await other.evaluate((t) => t.offsetHeight);
await other.fill('a long answer of my own '.repeat(20));
await page.screenshot({ path: path.join(S, 'ui-question-own.png') });
check(await other.evaluate((t) => t.offsetHeight) > oneLine * 1.8 && await other.evaluate((t) => t.scrollWidth <= t.clientWidth), 'own answer wraps onto more lines');
await other.fill('');
await page.click('.approval label:has-text("Blue") input');
check(await page.locator('.tool.asking:has(.q) .tool-head').evaluate((hd) => { hd.click(); return !hd.closest('.tool').classList.contains('folded') && !!hd.closest('.tool').querySelector('.approval'); }), 'an open question cannot be folded');
await page.click('.approval button:has-text("Submit")');
await page.locator('.tool.answered .ask-done').waitFor({ timeout: 10000 });
const answered = page.locator('.tool.answered');
check(await answered.locator('label:has-text("Blue") input').evaluate((i) => i.checked && i.disabled)
  && await answered.locator('label:has-text("Red") input').evaluate((i) => !i.checked)
  && await answered.locator('.btns').count() === 0, 'question answered via clicks; Blue stays selected, read-only');
await page.screenshot({ path: path.join(S, 'ui-answered.png') });
await answered.locator('.tool-head').click();
await page.screenshot({ path: path.join(S, 'ui-answered-folded.png') });
check(!(await answered.locator('.approval').isVisible()), 'an answered question folds to its head');
await answered.locator('.tool-head').click();
check(await answered.locator('.approval').isVisible(), 'and unfolds again');

// Write approval (may be auto-approved by user settings)
const writeCard = page.locator('.approval', { hasText: 'Write' }).locator('button.primary');
const done = page.locator('.meta', { hasText: '✓ done' });
await Promise.race([writeCard.waitFor({ timeout: 120000 }), done.waitFor({ timeout: 120000 })]);
if (await writeCard.count()) await writeCard.click();
await done.waitFor({ timeout: 120000 });
check(fs.existsSync(path.join(WORK, 'color.txt')) && /blue/i.test(fs.readFileSync(path.join(WORK, 'color.txt'), 'utf8')), 'color.txt = Blue');

// second session, then reload: selection & history restored
await startSession(page, WORK, 'Reply with just: second');
await page.locator('.md.assistant', { hasText: 'second' }).waitFor({ timeout: 120000 });
check(await page.locator('.sess').count() === 2, 'two sessions listed');
check((await page.locator('.sess.active .t').textContent()).includes('Reply with just: second'), 'new session auto-selected');
await page.locator('.sess', { hasText: 'AskUserQuestion' }).click();
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
await page.waitForTimeout(500);
check(await page.locator('.sess').count() === 2, 'sessions survive page reload');
check(await page.locator('.tool.answered label:has-text("Blue") input:checked').count() === 1, 'history replayed after reload (answer still selected)');

// Enter sends, Shift+Enter doesn't
await page.locator('.sess', { hasText: 'second' }).click();
await page.fill('#input', 'Reply with just: third');
await page.press('#input', 'Enter');
await page.locator('.md.assistant', { hasText: 'third' }).waitFor({ timeout: 120000 });
check(await page.inputValue('#input') === '', 'Enter sends and clears input');

await page.screenshot({ path: path.join(S, 'ui-final.png') });
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: path.join(S, 'ui-dark.png') });

// transport drop is visible in the UI
process.kill(client.pid, 'SIGUSR2'); // the client drops its connection to the daemon
await page.getByText('reconnecting to local').waitFor({ timeout: 5000 });
check(await page.locator('#send').isDisabled(), 'input disabled while reconnecting');
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
check(true, 'reconnects on its own');

await browser.close();
client.kill('SIGTERM');
finish();
