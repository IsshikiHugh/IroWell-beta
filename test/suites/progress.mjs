// The progress list (irowell:progress): a session starts one with the skill's script; from then on it sits at the
// rail's foot, the user edits it there, and the script reports what they changed. The script runs here as the
// session's Bash runs it: the session's Claude session id (from its first turn, on the fake) and a live CLI's pid
// in its environment.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, PORT, check, until, wait, expectSoon, startSuite, addFolder, workDir, logNow, reloadPage, endSuite } from '../lib.mjs';
import { rpcOf, stageFeed, sidePage, blankSession } from './_qc.mjs';

process.env.IRO_HOLD_MS = '0'; // (a message goes at once: the hold before it is the turns suite's)
const WORK = workDir('progress-work');
const api = await startSuite(PORT);
const { page, errors, token } = api;
const rpc = rpcOf(api);
await stageFeed(page.context());
await reloadPage(page); // (so this page has __iroFeed too)
await addFolder(page, WORK);
// another page, on another session: the list is only for the session it belongs to
const other = await sidePage(page, errors);
await blankSession(rpc, WORK, 'another task', other);

const sid = await blankSession(rpc, WORK, 'long task', page);
// The session's first turn tells the page its Claude session id, and the page asks for its list (none yet: that
// answer must not land after the first add's).
const asked = page.waitForResponse((r) => r.url().endsWith('/cmd') && JSON.parse(r.request().postData() || '{}').type === 'progress', { timeout: 10000 }).catch(() => {});
await rpc({ type: 'send', sid, text: 'hello' });
const ID = await expectSoon(async () => (await logNow(PORT, token)).find((e) => e.sid === sid && e.kind === 'init')?.claudeSessionId, 'the session has its Claude session id');
await asked;

// (CLAUDE_PID: a CLI that runs, as a live session's Bash tool has it; without one every daemon here lists the script as left running)
const cli = (...args) => {
  try { return execFileSync(process.execPath, [path.join(REPO, 'skills', 'progress', 'progress.mjs'), ...args], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: ID, CLAUDE_PID: String(process.pid) }, stdio: 'pipe' }).toString(); }
  catch (e) { return String(e.stdout) + String(e.stderr); }
};
const items = () => page.evaluate(() => [...document.querySelectorAll('#progress .pg-item')].map((r) => `${r.className.replace('pg-item ', '')}:${r.querySelector('.pg-text').textContent}`).join(' | '));
const item = (text) => page.locator('#progress .pg-item', { hasText: text });
const listOnServer = async () => (await rpc({ type: 'progress', claudeSessionId: ID })).data;

check(/no progress list yet/.test(cli()), 'progress: a session has no list until it starts one');
check((await rpc({ type: 'progressCli', session: ID, op: 'add', texts: ['x'] })).status === 400, 'the page can\'t write to a list as the session');
check(/no progress list/.test((await rpc({ type: 'progressEdit', claudeSessionId: ID, op: 'add', texts: ['x'] })).error || '') && await listOnServer() === null,
  'nor start one: only the session does (the skill)');
check(/No such session/.test((await rpc({ type: 'progress', claudeSessionId: '../folders' })).error || ''), 'a list is named by a session id, never a path');
check(await page.locator('#progress').isHidden(), 'the rail shows no progress list before there is one');
const started = cli('add', 'Load the data', 'Train the baseline', 'Write it up');
check(started === 'Progress list (0 of 3 done)\n  1 [ ] Load the data\n  2 [ ] Train the baseline\n  3 [ ] Write it up\n', `the script's first add starts the list and prints it (${JSON.stringify(started)})`);
await item('Write it up').waitFor({ timeout: 5000 }).catch(() => {});
cli('done', '1'); cli('doing', '2');
await until(async () => await items() === 'done:Load the data | doing:Train the baseline | todo:Write it up', 5000); // (two changes: two lists sent)
check(await items() === 'done:Load the data | doing:Train the baseline | todo:Write it up', `it shows in the rail as Claude changes it (${await items()})`);
check(await other.locator('#progress').isHidden(), 'only for the session it belongs to');
const place = () => page.evaluate(() => {
  const r = document.getElementById('rail').getBoundingClientRect(), b = document.getElementById('progress').getBoundingClientRect();
  return { foot: Math.round(r.bottom - b.bottom), left: Math.round(b.left - r.left), right: Math.round(r.right - b.right), h: Math.round(b.height), list: Math.round(document.querySelector('#progress .pg-fold').getBoundingClientRect().height) };
});
const open = await place();
check(open.foot === 0 && open.left <= 1 && open.right === 0, `it is docked at the rail's foot, edge to edge (${JSON.stringify(open)})`);
const tabsLeft = [];
for (const tab of ['tasks', 'btw', 'anchors']) { await page.click(`#railtabs button[data-tab="${tab}"]`); if (!await page.locator('#progress').isVisible()) tabsLeft.push(tab); }
check(!tabsLeft.length, `the list stays under every rail tab (${tabsLeft.join() || 'it does'})`);

