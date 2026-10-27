// Work that reports back on its own.
// Units: what a session starts outside its CLI, systemd units (`systemd-run --user`, with test/fakeunits for the
// systemd a Mac lacks) and a process left running. Each is bound to the session (its Tasks tab), and when it ends
// Claude hears of it as of a background task: a turn of its own, headed by the task's bubble (jobs that end together
// share one), after the messages you queued. One stopped from here says nothing; one whose session has ended shows
// in Left running and stops there.
// Triggers: turns you didn't send have a bubble at the head saying what started each (a background task, another
// session's message, a schedule firing); a subagent's report read mid-turn sits inside that turn; the same heads come
// back when the conversation is read from its transcript.
import { PORT, startSuite, startSession, check, until, expectSoon, waitResults, turn, eventStream, hold, cleanEnv, wait, workDir, reloadPage, killDaemon, daemonPids, outDir, endSuite } from '../lib.mjs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// (the daemon scans for processes and units every 500 ms, not 10 s; a unit counts as a Bash call's for 1.5 s after
// the call, not 5 s: past the second it may show as started, a Mac's uptime being whole seconds)
const BIND_MS = 1500;
Object.assign(process.env, { IRO_SCAN_MS: '500', IRO_UNIT_BIND_MS: String(BIND_MS) });
// (the daemon asks systemctl and journalctl on its PATH; Claude's Bash calls name the fake systemd-run by its path)
const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fakeunits');
const SR = path.join(FAKE, 'systemd-run');
const UNITS = process.env.FAKE_UNITS_DIR = workDir('fake-units');
process.env.PATH = `${FAKE}:${process.env.PATH}`;
// a job Claude leaves running: it ends once the file go-job is there
const W = workDir('work-units', { 'job.js': "const fs = require('fs'); setInterval(() => { if (fs.existsSync('go-job')) process.exit(0); }, 100);\n" });
const A = workDir('work-trig-a');
const touch = (name) => fs.writeFileSync(path.join(W, name), '');
const killUnits = () => {
  for (const x of fs.readdirSync(UNITS).filter((n) => n.endsWith('.json'))) {
    try { process.kill(-JSON.parse(fs.readFileSync(path.join(UNITS, x), 'utf8')).pid, 'SIGKILL'); } catch {}
  }
};
process.on('exit', () => { try { killUnits(); touch('go-job'); touch('go-turn'); } catch {} });

const suite = await startSuite(PORT);
const { page, token, cmd } = suite;
const T = eventStream(PORT, token);
await until(() => T.up, 15000, 'event stream up');
const results = () => page.locator('.turn-foot .meta.result').count();
const turns = page.locator('.turn.trigger');
const bubble = (src) => page.locator(`.turn.trigger .trig.src-${src}`);

// ---- units ----
const tag = randomBytes(3).toString('hex');
const U1 = `iro-e2e-${tag}`, U2 = `iro-e2e2-${tag}`, BF1 = `iro-bf-a-${tag}`, BF2 = `iro-bf-b-${tag}`;

// 1. Claude starts two units with systemd-run and a job with nohup: bound to the session by its Bash calls
await startSession(page, W, `Start the units: ${JSON.stringify({ sr: SR, u1: U1, u2: U2, bf1: BF1, bf2: BF2 })}`, { mode: 'bypassPermissions' });
await waitResults(page, 1, { timeout: 20000, what: 'Claude launched the units and the job' });
const launched = Date.now(); // (its Bash calls have all ended)
const sid = (await cmd({ type: 'overview' })).data[0]?.sid;
const procs = async () => { await cmd({ type: 'overview' }); return (await cmd({ type: 'activity', sid })).data?.procs || []; }; // (overview: a scan now)
const has = async (unit) => (await procs()).some((p) => p.unit === `${unit}.service`);
const job = async () => (await procs()).find((p) => !p.unit && /job\.js/.test(p.cmd));
check(await until(async () => (await has(U1)) && (await has(U2)) && !!(await job()), 10000), `the units and the job are the session's background processes (${JSON.stringify(await procs())})`);
await page.click('#railtabs button[data-tab="tasks"]');
const row = (name) => page.locator('#runlist .run-item').filter({ hasText: name });
check(await until(async () => (await row(U1).count()) === 1, 5000), 'the Tasks tab lists a unit by its name');

