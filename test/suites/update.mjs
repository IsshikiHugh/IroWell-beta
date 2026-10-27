// Installing a host from the UI, and the connection to it through an update (see _update.mjs: fake ssh, npm a
// stub). A host without IroWell gets it installed on the first start, by itself; a failed install leaves an
// "Install server" button. An update whose new daemon dies on start says so; an ssh that outlives attach, or a
// daemon that stops answering, doesn't leave the page stuck.
import fs from 'node:fs';
import path from 'node:path';
import { REPO, check, until, finish, seen } from '../lib.mjs';
import { updateRig } from './_update.mjs';

const r = await updateRig('upa');
const { page, button, up, note, label, reason, pid, one, args, current, flag } = r;

try {
  // ---- a host without IroWell: the client installs it by itself. The first try fails (npm offline), which
  // leaves the Install button; once npm works, the button installs it ----
  fs.writeFileSync(flag.fail, '');
  await r.start({ IRO_TEST_TAKEOVER_MS: '3000' }); // (a new daemon that never comes up, below: given up on after 3 s)
  await until(async () => /Install failed/.test(await note()), 20000, 'the automatic install fails');
  check(/npm: no network/.test(await note()), `the failure says why (${await note()})`);
  check(await label() === 'Install server', 'a failed install leaves an Install server button');
  check(!fs.existsSync(path.join(r.RDIR, 'attach.mjs')), 'nothing half-installed is taken for an install');
  fs.rmSync(flag.fail);
  await button.click();
  check(await seen(up, 30000) && await button.count() === 0, 'Install server installs it and connects');
  check(fs.readFileSync(path.join(r.RDIR, 'current', 'daemon.mjs'), 'utf8') === fs.readFileSync(path.join(REPO, 'server', 'daemon.mjs'), 'utf8'), 'the daemon code was installed as a release');
  check(['system-prompt.md', '.claude-plugin/plugin.json'].every((f) => fs.readFileSync(path.join(r.RDIR, 'current', 'skills', f), 'utf8') === fs.readFileSync(path.join(r.SKILLS, f), 'utf8')), 'skills/ was installed next to it');
  check(one(pid()) && args(pid()).includes(current()), 'the daemon runs from its release folder');
  r.client.kill('SIGUSR2'); // the ssh pipe drops
  check(await until(async () => (await up.count()) === 0, 5000) && await seen(up, 15000), 'reconnects after the ssh connection drops');

  // ---- newer code here: the update is installed by itself, Reconnect switches. The new daemon dies on start:
  // the update says so (it used to report success and leave the old daemon retiring, after which the button
  // did nothing) ----
  fs.writeFileSync(flag.brk, '');
  r.newer();
  await r.prepared('newer code');
  check(/older/.test(await reason()) && !await page.locator('#conn .conn-err').count(), `no note, and the button says why (${await reason()})`);
  const before = pid();
  await button.click();
  // While it switches, the steps show as a bar in the button's place (here it waits on the new daemon).
  const progress = page.locator('#updateProgress');
  await seen(progress);
  check(/Starting the new version… ?1\/2/.test(await progress.textContent().catch(() => '')) && await button.count() === 0
    && await progress.locator('.uc-bar').count() === 2 && await progress.locator('.uc-fill.now').count() === 1,
    `the switch shows its steps (${await progress.textContent().catch(() => '')})`);
  await until(async () => /Update failed: the new daemon did not take over/.test(await note()), 15000, 'a new daemon that never comes up is an error');
  check(await label() === 'Try again' && pid() === before, `the old daemon still serves, and the button offers to try again (${await label()}; ${await note()})`);
  fs.rmSync(flag.brk);
  // (from here on a new daemon has the usual time to take over; and the client's heartbeat is every second)
  await r.restart({ IRO_PING_MS: '1000' });
  await r.prepared('newer code, the client started again');
  await r.update('newer code, the second try');

  // ---- an ssh that outlives attach (a real one waits for its open forwarded connections): when the old daemon
  // lets the page go, the client still notices, reconnects to the new daemon, and the update goes through.
  // (It used to keep writing commands into that ssh, and the page froze until it exited.) ----
  fs.writeFileSync(r.LINGER, '');
  r.client.kill('SIGUSR2'); // (the connection the update ends must be one made since)
  await until(async () => (await up.count()) === 0, 5000);
  await up.waitFor({ timeout: 15000 });
  r.newer();
  await r.prepared('ssh outlives attach');
  await r.update('ssh outlives attach');
  check(!/Update failed/.test(await note()), `ssh outlives attach: the client reconnected to the new daemon (${await note()})`);
  fs.rmSync(r.LINGER);

  // ---- a daemon that stops answering while its pipe stays open (stopped here with SIGSTOP): the client's
  // heartbeat notices, and it reconnects once the daemon answers again (it used to wait forever) ----
  const stuck = Number(pid());
  process.kill(stuck, 'SIGSTOP');
  check(await until(async () => (await up.count()) === 0, 15000), 'a daemon that stops answering shows as not connected');
  process.kill(stuck, 'SIGCONT');
  check(await seen(up, 15000), 'once it answers again, the page is connected again');
  check(r.errors.length === 0, 'no page errors' + (r.errors.length ? ': ' + r.errors.join(' | ') : ''));
} finally {
  await r.close();
}
finish();