// the user's side: mark, reword, add, reorder, remove
const marked = page.waitForResponse((r) => r.url().endsWith('/cmd') && JSON.parse(r.request().postData() || '{}').type === 'progressEdit', { timeout: 5000 }).catch(() => {});
await item('Write it up').locator('.pg-state').click();
await page.waitForFunction(() => document.querySelectorAll('#progress .pg-item.doing').length === 2, null, { timeout: 5000 }).catch(() => {});
await marked; // (and its answer: a redraw between the next click's press and release would lose the click)
await item('Train the baseline').locator('.pg-text').click();
const field = await item('Train the baseline').locator('.pg-text').evaluate((t) => { const c = getComputedStyle(t); return { on: document.activeElement === t, outline: c.outlineStyle, edge: c.boxShadow }; });
const accent = await page.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--accent)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
check(field.on && field.outline === 'none' && field.edge.includes(accent), `a click on an item's text makes it a field with the accent on its edge, not the browser's ring (${JSON.stringify(field)})`);
await page.keyboard.press('End');
await page.keyboard.type(' twice');
const meanwhile = cli('add', 'Check the numbers'); // Claude adds one meanwhile: the field keeps its text and its focus
check(/\n\nThe user changed the list since you last read it:\n +\d\d-\d\d \d\d:\d\d  marked 3 doing \(was todo\): "Write it up"\n$/.test(meanwhile), `whatever the script is run for, its output ends with what the user changed since (${JSON.stringify(meanwhile)})`);
await wait(300); // (the list Claude changed reaches the page meanwhile)
check(await item('Train the baseline twice').locator('.pg-text').evaluate((t) => document.activeElement === t) && await item('Check the numbers').count() === 0, 'a change from Claude meanwhile waits for the field');
await page.keyboard.press('Enter');
await item('Check the numbers').waitFor({ timeout: 5000 }).catch(() => {});
await page.fill('#progress .pg-add', 'Report GPU hours');
await page.press('#progress .pg-add', 'Enter');
await item('Report GPU hours').waitFor({ timeout: 5000 }).catch(() => {});
check(await page.inputValue('#progress .pg-add') === '', 'Enter in the box adds an item and empties the box');
await until(async () => Number(await item('Report GPU hours').getAttribute('data-id')) > 0, 5000); // (it is moved by the id the server gives it)
await item('Report GPU hours').dragTo(item('Train the baseline twice'), { targetPosition: { x: 60, y: 3 } });
await page.waitForFunction(() => document.querySelectorAll('#progress .pg-item')[1]?.textContent.includes('Report GPU hours'), null, { timeout: 5000 }).catch(() => {});
await item('Load the data').hover();
await item('Load the data').locator('.pg-x').click();
await page.waitForFunction(() => document.querySelectorAll('#progress .pg-item').length === 4, null, { timeout: 5000 }).catch(() => {});
check(await items() === 'todo:Report GPU hours | doing:Train the baseline twice | doing:Write it up | todo:Check the numbers' && await page.locator('#progress .pg-count').textContent() === '0/4',
  `marked, reworded, added, dragged above another, removed (${await items()})`);
await until(async () => (await listOnServer())?.items.map((i) => i.text).join() === 'Report GPU hours,Train the baseline twice,Write it up,Check the numbers', 5000); // (the server has them all)
const told = cli();
check(told.startsWith('Progress list (0 of 4 done)\n  5 [ ] Report GPU hours\n  2 [~] Train the baseline twice\n  3 [~] Write it up\n  4 [ ] Check the numbers\n\nThe user changed the list since you last read it:\n')
  && ['reworded 2: "Train the baseline" -> "Train the baseline twice"', 'added 5 "Report GPU hours" below 4', 'moved 5 below 1: "Report GPU hours"', 'removed 1 (was done): "Load the data"']
    .every((l, i, all) => told.includes(l) && (!i || told.indexOf(all[i - 1]) < told.indexOf(l))) && !/Check the numbers"|Write it up"/.test(told),
  `the next time, the changes after that, in order: not Claude's own, nor one it was told already (${JSON.stringify(told)})`);
check(!/The user changed/.test(cli()), 'each change is told once');
const all = cli('log');
check(/you +added 1 "Load the data" at the top/.test(all) && /user +removed 1 \(was done\): "Load the data"/.test(all), 'the log keeps every change with who made it');
check(/The list has no item 1\n/.test(cli('done', '1')) && /^Unknown command: finish\nusage:/.test(cli('finish')), 'an item that is gone, or a command the script doesn\'t have, is said so');

