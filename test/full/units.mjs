// What a session starts outside its CLI: systemd units (`systemd-run --user`, with test/fakeunits for the
// systemd a Mac lacks) and a process left running. Each is bound to the session (its Tasks tab), and when it
// ends Claude hears of it as of a background task: a turn of its own, headed by the task's bubble (jobs that end
// together share one), after the messages you queued. One stopped from here says nothing; one whose session
// has ended shows in Left running and stops there.
import { outDir, check, until, finish, startSuite, startSession, waitResults, eventStream, hold, cleanEnv, wait } from '../lib.mjs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4821;
const WORK = path.join(S, 'work-units');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const touch = (name) => fs.writeFileSync(path.join(WORK, name), '');
// a job Claude leaves running: it ends once the file `go-job` is there
fs.writeFileSync(path.join(WORK, 'job.js'), "const fs = require('fs'); setInterval(() => { if (fs.existsSync('go-job')) process.exit(0); }, 200);\n");
// (the daemon asks systemctl and journalctl on its PATH; Claude is told the fake systemd-run's full path)
const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fakeunits');
process.env.FAKE_UNITS_DIR = path.join(S, 'fake-units');
process.env.PATH = `${FAKE}:${process.env.PATH}`;
fs.rmSync(process.env.FAKE_UNITS_DIR, { recursive: true, force: true });
fs.mkdirSync(process.env.FAKE_UNITS_DIR);
const killUnits = () => {
  for (const x of fs.readdirSync(process.env.FAKE_UNITS_DIR).filter((n) => n.endsWith('.json'))) {
    try { process.kill(-JSON.parse(fs.readFileSync(path.join(process.env.FAKE_UNITS_DIR, x), 'utf8')).pid, 'SIGKILL'); } catch {}
  }
};
process.on('exit', () => { try { killUnits(); touch('go-job'); } catch {} });

const { client, browser, page, errors, token, cmd } = await startSuite(PORT);
const T = eventStream(PORT, token);
await until(() => T.up, 15000, 'event stream up');
const tag = randomBytes(3).toString('hex');
const U1 = `iro-e2e-${tag}`, U2 = `iro-e2e2-${tag}`, BF1 = `iro-bf-a-${tag}`, BF2 = `iro-bf-b-${tag}`;
const SR = path.resolve(FAKE, 'systemd-run');
const results = () => page.locator('.turn-foot .meta.result').count();
const turns = page.locator('.turn.trigger');

// 1. Claude starts two units with systemd-run and a job with nohup: bound to the session by its Bash calls
const wait1 = "bash -c 'while [ ! -e go-units ]; do sleep 0.2; done; echo UNIT-OUT-7; exit 3'", wait2 = "bash -c 'while [ ! -e go-units ]; do sleep 0.2; done; exit 0'";
await startSession(page, WORK, [
  `Run exactly this command with Bash, in the foreground: ${SR} --user --unit=${U1} --working-directory=$PWD ${wait1}; ${SR} --user --unit=${U2} --working-directory=$PWD ${wait2}`,
  'Then run this with Bash: nohup node job.js > job.log 2>&1 &',
  `Then run this one with Bash too: echo "for later: systemd-run --user --unit=${BF1} sleep 600; systemd-run --user --unit=${BF2} sleep 600"`,
  'Then reply with just: launched. Whenever you are told later that something ended, reply with just: noted',
].join('\n'), { mode: 'bypassPermissions' });
await waitResults(page, 1, { timeout: 150000, what: 'Claude launched the units and the job' });
const sid = (await cmd({ type: 'overview' })).data[0]?.sid;
const procs = async () => { await cmd({ type: 'overview' }); return (await cmd({ type: 'activity', sid })).data?.procs || []; }; // (overview: a scan now)
const has = async (unit) => (await procs()).some((p) => p.unit === `${unit}.service`);
const job = async () => (await procs()).find((p) => !p.unit && /job\.js/.test(p.cmd));
check(await until(async () => (await has(U1)) && (await has(U2)) && !!(await job()), 20000), `the units and the job are the session's background processes (${JSON.stringify(await procs())})`);
await page.click('#railtabs button[data-tab="tasks"]');
const row = (name) => page.locator('#runlist .run-item').filter({ hasText: name });
check(await until(async () => (await row(U1).count()) === 1, 5000), 'the Tasks tab lists a unit by its name');
await page.screenshot({ path: path.join(S, 'units-tasks.png') });

