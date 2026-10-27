// A session's states on the page: the status dot (busy / background / idle / unseen, its rings, the logo
// that turns meanwhile), the activity line and the Tasks tab, Detach / Reattach, Ctrl+C, a daemon restart,
// and the rail's width.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, startSuite, startSession, killDaemon, check, until, wait, hold, turn, waitResults, workDir, expectSoon, command, reloadPage, eventStream, endSuite } from '../lib.mjs';

process.env.IRO_HOLD_MS = '0'; // a message goes to Claude at once: Ctrl+C stops the turn, not the held message
const WORK = workDir('work-states');
const { client, token, browser, page, errors } = await startSuite(PORT);
const T = eventStream(PORT, token);
const dotClass = () => page.locator('.sess.active .dot').getAttribute('class');
const rowDot = () => page.locator(`.folder[data-dir="${WORK}"] .sess .dot`).first().getAttribute('class');
const workRows = page.locator(`.folder[data-dir="${WORK}"] .sess`); // (this folder has just the one session)

// ---- a turn running: green dot, the activity line names the tool and counts ----
await startSession(page, WORK, 'Run a four-second command, then reply with just: done');
check((await dotClass()) === 'dot st-busy', `a working session is green (busy), a plain dot (${await dotClass()})`);
// (the row's green dot shows already for the draft's stand-in; the activity line comes with the server's session)
await expectSoon(() => page.locator('#busy').isVisible(), 'the activity line shows as soon as the turn starts', 3000);
{
  const label = await expectSoon(async () => { const l = await page.locator('#act-label').textContent(); return /^Running Bash.* · \d+s$/.test(l) && l; }, 'it names the running tool and how long it has run');
  const m1 = await page.locator('#act-meta').textContent();
  await until(async () => (await page.locator('#act-meta').textContent()) !== m1, 2500);
  const m2 = await page.locator('#act-meta').textContent();
  check(m1 !== m2 && /^\d+s$/.test(m2), `the turn's timer counts (${m1} → ${m2}; ${label})`);
  check(await until(() => T.msgs.some((m) => m.type === 'partial' && m.op === 'tick'), 4000), 'the daemon\'s heartbeat arrives while the turn runs');
}
check(await waitResults(page, 1, { timeout: 20000 }), 'the turn finishes');
const turnDone = Date.now();
check(await page.locator('#busy').waitFor({ state: 'hidden', timeout: 5000 }).then(() => true, () => false), 'the activity line goes once the session is idle');
// when each request was sent, in this computer's time, tucked under the right end of its card
const sentTime = () => page.locator('.turn .turn-time').first().evaluate((t) => {
  const q = t.closest('.turn').querySelector('.turn-q').getBoundingClientRect(), r = t.getBoundingClientRect();
  return { at: Date.parse(t.dateTime), text: t.textContent, title: t.title, gap: r.top - q.bottom, right: q.right - r.right };
});
const sent1 = await sentTime();
check(Math.abs(sent1.at - Date.now()) < 60000 && sent1.text === new Date(sent1.at).toLocaleString([], { hour: 'numeric', minute: '2-digit' }) && sent1.title,
  `a request shows when it was sent (local time today; full date on hover) (${JSON.stringify(sent1)})`);
check(sent1.gap >= 0 && sent1.gap < 10 && sent1.right > 0 && sent1.right < 30, 'the time sits just under the right end of the card');
check(await page.locator('header #sb-tokens').isVisible() && await page.locator('header #sb-cost').isVisible(), 'tokens and cost sit under the title');

