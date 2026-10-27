// The feed's layout: tool calls folded into steps groups, changed files in the turn's footer, the outline and
// ⌥↑/⌥↓, and where a question's card sits (pinned below the header's fade, gliding there, never covering).
import { PORT, startSuite, startSession, check, expectSoon, seen, wait, waitResults, turn, workDir, endSuite } from '../lib.mjs';

const WORK = workDir('layout', {
  'calc.py': 'def add(a, b):\n    return a - b\n\n\nprint(add(2, 3))\n',
  'README.md': '# demo\n\n' + 'Some text.\n'.repeat(80),
});
const suite = await startSuite(PORT, { viewport: { width: 1400, height: 600 } });
const { page } = suite;

// Where turn `i`'s question card is, against where a pinned one sits (the feed's top plus the header's fade).
const cardOffset = (i) => page.evaluate((i) => {
  const f = document.getElementById('feed');
  const fade = parseFloat(getComputedStyle(f).getPropertyValue('--fade')) || 0;
  return document.querySelectorAll('.turn-q')[i].getBoundingClientRect().top - f.getBoundingClientRect().top - fade;
}, i);
const atTop = async (i) => Math.abs(await cardOffset(i)) <= 2;
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const active = () => page.locator('#outline .ol-item.active').textContent();
const busyGone = () => page.waitForFunction(() => document.getElementById('busy').hidden, null, { timeout: 10000 });

// ---- steps groups, approvals, changed files ----
await startSession(page, WORK, 'Read calc.py and README.md, then fix the bug in calc.py with Edit, run it with Bash, and explain the fix in 3 short paragraphs.', { mode: 'default' });
check(await seen(page.locator('.approval .btns button.primary').first(), 15000)
  && await page.locator('.steps.open .tool.asking').count() >= 1, 'a pending approval opens its steps group');
check(await waitResults(page, 1, { timeout: 30000 }), 'the tool turn finished');
check(await page.locator('.turn').count() === 1, 'one turn section');
check(await page.locator('.steps').count() >= 1 && await page.locator('.steps.open').count() === 0, 'tool calls collapsed into steps groups');
check(await page.locator('.steps-list .tool').count() >= 4, 'the steps hold the tool cards');
check(await page.locator('.turn-foot .changed .file-link', { hasText: 'calc.py' }).count() === 1, 'the turn footer lists the changed file');
await page.locator('.steps-head').first().click();
check(await page.locator('.steps.open').count() === 1, 'clicking a steps line expands it');
await page.locator('.steps-head').first().click();

