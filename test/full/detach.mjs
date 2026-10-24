// Detach from the page: a session started here, and one that an update handed over to a new daemon, in a
// browser that has stopped the page's own dialogs (every native confirm() answers "cancel" unseen).
// What a session left running goes on through the update, and stops with the detach.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { outDir, log, check, until, finish, startClient, eventStream, browserPath, answerDialogs, hold, cleanEnv } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4801;
const WORK = path.join(S, 'work-detach');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
let { client, token, cmd } = await startClient(PORT, { stdio: ['ignore', 'pipe', 'pipe'] });
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const T = eventStream(PORT, token);
const { of, closed } = T;
const browser = await chromium.launch({ executablePath: browserPath() });
// A process as a session's Bash tool leaves it (`nohup … &`): the session's id in its environment, and the
// pid of a CLI that has exited since.
const left = [];
const leave = (cid, code = 'setInterval(() => {}, 1000)') => {
  const p = spawn(process.execPath, ['-e', code], { env: { ...cleanEnv(), CLAUDE_CODE_SESSION_ID: cid, CLAUDE_PID: '99999' }, detached: true, stdio: 'ignore' });
  p.unref();
  left.push(p.pid);
  return p.pid;
};
const runsStill = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  await until(() => T.up, 15000, 'transport up');
  const mk = async (title) => {
    const r = await cmd({ type: 'new', cwd: WORK, text: `Reply with just: ${title}` });
    await until(() => of(r.data.sid).some((e) => e.kind === 'msg' && e.msg.type === 'result'), 120000, `${title} answered`);
    await cmd({ type: 'rename', sid: r.data.sid, title });
    return r.data.sid;
  };
  const A = await mk('alpha'), B = await mk('bravo');
  const cidOf = (sid) => of(sid).find((e) => e.kind === 'init')?.claudeSessionId;
  const cidA = cidOf(A);
  const jobA = leave(cidA), jobB = leave(cidOf(B), "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"); // (B's ignores SIGTERM)
  const r = await cmd({ type: 'deploy' });
  check(r.error == null, 'update');
  await until(() => T.up && of(A).length && of(B).length, 20000);
  await until(() => /\] taken over/.test(fs.readFileSync(path.join(process.env.IRO_DIR, 'daemon.log'), 'utf8')), 15000, 'handed over');
  check(runsStill(jobA) && runsStill(jobB), 'an update keeps what the sessions left running');
  const C = await mk('charlie'); // started on the new daemon
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let native = 0;
  page.on('dialog', (d) => { native++; d.dismiss(); }); // as a browser does once it stops the page's dialogs
  await answerDialogs(page);
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
  for (const [sid, title] of [[A, 'alpha'], [C, 'charlie']]) {
    await page.locator('.sess').filter({ hasText: title }).first().click();
    await page.waitForTimeout(500);
    const btn = page.locator('#closeSess');
    log(title, 'button', await btn.textContent(), 'disabled', await btn.isDisabled());
    await hold(page, btn).catch((e) => log('hold failed:', e.message.split('\n')[0]));
    check(await until(() => closed(sid), 10000), `${title}: Detach from the page detaches it`);
  }
  check(await until(() => !runsStill(jobA), 4000), 'alpha: what it left running stops with it');
  // The client is restarted (a new token) while the page stays open: the page reconnects by itself, and
  // Detach works again. (It used to stay "not connected", every button disabled, until reloaded by hand.)
  client.kill('SIGTERM');
  await until(() => client.exitCode != null || client.signalCode != null, 5000);
  const api = await startClient(PORT, { stdio: ['ignore', 'pipe', 'pipe'], fresh: false }); // (the daemon runs on)
  client = api.client;
  check(await page.locator('#conn .dot.up').waitFor({ timeout: 15000 }).then(() => true, () => false), 'after a client restart the open page reconnects by itself');
  const T2 = eventStream(PORT, api.token);
  await until(() => T2.up, 10000);
  await api.cmd({ type: 'rename', sid: B, title: 'bravo2' });
  check(await until(async () => (await page.locator('.sess').filter({ hasText: 'bravo2' }).count()) > 0, 10000), 'its stream picks up again by itself (a rename shows)');
  await page.locator('.sess').filter({ hasText: 'bravo' }).first().click();
  await page.waitForTimeout(500);
  log('bravo button disabled', await page.locator('#closeSess').isDisabled());
  await hold(page, '#closeSess').catch((e) => log('hold failed:', e.message.split('\n')[0]));
  check(await until(() => T2.closed(B), 10000), 'bravo: Detach works on that page');
  check(await until(() => runsStill(jobB), 1000) && await until(() => !runsStill(jobB), 9000), 'bravo: what it left running ignores SIGTERM, and gets SIGKILL');
  // One that got away all the same is listed under its session's name and folder, and stops from there.
  const stray = leave(cidA);
  const listed = async () => ((await api.cmd({ type: 'leftRunning' })).data || []).find((g) => g.cid === cidA);
  const g = await until(listed, 5000) && await listed();
  check(g?.title === 'alpha' && [WORK, fs.realpathSync(WORK)].includes(g.cwd) && g.procs.some((p) => p.pid === stray), `Left running names its session (${JSON.stringify(g)})`);
  await api.cmd({ type: 'stopLeftRunning', pid: stray });
  check(await until(() => !runsStill(stray), 4000), 'and stops it');
  check(native === 0, `no native dialogs (${native})`);
  check(!errors.length, 'no page errors ' + errors.join(' | '));
} finally {
  for (const pid of left) try { process.kill(pid, 'SIGKILL'); } catch {}
  await browser.close();
  client.kill('SIGTERM');
}
finish();
