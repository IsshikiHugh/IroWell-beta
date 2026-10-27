// A session in the page, end to end on the fake Claude: a missing folder refused; a question card (bell in the
// tab's title, steady options, own answer, folding); Always allow; two sessions and a reload; Enter sends; the
// logo under the feed while Claude works; a dropped transport shown in the page.
import { PORT, startSuite, startSession, workDir, check, expectSoon, until, wait, seen, reloadPage, endSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const WORK = workDir('session-work');
const { client, browser, page, errors } = await startSuite(PORT, { viewport: { width: 1300, height: 900 }, dialog: 'dismiss' });

// ---- a missing directory can't be added as a folder ----
await page.click('#addFolder');
await page.fill('.fp-input', '/nope/nope/');
await page.locator('.fp-where.err').waitFor({ timeout: 5000 });
await page.press('.fp-input', 'Meta+Enter');
await wait(300);
check(await page.locator('.folder[data-dir="/nope/nope"]').count() === 0, 'a missing directory is not added');
await page.keyboard.press('Escape');
if (await page.locator('.modal-back').count()) await page.locator('.modal-back').click({ position: { x: 5, y: 5 } });

// ---- a question card ----
await startSession(page, WORK, 'Ask me which color I prefer, then write it to color.txt');
check(await page.inputValue('#input') === '' && await page.locator('.draft-intro').count() === 0 && await page.locator('.sess.active').count() === 1, 'the draft becomes the session and the box clears');
await page.locator('.approval .q').first().waitFor({ timeout: 15000 });
check(/^\u{1F514} IroWell at /u.test(await page.title()), `a session waiting on you puts a bell in the tab's title (${await page.title()})`);
// The text's place inside its option box (the feed itself may scroll meanwhile).
const blueOffset = () => page.locator('.approval label:has-text("Blue")').evaluate((lab) => {
  const a = lab.getBoundingClientRect(), b = lab.querySelector('.opt-label').getBoundingClientRect(), i = lab.querySelector('input').getBoundingClientRect();
  return [b.x - a.x, b.y - a.y, i.x - a.x, i.y - a.y, a.width, a.height].map((v) => Math.round(v * 100) / 100);
});
const before = await blueOffset();
await page.click('.approval label:has-text("Blue") input');
await wait(200); // past the border transition
const after = await blueOffset();
check(before.every((v, i) => Math.abs(v - after[i]) < 0.05), `picking an option does not shift its text (${before} → ${after})`);
// Your own answer wraps and grows instead of scrolling sideways (then cleared: it would replace Blue).
const other = page.locator('.approval .other');
const oneLine = await other.evaluate((t) => t.offsetHeight);
await other.fill('a long answer of my own '.repeat(20));
check(await other.evaluate((t) => t.offsetHeight) > oneLine * 1.8 && await other.evaluate((t) => t.scrollWidth <= t.clientWidth), 'own answer wraps onto more lines');
await other.fill('');
await page.click('.approval label:has-text("Blue") input');
check(await page.locator('.tool.asking:has(.q) .tool-head').evaluate((hd) => { hd.click(); return !hd.closest('.tool').classList.contains('folded') && !!hd.closest('.tool').querySelector('.approval'); }), 'an open question cannot be folded');
await page.click('.approval button:has-text("Submit")');
await page.locator('.tool.answered .ask-done').waitFor({ timeout: 10000 });
await expectSoon(() => page.evaluate(() => !document.title.includes('\u{1F514}')), 'the bell goes once the question is answered');
const answered = page.locator('.tool.answered');
check(await answered.locator('label:has-text("Blue") input').evaluate((i) => i.checked && i.disabled)
  && await answered.locator('label:has-text("Red") input').evaluate((i) => !i.checked)
  && await answered.locator('.btns').count() === 0, 'the answered question keeps Blue selected, read-only');
await answered.locator('.tool-head').click();
check(!(await answered.locator('.approval').isVisible()), 'an answered question folds to its head');
await answered.locator('.tool-head').click();
check(await answered.locator('.approval').isVisible(), 'and unfolds again');

// ---- Always allow: the Write that follows asks, the next one does not ----
const always = page.locator('.approval button', { hasText: 'Always allow' });
check(await seen(always, 15000), 'the Write asks, with Always allow offered');
await always.click();
await page.getByText('✓ always allowed').waitFor({ state: 'attached', timeout: 10000 });
await page.locator('.meta.result').first().waitFor({ timeout: 15000 });
check(fs.readFileSync(path.join(WORK, 'color.txt'), 'utf8') === 'Blue', 'the answer reached Claude: color.txt = Blue');
await page.fill('#input', 'Write b.txt');
await page.press('#input', 'Enter');
await page.locator('.meta.result').nth(1).waitFor({ timeout: 15000 });
check(await page.locator('.approval:not(:has(.q))').count() === 1 && fs.existsSync(path.join(WORK, 'b.txt')), 'the second Write is not asked again');

// ---- a second session, then a reload ----
await startSession(page, WORK, 'Reply with just: second');
// (the answer, not the block still typing it out: the two are both there for a moment, the answer hidden)
await page.locator('.md.assistant:not(.live)', { hasText: 'second' }).waitFor({ timeout: 15000 });
check(await page.locator('.sess').count() === 2, 'two sessions listed');
check((await page.locator('.sess.active .t').textContent()).includes('Reply with just: second'), 'the new session is selected');
await reloadPage(page);
await page.locator('.sess').nth(1).waitFor({ timeout: 5000 });
check(await page.locator('.sess').count() === 2, 'sessions survive a page reload');
await page.locator('.sess', { hasText: 'Ask me which color' }).click();
check(await seen(page.locator('.tool.answered label:has-text("Blue") input:checked')), 'its history is replayed after the reload (the answer still selected)');

// ---- Enter sends; the logo turns under the latest message while Claude works ----
await page.locator('.sess', { hasText: 'second' }).click();
await page.fill('#input', 'Reply with just: third');
await page.press('#input', 'Enter');
// (after the turn it is on ends it lingers up to 4 s, so a quick turn still shows it)
const thinking = await page.waitForFunction(() => document.getElementById('feed').lastElementChild?.matches('.feed-thinking:not(.idle)') && !!document.querySelector('.feed-thinking svg'), null, { timeout: 10000 }).then(() => true, () => false);
await page.locator('.md.assistant:not(.live)', { hasText: 'third' }).waitFor({ timeout: 15000 });
check(await page.inputValue('#input') === '', 'Enter sends and clears the input');
// (it hides, keeping its place: the feed does not jump)
const gone = await page.waitForFunction(() => getComputedStyle(document.querySelector('.feed-thinking')).visibility === 'hidden', null, { timeout: 10000 }).then(() => true, () => false);
check(thinking && gone, `while Claude works the logo turns under the latest message, and it hides once the turn is over (${thinking}, ${gone})`);

// ---- a dropped transport shows in the page ----
process.kill(client.pid, 'SIGUSR2'); // the client drops its connection to the daemon
await page.getByText('reconnecting to local').waitFor({ timeout: 5000 });
check(await page.locator('#send').isDisabled(), 'the input is disabled while reconnecting');
{ // (it turns at least to the end of a turn, so a quick reconnect still shows it moving; a turn holds a shape
  // for at most 0.5 s)
  const logo = () => page.evaluate(() => [...document.querySelectorAll('.brand-logo svg > path')].map((p) => p.getAttribute('d')).join());
  const a = await logo();
  check(await until(async () => await logo() !== a, 1500), 'the sidebar\'s logo turns while it reconnects');
}
check(await seen(page.locator('#conn .dot.up'), 10000), 'it reconnects on its own');

await endSuite({ browser, client, errors });
