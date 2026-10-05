// Sticky question contrast, command visibility, /usage /context panels, /btw.
import { outDir, startSession, check, finish, startSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4788;
const WORK = path.join(S, 'work10');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const { client, browser, page, errors } = await startSuite(PORT, { viewport: { width: 1400, height: 800 } });

const results = () => page.locator('.turn-foot .meta.result').count();
async function waitResults(n, timeout = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if ((await results()) >= n) return true; await page.waitForTimeout(200); }
  return false;
}
async function command(text) {
  await page.fill('#input', text);
  await page.press('#input', 'Escape');
  await page.press('#input', 'Enter');
}

await startSession(page, WORK, 'Remember the codeword PELICAN. Then list 30 numbered one-sentence facts about mountains.');
check(await waitResults(1), 'first turn');

const colors = await page.evaluate(() => {
  const q = getComputedStyle(document.querySelector('.turn-q'));
  const f = getComputedStyle(document.body);
  return { q: q.backgroundColor, body: f.backgroundColor, border: q.borderLeftColor };
});
check(colors.q !== colors.body, `question bar has its own colour (${colors.q} vs page ${colors.body})`);
// a new message scrolls up to the top: its card ends up just below the header's fade, not under it
{
  await page.waitForTimeout(800); // the smooth scroll
  const g = await page.evaluate(() => {
    const head = document.querySelector('header').getBoundingClientRect().bottom;
    const fade = parseFloat(getComputedStyle(document.querySelector('header'), '::after').height);
    return { want: head + fade, card: document.querySelector('.turn-q').getBoundingClientRect().top };
  });
  check(Math.abs(g.card - g.want) <= 1, `the new message hangs right below the header's fade (card top ${g.card}, fade ends ${g.want})`);
  // the end of the feed leaves room to scroll the last question up there too
  await page.evaluate(() => { const f = document.getElementById('feed'); f.scrollTop = f.scrollHeight; });
  await page.waitForTimeout(100);
  const top = await page.evaluate(() => document.querySelector('.turn-q').getBoundingClientRect().top);
  check(top <= g.want + 1, `scrolling to the end can bring the last question up to the top (card top ${top})`);
}
// at the very top, the first card sits in its own place: sticking below the fade must not push it onto its reply
{
  const r = await page.evaluate(async () => {
    const f = document.getElementById('feed');
    f.scrollTop = 0;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { card: document.querySelector('.turn-q').getBoundingClientRect().bottom, body: document.querySelector('.turn-body').getBoundingClientRect().top };
  });
  check(r.body - r.card >= 10, `at the top, the first question keeps its gap above the reply (card bottom ${r.card}, reply top ${r.body})`);
}
// scrolled past the reply, the card is pushed up instead of covering the turn's "done" line
{
  const r = await page.evaluate(async () => {
    const f = document.getElementById('feed'), foot = document.querySelector('.turn-foot');
    f.scrollTop += foot.getBoundingClientRect().top - f.getBoundingClientRect().top - 20; // the footer near the top
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { card: document.querySelector('.turn-q').getBoundingClientRect().bottom, foot: foot.getBoundingClientRect().top };
  });
  check(r.card <= r.foot, `the question card never covers the "done" line (card bottom ${r.card}, line top ${r.foot})`);
}
await page.evaluate(() => { const f = document.getElementById('feed'); f.scrollTop = 600; });
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(S, 'f2-sticky.png') });

// ---- functional commands leave no trace in the conversation ----
const turnsBefore = await page.locator('.turn').count();
await command('/usage');
await page.locator('.modal .meter-row').first().waitFor({ timeout: 30000 }).catch(() => {});
check(await page.locator('.modal .meter-row').count() >= 1, '/usage shows meters');
check(await page.locator('.modal .plan-badge').count() === 1, '/usage shows the plan');
await page.screenshot({ path: path.join(S, 'f2-usage.png') });
await page.keyboard.press('Escape');

await command('/context');
await page.locator('.modal .ctx-bar').waitFor({ timeout: 30000 }).catch(() => {});
check(await page.locator('.modal .ctx-seg').count() >= 2, '/context shows a stacked bar');
check(await page.locator('.modal .ctx-grid .sq').count() >= 50, '/context shows the square grid');
check(await page.locator('.modal .ctx-leg').count() >= 3, '/context shows a legend');
await page.screenshot({ path: path.join(S, 'f2-context.png') });
await page.keyboard.press('Escape');

await command('/agents'); // goes to the CLI, answers with text and no model turn
await page.locator('.modal .modal-title', { hasText: '/agents' }).waitFor({ timeout: 30000 }).catch(() => {});
check(await page.locator('.modal .modal-title', { hasText: '/agents' }).count() === 1, 'CLI command output opens in a dialog');
await page.keyboard.press('Escape');
await page.waitForTimeout(1500);
check(await page.locator('.turn').count() === turnsBefore && await page.locator('#outline .ol-item').count() === turnsBefore, 'none of these commands added a turn');
check(await page.locator('.cmd-chip').count() === 0, 'no command chips in the conversation');