// the anchors keep clear of it, and it never takes more than half the rail (forty requests, staged: the page then
// drops the log's own events, and only the list's own messages follow)
await page.evaluate(({ sid }) => { for (let i = 1; i <= 40; i++) window.__iroFeed({ type: 'event', seq: 1e12 + i, sid, ts: Date.now(), kind: 'user_text', text: `request ${i}` }); }, { sid });
await page.locator('#outline .ol-item').nth(39).waitFor({ timeout: 5000 }).catch(() => {});
const clear = () => page.evaluate(() => {
  const last = document.querySelector('#outline').lastElementChild.getBoundingClientRect(), b = document.getElementById('progress').getBoundingClientRect(), tabs = document.getElementById('railtabs').getBoundingClientRect().bottom;
  return { last: Math.round(last.top), spot: Math.round(tabs + (b.top - tabs) / 3), above: last.bottom <= b.top };
});
const placed = (c) => c.above && Math.abs(c.last - c.spot) <= 2;
let c1, c2;
await until(async () => placed(c1 = await clear()), 5000); // (placed on a later frame)
check(placed(c1), `the newest anchor rests a third of the way down the room above the list (${JSON.stringify(c1)})`);
cli('add', ...Array.from({ length: 40 }, (_, i) => `Experiment ${i + 1}`));
await item('Experiment 40').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
await until(async () => placed(c2 = await clear()), 5000);
const full = await place();
check(full.h <= 451 && full.h > open.h && await page.evaluate(() => { const l = document.querySelector('#progress .pg-list'); return l.scrollHeight > l.clientHeight + 100; }) && await page.locator('#progress .pg-add').isVisible(),
  `a long list takes half the rail at most and scrolls inside, the box still below it (${full.h} of 900)`);
check(placed(c2), `and the anchors move up to the room that is left (${JSON.stringify(c2)})`);
// folded: the body closes downwards, the bar stays at the foot
await page.click('#progress .pg-bar');
let shut;
await until(async () => (shut = await place()).list === 0, 5000); // (it folds over .18 s)
check(shut.list === 0 && shut.foot === 0 && shut.h < 50 && await page.locator('#progress .pg-count').textContent() === '0/44' && await page.locator('#progress .pg-bar').getAttribute('aria-expanded') === 'false',
  `its bar folds it down to one line at the rail's foot (${JSON.stringify(shut)})`);
const later = await sidePage(page, errors); // (folded is remembered in this browser)
check(await later.evaluate(() => document.getElementById('progress').classList.contains('folded')), 'folded stays folded in a page opened later');
await later.close();
await page.click('#progress .pg-bar');
check(await until(async () => (await place()).h === full.h, 5000), 'and opens again');

// ended: by the user's End (held, as Detach is), or by the session once the user said yes
const endBtn = page.locator('#progress .pg-end');
await endBtn.click();
await wait(300);
check(await page.locator('#progress').isVisible(), 'a click on End does nothing: it is held');
await endBtn.hover();
await page.mouse.down();
await page.locator('#progress').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {}); // (let go once it ran)
await page.mouse.up();
await until(async () => await listOnServer() === null, 5000); // (it is hidden before the server has it)
check(await page.locator('#progress').isHidden() && await listOnServer() === null, 'held, End ends the list: it leaves the rail');
check(/no progress list/.test((await rpc({ type: 'progressEdit', claudeSessionId: ID, op: 'add', texts: ['x'] })).error || ''), 'and the page can\'t write to it any more');
const ended = cli();
check(/^Progress list: ended\. `add` starts a new one\.\n\nThe user changed the list since you last read it:\n +\d\d-\d\d \d\d:\d\d  ended the list \(0 of 44 done\)\n$/.test(ended), `the session is told the user ended it (${JSON.stringify(ended)})`);
check(/user +ended the list \(0 of 44 done\)/.test(cli('log')), 'the log keeps it');
const again = cli('add', 'Next task');
check(/^Progress list \(0 of 1 done\)\n  46 \[ \] Next task\n$/.test(again), `the session's next add starts a new list (${JSON.stringify(again)})`);
await item('Next task').waitFor({ timeout: 5000 }).catch(() => {});
check(await items() === 'todo:Next task' && await page.locator('#progress .pg-count').textContent() === '0/1', `a new list shows again, with only its own items (${await items()})`);
const allDone = cli('done', '46');
check(/\n\nEvery item is done\. Once the user has nothing more to add or change, ask them whether to end the list; run `end` only after they say yes\.\n$/.test(allDone), `with every item done, the session is told to ask the user before ending it (${JSON.stringify(allDone)})`);
check(/^Progress list: ended\. `add` starts a new one\.\n$/.test(cli('end')), 'the session\'s `end` ends it');
await page.locator('#progress').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
check(await page.locator('#progress').isHidden() && /The list has no item 46|no progress list/.test(cli('done', '46')), 'and it leaves the rail too');

await endSuite(api);
