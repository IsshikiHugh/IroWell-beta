// Messages sent while Claude is busy: queued (not slipped into the running turn), each its own turn
// in order, removable (back into the input), and "Send now" interrupts the turn to send one next.
import { chromium } from 'playwright-core';
import { CLIENT, outDir, browserPath, cleanEnv, startSession, killDaemon, check, finish } from '../lib.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4796;
const WORK = path.join(S, 'work-queue');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
killDaemon();
await new Promise((r) => setTimeout(r, 500));
const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });

const results = () => page.locator('.turn-foot .meta.result').count();
const questions = () => page.locator('.turn-q-text').allTextContents();
const queued = () => page.locator('#queue .q-item').count();
async function until(fn, ms = 150000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const allow = page.locator('.approval .btns button.primary');
    if (await allow.count()) await allow.first().click().catch(() => {});
    if (await fn()) return true;
    await page.waitForTimeout(300);
  }
  return false;
}
async function type(text) { // (a send waits for the server; the input clears once it is through)
  await page.fill('#input', text);
  await page.click('#send');
  await page.waitForFunction(() => !document.querySelector('#input').value, null, { timeout: 10000 });
}

// ---- 1. queued while busy, in order, one turn each ----
await startSession(page, WORK, 'Run this with Bash (not in the background): sleep 15. Then reply with just: first');
await until(async () => (await page.locator('.sess.active .dot.st-busy').count()) > 0, 20000);
await page.waitForTimeout(1500);
await type('Reply with just: second');
await type('Reply with just: third');
check(await until(async () => (await queued()) === 2, 5000), 'two messages sent during the turn are listed as queued');
check((await questions()).length === 1, 'queued messages are not put into the running turn');
await page.screenshot({ path: path.join(S, 'queue-list.png') });

await page.locator('#queue .q-item').nth(1).locator('.q-x').click();
check(await until(async () => (await queued()) === 1, 5000), '✕ takes a message off the queue');
check((await page.inputValue('#input')) === 'Reply with just: third', 'the removed message is back in the input');
await page.fill('#input', '');

check(await until(async () => (await results()) >= 2), 'the queued message runs once the turn is done');
const qs = await questions();
check(qs.length === 2 && /second/.test(qs[1]), `it is a turn of its own, after the first (${JSON.stringify(qs)})`);
check((await queued()) === 0 && await page.locator('#queue').isHidden(), 'the queue is empty and hidden again');
const texts = await page.locator('.turn').allTextContents();
check(/first/.test(texts[0].replace(qs[0], '')) && !texts[0].includes('Reply with just: second'), `the first turn has its answer and not the second message (${JSON.stringify(texts[0].slice(0, 300))})`);

// ---- 2. "Send now" interrupts the turn ----
await type('Run this with Bash (not in the background): sleep 60. Then reply with just: slow');
await until(async () => (await page.locator('.turn').count()) === 3 && (await page.locator('.sess.active .dot.st-busy').count()) > 0, 20000);
await page.waitForTimeout(3000);
await type('Reply with just: jump');
check(await until(async () => (await queued()) === 1, 5000), 'queued behind the slow turn');
const t0 = Date.now();
await page.locator('#queue .q-now').click();
check(await until(async () => (await questions()).some((q) => /jump/.test(q)), 30000), 'Send now: the message is sent without waiting for the turn');
check(Date.now() - t0 < 30000, `well before the 60 s sleep ends (${Math.round((Date.now() - t0) / 1000)} s)`);
check(await until(async () => (await results()) >= 4, 90000), 'the interrupted turn and the new one both finish');
check((await queued()) === 0, 'nothing left queued');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await page.screenshot({ path: path.join(S, 'queue-done.png') });
await browser.close();
client.kill('SIGTERM');
killDaemon();
finish();