// ---- /btw while the main turn is running ----
// Every frame from sending until the turn ends, where the new question's card is: it glides up to the top
// once and then holds still while the reply streams in below it (never pushed up past the top, never moved).
await page.evaluate(() => {
  const head = document.querySelector('header').getBoundingClientRect().bottom;
  const want = head + parseFloat(getComputedStyle(document.querySelector('header'), '::after').height);
  const n = document.querySelectorAll('.turn-q').length;
  const p = window.__pin = { above: 0, settled: false, drift: 0, stop: false };
  const tick = () => {
    const q = document.querySelectorAll('.turn-q')[n];
    if (q) {
      const d = q.getBoundingClientRect().top - want;
      p.above = Math.max(p.above, -d);
      if (Math.abs(d) <= 1) p.settled = true;
      else if (p.settled) p.drift = Math.max(p.drift, Math.abs(d));
    }
    if (!p.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
// Meanwhile the working session's dot in the sidebar: rebuilt with the list on every update, its ring must
// carry on smoothly instead of starting over each time.
await page.evaluate(() => {
  const d = window.__dot = { frames: 0, rebuilt: 0, snaps: 0, stop: false };
  let el = null, prev = null;
  const tick = () => {
    const dot = document.querySelector('.sess.active .dot.spinning');
    if (dot) {
      if (el && dot !== el) d.rebuilt++;
      el = dot;
      const r = new DOMMatrix(getComputedStyle(dot, '::after').transform).a;
      if (prev != null && r < prev - 0.01 && prev < 2.1) d.snaps++; // the ring jumped back before reaching its end (2.2)
      prev = r; d.frames++;
    } else prev = null;
    if (!d.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
await page.fill('#input', 'Write 40 numbered one-sentence facts about rivers.');
await page.press('#input', 'Enter');
await page.locator('.md.assistant.live').waitFor({ timeout: 60000 }).catch(() => {});
await command('/btw what codeword did I ask you to remember?');
await page.locator('#btw').waitFor({ timeout: 5000 });
await page.waitForFunction(() => /PELICAN/i.test(document.querySelector('#btw .btw-body')?.textContent || ''), null, { timeout: 90000 }).catch(() => {});
check(/PELICAN/i.test(await page.locator('#btw .btw-body').textContent()), '/btw answered from the conversation');
const mainBusy = await page.evaluate(() => !document.getElementById('busy').hidden);
console.log('  main turn still running when btw answered:', mainBusy);
await page.screenshot({ path: path.join(S, 'f2-btw.png') });
check(await waitResults(2), 'main turn finished normally');
{
  await page.waitForTimeout(300); // the activity line goes away after the turn: the card must not move then either
  const p = await page.evaluate(() => { window.__pin.stop = true; return window.__pin; });
  const d = await page.evaluate(() => { window.__dot.stop = true; return window.__dot; });
  check(d.frames > 30 && d.snaps === 0, `the working dot's ring carries on through ${d.rebuilt} sidebar rebuilds (${d.snaps} rings cut short, ${d.frames} frames)`);
  check(p.settled && p.above <= 1 && p.drift <= 1, `the new question glides to the top and holds still while the reply streams (pushed above by ${p.above.toFixed(1)}px, moved by ${p.drift.toFixed(1)}px after settling)`);
}
check(await page.locator('.turn').count() === turnsBefore + 1, 'btw did not add a turn');
const lastAnswer = await page.locator('.turn').last().textContent();
check(!/codeword/i.test(lastAnswer), 'btw is not in the main conversation');
await page.locator('#btw .btw-close').click();
check(await page.locator('#btw').count() === 0, 'btw card closes');
// Reopened from the btw tab, it goes away when the page changes (Usage here; switching sessions too)
await page.locator('#railtabs [data-tab=btw]').click();
await page.locator('.btw-item').first().click();
await page.locator('#btw').waitFor({ timeout: 5000 });
await page.locator('#usageBtn').click();
check(await page.locator('#btw').count() === 0, 'btw card closes when the Usage page opens');
await page.locator('#usageBack').click();

// A short reply leaves blank space below its pinned question. The activity line going away in a timer task
// with the layout read at once makes the browser clamp the scroll before the blank space is refit (the scroll
// event comes first in the next frame): the question must stay put, not drop by the line's height.
await page.fill('#input', 'Reply with just: ok');
await page.press('#input', 'Enter');
check(await waitResults(3), 'short turn');
await page.waitForTimeout(1000);
{
  const r = await page.evaluate(async () => {
    const q = [...document.querySelectorAll('.turn-q')].at(-1), f = document.getElementById('feed'), busy = document.getElementById('busy');
    const frames = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const before = q.getBoundingClientRect().top;
    busy.hidden = false; await frames(); // the line is back: the feed is shorter, and so is the blank space
    await new Promise((res) => setTimeout(() => { busy.hidden = true; void f.scrollHeight; res(); }, 0));
    await frames(); await frames();
    return { before, after: q.getBoundingClientRect().top, line: busy.offsetHeight };
  });
  check(Math.abs(r.after - r.before) <= 1, `the pinned question stays put when the activity line goes away (card top ${r.before} → ${r.after})`);
}

// Reload: history replay must not resurrect commands either
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
await page.locator('.sess').first().click();
await page.waitForTimeout(800);
check(await page.locator('.turn').count() === turnsBefore + 2, 'after reload, still no command turns');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
finish();
