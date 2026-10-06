// Detach from the page: a session started here, and one that an update handed over to a new daemon, in a
// browser that has stopped the page's own dialogs (every native confirm() answers "cancel" unseen).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { CLIENT, outDir, log, check, until, finish, cleanEnv, clientApi, eventStream, browserPath, answerDialogs } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4793;
const WORK = path.join(S, 'work-detach');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
let client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const { token, cmd } = await clientApi(PORT);
const T = eventStream(PORT, token);
const of = (sid) => T.events.filter((e) => e.sid === sid);
const closed = (sid) => of(sid).some((e) => e.kind === 'closed');
const browser = await chromium.launch({ executablePath: browserPath() });
try {
  await until(() => T.up, 15000, 'transport up');
  const mk = async (title) => {
    const r = await cmd({ type: 'new', cwd: WORK, text: `Reply with just: ${title}` });
    await until(() => of(r.data.sid).some((e) => e.kind === 'msg' && e.msg.type === 'result'), 120000, `${title} answered`);
    await cmd({ type: 'rename', sid: r.data.sid, title });
    return r.data.sid;
  };
  const A = await mk('alpha'), B = await mk('bravo');
  const r = await cmd({ type: 'deploy' });
  check(r.error == null, 'update');
  await until(() => T.up && of(A).length && of(B).length, 20000);
  await until(() => /\] taken over/.test(fs.readFileSync(path.join(process.env.IRO_DIR, 'daemon.log'), 'utf8')), 15000, 'handed over');
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
    await btn.click({ timeout: 5000 }).catch((e) => log('click failed:', e.message.split('\n')[0]));
    check(await until(() => closed(sid), 10000), `${title}: Detach from the page detaches it`);
  }
  // The client is restarted (a new token) while the page stays open: the page reconnects by itself, and
  // Detach works again. (It used to stay "not connected", every button disabled, until reloaded by hand.)
  client.kill('SIGTERM');
  await until(() => client.exitCode != null || client.signalCode != null, 5000);
  client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  await clientApi(PORT);
  check(await page.locator('#conn .dot.up').waitFor({ timeout: 15000 }).then(() => true, () => false), 'after a client restart the open page reconnects by itself');
  const T2 = eventStream(PORT, (await clientApi(PORT)).token);
  await until(() => T2.up, 10000);
  await (await clientApi(PORT)).cmd({ type: 'rename', sid: B, title: 'bravo2' });
  check(await until(async () => (await page.locator('.sess').filter({ hasText: 'bravo2' }).count()) > 0, 10000), 'its stream picks up again by itself (a rename shows)');
  await page.locator('.sess').filter({ hasText: 'bravo' }).first().click();
  await page.waitForTimeout(500);
  log('bravo button disabled', await page.locator('#closeSess').isDisabled());
  await page.locator('#closeSess').click({ timeout: 5000 }).catch((e) => log('click failed:', e.message.split('\n')[0]));
  check(await until(() => T2.events.some((e) => e.sid === B && e.kind === 'closed'), 10000), 'bravo: Detach works on that page');
  check(native === 0, `no native dialogs (${native})`);
  check(!errors.length, 'no page errors ' + errors.join(' | '));
} finally {
  await browser.close();
  client.kill('SIGTERM');
}
finish();
