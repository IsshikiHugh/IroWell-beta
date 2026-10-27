// Shells: the icon in the header's corner drops a terminal in the session's folder, one tab per shell; they
// outlive a reload, and closing the last one opens a fresh one.
import path from 'node:path';
import { check, wait, expectSoon, endSuite, reloadPage } from '../lib.mjs';
import { start, work, openBlank } from './_qa.mjs';

const WORK = work('shell-work');
const S = await start();
const { page, cmd } = S;
const sid = await openBlank(page, cmd, WORK);
const row = page.locator(`.folder[data-dir="${WORK}"] .sess`).first();
const screen = () => page.evaluate(() => document.querySelector('#shell .sh-term:not([hidden]) .xterm-rows')?.textContent || '');
const shells = async () => (await cmd({ type: 'shellList', sid })).data || [];
const tabs = page.locator('#shell .sh-tab');
// The screen once it has stopped changing: the login shell's prompt is up (startup files that cd elsewhere,
// e.g. a config.fish's `cd ~`, are sent back first).
async function settled() {
  let last = null;
  for (let same = 0, end = Date.now() + 10000; same < 3 && Date.now() < end; await wait(100)) { const s = await screen(); same = s && s === last ? same + 1 : 0; last = s; }
  return last;
}

const btn = await page.evaluate(() => { const b = document.getElementById('shellBtn').getBoundingClientRect(), hd = document.querySelector('header').getBoundingClientRect(); return { right: hd.right - b.right, bottom: hd.bottom - b.bottom, w: b.width, h: b.height }; });
check(await page.locator('#shellBtn').isVisible() && btn.right < btn.w && btn.bottom < btn.h, `the shell icon is in the header's bottom-right corner (${JSON.stringify(btn)})`);
await page.click('#shellBtn');
await page.locator('#shell .sh-term:not([hidden]) .xterm').waitFor({ timeout: 10000 });
check(await page.evaluate(() => { const p = document.getElementById('shell').getBoundingClientRect(), m = document.getElementById('middle').getBoundingClientRect(); return Math.abs(p.top - m.top) < 2 && p.height < m.height; }), 'the panel drops over the conversation, under the header');
await settled();
await page.keyboard.type("printf 'IRO_%s\\n' 42; printf 'DIR=%s\\n' \"$PWD\"\n");
await expectSoon(async () => { const t = await screen(); return /IRO_42/.test(t) && t.includes(`DIR=${WORK}`); }, `a shell runs commands in the session's folder (${process.env.SHELL})`, 15000);
await page.click('#shell .sh-add');
await tabs.nth(1).waitFor();
await tabs.first().click();
await tabs.locator('.sh-x').nth(1).click();
await expectSoon(async () => await tabs.count() === 1 && await page.evaluate(() => document.getElementById('shell').contains(document.activeElement)), '× on a tab closes it, and the keys go back to the shell left', 5000);
{
  const mode0 = await page.inputValue('#mode');
  await page.keyboard.press('Shift+Tab');
  await wait(300);
  check(await page.inputValue('#mode') === mode0, 'keys typed in the shell stay there (⇧Tab does not cycle the mode)');
}
await page.click('#shell .sh-add');
await expectSoon(async () => await tabs.count() === 2 && await page.locator('#shell .sh-tab.on').getAttribute('data-tid') === await tabs.nth(1).getAttribute('data-tid'),
  '+ opens a second shell in its own tab', 10000);
await tabs.first().dblclick();
await page.locator('#shell .sh-tab input').fill('build');
await page.keyboard.press('Enter');
await expectSoon(async () => (await shells()).some((t) => t.name === 'build') && await tabs.first().textContent() === 'build', 'double-clicking a tab renames the shell', 5000);
{
  // (the animation is short: caught as it starts, not read once after the press)
  const lifted = await page.locator('#shell').evaluateHandle((el) => ({ started: new Promise((ok) => {
    el.addEventListener('animationstart', (ev) => { if (ev.animationName === 'sh-lift') ok(true); });
    setTimeout(() => ok(false), 5000);
  }) }));
  await page.keyboard.press('Control+Backquote');
  check(await lifted.evaluate((l) => l.started), '⌃` folds the panel away, animated');
  await expectSoon(() => page.locator('#shell').isHidden(), '… and then it is hidden', 2000);
}
// a reload shows the shells again, with their recent output
await reloadPage(page);
await row.click();
await page.keyboard.press('Control+Backquote');
await expectSoon(async () => (await tabs.allTextContents()).join('|') === `build|${path.basename(process.env.SHELL || 'sh')} 2` && /IRO_42/.test(await screen()),
  'after a reload the shells and their output are still there', 15000);
const before = (await shells()).map((t) => t.tid);
await tabs.locator('.sh-x').first().click();
await expectSoon(async () => (await shells()).map((t) => t.tid).join() === before[1], '× closes a shell', 5000);
await tabs.locator('.sh-x').first().click();
const after = await expectSoon(async () => {
  const l = await shells();
  return l.length === 1 && !before.includes(l[0].tid) && (await tabs.evaluateAll((ts) => ts.map((t) => t.dataset.tid))).join() === l[0].tid && l;
}, 'closing the last shell opens a fresh one', 5000);
await expectSoon(async () => (await screen()).includes(path.basename(WORK)), '… in the session\'s folder, at once', 10000);
if (after) await cmd({ type: 'shellClose', sid, tid: after[0].tid });

await endSuite(S);
