// An update that waits (see _update.mjs: fake ssh, npm a stub): what a daemon started meanwhile runs, a page
// reload, an edit here, and a server stopped with --stop. Only a click on Reconnect switches. And a client in a
// git checkout ships only what is committed.
import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { REPO, PORT, CLIENT, check, until, finish, seen, wait, workDir } from '../lib.mjs';
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

  // ---- only what is committed reaches a host: a client in a git checkout (a clone of this one, with this
  // checkout's files committed) installs its last commit. An edit not committed yet changes nothing there; once
  // committed, the update is prepared, and it carries the commit, not later edits. (The other suites ship the
  // files as they are: IRO_SHIP_WORKTREE, set by lib.mjs.) ----
  r.client.kill('SIGTERM');
  r.killDaemons();
  const CLONE = workDir('upc-clone');
  const git = (...a) => execSync(`git -C '${CLONE}' -c user.name=t -c user.email=t@t -c commit.gpgsign=false ${a.join(' ')}`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  fs.rmSync(CLONE, { recursive: true, force: true });
  execSync(`git clone -q --shared '${REPO}' '${CLONE}'`);
  for (const f of execSync(`git -C '${REPO}' ls-files -co --exclude-standard -z`).toString().split('\0').filter(Boolean)) {
    if (!fs.existsSync(path.join(REPO, f))) continue; // (deleted here, not committed yet)
    fs.mkdirSync(path.dirname(path.join(CLONE, f)), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), path.join(CLONE, f));
  }
  for (const d of ['client', 'server']) fs.symlinkSync(path.join(REPO, d, 'node_modules'), path.join(CLONE, d, 'node_modules'));
  git('add', '-A'); git('commit', '-qm', 'base', '--allow-empty');
  r.client = spawn(process.execPath, [path.join(CLONE, 'client', 'client.mjs'), '--host', 'upc', '--port', String(PORT)], { env: { ...r.env, IRO_SKILLS_DIR: '', IRO_SHIP_WORKTREE: '' }, stdio: 'inherit' });
  await until(async () => { try { await page.goto(`http://127.0.0.1:${PORT}/`); return true; } catch { return false; } }, 10000);
  await up.waitFor({ timeout: 20000 });
  await r.prepared('a client in a git checkout'); // (the host still has the edited skills from above)
  await r.update('a client in a git checkout');
  const installed = newest();
  fs.appendFileSync(path.join(CLONE, 'server', 'daemon.mjs'), '\n// committed later\n');
  fs.appendFileSync(path.join(CLONE, 'skills', 'system-prompt.md'), '\nNot committed.\n');
  await wait(1500); // (three of the client's looks at the code: an update would be under way by now)
  check(await r.button.count() === 0 && newest() === installed, `edits not committed: nothing is prepared, no Reconnect (${installed} -> ${newest()})`);
  git('add', 'server/daemon.mjs'); git('commit', '-qm', 'edit');
  await r.prepared('a commit');
  await r.update('a commit'); // (and afterwards no Reconnect: up to date with the commit)
  const runs = (f) => fs.readFileSync(path.join(r.RDIR, 'current', f), 'utf8');
  check(/committed later/.test(runs('daemon.mjs')) && !/Not committed/.test(runs('skills/system-prompt.md')), 'the host runs the commit, without the edit not committed');
  check(r.errors.length === 0, 'no page errors' + (r.errors.length ? ': ' + r.errors.join(' | ') : ''));
} finally {
  await r.close();
}
finish();
