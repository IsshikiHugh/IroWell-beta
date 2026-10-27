// Messages sent while Claude is busy: queued (not slipped into the running turn), per session, each its own
// turn in order, removable (back into the input); "Send now" interrupts the turn to send one next; a /branch
// typed during a turn waits its turn too. (A queued /clear and /detach, and the held message: test/suites/turns.mjs.)
// A busy turn here waits for a file the suite creates (queue.fake.mjs), so nothing depends on how long it runs.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, startSuite, startSession, check, until, hold, waitResults, workDir, endSuite } from '../lib.mjs';

process.env.IRO_HOLD_MS = '0'; // (the held moment is test/suites/turns.mjs's)
const WORK = workDir('work-queue');
const FOLDER = `.folder[data-dir="${WORK}"]`;
const { client, browser, page, errors } = await startSuite(PORT, { dialog: 'dismiss' });

const results = () => page.locator('.turn-foot .meta.result').count();
const questions = () => page.locator('.turn-q-text').allTextContents();
const queued = () => page.locator('#queue .q-item').count();
const active = () => page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);
const busy = () => until(async () => (await page.locator('.sess.active .dot.st-busy').count()) > 0, 5000);
const release = (gate) => fs.writeFileSync(path.join(WORK, gate), '');
async function type(text) { // (a send waits for the server; the input clears once it is through)
  await page.fill('#input', text);
  await page.click('#send');
  await page.waitForFunction(() => !document.querySelector('#input').value, null, { timeout: 10000 });
}

// another session in the folder, idle, to switch to while the busy one has a queue
await startSession(page, WORK, 'Reply with just: other');
await waitResults(page, 1, { timeout: 10000 });
const otherTitle = await active();

// ---- queued while busy, in order, one turn each ----
await startSession(page, WORK, 'Wait for gate1. Then reply with just: first');
await busy();
const busyTitle = await active();
await type('Reply with just: second');
await type('Reply with just: third');
await type('Reply with just: fourth');
check(await until(async () => (await queued()) === 3, 5000), 'three messages sent during the turn are listed as queued');
check((await questions()).length === 1, 'queued messages are not put into the running turn');

// the queue belongs to its session: another one (a new draft, a live one, a detached one) does not show it
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-new`);
await page.locator('.draft-intro').waitFor({ timeout: 5000 });
check(await page.locator('#queue').isHidden() && (await queued()) === 0, 'a draft does not show another session\'s queue');
await page.locator('.sess', { hasText: otherTitle }).click();
await until(async () => (await active()) === otherTitle, 3000);
check(await page.locator('#queue').isHidden() && (await queued()) === 0, 'nor does another live session');
await hold(page, '#closeSess');
await page.locator('.sess.active .dot.st-detached').waitFor({ timeout: 10000 }).catch(() => {});
check(await page.locator('#queue').isHidden() && (await queued()) === 0, 'nor a detached one');
await page.locator('.sess', { hasText: busyTitle }).click();
check(await until(async () => (await queued()) === 3, 5000), 'back in the session, its queue is still there');

await page.fill('#input', 'half typed');
await page.locator('#queue .q-item').nth(1).locator('.q-x').click();
check(await until(async () => (await queued()) === 2, 5000), '✕ takes a message off the queue');
check((await page.inputValue('#input')) === 'half typed\n\nReply with just: third', `the removed message is back in the input, after what was there (${JSON.stringify(await page.inputValue('#input'))})`);
await page.fill('#input', '');

// (the CLI reports idle only after the result: that late idle must not hand the CLI the next queued
// message while the one sent at the result is still running)
release('gate1');
check(await waitResults(page, 3, { timeout: 15000, approve: false }), 'the queued messages run once the turn is done');
const qs = await questions();
check(qs.length === 3 && /second/.test(qs[1]) && /fourth/.test(qs[2]), `each is a turn of its own, in order (${JSON.stringify(qs)})`);
{
  const t = await page.locator('.turn').allTextContents();
  check(/first/.test(t[0].replace(qs[0], '')) && !t[0].includes('Reply with just: second'), `the first turn has its answer and not the second message (${JSON.stringify(t[0].slice(0, 300))})`);
  check(!t[1].replace(qs[1], '').includes('fourth') && /fourth/.test(t[2].replace(qs[2], '')), `the second turn answers only the second message (${JSON.stringify(t.slice(1).map((x) => x.slice(0, 200)))})`);
}
check((await queued()) === 0 && await page.locator('#queue').isHidden(), 'the queue is empty and hidden again');

// ---- "Send now" interrupts the turn (one that would never end by itself) ----
await type('Wait for gate-never. Then reply with just: slow');
await until(async () => (await page.locator('.turn').count()) === 4, 5000);
await busy();
await type('Reply with just: jump');
check(await until(async () => (await queued()) === 1, 5000), 'queued behind the running turn');
await page.locator('#queue .q-now').click();
check(await until(async () => (await questions()).some((q) => /jump/.test(q)), 10000), 'Send now: the message is sent without waiting for the turn to end');
check(await waitResults(page, 5, { timeout: 15000, approve: false }), 'the interrupted turn and the new one both finish');
check((await queued()) === 0, 'nothing left queued');

// ---- a /branch typed during a turn waits for it, then opens the branch as it was at that point ----
{
  const source = await active();
  await type('Wait for gate3. Then reply with just: sixth');
  await busy();
  await type('/branch side');
  await type('Reply with just: seventh');
  check(await until(async () => (await queued()) === 2, 5000) && (await active()) === source && !(await page.locator('.sess-title').allTextContents()).includes('side'),
    `typed during a turn, the /branch is listed in the queue and nothing has happened yet (${JSON.stringify(await page.locator('#queue .q-text').allTextContents())})`);
  release('gate3');
  check(await until(async () => (await active()) === 'side', 15000), 'the queued /branch runs once the turn is over, and the branch opens');
  await page.waitForFunction(() => /branched/.test(document.getElementById('feed').textContent), null, { timeout: 10000 }).catch(() => {});
  const bq = await questions();
  check(/sixth/.test(bq.at(-1)) && /first/.test(bq[0]) && !bq.some((q) => /seventh/.test(q)), `the branch has the conversation up to that turn, and nothing after it (${JSON.stringify(bq)})`);
  await page.locator('.sess', { hasText: source }).first().click();
  check(await until(async () => /seventh/.test((await questions()).at(-1) || '') && (await page.locator('.turn').allTextContents()).at(-1).replace((await questions()).at(-1), '').includes('seventh'), 15000),
    'the message behind it goes on in the original session, answered');
}

await endSuite({ browser, client, errors });
