// Session states (busy/idle/detached), Running list, Detach/Reattach, status layout, /color.
import { outDir, cleanEnv, startSession, killDaemon, check, finish, startSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4781; // not 4782: a common port for a real client
const WORK = path.join(S, 'work15');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const env = cleanEnv();
const { client, browser, page, errors } = await startSuite(PORT);
const dotClass = () => page.locator('.sess.active .dot').getAttribute('class');
async function waitResults(n) {
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const allow = page.locator('.approval .btns button.primary');
    if (await allow.count()) await allow.first().click();
    if ((await page.locator('.turn-foot .meta.result').count()) >= n) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

await startSession(page, WORK, 'Start this with Bash using run_in_background: node -e "setTimeout(() => console.log(9), 90000)". Do not wait for it. Reply with just: started');
check(/st-busy/.test(await dotClass()), 'working session is green (busy)');
check(await waitResults(1), 'turn finished');
await page.waitForTimeout(2500);
check(/st-busy/.test(await dotClass()), 'still busy after the turn: background shell running');
check(JSON.stringify(await page.locator('#railtabs button').allTextContents()).includes('Anchors') && (await page.locator('#railtabs button').allTextContents()).some((t) => t.startsWith('Tasks')), 'rail tabs: Anchors / btw / Tasks');
check(await page.locator('#runlist').isHidden(), 'Tasks pane is a tab, not stacked under the anchors');
check(await page.locator('#railtabs [data-tab=tasks] .tab-count').count() === 0, 'the Tasks tab has no badge');
await page.click('#railtabs button[data-tab="tasks"]');
check(await page.locator('#runlist .run-item .run-kind', { hasText: 'shell' }).count() === 1, 'Running list shows the background shell');
check(/running for \d/.test(await page.locator('#runlist .run-item .run-sub').nth(1).textContent()), `task timing reads "running for …" (${await page.locator('#runlist .run-item .run-sub').nth(1).textContent()})`);
check((await page.locator('#runlist .run-item').first().textContent()).startsWith('main'), 'main is always listed first');
await page.screenshot({ path: path.join(S, 'states-busy.png') });

await page.locator('#runlist .run-item .run-stop').first().click();
await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-idle'), null, { timeout: 30000 }).catch(() => {});
check(/st-idle/.test(await dotClass()), 'stopping it makes the session yellow (idle)');
check(await page.locator('#runlist .run-item:not(.run-done)').count() === 1 && (await page.locator('#runlist .run-item').first().textContent()).includes('Idle'), 'Running list shows only "main · Idle" as running');
check(/finished · /.test(await page.locator('#runlist .run-item.run-done').first().textContent().catch(() => '')), 'the stopped shell stays listed as finished');

// status line layout
const rows = await page.evaluate(() => [...document.querySelectorAll('#statusbar .sb-row')].map((r) => [...r.children].filter((c) => !c.classList.contains('dd-native')).map((c) => c.id || c.className.split(' ')[0])));
console.log('  rows:', JSON.stringify(rows));
check(rows.length === 1 && rows[0][0] === 'modelBtn' && rows[0][1] === 'dd-btn' && rows[0][2] === 'sb-ctx' && rows[0].at(-1) === 'closeSess', 'settings line: model, mode, context … Stop, Detach');
check(await page.locator('header #sb-tokens').isVisible() && await page.locator('header #sb-cost').isVisible(), 'tokens and cost sit under the title');
check(await page.locator('header #sb-dir').isVisible() && await page.locator('header #sb-sid').isVisible(), 'folder and session id under the title');
check(await page.locator('aside #sb-5h').count() === 1 && await page.locator('aside #sb-7d').count() === 1, '5-hour and weekly limits live in the sidebar usage card');

// /color
await page.fill('#input', '/color blue');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#3d78c2', null, { timeout: 10000 }).catch(() => {});
const theme = await page.evaluate(() => ({ accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), send: getComputedStyle(document.getElementById('send')).backgroundColor, q: getComputedStyle(document.querySelector('.turn-q-text'), '::before').backgroundColor }));
console.log('  theme:', JSON.stringify(theme));
check(theme.accent === '#3d78c2' && theme.send === 'rgb(61, 120, 194)' && theme.q === 'rgb(61, 120, 194)', '/color blue recolours Send and the avatar on your requests');
check(await page.locator('.turn').count() === 1, '/color adds no turn');
const side = await page.evaluate(() => ({ accent: getComputedStyle(document.querySelector('aside')).getPropertyValue('--accent').trim(), base: getComputedStyle(document.documentElement).getPropertyValue('--base-accent').trim(), row: getComputedStyle(document.querySelector('.sess.active')).backgroundColor }));
check(side.accent === side.base && side.row === 'rgb(61, 120, 194)', `the sidebar ignores the page colour; the open session's row is filled with its own colour (${JSON.stringify(side)})`);
await page.screenshot({ path: path.join(S, 'states-color.png') });
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
await page.waitForTimeout(800);
await page.locator('.sess').first().click();
check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#3d78c2', 'colour survives a reload');
await page.fill('#input', '/color default');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForTimeout(1000);
check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) !== '#3d78c2', '/color default resets it');

