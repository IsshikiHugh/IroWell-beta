// What a session starts outside its CLI: a systemd unit (`systemd-run --user`, with test/fakeunits for the
// systemd a Mac lacks) and a process left running. Each is bound to the session (its Tasks tab), and when it
// ends Claude hears of it as of a background task: a turn of its own, headed by the task's bubble. One stopped
// from here says nothing; one whose session has ended shows in Left running and stops there.
import { outDir, check, until, finish, startSuite, startSession, waitResults, eventStream, hold, cleanEnv, wait } from '../lib.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4821;
const WORK = path.join(S, 'work-units');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
// (the daemon asks systemctl and journalctl on its PATH; Claude is told the fake systemd-run's full path)
const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fakeunits');
process.env.FAKE_UNITS_DIR = path.join(S, 'fake-units');
process.env.PATH = `${FAKE}:${process.env.PATH}`;
fs.rmSync(process.env.FAKE_UNITS_DIR, { recursive: true, force: true });
const killUnits = () => {
  for (const x of fs.readdirSync(process.env.FAKE_UNITS_DIR).filter((n) => n.endsWith('.json'))) {
    try { process.kill(-JSON.parse(fs.readFileSync(path.join(process.env.FAKE_UNITS_DIR, x), 'utf8')).pid, 'SIGKILL'); } catch {}
  }
};
const left = [];
process.on('exit', () => { try { killUnits(); } catch {} for (const pid of left) try { process.kill(pid, 'SIGKILL'); } catch {} });

const { client, browser, page, errors, token, cmd } = await startSuite(PORT);
const T = eventStream(PORT, token);
await until(() => T.up, 15000, 'event stream up');
const tag = randomBytes(3).toString('hex');
const U1 = `iro-e2e-${tag}`, BF1 = `iro-bf-a-${tag}`, BF2 = `iro-bf-b-${tag}`;
const SR = path.resolve(FAKE, 'systemd-run');
const results = () => page.locator('.turn-foot .meta.result').count();
const bubbles = page.locator('.turn.trigger .trig.src-task');

// 1. Claude starts a unit with systemd-run: bound to the session by its Bash call, and in the Tasks tab
await startSession(page, WORK, [
  `Run exactly this command with Bash, in the foreground: ${SR} --user --unit=${U1} --working-directory=$PWD bash -c 'sleep 12; echo UNIT-OUT-7; exit 3'`,
  `Then run this one with Bash too: echo "for later: systemd-run --user --unit=${BF1} sleep 600; systemd-run --user --unit=${BF2} sleep 600"`,
  'Then reply with just: launched. Whenever you are told later that something ended, reply with just: noted',
].join('\n'), { mode: 'bypassPermissions' });
await waitResults(page, 1, { timeout: 150000, what: 'Claude launched the unit' });
const sid = (await cmd({ type: 'overview' })).data[0]?.sid;
const procs = async () => (await cmd({ type: 'activity', sid })).data?.procs || [];
const has = async (unit) => (await procs()).some((p) => p.unit === `${unit}.service`);
check(await until(() => has(U1), 20000), `the unit is one of the session's background processes (${JSON.stringify(await procs())})`);
await page.click('#railtabs button[data-tab="tasks"]');
const row = (name) => page.locator('#runlist .run-item').filter({ hasText: name });
check(await until(async () => (await row(U1).count()) === 1, 5000), 'the Tasks tab lists it by its name');
await page.screenshot({ path: path.join(S, 'units-tasks.png') });

// 2. it ends: Claude hears of it in a turn of its own (exit code, what it printed)
await waitResults(page, 2, { timeout: 120000, what: 'the unit ended and Claude answered the report' });
const b1 = bubbles.last();
const t1 = await b1.locator('.trig-btn').textContent().catch(() => '');
check(t1.includes(U1) && /exit 3/.test(t1), `the turn is headed by a Background task bubble naming the unit and its exit code (${t1})`);
await b1.locator('.trig-btn').click();
check(/UNIT-OUT-7/.test(await b1.locator('.trig-pane').textContent().catch(() => '')), 'it opens to what the unit printed');
check(await until(async () => !(await has(U1)), 15000), 'the unit has left the Tasks tab');
await page.screenshot({ path: path.join(S, 'units-report.png') });

// 3. units started elsewhere: bound by the systemd-run command that names them in the session's transcript
await wait(6000); // (past the Bash call's time: only the transcript can tell whose they are)
for (const u of [BF1, BF2]) spawnSync(SR, ['--user', `--unit=${u}`, 'sleep', '600'], { env: cleanEnv() });
check(await until(async () => (await has(BF1)) && (await has(BF2)), 60000), `both are bound to the session by its transcript (${JSON.stringify(await procs())})`);

// 4. a process the session left running (nohup …&): when it ends, Claude hears of that too
const cid = T.claudeId(sid);
const gone = String(spawnSync('true').pid);
const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 25000)'], { env: { ...cleanEnv(), CLAUDE_CODE_SESSION_ID: cid, CLAUDE_PID: gone }, detached: true, stdio: 'ignore' });
p.unref();
left.push(p.pid);
check(await until(async () => { await cmd({ type: 'overview' }); return (await procs()).some((x) => x.pid === p.pid); }, 15000), 'the process is listed'); // (overview: a scan now)
await waitResults(page, 3, { timeout: 120000, what: 'the process ended and Claude answered the report' });
const t2 = await bubbles.last().locator('.trig-btn').textContent().catch(() => '');
check(/^Background tasknode -e setTimeout/.test(t2) && /ended$/.test(t2), `a bubble says the process ended (${t2})`);

// 5. stopped from the Tasks tab: it stops, and Claude is told nothing
const n = await results();
await hold(page, `#runlist .run-item:has-text("${BF1}") .run-stop`);
check(await until(async () => !(await has(BF1)), 15000), 'Stop (held) stops the unit');
await wait(12000);
check(await results() === n && await page.locator('.turn.trigger').count() === 2, 'no turn for a unit stopped from here');

// 6. the session detached: its unit runs on, in Left running, and stops there
await cmd({ type: 'close', sid });
const lr = async () => ((await cmd({ type: 'leftRunning' })).data || []).find((g) => g.cid === cid)?.procs || [];
check(await until(async () => (await lr()).some((x) => x.unit === `${BF2}.service`), 20000), `the unit outlives the session: Left running lists it (${JSON.stringify(await lr())})`);
const r = await cmd({ type: 'stopLeftRunning', unit: `${BF2}.service` });
check(r.error == null, `Left running stops it (${r.error || 'ok'})`);
check(await until(async () => !(await lr()).length, 15000), 'and it is gone from there');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
killUnits();
await browser.close();
client.kill('SIGTERM');
finish();