// 2. both units end together: one turn, headed by a bubble for each (exit code, what it printed)
touch('go-units');
await waitResults(page, 2, { timeout: 15000, what: 'the units ended and Claude answered the report' });
const heads = turns.last().locator('.trig-head .trig');
const texts = await heads.locator('.trig-btn').allTextContents();
check(texts.length === 2 && texts.some((t) => t.includes(U1) && /exit 3/.test(t)) && texts.some((t) => t.includes(U2) && /done/.test(t)),
  `one turn, a Background task bubble for each unit: the exit code, done for an exit 0 (${JSON.stringify(texts)})`);
const b1 = heads.filter({ hasText: U1 });
await b1.locator('.trig-btn').click();
check(/UNIT-OUT-7/.test(await b1.locator('.trig-pane').textContent().catch(() => '')), 'it opens to what the unit printed');
check(await until(async () => !(await has(U1)) && !(await has(U2)), 5000), 'the units have left the Tasks tab');

// 3. units started elsewhere: bound by the systemd-run command that names them in the session's transcript
await wait(launched + BIND_MS + 1100 - Date.now()); // (past the Bash call's window: only the transcript can tell whose they are)
for (const u of [BF1, BF2]) spawnSync(SR, ['--user', `--unit=${u}`, 'sleep', '600'], { env: cleanEnv() });
const how = (unit) => fs.readdirSync(path.join(process.env.IRO_DIR, 'units')).map((f) => JSON.parse(fs.readFileSync(path.join(process.env.IRO_DIR, 'units', f), 'utf8'))).find((e) => e.unit === `${unit}.service`)?.how;
check(await until(async () => (await has(BF1)) && (await has(BF2)), 15000) && how(BF1) === 'transcript' && how(BF2) === 'transcript',
  `both are bound to the session by its transcript (${JSON.stringify(await procs())}; bound by: ${how(BF1)}, ${how(BF2)})`);

// 4. the job ends while Claude is busy and you have queued a message: yours goes first, then the report
const n = await results();
const bashCmds = () => T.of(sid).flatMap((e) => (e.kind === 'msg' && e.msg.type === 'assistant' ? e.msg.message.content : [])).filter((b) => b.type === 'tool_use' && b.name === 'Bash').map((b) => b.input.command);
await page.fill('#input', 'Hold on until go-turn');
await page.press('#input', 'Enter');
await until(() => bashCmds().some((c) => c.includes('go-turn')), 10000, 'the turn is busy');
touch('go-job');
await page.fill('#input', 'Reply with just: second');
await page.press('#input', 'Enter');
await until(async () => !(await job()), 10000, 'the job\'s end is seen while the turn runs');
touch('go-turn');
await waitResults(page, n + 3, { timeout: 20000, what: 'your two turns and the report' });
const order = T.of(sid).filter((e) => e.kind === 'user_text' || e.kind === 'notify').slice(-3).map((e) => (e.kind === 'notify' ? `notify:${e.title}` : e.text));
check(order[0] === 'Hold on until go-turn' && order[1] === 'Reply with just: second' && /^notify:node job\.js/.test(order[2]), `your queued message went before the report (${JSON.stringify(order)})`);
const t2 = await turns.last().locator('.trig-btn').first().textContent().catch(() => '');
check(/^Background tasknode job\.js/.test(t2) && /ended$/.test(t2), `a bubble says the job ended (${t2})`);

// 5. stopped from the Tasks tab: it stops, and Claude is told nothing
const m = await results(), k = await turns.count();
const daemonLog = () => { try { return fs.readFileSync(path.join(process.env.IRO_DIR, 'daemon.log'), 'utf8'); } catch { return ''; } };
await hold(page, `#runlist .run-item:has-text("${BF1}") .run-stop`);
check(await until(async () => !(await has(BF1)), 5000), 'Stop (held) stops the unit');
await until(() => /unit:\w+ ended \(stopped on purpose: not reported\)/.test(daemonLog()), 5000, 'the daemon saw the unit end');
await wait(1600); // (a report would go 1.5 s after the end)
check(await results() === m && await turns.count() === k, 'no turn for a unit stopped from here');

// 6. the session detached: its unit runs on, in Left running, and stops there
const cid = T.claudeId(sid);
await cmd({ type: 'close', sid });
const lr = async () => ((await cmd({ type: 'leftRunning' })).data || []).find((g) => g.cid === cid)?.procs || [];
check(await until(async () => (await lr()).some((x) => x.unit === `${BF2}.service`), 5000), `the unit outlives the session: Left running lists it (${JSON.stringify(await lr())})`);
const r = await cmd({ type: 'stopLeftRunning', unit: `${BF2}.service` });
check(r.error == null, `Left running stops it (${r.error || 'ok'})`);
check(await until(async () => !(await lr()).length, 5000), 'and it is gone from there');
killUnits();

