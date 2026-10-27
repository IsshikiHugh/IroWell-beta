// Rolling updates ("Update server") never interrupt a session. A busy one (a question pending) stays on its
// daemon, still usable from the page, until it is answered and idle; an idle one moves over at once, keeping
// its sid and its conversation; what sessions left running goes on. The page sees one daemon and one gapless
// event log throughout, over several updates in a row. Then Detach from the page: a session that moved, one
// started on the new daemon, and one after the client restarted under the open page. (The update restarts
// the daemon from this checkout.)
import { PORT, log, check, until, startClient, openPage, eventStream, hold, cleanEnv, workDir, seen, endSuite } from '../lib.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const DIR = process.env.IRO_DIR;
const WORK = workDir('work-handover');
const daemonLog = () => { try { return fs.readFileSync(path.join(DIR, 'daemon.log'), 'utf8'); } catch { return ''; } };
const takenOver = (sid) => daemonLog().split('\n').filter((l) => l.includes(`[${sid}] taken over`)).length;
const oldSocks = () => fs.readdirSync(DIR).filter((f) => /^old-[0-9a-f]{8}\.sock$/.test(f));

// A process as a session's Bash tool leaves it: the session's id in its environment, and the pid of a CLI
// that has exited (one that just did: a made-up pid can be a process that runs).
const gone = String(spawnSync('true').pid);
const left = [];
const leave = (cid) => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...cleanEnv(), CLAUDE_CODE_SESSION_ID: cid, CLAUDE_PID: gone }, detached: true, stdio: 'ignore' });
  p.unref();
  left.push(p.pid);
  return p.pid;
};
const runsStill = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
process.on('exit', () => { for (const pid of left) try { process.kill(pid, 'SIGKILL'); } catch {} });

let { client, token, cmd } = await startClient(PORT, { stdio: ['ignore', 'pipe', 'pipe'] });
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const T = eventStream(PORT, token, cmd);
const { of, results, state, closed, claudeId, ask, lastText } = T;
const question = (sid) => of(sid).filter((e) => e.kind === 'approval').pop();
const start = async (text, title) => {
  const sid = (await cmd({ type: 'new', cwd: WORK, text })).data.sid;
  await cmd({ type: 'rename', sid, title });
  return sid;
};
await until(() => T.up, 15000, 'transport up');

// B: idle, with something to remember and a job it left running. A and C: busy, a question each waits.
const B = await start('Remember the codeword PELICAN. Reply with just: ok', 'bravo');
const A = await start('Ask me which color I prefer, Red or Blue, then reply with just the one I picked.', 'alpha');
const C = await start('Ask me which fruit I prefer, Apple or Pear, then reply with just the one I picked.', 'charlie');
await until(() => results(B).length && state(B) === 'idle' && question(A) && question(C), 15000, 'B answered, A and C ask');
const qA = question(A), qC = question(C), cidB = claudeId(B), cidC = claudeId(C);
const jobB = leave(cidB);

// An update: the page is on the new daemon once its log has come again.
async function update(n) {
  const resets = T.resets;
  const r = await cmd({ type: 'deploy' });
  check(r.error == null, `update ${n} goes through${r.error ? ': ' + r.error : ''}`);
  await until(() => T.resets > resets && T.up && question(C) && results(B).length, 20000, `update ${n}: the page is on the new daemon`);
}

// ---- the first update: B moves, A and C stay ----
await update(1);
check(!closed(A) && !closed(C) && state(A) === 'waiting' && state(C) === 'waiting' && question(A).rid === qA.rid && question(C).rid === qC.rid,
  'A and C stay on the old daemon, their questions still pending');
await until(() => takenOver(B) >= 1, 15000, 'B moves to the new daemon at once');
const first = oldSocks();
check(first.length === 1, `the old daemon keeps running for A and C (${first.join(' ')})`);
check(runsStill(jobB), 'an update keeps what a session left running');
const saidB = await ask(B, 'What was the codeword?');
check(saidB === 'PELICAN' && !closed(B) && claudeId(B) === cidB, `B kept its sid, its Claude session and its conversation (${saidB})`);

// A: answered through the new daemon (relayed to the old one), then it moves too
const answered = await cmd({ type: 'approve', sid: A, rid: qA.rid, allow: true, answers: { [qA.input.questions[0].question]: 'Blue' } });
check(answered.error == null, `the answer reaches the old daemon${answered.error ? ': ' + answered.error : ''}`);
await until(() => results(A).length >= 1, 10000, 'A finishes its turn on the old daemon');
check(lastText(A) === 'Blue', `A's reply comes through the new daemon (${lastText(A)})`);
await until(() => takenOver(A) >= 1, 15000, 'A moves once idle');
const saidA = await ask(A, 'Which color did I pick?');
check(saidA === 'Blue', `A kept its conversation (${saidA})`);