// ---- a background shell runs on after the turn: one ring, the task button, the Tasks tab's badge ----
check(await turn(page, 'Start a background wait, then reply with just: started', { timeout: 20000 }), 'a turn starts a background shell');
check(await until(async () => (await dotClass()) === 'dot st-busy background', 5000), `still busy after the turn (background shell running): green, one ring (${await dotClass()})`);
const tasksBtn = page.locator('#act-tasks');
check(await tasksBtn.isVisible() && /1 background task/.test(await tasksBtn.textContent()), `the activity line stays, with the background task (${await tasksBtn.textContent()})`);
await tasksBtn.click();
check(await page.locator('#act-tasklist .act-task').count() === 1, 'its button opens the task list');
check(await page.locator('#runlist').isHidden() && await page.locator('#taskCount').isVisible() && await page.locator('#taskCount').textContent() === '1',
  `the Tasks tab (a tab, not under the anchors) counts what runs besides main (${await page.locator('#taskCount').textContent()})`);
{
  // (a user decision: rail tabs keep a fixed width; the badge sits over the tab)
  const w = await page.evaluate(() => { const b = document.querySelector('#railtabs [data-tab=tasks]'), c = document.getElementById('taskCount'), on = b.getBoundingClientRect().width;
    c.hidden = true; const off = b.getBoundingClientRect().width; c.hidden = false; return [on, off]; });
  check(w[0] === w[1], `the badge doesn't change the tab's width (${w})`);
}
await page.click('#railtabs button[data-tab="tasks"]');
check(await page.locator('#runlist .run-item .run-kind', { hasText: 'shell' }).count() === 1, 'the Tasks tab lists the background shell');
check(/running for \d/.test(await page.locator('#runlist .run-item .run-sub').nth(1).textContent()), `its timing reads "running for …" (${await page.locator('#runlist .run-item .run-sub').nth(1).textContent()})`);
check((await page.locator('#runlist .run-item').first().textContent()).startsWith('main'), 'main is always listed first');

