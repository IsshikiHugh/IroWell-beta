// Messages sent while Claude is busy: queued (not slipped into the running turn), each its own turn
// in order, removable (back into the input), and "Send now" interrupts the turn to send one next.
import { outDir, startSession, killDaemon, check, finish, startSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4796;
const WORK = path.join(S, 'work-queue');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const { client, browser, page, errors } = await startSuite(PORT, { dialog: 'dismiss' });

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

// another session in the folder, idle, to switch to while the busy one has a queue
await startSession(page, WORK, 'Reply with just: other');
await until(async () => (await results()) >= 1, 60000);
const otherTitle = await page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);

// ---- 1. queued while busy, in order, one turn each ----
await startSession(page, WORK, 'Run this with Bash (not in the background): sleep 15. Then reply with just: first');
await until(async () => (await page.locator('.sess.active .dot.st-busy').count()) > 0, 20000);
await page.waitForTimeout(1500);
await type('Reply with just: second');
await type('Reply with just: third');
await type('Reply with just: fourth');
check(await until(async () => (await queued()) === 3, 5000), 'three messages sent during the turn are listed as queued');
check((await questions()).length === 1, 'queued messages are not put into the running turn');
await page.screenshot({ path: path.join(S, 'queue-list.png') });

// the queue belongs to its session: another one (here a new draft) does not show it; back, it is there
{
  const FOLDER = `.folder[data-dir="${fs.realpathSync(WORK)}"]`;
  const busySid = await page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);
  await page.locator(`${FOLDER} .folder-head`).hover();
  await page.click(`${FOLDER} .folder-new`);
  await page.locator('.draft-intro').waitFor({ timeout: 5000 });
  check(await page.locator('#queue').isHidden() && (await queued()) === 0, 'another session does not show this one\'s queue');
  await page.locator('.sess', { hasText: otherTitle }).click();
  await page.waitForTimeout(500);
  check(await page.locator('#queue').isHidden() && (await queued()) === 0, 'nor does another live session');
  await page.click('#closeSess');
  await page.locator('.sess.active .dot.st-detached').waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);
  check(await page.locator('#queue').isHidden() && (await queued()) === 0, 'nor a detached one');
  await page.locator('.sess', { hasText: busySid }).click();
  check(await until(async () => (await queued()) === 3, 5000), 'back in the session, its queue is still there');
}

await page.fill('#input', 'half typed');
await page.locator('#queue .q-item').nth(1).locator('.q-x').click();
check(await until(async () => (await queued()) === 2, 5000), '✕ takes a message off the queue');
check((await page.inputValue('#input')) === 'half typed\n\nReply with just: third', `the removed message is back in the input, after what was there (${JSON.stringify(await page.inputValue('#input'))})`);
await page.fill('#input', '');

// (the CLI reports idle only after the result: that late idle must not hand the CLI the next queued
// message while the one sent at the result is still running)
check(await until(async () => (await results()) >= 3), 'the queued messages run once the turn is done');
const qs = await questions();
check(qs.length === 3 && /second/.test(qs[1]) && /fourth/.test(qs[2]), `each is a turn of its own, in order (${JSON.stringify(qs)})`);
{
  const t = await page.locator('.turn').allTextContents();
  check(!t[1].replace(qs[1], '').includes('fourth') && /fourth/.test(t[2].replace(qs[2], '')), `the second turn answers only the second message (${JSON.stringify(t.slice(1).map((x) => x.slice(0, 200)))})`);
}
check((await queued()) === 0 && await page.locator('#queue').isHidden(), 'the queue is empty and hidden again');
const texts = await page.locator('.turn').allTextContents();
check(/first/.test(texts[0].replace(qs[0], '')) && !texts[0].includes('Reply with just: second'), `the first turn has its answer and not the second message (${JSON.stringify(texts[0].slice(0, 300))})`);

// ---- 2. "Send now" interrupts the turn ----
await type('Run this with Bash (not in the background): sleep 60. Then reply with just: slow');
await until(async () => (await page.locator('.turn').count()) === 4 && (await page.locator('.sess.active .dot.st-busy').count()) > 0, 20000);
await page.waitForTimeout(3000);
await type('Reply with just: jump');
check(await until(async () => (await queued()) === 1, 5000), 'queued behind the slow turn');
const t0 = Date.now();
await page.locator('#queue .q-now').click();
check(await until(async () => (await questions()).some((q) => /jump/.test(q)), 30000), 'Send now: the message is sent without waiting for the turn');
check(Date.now() - t0 < 30000, `well before the 60 s sleep ends (${Math.round((Date.now() - t0) / 1000)} s)`);
check(await until(async () => (await results()) >= 5, 90000), 'the interrupted turn and the new one both finish');
check((await queued()) === 0, 'nothing left queued');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await page.screenshot({ path: path.join(S, 'queue-done.png') });
await browser.close();
client.kill('SIGTERM');
killDaemon();
finish();