// 2. both units end together: one turn, headed by a bubble for each (exit code, what it printed)
touch('go-units');
await waitResults(page, 2, { timeout: 120000, what: 'the units ended and Claude answered the report' });
const heads = turns.last().locator('.trig-head .trig');
const texts = await heads.locator('.trig-btn').allTextContents();
check(texts.length === 2 && texts.some((t) => t.includes(U1) && /exit 3/.test(t)) && texts.some((t) => t.includes(U2) && /done/.test(t)),
  `one turn, a Background task bubble for each unit: the exit code, done for an exit 0 (${JSON.stringify(texts)})`);
const b1 = heads.filter({ hasText: U1 });
await b1.locator('.trig-btn').click();
check(/UNIT-OUT-7/.test(await b1.locator('.trig-pane').textContent().catch(() => '')), 'it opens to what the unit printed');
check(await until(async () => !(await has(U1)) && !(await has(U2)), 15000), 'the units have left the Tasks tab');
await page.screenshot({ path: path.join(S, 'units-report.png') });

// 3. units started elsewhere: bound by the systemd-run command that names them in the session's transcript
await wait(6000); // (past the Bash call's time: only the transcript can tell whose they are)
for (const u of [BF1, BF2]) spawnSync(SR, ['--user', `--unit=${u}`, 'sleep', '600'], { env: cleanEnv() });
const bashCmds = () => T.of(sid).flatMap((e) => (e.kind === 'msg' && e.msg.type === 'assistant' ? e.msg.message.content : [])).filter((b) => b.type === 'tool_use' && b.name === 'Bash').map((b) => b.input.command);
check(await until(async () => (await has(BF1)) && (await has(BF2)), 60000), `both are bound to the session by its transcript (${JSON.stringify(await procs())}; its Bash calls: ${JSON.stringify(bashCmds())})`);

// 4. the job ends while Claude is busy and you have queued a message: yours goes first, then the report
const n = await results();
await page.fill('#input', 'Run this with Bash in the foreground: sleep 12. Then reply with just: slept');
await page.press('#input', 'Enter');
await until(async () => (await page.locator('.turn').last().textContent()).includes('sleep 12'), 30000);
await wait(2000);
touch('go-job');
await page.fill('#input', 'Reply with just: second');
await page.press('#input', 'Enter');
await waitResults(page, n + 3, { timeout: 180000, what: 'your two turns and the report' });
const order = T.of(sid).filter((e) => e.kind === 'user_text' || e.kind === 'notify').slice(-3).map((e) => (e.kind === 'notify' ? `notify:${e.title}` : e.text));
check(/^Run this/.test(order[0]) && order[1] === 'Reply with just: second' && /^notify:node job\.js/.test(order[2]), `your queued message went before the report (${JSON.stringify(order)})`);
const t2 = await turns.last().locator('.trig-btn').first().textContent().catch(() => '');
check(/^Background tasknode job\.js/.test(t2) && /ended$/.test(t2), `a bubble says the job ended (${t2})`);

// 5. stopped from the Tasks tab: it stops, and Claude is told nothing
const m = await results(), k = await turns.count();
await hold(page, `#runlist .run-item:has-text("${BF1}") .run-stop`);
check(await until(async () => !(await has(BF1)), 15000), 'Stop (held) stops the unit');
await wait(12000);
check(await results() === m && await turns.count() === k, 'no turn for a unit stopped from here');

// 6. the session detached: its unit runs on, in Left running, and stops there
const cid = T.claudeId(sid);
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