// Detach → grey, stays listed; Reattach. The session's /color survives all of it.
await page.fill('#input', '/color green');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#368552', null, { timeout: 10000 }).catch(() => {});
const colours = () => page.evaluate(() => ({ page: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), row: getComputedStyle(document.querySelector('.sess.active')).backgroundColor, sid: document.querySelector('#sb-sid .sid-dot')?.style.background }));
const GREEN = { page: '#368552', row: 'rgb(54, 133, 82)', sid: 'rgb(54, 133, 82)' }; // green deepened so white text reads on it
const isGreen = (c) => JSON.stringify(c) === JSON.stringify(GREEN);
const detachW = await page.locator('#closeSess').evaluate((e) => e.getBoundingClientRect().width);
const lineX = await page.locator('#stop').evaluate((e) => e.getBoundingClientRect().left);
await page.click('#closeSess');
await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-detached'), null, { timeout: 15000 }).catch(() => {});
check(/st-detached/.test(await dotClass()), 'Detach turns it grey and keeps it in the list');
const cDetached = await colours();
check(isGreen(cDetached), `a detached session keeps its colour: page, its row, the id dot (${JSON.stringify(cDetached)})`);
check(!(await page.locator('#input').isDisabled()) && /reattach/i.test(await page.locator('#input').getAttribute('data-placeholder')), 'composer stays usable while detached (sending reattaches)');
check((await page.locator('#closeSess').textContent()) === 'Reattach' && !(await page.locator('#closeSess').isDisabled()), 'the Detach button turns into Reattach');
check(await page.locator('#closeSess').evaluate((e) => e.getBoundingClientRect().width) === detachW && await page.locator('#stop').evaluate((e) => e.getBoundingClientRect().left) === lineX, 'Detach and Reattach have the same width (the line does not shift)');
check(await page.locator('#closeSess').evaluate((e) => e.scrollWidth <= e.clientWidth), 'Reattach fits its button');
check(await page.locator('.detached-note button', { hasText: 'Reattach' }).count() === 1, 'a Reattach button is offered');
await page.screenshot({ path: path.join(S, 'states-detached.png') });
await page.locator('.detached-note button', { hasText: 'Reattach' }).click();
await page.getByText('earlier conversation above').waitFor({ timeout: 30000 });
// the sidebar is redrawn on the next animation frame, after the conversation
await page.waitForFunction(() => document.querySelectorAll('.sess').length === 1 && !document.querySelector('.sess.active .st-detached'), null, { timeout: 2000 }).catch(() => {});
check(!/st-detached/.test(await dotClass()) && await page.locator('.sess').count() === 1, 'Reattach brings it back (listed once)');
const cBack = await colours();
check(isGreen(cBack), `and with its colour (${JSON.stringify(cBack)})`);
check((await page.locator('#closeSess').textContent()) === 'Detach', 'and the button is Detach again');
// Detach (confirmed), then just send a message: it reattaches first
await page.click('#closeSess');
await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-detached'), null, { timeout: 15000 }).catch(() => {});
const results0 = await page.locator('.turn-foot .meta.result').count();
await page.fill('#input', 'Without using any tools, reply with just: back');
await page.press('#input', 'Enter');
check(await waitResults(results0 + 1), 'sending to a detached session reattaches it and runs the turn');
check(!/st-detached/.test(await dotClass()) && await page.locator('.sess').count() === 1, 'it is live again (listed once)');
// Ctrl+C stops a running turn, like Stop / Esc
await page.fill('#input', 'Use Bash to run: sleep 40. Then reply with just: slept');
await page.press('#input', 'Enter');
await page.waitForFunction(() => !document.getElementById('stop').disabled, null, { timeout: 30000 }).catch(() => {});
check(!(await page.locator('#stop').isDisabled()), 'Stop is enabled while the turn runs');
const tStop = Date.now();
await page.keyboard.press('Control+c');
await page.waitForFunction(() => document.getElementById('stop').disabled, null, { timeout: 15000 }).catch(() => {});
check(await page.locator('#stop').isDisabled() && Date.now() - tStop < 15000, `Ctrl+C stops the running turn (${Date.now() - tStop}ms)`);

