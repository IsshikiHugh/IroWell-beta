// A session's settings and life in the page, on the fake Claude: started in plan mode; mode and model switched
// from the header; / completion; an image sent and looked at; Accept edits needs no approval; rename in place;
// Esc does not interrupt; after a daemon restart a detached session is renamed, reopened from History under
// that name, and goes on with its earlier conversation.
import { PORT, startSuite, startSession, openFolderHistory, killDaemon, workDir, eventStream, check, expectSoon, until, seen, turn, endSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const WORK = workDir('modes-work', { 'calc.py': 'def add(a, b):\n    return a + b\n\n\nprint(add(2, 3))\n' });
const { client, browser, page, errors, token } = await startSuite(PORT, { viewport: { width: 1300, height: 1000 }, dialog: ({ confirm }) => confirm });
const T = eventStream(PORT, token);
const lastReply = async () => (await page.locator('.md.assistant').last().textContent()) || '';
const meta = (key, value) => T.events.some((e) => e.kind === 'meta' && e[key] === value);

// ---- a new session in plan mode ----
await startSession(page, WORK, 'Remember the codeword PELICAN.', { mode: 'plan' });
await page.locator('.meta.result').first().waitFor({ timeout: 15000 });
check(await page.inputValue('#mode') === 'plan', 'the session starts in plan mode');

// ---- mode and model switched from the header ----
await page.selectOption('#mode', 'acceptEdits');
check(await until(() => meta('mode', 'acceptEdits'), 10000) && await page.inputValue('#mode') === 'acceptEdits', 'the mode switches to Accept edits');
await page.waitForFunction(() => [...document.getElementById('model').options].some((o) => o.value === 'haiku'), null, { timeout: 10000 });
await page.selectOption('#model', 'haiku');
check(await until(() => meta('model', 'haiku'), 10000) && await page.inputValue('#model') === 'haiku', 'the model switches to Haiku');

// ---- / completion ----
await page.fill('#input', '');
await page.type('#input', '/co');
await page.locator('#popup .pop-item').first().waitFor({ timeout: 10000 });
const items = await page.locator('#popup .pop-main').allTextContents();
check(items.length > 1 && items.every((t) => t.startsWith('/co')), `the command popup filters by what was typed (${items.join(' ')})`);
await page.press('#input', 'Tab');
check(/^\/co\S* $/.test(await page.inputValue('#input')), `Tab completes the command (${JSON.stringify(await page.inputValue('#input'))})`);
await page.fill('#input', '');

// ---- an image: sent, shown under the message, previewed ----
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
check(await turn(page, 'What is in this image?', { timeout: 15000 }), 'the turn with an image finishes');
check(/got an image\/png image/.test(await lastReply()), `the image reaches Claude as an image (${JSON.stringify((await lastReply()).slice(0, 40))})`);
check(await page.locator('.turn-q .thumbs img').count() === 1, 'the image shows in the sent message');
check(await page.evaluate(() => { const q = [...document.querySelectorAll('.turn-q')].find((x) => x.querySelector('.thumbs')); return q.querySelector('.thumbs').getBoundingClientRect().top >= q.querySelector('.turn-q-text').getBoundingClientRect().bottom; }), 'the image sits below the message text');
// (once it has loaded: the server keeps the image, and the page loads it from there. The feed may still scroll as
// the answer finishes typing out, and a scroll hides the preview: then hovered again)
const thumb = page.locator('.turn-q .thumbs img').first();
check(await until(async () => {
  if (!await page.locator('.img-peek').count()) { await page.mouse.move(5, 5); await thumb.hover(); }
  return page.locator('.img-peek img').isVisible().catch(() => false);
}, 5000), 'hovering the image shows a larger preview');
await thumb.click();
check(await page.locator('.modal .modal-body.img-full img').count() === 1, 'clicking the image opens it full size');
await page.keyboard.press('Escape');
await page.mouse.move(5, 5);
check(await page.locator('.img-peek').count() === 0, 'the preview goes away when the mouse leaves');

// ---- Accept edits: an edit needs no approval ----
check(await turn(page, 'Change the print line in calc.py to print(add(4, 5)).', { approve: false, timeout: 15000 }) && await page.locator('.approval').count() === 0,
  'in Accept edits mode an edit runs without asking');
check(fs.readFileSync(path.join(WORK, 'calc.py'), 'utf8').includes('add(4, 5)'), 'the file is edited');

// ---- rename: the title is edited in place, no browser prompt ----
const before = await page.textContent('#title');
await page.hover('#title');
await expectSoon(() => page.evaluate(() => +getComputedStyle(document.querySelector('header .uline')).opacity > 0.3), 'hovering the title shows the accent line under it', 3000);
await page.click('#title');
check(await page.evaluate(() => document.activeElement?.id === 'title'), 'clicking the title puts the caret in it');
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('Never saved');
await page.keyboard.press('Escape');
check((await page.textContent('#title')) === before && await page.evaluate(() => document.activeElement?.id !== 'title'), 'Esc puts the old name back');
await page.click('#title');
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('Calc session');
await page.keyboard.press('Enter');
check(await seen(page.locator('.sess.active .t', { hasText: 'Calc session' })) && (await page.textContent('#title')) === 'Calc session' && await page.evaluate(() => document.activeElement?.id !== 'title'),
  'Enter renames in place: header and list');

// ---- Esc does not interrupt a running command (Ctrl+C does: test/suites/states.mjs) ----
let interrupts = 0;
page.on('request', (r) => { if (r.url().endsWith('/cmd') && /"type":"interrupt"/.test(r.postData() || '')) interrupts++; });
await page.fill('#input', 'Run a long command.');
await page.press('#input', 'Enter');
await page.locator('.tool.running .tool-name', { hasText: 'Bash' }).waitFor({ state: 'attached', timeout: 15000 });  // (it may sit folded in the turn's steps)
await page.locator('#feed').click({ position: { x: 5, y: 5 } }); // focus away from the input
await page.keyboard.press('Escape');
// (a request sent after the key's: an interrupt it caused would have shown before this one's answer)
await page.evaluate(() => fetch('/cmd', { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': document.querySelector('meta[name=token]').content }, body: JSON.stringify({ type: 'folders' }) }));
check(interrupts === 0 && await page.locator('.tool.running .tool-name', { hasText: 'Bash' }).count() === 1, 'Esc does not interrupt the running command');
await page.keyboard.press('Control+KeyC');
await until(() => page.locator('.meta.result', { hasText: 'stopped' }).count(), 15000, 'Ctrl+C to stop the command');

// ---- after a daemon restart: rename while detached, reopen from History, go on ----
killDaemon();
await page.waitForFunction(() => /reconnecting/.test(document.getElementById('conn').textContent), null, { timeout: 10000 }).catch(() => {});
await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
await page.locator('.sess.detached', { hasText: 'Calc session' }).first().click({ timeout: 10000 });
await page.waitForFunction(() => document.getElementById('title').textContent === 'Calc session', null, { timeout: 10000 });
// a detached session is renamed with no process to tell: its row takes the name, and so does its transcript
await page.click('#title');
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.type('Calc detached');
await page.keyboard.press('Enter');
check(await seen(page.locator('.sess.active.detached .sess-title', { hasText: 'Calc detached' })) && (await page.textContent('#title')) === 'Calc detached',
  'a detached session is renamed in place, still detached');
await openFolderHistory(page, WORK);
await page.locator('.hrow').first().waitFor({ timeout: 20000 });
await page.fill('.hfilter', 'Calc detached');
const row = page.locator('.hrow', { hasText: 'Calc detached' }).first();
check(await row.count() === 1, 'History lists the session under the name it got while detached');
await row.click();
await page.getByText('earlier conversation above').waitFor({ timeout: 30000 });
await expectSoon(async () => (await page.textContent('#title')) === 'Calc detached' && await page.locator('.sess.active:not(.detached) .sess-title', { hasText: 'Calc detached' }).count() === 1,
  'reopened, it keeps that name');
check(await page.locator('.turn-q', { hasText: 'Remember the codeword' }).count() === 1 && await page.locator('table.diff').count() >= 1, 'the reopened session shows its earlier messages and tool cards');
check(await turn(page, 'What was the codeword?', { timeout: 15000 }) && /PELICAN/.test(await lastReply()), `it goes on with its earlier conversation (${JSON.stringify((await lastReply()).slice(0, 30))})`);

T.req.destroy();
await endSuite({ browser, client, errors });