// ---- triggers ----
// 1. A background command finishing while Claude is idle: a turn of its own, headed by the task's bubble.
await startSession(page, A, 'Start a background command', { mode: 'bypassPermissions' });
await waitResults(page, 1, { timeout: 15000, what: 'Claude started the background command' });
await page.hover('#feed');
await page.mouse.wheel(0, 200); // a scroll of your own lets go of the request; the feed now follows its bottom
fs.writeFileSync(path.join(A, 'go-trig'), ''); // (the command ends)
await waitResults(page, 2, { timeout: 15000, what: 'the background command reported back and Claude answered' });
await page.waitForTimeout(300); // (the report's turn drawn and laid out)
const reqTop = await page.evaluate(() => { // the card's top below the feed's (the first card sits in its own place, a bit lower)
  const f = document.getElementById('feed');
  return document.querySelector('.turn-q').getBoundingClientRect().top - f.getBoundingClientRect().top;
});
check(reqTop >= 0 && reqTop <= 60, `the report reads on below your request, which stays at the top (card ${reqTop}px below the feed's top)`);
const task = bubble('task').first();
check(await task.isVisible(), 'a turn headed by a Background task bubble');
check(!(await turns.first().locator('.turn-q').count()), 'that turn has no request card');
const taskText = await task.locator('.trig-btn').textContent();
check(/Background task/.test(taskText) && /exit 0/.test(taskText), `the bubble names it and its exit code: ${taskText}`);
check(await task.evaluate((el) => getComputedStyle(el.closest('.trig-head')).position) !== 'sticky', 'the bubble does not stick (unlike a request card)');
await task.locator('.trig-btn').click();
check(/TRIG-DONE/.test(await task.locator('.trig-pane').textContent().catch(() => '')), 'it opens to what the command printed');
await task.locator('.trig-btn').click();
check(await task.locator('.trig-pane').isHidden(), 'a second click folds it again');
check(await page.locator('#outline .ol-item').count() === 1, 'it is no anchor: the outline lists only your request');

// 2. A subagent reporting back while Claude is still working: a small bubble inside the turn running.
await turn(page, 'Launch a subagent and keep working', { timeout: 15000, what: 'the turn with the subagent ended' });
const inline = page.locator('.turn:not(.trigger) .turn-body .trig.small.src-agent');
check(await inline.count() === 1 && await bubble('agent').count() === 0, `the report sits inside the turn, not at the head of one (${await inline.count()} inside, ${await bubble('agent').count()} heading a turn)`);
check(/Subagent/.test(await inline.locator('.trig-kind').textContent()), 'labelled Subagent');
await inline.locator('.trig-btn').click();
check(/MID-REPORT-3/.test(await inline.locator('.trig-pane').textContent().catch(() => '')), 'it opens to the report');

// 3. Another session sends a message.
let n3 = await results();
await turn(page, 'Wait for a message from another session', { timeout: 15000 });
await waitResults(page, n3 + 2, { timeout: 15000, what: 'Claude answered the other session' });
const sessText = await bubble('session').first().locator('.trig-btn').textContent().catch(() => '');
check(/^work-trig-b/.test(sessText) && /PING-FROM-B/.test(sessText), `a turn headed by the sender's name and its message: ${sessText}`);

// 4. A schedule firing.
n3 = await results();
await turn(page, 'Schedule a prompt', { timeout: 15000 });
await waitResults(page, n3 + 2, { timeout: 15000, what: 'Claude answered the schedule' });
const wakeText = await bubble('wakeup').first().locator('.trig-btn').textContent().catch(() => '');
check(/^Wakeup/.test(wakeText) && /TICK-9/.test(wakeText), `a turn headed by the scheduled prompt: ${wakeText}`);

// 5. Read back from the transcript (a daemon restart: the session is reopened from what the CLI wrote).
killDaemon();
await until(() => !daemonPids().length, 5000, 'the daemon stopped');
await reloadPage(page);
await page.click(`.folder[data-dir="${A}"] .sess`);
const heads2 = async () => Object.fromEntries(await Promise.all(['task', 'session', 'wakeup'].map(async (src) => [src, await bubble(src).count()])));
await expectSoon(async () => { const h = await heads2(); return h.task >= 1 && h.session >= 1 && h.wakeup >= 1 && h; }, 'from the transcript: the same heads', 15000);
check(!(await page.locator('.turn-q-text', { hasText: /^(Another Claude session|PING-FROM-B|<task-notification>|Reply with just: TICK-9)/ }).count()), 'none of them shows as a request of yours');

await endSuite(suite);