// ---- a new question glides to the top and holds still while its reply streams in ----
// Every frame from sending until the turn ends: never pushed above the top, never moved once there.
await page.evaluate(() => {
  const f = document.getElementById('feed');
  const want = () => f.getBoundingClientRect().top + (parseFloat(getComputedStyle(f).getPropertyValue('--fade')) || 0);
  const n = document.querySelectorAll('.turn-q').length;
  const p = window.__pin = { above: 0, settled: false, drift: 0, stop: false };
  const tick = () => {
    const q = document.querySelectorAll('.turn-q')[n];
    if (q) {
      const d = q.getBoundingClientRect().top - want();
      p.above = Math.max(p.above, -d);
      if (Math.abs(d) <= 1) p.settled = true;
      else if (p.settled) p.drift = Math.max(p.drift, Math.abs(d));
    }
    if (!p.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
check(await turn(page, 'Now write a long answer: list 40 numbered facts about the sea, one sentence each.', { timeout: 30000 }), 'the long turn finished');
await busyGone(); await frames(); // (the activity line going away must not move the card either)
{
  const p = await page.evaluate(() => { window.__pin.stop = true; return window.__pin; });
  check(p.settled && p.above <= 1 && p.drift <= 1, `the new question glides to the top and holds still while the reply streams (pushed above by ${p.above.toFixed(1)}px, moved by ${p.drift.toFixed(1)}px after settling)`);
}
check(await page.locator('.turn').count() === 2 && await page.locator('#outline .ol-item').count() === 2, 'the outline lists both turns');
await page.evaluate(() => { const f = document.getElementById('feed'); f.scrollTop = f.scrollHeight; });
await frames();
check(await cardOffset(1) <= 1, `scrolling to the end can bring the last question up to the top (${(await cardOffset(1)).toFixed(1)}px off)`);

// ---- reading a long answer: its question stays pinned, the outline follows ----
await page.evaluate(() => { const f = document.getElementById('feed'); f.scrollTop = document.querySelectorAll('.turn')[1].offsetTop + 500; });
await frames();
check(await atTop(1), `turn 2's question is pinned at the top while reading its answer (${(await cardOffset(1)).toFixed(1)}px off)`);
await expectSoon(async () => (await active()).startsWith('Now write'), 'the outline highlights the turn being read');
await page.locator('#outline .ol-item').first().click();
await expectSoon(async () => (await active()).startsWith('Read calc.py') && await atTop(0), 'clicking the outline jumps to that turn');

// ⌥↑ / ⌥↓ step through the anchors, and stop at the first and the last
await page.keyboard.press('Alt+ArrowUp');
await wait(300);
check((await active()).startsWith('Read calc.py') && await atTop(0), '⌥↑ on the first anchor stays there');
await page.keyboard.press('Alt+ArrowDown');
await expectSoon(async () => (await active()).startsWith('Now write') && await atTop(1), '⌥↓ jumps to the next anchor');
await page.keyboard.press('Alt+ArrowDown');
await wait(300);
check((await active()).startsWith('Now write') && await atTop(1), '⌥↓ on the last anchor stays there');
await page.keyboard.press('Alt+ArrowUp');
await expectSoon(async () => (await active()).startsWith('Read calc.py') && await atTop(0), '⌥↑ jumps to the previous anchor');

// The last anchor goes all the way to the top too, though there is not a screen of text below it.
await page.setViewportSize({ width: 1400, height: 1300 });
await page.locator('#outline .ol-item').last().click();
await expectSoon(() => atTop(1), 'the last anchor jumps to the very top, below the header\'s fade');
await page.setViewportSize({ width: 1400, height: 600 });

// ---- the first card at the top, and past its reply ----
// (scrolled by the wheel, as a user does: that lets go of the turn the outline pinned)
await page.locator('#feed').hover();
await page.mouse.wheel(0, -100000);
await page.waitForFunction(() => document.getElementById('feed').scrollTop === 0, null, { timeout: 5000 });
{
  const r = await page.evaluate(async () => {
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { card: document.querySelector('.turn-q').getBoundingClientRect().bottom, body: document.querySelector('.turn-body').getBoundingClientRect().top };
  });
  check(r.body - r.card >= 10, `at the top, the first question keeps its gap above the reply (card bottom ${r.card}, reply top ${r.body})`);
}
{
  const r = await page.evaluate(async () => {
    const f = document.getElementById('feed'), foot = document.querySelector('.turn-foot');
    f.scrollTop += foot.getBoundingClientRect().top - f.getBoundingClientRect().top - 20; // the footer near the top
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { card: document.querySelector('.turn-q').getBoundingClientRect().bottom, foot: foot.getBoundingClientRect().top };
  });
  check(r.card <= r.foot, `scrolled past its reply, the question card never covers the "done" line (card bottom ${r.card}, line top ${r.foot})`);
}

// ---- a short reply: the pinned question stays put when the activity line goes away ----
// The line going away in a timer task with the layout read at once makes the browser clamp the scroll before
// the blank space below is refit (the scroll event comes in the next frame).
check(await turn(page, 'Reply with just: ok', { timeout: 30000 }), 'the short turn finished');
await busyGone();
await expectSoon(() => atTop(2), 'the short reply\'s question sits at the top');
{
  const r = await page.evaluate(async () => {
    const q = [...document.querySelectorAll('.turn-q')].at(-1), f = document.getElementById('feed'), busy = document.getElementById('busy');
    const frames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const before = q.getBoundingClientRect().top;
    busy.hidden = false; await frames(); // the line is back: the feed is shorter, and so is the blank space
    await new Promise((res) => setTimeout(() => { busy.hidden = true; void f.scrollHeight; res(); }, 0));
    await frames(); await frames();
    return { before, after: q.getBoundingClientRect().top };
  });
  check(Math.abs(r.after - r.before) <= 1, `the pinned question stays put when the activity line goes away (card top ${r.before} → ${r.after})`);
}

await endSuite(suite);
