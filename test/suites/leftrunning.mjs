// Left running: what sessions that have ended left behind shows by the server's name, by session, and stops there
// (a job whole; one that ignores SIGTERM gets SIGKILL a grace later: 2.5 s here, IRO_KILL_GRACE_MS). Then stopping
// the server: the ⏻ button, Start server, and client.mjs --stop.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { CLIENT, PORT, check, until, wait, startSuite, cleanEnv, hold, seen, endSuite } from '../lib.mjs';
import { rpcOf } from './_qc.mjs';

process.env.IRO_KILL_GRACE_MS = '2500'; // (a hold takes 1.2 s of it: the check that it still runs comes after)
const api = await startSuite(PORT);
const { page } = api;
const rpc = rpcOf(api);
let nativeDialogs = 0;
page.on('dialog', (d) => { nativeDialogs++; d.dismiss(); }); // the page draws its own (ui/dialog.js)

{
  // (as a session's Bash tool leaves them: its id in the environment, and the pid of a CLI that has exited: one
  // that just did. A made-up pid can be a process that runs: Linux's go well past 99999)
  const gone = String(spawnSync('true').pid);
  const leave = (cid, code) => {
    const p = spawn(process.execPath, ['-e', code], { env: { ...cleanEnv(), CLAUDE_CODE_SESSION_ID: cid, CLAUDE_PID: gone }, detached: true, stdio: 'ignore' });
    p.unref();
    return p.pid;
  };
  const runsStill = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const kidOf = (pid) => { try { return Number(execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n')[0]); } catch { return 0; } };
  const [c1, c2] = [crypto.randomUUID(), crypto.randomUUID()];
  // (the count is the whole machine's: this one's own leftovers, and what other suites running meanwhile leave,
  // come and go. So the button is held to the list the server gives at the same moment, and only ours are looked at)
  const sketch = (l) => JSON.stringify(l.map((g) => [g.cid.slice(0, 8), g.procs.map((p) => `${p.pid} ${(p.cmd || '').slice(0, 60)}`)]));
  const leftNow = async () => (await rpc({ type: 'leftRunning' })).data || [];
  const jobs = (l) => l.reduce((n, g) => n + g.procs.length, 0);
  const ours = (l) => l.filter((g) => g.cid === c1 || g.cid === c2).reduce((n, g) => n + g.procs.length, 0);
  const btn = page.locator('#leftRunningBtn');
  // the button shows the server's count (none: no button), and ours in it are `n` (the server tells the page of
  // each list it is asked for)
  const countIs = async (n) => { const l = await leftNow(); return ours(l) === n && (jobs(l) ? (await btn.isVisible()) && (await btn.textContent()).trim() === String(jobs(l)) : !(await btn.isVisible())); };
  const quiet = leave(c1, 'setInterval(() => {}, 1000)');
  const stubborn = leave(c2, "process.on('SIGTERM', () => {}); require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)");
  // (each its own process group: the suite ends them, passed or not. One that ignores SIGTERM would run on for
  // good, in this machine's Left running)
  process.on('exit', () => { for (const pid of [quiet, stubborn]) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  await until(() => kidOf(stubborn), 5000, 'the stubborn job has its child');
  const kid = kidOf(stubborn);
  await rpc({ type: 'overview' }); // (scans now: else within 10 s)
  check(await until(() => countIs(2), 10000), `the ghost by the server's name counts our 2 jobs (${await btn.textContent().catch(() => '?')} ${sketch(await leftNow())})`);
  const list = await leftNow();
  const g2 = list.find((g) => g.cid === c2);
  check(list.some((g) => g.cid === c1 && g.procs.length === 1 && g.procs[0].pid === quiet) && g2?.procs.length === 1 && g2.procs[0].pid === stubborn && g2.procs[0].children === 1,
    `listed by session, each job once by its top process (${JSON.stringify(list.map((g) => [g.cid.slice(0, 4), g.procs.map((p) => [p.pid, p.children])]))})`);
  await btn.click();
  await page.locator('.modal .lr-row').first().waitFor({ timeout: 5000 });
  check(await page.locator(`.modal .lr-head[data-cid="${c1}"], .modal .lr-head[data-cid="${c2}"]`).count() === 2
    && await page.locator(`.modal .lr-row[data-pid="${quiet}"], .modal .lr-row[data-pid="${stubborn}"]`).count() === 2
    && await page.locator(`.modal .lr-row[data-pid="${kid}"]`).count() === 0, 'the dialog: a heading per session, a row per job (not one for the process under it)');
  await hold(page, `.modal .lr-row[data-pid="${quiet}"] .run-stop`);
  check(await until(() => !runsStill(quiet), 4000), 'Stop (held) stops a job');
  // (its row goes once the server says so, and the rows below move up: a hold begun before then lands beside Stop)
  await until(async () => (await page.locator(`.modal .lr-row[data-pid="${quiet}"]`).count()) === 0, 5000, 'the stopped job leaves the dialog');
  await hold(page, `.modal .lr-row[data-pid="${stubborn}"] .run-stop`);
  check(await until(() => !runsStill(kid), 1000) && runsStill(stubborn), 'its processes all get SIGTERM: one that ignores it is still there');
  check(await until(() => !runsStill(stubborn), 6000), '…until SIGKILL, a grace later');
  check(await until(async () => (await page.locator(`.modal .lr-head[data-cid="${c1}"], .modal .lr-head[data-cid="${c2}"]`).count()) === 0, 15000)
    && await until(() => countIs(0), 5000),
    `then they are gone from the dialog, and from the count (${await btn.textContent().catch(() => '?')} ${sketch(await leftNow())})`);
  await page.locator('.modal-head button').click();
  // (this machine's own leftovers can keep the count above 0: whether a hidden ghost really goes is checked here)
  check(await btn.evaluate((b) => { const was = b.hidden; b.hidden = true; const d = getComputedStyle(b).display; b.hidden = was; return d === 'none'; }),
    'with nothing left running the ghost is gone (hidden takes it off the line)');
}

// ---- stopping: the ⏻ button, Start server, and client.mjs --stop ----
{
  const daemonUp = () => fs.existsSync(path.join(process.env.IRO_DIR, 'daemon.sock'));
  const stopCli = () => execFileSync(process.execPath, [CLIENT, '--local', '--stop'], { env: cleanEnv() }).toString();
  await hold(page, '#stopServer');
  await until(() => !daemonUp(), 15000, 'the daemon stops');
  check(await seen(page.locator('#startServer')) && /server stopped/.test(await page.locator('#conn').textContent()), 'Stop server: the page says so and offers Start server');
  await wait(1300); // (past the client's first reconnect, a second after a connection ends)
  check(!daemonUp(), 'the client does not restart a stopped server');
  await page.click('#startServer');
  check(await seen(page.locator('#conn .dot.up'), 15000) && daemonUp(), 'Start server starts it again');
  check(/stopped the IroWell server/.test(stopCli()), 'client.mjs --local --stop stops it');
  check(!daemonUp() && await seen(page.locator('#startServer')), 'the open page hears of it and does not restart it');
  check(/no IroWell server is running/.test(stopCli()), '--stop with no server running says so');
}

check(nativeDialogs === 0, `no native confirm/alert (${nativeDialogs})`);
await endSuite(api);
