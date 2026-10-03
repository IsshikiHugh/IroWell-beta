// Composer history/ghost suggestions and multi-turn /btw with a history tab.
import { outDir, cleanEnv, startSession, openFolderHistory, killDaemon, check, finish, startSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4786;
const WORK = path.join(S, 'work11');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const env = cleanEnv();
try { fs.rmSync(path.join(process.env.IRO_DIR, 'btw.json')); } catch {}
const { client, browser, page, errors } = await startSuite(PORT);
await page.evaluate(() => localStorage.removeItem('iro-input-history'));
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });

const results = () => page.locator('.turn-foot .meta.result').count();
async function waitResults(n, timeout = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if ((await results()) >= n) return true; await page.waitForTimeout(200); }
  return false;
}
async function say(text, n) {
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
  return waitResults(n);
}
const ghost = () => page.locator('#ghost .g').textContent();

await startSession(page, WORK, 'Remember the codeword PELICAN. Reply with just: ok');
check(await waitResults(1), 'first turn');
check(await say('What is 2+2? Reply with just the number.', 2), 'second turn');
check(await say('What is 3+3? Reply with just the number.', 3), 'third turn');

// ---- history with ↑/↓ ----
await page.click('#input');
await page.keyboard.type('draft text');
await page.keyboard.press('ArrowUp');
check(await page.inputValue('#input') === 'What is 3+3? Reply with just the number.', '↑ recalls the last message');
await page.keyboard.press('ArrowUp');
check(await page.inputValue('#input') === 'What is 2+2? Reply with just the number.', '↑ again goes further back');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
check(await page.inputValue('#input') === 'draft text', '↓ past the newest restores the draft');

// ---- inline suggestion from history, → accepts ----
await page.fill('#input', '');
await page.keyboard.type('What is 2');
check((await ghost()) === '+2? Reply with just the number.', `grey completion from history (${JSON.stringify(await ghost())})`);
await page.keyboard.press('ArrowRight');
check(await page.inputValue('#input') === 'What is 2+2? Reply with just the number.', '→ accepts it');
await page.fill('#input', '');

// ---- predicted next prompt when the box is empty ----
check(await say('Write a Python function is_prime(n) in a code block, nothing else. Do not create files.', 4), 'fourth turn');
await page.click('#input');
await page.waitForFunction(() => (document.querySelector('#ghost .g')?.textContent || '').length > 0, null, { timeout: 8000 }).catch(() => {});
const predicted = await ghost();
console.log('  predicted next prompt:', JSON.stringify(predicted));
// The small model may honestly have no suggestion ('-'), so this is reported, not required.
console.log(predicted ? 'INFO predicted next prompt shown' : 'INFO no predicted prompt this time');
if (predicted) {
  await page.keyboard.press('Tab');
  check((await page.inputValue('#input')) === predicted, 'Tab accepts the predicted prompt');
  await page.fill('#input', '');
}

// ---- /btw with follow-ups ----
const turns = await page.locator('.turn').count();
await page.fill('#input', '/btw what codeword did I give you?');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('#btw .btw-answer:not(.live)').length >= 1, null, { timeout: 90000 });
check(/PELICAN/i.test(await page.locator('#btw .btw-answer').last().textContent()), 'btw answers');
await page.fill('#btw .btw-input', 'Spell it backwards, letters only.');
await page.press('#btw .btw-input', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('#btw .btw-answer:not(.live)').length >= 2, null, { timeout: 90000 });
check(/NACILEP/i.test((await page.locator('#btw .btw-answer').last().textContent()).replace(/[^A-Za-z]/g, '')), 'follow-up keeps the thread (spelled backwards)');
check(await page.locator('.turn').count() === turns, 'btw stays out of the conversation');
await page.waitForTimeout(1500);
console.log('  daemon has:', JSON.stringify(await page.evaluate(async () => {
  const t = document.querySelector('meta[name=token]').content;
  const sid = null;
  return 'n/a';
})));
console.log('  ui answers:', JSON.stringify(await page.locator('#btw .btw-body > *').evaluateAll((els) => els.map((e) => e.className + ':' + e.textContent.slice(0, 30)))));
await page.screenshot({ path: path.join(S, 'btw-thread.png') });
await page.locator('#btw .btw-head button').click();

await page.click('#railtabs button[data-tab="btw"]');
await page.locator('#btwlist .btw-item').first().waitFor({ timeout: 10000 });
check((await page.locator('#btwlist .btw-item').count()) === 1 && /2 exchanges/.test(await page.locator('#btwlist .btw-item .m').textContent()), 'btw tab lists the thread with 2 exchanges');
await page.locator('#btwlist .btw-item').first().click();
check(await page.locator('#btw .btw-user').count() === 2 && await page.locator('#btw .btw-answer').count() === 2, 'clicking reopens the whole thread');
await page.screenshot({ path: path.join(S, 'btw-tab.png') });

// ---- after a daemon restart the thread is still there and can continue ----
await page.locator('#btw .btw-head button').click();
killDaemon();
await page.getByText('reconnecting to local').waitFor({ timeout: 20000 });
await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
await page.waitForTimeout(1000);
await openFolderHistory(page, WORK);
await page.locator('.hrow').first().waitFor({ timeout: 20000 });
await page.locator('.hrow', { hasText: 'codeword' }).first().click();
await page.getByText('earlier conversation above').waitFor({ timeout: 30000 });
await page.locator('#btwlist .btw-item').first().waitFor({ timeout: 10000 });
check(await page.locator('#btwlist .btw-item').count() === 1, 'thread survives a daemon restart');
await page.locator('#btwlist .btw-item').first().click();
await page.fill('#btw .btw-input', 'What did you answer to my previous side question? Quote it.');
await page.click('#btw .btw-send'); // the pill's send button
await page.waitForFunction(() => document.querySelectorAll('#btw .btw-answer:not(.live)').length >= 3, null, { timeout: 90000 });
check(/NACILEP/i.test((await page.locator('#btw .btw-answer').last().textContent()).replace(/[^A-Za-z]/g, '')), 'continuing after restart still knows the thread');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
finish();