// The session outlives a daemon restart: listed as detached, earlier conversation readable, sending reattaches
const title = await page.locator('.sess.active .sess-title').textContent();
const workRows = page.locator(`.folder[data-dir="${fs.realpathSync(WORK)}"] .sess`); // its folder has just this session (the title may be Claude's own after a restart)
// Without recent.json (a daemon from before it existed) the session is found again from its transcript.
fs.rmSync(path.join(process.env.IRO_DIR, 'recent.json'), { force: true });
killDaemon();
await page.waitForFunction(() => /reconnecting/.test(document.getElementById('conn').textContent), null, { timeout: 10000 }).catch(() => {});
await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
await workRows.first().waitFor({ timeout: 5000 }).catch(() => {});
check(await workRows.count() === 1 && await page.locator(`.folder[data-dir="${fs.realpathSync(WORK)}"] .sess.detached`).count() === 1, `after a daemon restart the session is still listed, detached (${await workRows.first().textContent().catch(() => 'none')})`);
await workRows.first().click();
await page.waitForTimeout(300);
const cRestart = await colours();
check(isGreen(cRestart), `after a daemon restart it still has its colour (${JSON.stringify(cRestart)})`);
await page.locator('.turn-q', { hasText: 'sleep 40' }).first().waitFor({ timeout: 15000 }).catch(() => {});
check(await page.locator('.turn-q', { hasText: 'sleep 40' }).count() >= 1, 'its earlier conversation is shown');
const results1 = await page.locator('.turn-foot .meta.result').count();
await page.fill('#input', 'Without using any tools, reply with just: again');
await page.press('#input', 'Enter');
check(await waitResults(results1 + 1), 'sending to it reattaches and runs the turn');
check(!/st-detached/.test(await dotClass()) && await workRows.count() === 1, 'it is live again, listed once');
// A fresh page replays the detached copy first: it must list only the live copy, with no ghost row
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
await page.waitForTimeout(800);
await workRows.first().click();
check(await workRows.count() === 1 && await page.locator('.sess.detached').count() === 0 && !/st-detached/.test(await dotClass()),
  'after a reload the reattached session is listed once, live (no detached ghost)');

// the composer is a pill with the send button inside it
const pill = await page.evaluate(() => {
  const w = document.querySelector('.input-wrap').getBoundingClientRect(), s = document.getElementById('send').getBoundingClientRect();
  return { h: Math.round(w.height), radius: getComputedStyle(document.querySelector('.input-wrap')).borderRadius, sendInside: s.right <= w.right && s.bottom <= w.bottom };
});
console.log('  pill:', JSON.stringify(pill));
check(pill.sendInside && pill.radius === '24px' && pill.h < 70, 'one line: a pill with the send button inside it');
// the right rail can be dragged wider, and keeps its width
const rw0 = await page.evaluate(() => document.getElementById('rail').offsetWidth);
const gr = await page.locator('#railResize').boundingBox();
await page.mouse.move(gr.x + 3, gr.y + 200);
await page.mouse.down();
await page.mouse.move(gr.x - 120, gr.y + 200, { steps: 5 });
await page.mouse.up();
const rw1 = await page.evaluate(() => document.getElementById('rail').offsetWidth);
check(rw1 > rw0 + 100, `dragging the rail edge widens it (${rw0} → ${rw1}px)`);
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
await page.locator('.sess:not(.detached)').first().click(); // (a fresh page opens the usage page, which hides the rail)
check(Math.abs((await page.evaluate(() => document.getElementById('rail').offsetWidth)) - rw1) <= 1, 'rail width is remembered');
await page.locator('#railResize').dblclick();
await page.locator('.sess:not(.detached)').first().click();
await page.waitForTimeout(500);

// the input grows with its text, then offers a half-screen editor
const h0 = await page.evaluate(() => document.getElementById('input').offsetHeight);
await page.fill('#input', 'line\n'.repeat(4));
const h1 = await page.evaluate(() => document.getElementById('input').offsetHeight);
check(h1 > h0, `input grows with its text (${h0}px → ${h1}px)`);
check(await page.evaluate(() => getComputedStyle(document.getElementById('input')).resize) === 'none', 'no drag handle');
await page.fill('#input', 'line\n'.repeat(60));
check(await page.locator('#expandInput').isVisible(), 'a long text shows the expand arrow');
await page.click('#expandInput');
const h2 = await page.evaluate(() => document.getElementById('input').offsetHeight / window.innerHeight);
check(h2 > 0.45, `expanded to about half the screen (${Math.round(h2 * 100)}%)`);
await page.fill('#input', '');
check(await page.evaluate(() => document.getElementById('feed').scrollWidth <= document.getElementById('feed').clientWidth + 1), 'no sideways scrolling in the conversation');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
finish();