// The sidebar is rebuilt on every update, and each new dot would start its animation over: the ring must carry
// on smoothly instead (here the list is rebuilt by opening the open session again).
{
  await page.evaluate(() => {
    const d = window.__dot = { frames: 0, rebuilt: 0, snaps: 0, stop: false };
    let el = null, prev = null;
    const tick = () => {
      const dot = document.querySelector('.sess.active .dot.background');
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
  for (let i = 0; i < 12; i++) { await page.locator('.sess.active').click(); await wait(250); }
  const d = await page.evaluate(() => { window.__dot.stop = true; return window.__dot; });
  check(d.frames > 30 && d.rebuilt >= 10 && d.snaps === 0, `the dot's ring carries on through ${d.rebuilt} sidebar rebuilds (${d.snaps} rings cut short, ${d.frames} frames)`);
}

// ---- a turn that ends while you are elsewhere: two rings on its dot until you open the session ----
// The sidebar's logo, as drawn now (it turns while some dot sends out two rings).
const brand = () => page.evaluate(() => [...document.querySelectorAll('.brand-logo svg > path')].map((p) => p.getAttribute('d')).join());
// (looked at over 0.8 s: a turn holds a shape for at most 0.5 s)
const brandMoving = async () => { const a = await brand(); await wait(400); const b = await brand(); await wait(400); return a !== b || b !== await brand(); };
async function turnWhileAway({ logo = false } = {}) {
  await page.fill('#input', 'Take a moment, then reply with just: ok');
  await page.press('#input', 'Enter');
  await page.waitForFunction(() => !document.getElementById('stop').disabled, null, { timeout: 5000 }).catch(() => {});
  await page.click(`.folder[data-dir="${WORK}"] .folder-new`);
  await page.locator('.draft-intro').waitFor({ timeout: 5000 });
  const working = await rowDot();
  await page.waitForFunction(() => document.querySelector('.sess .dot.unseen'), null, { timeout: 10000 }).catch(() => {});
  const away = await rowDot();
  const turning = logo && await brandMoving();
  await workRows.first().click();
  const back = await dotClass();
  // (the logo's turn under way ends first: within one turn, 4 s)
  const stops = logo && await until(async () => !(await brandMoving()), 6000);
  return { working, away, back, turning, stops };
}
{
  const d = await turnWhileAway({ logo: true });
  check(d.working === 'dot st-busy' && d.away === 'dot st-busy unseen' && d.back === 'dot st-busy background',
    `a turn that ended while you were away (background shell running): green with two rings, one once you open it (${JSON.stringify(d)})`);
  check(d.turning && d.stops, `while a dot sends out two rings the sidebar's logo turns, and it stops once you have opened the session (${JSON.stringify(d)})`);
  await reloadPage(page);
  await workRows.first().waitFor({ timeout: 10000 });
  await wait(300);
  check(!/unseen/.test(await rowDot()), `what you have looked at stays so over a reload (${await rowDot()})`);
  await workRows.first().click();
  await page.click('#railtabs button[data-tab="tasks"]');
  await page.locator('#runlist .run-item .run-stop').first().waitFor({ timeout: 10000 }).catch(() => {});
}

// ---- stopping the shell from the Tasks tab: yellow (idle) ----
await hold(page, page.locator('#runlist .run-item .run-stop').first());
check(await until(async () => (await dotClass()) === 'dot st-idle', 10000), `stopping it makes the session yellow (idle), a plain dot (${await dotClass()})`);
check(await page.locator('#runlist .run-item:not(.run-done)').count() === 1 && (await page.locator('#runlist .run-item').first().textContent()).includes('Idle'), 'the Tasks tab shows only "main · Idle" as running');
check(/finished · /.test(await page.locator('#runlist .run-item.run-done').first().textContent().catch(() => '')), 'the stopped shell stays listed as finished');
check(await page.locator('#taskCount').isHidden(), 'the Tasks badge is gone with nothing running besides main (finished tasks don\'t count)');
{
  const d = await turnWhileAway();
  check(d.working === 'dot st-busy' && d.away === 'dot st-idle unseen' && d.back === 'dot st-idle',
    `a turn that ended while you were away (nothing running): yellow with two rings, a plain dot once you open it (${JSON.stringify(d)})`);
}

// ---- Detach: grey, stays listed, keeps its colour; Reattach brings it back ----
await command(page, '/color green');
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#368552', null, { timeout: 10000 }).catch(() => {});
const colours = () => page.evaluate(() => ({ page: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), row: getComputedStyle(document.querySelector('.sess.active')).backgroundColor, sid: document.querySelector('#sb-sid .sid-dot')?.style.background }));
const GREEN = { page: '#368552', row: 'rgb(54, 133, 82)', sid: 'rgb(54, 133, 82)' }; // green deepened so white text reads on it
const isGreen = (c) => JSON.stringify(c) === JSON.stringify(GREEN);
// (the button is as wide as its word; the slot around it keeps its width, so the line stays put)
const detachW = await page.locator('.sess-slot').evaluate((e) => e.getBoundingClientRect().width);
const lineX = await page.locator('#stop').evaluate((e) => e.getBoundingClientRect().left);
const detached = () => until(async () => /st-detached/.test(await dotClass()), 10000);
await hold(page, '#closeSess');
check(await detached(), 'Detach turns it grey and keeps it in the list');
check(isGreen(await colours()), `a detached session keeps its colour: page, its row, the id dot (${JSON.stringify(await colours())})`);
check(!(await page.locator('#input').isDisabled()) && /reattach/i.test(await page.locator('#input').getAttribute('data-placeholder')), 'the composer stays usable while detached (sending reattaches)');
check((await page.locator('#closeSess').textContent()) === 'Reattach' && !(await page.locator('#closeSess').isDisabled()), 'the Detach button turns into Reattach');
check(await page.locator('.sess-slot').evaluate((e) => e.getBoundingClientRect().width) === detachW && await page.locator('#stop').evaluate((e) => e.getBoundingClientRect().left) === lineX
  && await page.locator('#closeSess').evaluate((e) => e.scrollWidth <= e.clientWidth), 'Detach and Reattach sit in a slot of the same width (the line does not shift), and Reattach fits its button');
await page.locator('.detached-note button', { hasText: 'Reattach' }).click();
await page.getByText('earlier conversation above').waitFor({ timeout: 15000 });
// (the sidebar is redrawn on the next animation frame, after the conversation)
check(await until(async () => !/st-detached/.test(await dotClass()) && await workRows.count() === 1, 3000), 'the note\'s Reattach brings it back (listed once)');
check(isGreen(await colours()), `and with its colour (${JSON.stringify(await colours())})`);
check((await page.locator('#closeSess').textContent()) === 'Detach', 'and the button is Detach again');
const sent2 = await sentTime();
// (the transcript has the time the CLI took the message in: after the page's clock at the send, before the turn ended)
check(sent2.at >= sent1.at - 2000 && sent2.at <= turnDone, `the earlier conversation keeps the time it was sent, not when it was reopened (${new Date(sent1.at).toISOString()} → ${new Date(sent2.at).toISOString()})`);
// Detach, then just send a message: it reattaches first
await hold(page, '#closeSess');
await detached();
check(await turn(page, 'Reply with just: back', { timeout: 20000 }), 'sending to a detached session reattaches it and runs the turn');
check(!/st-detached/.test(await dotClass()) && await workRows.count() === 1, 'it is live again (listed once)');

// ---- Ctrl+C stops a running turn, like Stop / Esc ----
await page.fill('#input', 'Run sleep 30, then reply with just: slept');
await page.press('#input', 'Enter');
check(await page.waitForFunction(() => !document.getElementById('stop').disabled, null, { timeout: 5000 }).then(() => true, () => false), 'Stop is enabled while the turn runs');
await expectSoon(() => T.msgs.some((m) => m.type === 'event' && m.kind === 'msg' && m.msg.message?.content?.some?.((b) => b.type === 'tool_use' && b.input?.command === 'sleep 30')), 'the turn is under way (its Bash started)');
const tStop = Date.now();
await page.keyboard.press('Control+c');
check(await page.waitForFunction(() => document.getElementById('stop').disabled, null, { timeout: 10000 }).then(() => true, () => false), `Ctrl+C stops the running turn (${Date.now() - tStop} ms)`);
check(await until(async () => (await dotClass()) === 'dot st-idle', 3000) && await page.locator('.detached-note').count() === 0, `and the session lives on, idle (${await dotClass()})`);

// ---- a daemon restart: still listed, detached, with its colour and conversation; sending reattaches ----
// Without recent.json (a daemon from before it existed) the session is found again from its transcript.
fs.rmSync(path.join(process.env.IRO_DIR, 'recent.json'), { force: true });
killDaemon();
await page.waitForFunction(() => /reconnecting/.test(document.getElementById('conn').textContent), null, { timeout: 10000 }).catch(() => {});
await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
await workRows.first().waitFor({ timeout: 5000 }).catch(() => {});
check(await workRows.count() === 1 && await page.locator(`.folder[data-dir="${WORK}"] .sess.detached`).count() === 1, `after a daemon restart the session is still listed, detached (${await workRows.first().textContent().catch(() => 'none')})`);
await workRows.first().click();
await page.locator('.turn-q', { hasText: 'sleep 30' }).first().waitFor({ timeout: 10000 }).catch(() => {});
check(isGreen(await colours()), `it still has its colour (${JSON.stringify(await colours())})`);
check(await page.locator('.turn-q', { hasText: 'sleep 30' }).count() >= 1, 'its earlier conversation is shown');
check(await turn(page, 'Reply with just: again', { timeout: 20000 }), 'sending to it reattaches and runs the turn');
check(!/st-detached/.test(await dotClass()) && await workRows.count() === 1, 'it is live again, listed once');
// A fresh page replays the detached copy first: it must list only the live copy, with no ghost row
await reloadPage(page);
await workRows.first().waitFor({ timeout: 10000 });
await workRows.first().click();
await wait(300);
check(await workRows.count() === 1 && await page.locator('.sess.detached').count() === 0 && !/st-detached/.test(await dotClass()),
  'after a reload the reattached session is listed once, live (no detached ghost)');

// ---- the right rail can be dragged wider, and keeps its width ----
const rw0 = await page.evaluate(() => document.getElementById('rail').offsetWidth);
const gr = await page.locator('#railResize').boundingBox();
await page.mouse.move(gr.x + 3, gr.y + 200);
await page.mouse.down();
await page.mouse.move(gr.x - 120, gr.y + 200, { steps: 5 });
await page.mouse.up();
const rw1 = await page.evaluate(() => document.getElementById('rail').offsetWidth);
check(rw1 > rw0 + 100, `dragging the rail edge widens it (${rw0} → ${rw1}px)`);
await reloadPage(page);
await workRows.first().click(); // (a fresh page opens the usage page, which hides the rail)
check(await until(async () => Math.abs((await page.evaluate(() => document.getElementById('rail').offsetWidth)) - rw1) <= 1, 3000), 'the rail\'s width is remembered');
await page.locator('#railResize').dblclick();
check(await page.evaluate(() => getComputedStyle(document.getElementById('input')).resize) === 'none', 'the input has no drag handle');
check(await page.evaluate(() => document.getElementById('feed').scrollWidth <= document.getElementById('feed').clientWidth + 1), 'no sideways scrolling in the conversation');

T.req.destroy();
await endSuite({ browser, client, errors });
