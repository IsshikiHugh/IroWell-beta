// An update that waits (see _update.mjs: fake ssh, npm a stub): what a daemon started meanwhile runs, a page
// reload, an edit here, and a server stopped with --stop. Only a click on Reconnect switches.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { CLIENT, check, until, finish, seen } from '../lib.mjs';
import { updateRig, RECONNECT } from './_update.mjs';

const r = await updateRig('upc');
const { page, up, label, pid, one, args, current, newest } = r;

try {
  await r.start(); // (installed by itself)
  await up.waitFor({ timeout: 30000 });

  // ---- a daemon started while an update is only prepared (after a crash here; a reboot or an idle exit alike)
  // runs the release in use, not the prepared one. Reconnect then switches, and the new one is current ----
  r.newer();
  await r.prepared('prepared, then the daemon dies');
  const inUse = current(), waiting = newest();
  process.kill(Number(pid()), 'SIGKILL');
  await until(() => one(pid()), 20000, 'the client starts a daemon again');
  check(args(pid()).includes(inUse) && current() === inUse, `a daemon started meanwhile runs the release in use, not the prepared one (${path.basename(current())}; prepared: ${waiting})`);
  await seen(up, 20000);
  check(await until(async () => (await label()) === RECONNECT, 10000), 'and Reconnect still offers the prepared one');
  const mark = '\n// (the prepared release)\n', rootAttach = () => fs.readFileSync(path.join(r.RDIR, 'attach.mjs'), 'utf8');
  fs.appendFileSync(path.join(r.RDIR, 'releases', waiting, 'attach.mjs'), mark);
  // (`fixed: false`: the mark makes that release's code another than this checkout's, so it is outdated again)
  await r.update('prepared, then the daemon died', { fixed: false });
  check(path.basename(current()) === waiting && rootAttach().endsWith(mark), `Reconnect switched to the prepared release, which is now current, and so is its attach.mjs (${path.basename(current())})`);

  // ---- reloading the page while Reconnect shows switches nothing (it used to do what the button does): the
  // switch is the button's alone ----
  r.newer();
  await r.prepared('newer code again');
  const kept = pid();
  await page.reload();
  await up.waitFor({ timeout: 20000 });
  await until(async () => (await label()) === RECONNECT, 5000);
  await new Promise((res) => setTimeout(res, 1000)); // (a switch the reload started would be under way by now)
  check(pid() === kept && (await label()) === RECONNECT && !r.retiring(),
    `reloading the page switches nothing: the same daemon, nothing retiring, and Reconnect still shows (${await label()})`);

  // ---- the checkout changes while an update waits: the release is prepared again from the new files ----
  const first = newest();
  r.newer();
  await until(() => newest() !== first, 10000, 'an edit: the release is prepared again'); // (Reconnect goes meanwhile, too briefly to see here)
  await r.prepared('after an edit');
  check(newest() !== first && !fs.existsSync(path.join(r.RDIR, 'releases', first)), `a new release replaces the one prepared before the edit (${first} -> ${newest()})`);
  await r.update('after an edit');
  check(fs.readFileSync(path.join(r.RDIR, 'current', 'skills', 'system-prompt.md'), 'utf8') === fs.readFileSync(path.join(r.SKILLS, 'system-prompt.md'), 'utf8'), 'the server runs the edited files');

  // ---- client.mjs --stop over ssh: stops the daemon without starting one when none runs ----
  const stopCli = () => execSync(`${process.execPath} ${CLIENT} --host upc --stop`, { env: r.env }).toString();
  check(/stopped the IroWell server on upc/.test(stopCli()) && !pid(), '--host upc --stop stops the daemon');
  check(/no IroWell server is running/.test(stopCli()) && !pid(), '--stop again: nothing runs, and nothing was started');
  // Reconnect while the server is stopped: it is started, then switched (it used to fail at once, "Not
  // connected to the server", and leave no button).
  await r.restartClient();
  r.newer();
  await r.prepared('prepared, then the server is stopped');
  check(/stopped the IroWell server on upc/.test(stopCli()) && !pid(), 'the server is stopped while an update waits');
  await seen(page.locator('#startServer'));
  check(await label() === RECONNECT, `stopped: Reconnect still offers the update (${await label()})`);
  await r.update('stopped, then Reconnect', { ahead: false }); // (waits for the new release to become current)
  check(r.errors.length === 0, 'no page errors' + (r.errors.length ? ': ' + r.errors.join(' | ') : ''));
} finally {
  await r.close();
}
finish();