// ---- two more updates while C stays busy on the first daemon: it stays usable from the page ----
for (const n of [2, 3]) {
  await update(n);
  check(oldSocks().includes(first[0]) && !closed(C) && state(C) === 'waiting', `update ${n}: C still runs on the first daemon, its question pending`);
  const act = await cmd({ type: 'activity', sid: C });
  check(act.data?.state === 'waiting', `update ${n}: C answers commands (${JSON.stringify(act.data ?? act.error)})`);
  await until(() => takenOver(A) >= n && takenOver(B) >= n, 15000, `update ${n}: A and B moved over`);
  check(!!(await cmd({ type: 'activity', sid: B })).data, `update ${n}: B answers commands`);
  await until(() => oldSocks().length === 1, 10000, `update ${n}: only C's daemon is left (${oldSocks().join(' ')})`);
}

// The link to C's daemon breaks while that daemon runs on (something else adopts it): the main daemon takes
// it back, and C neither shows as detached nor gets its conversation twice.
const created = () => of(C).filter((e) => e.kind === 'created').length;
const nC = of(C).length;
const thief = net.connect(path.join(DIR, first[0]));
let dropped = false;
thief.on('error', () => {});
thief.on('end', () => (dropped = true));
thief.resume();
thief.on('connect', () => thief.write(JSON.stringify({ type: 'adopt', id: 1 }) + '\n'));
await until(() => /lost the link to old-/.test(daemonLog()), 5000, 'the main daemon notices the lost link');
await until(() => dropped, 5000, 'it adopts that daemon again');
thief.destroy();
await until(async () => (await cmd({ type: 'activity', sid: C })).data?.state === 'waiting', 5000, 'C answers commands again');
check(!closed(C) && created() === 1 && of(C).length === nC, `C is not detached, nor drawn twice (closed=${closed(C)} created=${created()} events ${nC} -> ${of(C).length})`);

// C detached three daemons later: the first daemon exits, and a reattach starts it here (not the closed sid back)
const c = await cmd({ type: 'close', sid: C });
check(c.error == null, `C detaches${c.error ? ': ' + c.error : ''}`);
await until(() => closed(C), 10000, 'C shows as detached');
await until(() => !oldSocks().length && /retired: every session/.test(daemonLog()), 15000, 'the first daemon exits once C is gone');
const rc = await cmd({ type: 'resume', claudeSessionId: cidC, cwd: WORK, title: 'charlie' });
const C2 = rc.data?.sid;
check(rc.error == null && C2 && C2 !== C && !rc.data.existing, `C reattaches under a new sid (${JSON.stringify(rc.data ?? rc.error)})`);
await until(() => of(C2).some((e) => e.kind === 'created'), 10000, 'the reattached C is listed');
check(T.dupes === 0 && T.events.every((e, i) => !i || e.seq === T.events[i - 1].seq + 1), 'one gapless event log throughout');
check(!closed(A) && !closed(B), 'A and B were never detached');

// ---- Detach from the page, in a browser that has stopped the page's own dialogs (every native confirm()
// answers "cancel" unseen): one that moved three times (B), one started on the newest daemon (D) ----
const D = await start('Reply with just: delta', 'delta');
await until(() => results(D).length, 10000, 'D answered');
const { browser, page, pageErrors } = await openPage(PORT); // (not the console's: the restart below cuts the old stream)
let native = 0;
page.on('dialog', (d) => { native++; d.dismiss(); });
const detach = async (sid, title, stream = T) => {
  await page.locator('.sess', { hasText: title }).first().click();
  await page.waitForFunction((t) => document.getElementById('title').textContent === t && document.getElementById('closeSess').textContent === 'Detach' && !document.getElementById('closeSess').disabled, title, { timeout: 10000 });
  await hold(page, '#closeSess');
  check(await until(() => stream.closed(sid), 10000), `${title}: Detach from the page detaches it`);
};
await detach(B, 'bravo');
check(await until(() => !runsStill(jobB), 5000), 'bravo: what it left running stops with it');
await detach(D, 'delta');
// One that got away all the same is listed under its session's name and folder.
const stray = leave(cidB);
const listed = async () => ((await cmd({ type: 'leftRunning' })).data || []).find((g) => g.cid === cidB);
const g = await until(listed, 5000) && await listed();
check(g?.title === 'bravo' && g.cwd === WORK && g.procs.some((p) => p.pid === stray), `Left running names its session (${JSON.stringify(g)})`);

// The client is restarted (a new token) while the page stays open: the page reconnects by itself, and Detach
// works again. (It used to stay "not connected", every button disabled, until reloaded by hand.)
const exited = new Promise((r) => client.once('exit', r));
client.kill('SIGTERM');
await exited;
await seen(page.locator('#conn .dot:not(.up)'), 5000);
const api = await startClient(PORT, { stdio: ['ignore', 'pipe', 'pipe'], fresh: false }); // (the daemon runs on)
client = api.client;
check(await seen(page.locator('#conn .dot.up'), 15000), 'after a client restart the open page reconnects by itself');
const T2 = eventStream(PORT, api.token);
await until(() => T2.up, 10000, 'the new client\'s stream');
await api.cmd({ type: 'rename', sid: A, title: 'alpha2' });
check(await seen(page.locator('.sess', { hasText: 'alpha2' }), 10000), 'its stream picks up again by itself (a rename shows)');
await detach(A, 'alpha2', T2);
check(native === 0, `no native dialogs (${native})`);

await endSuite({ browser, client, errors: pageErrors });
