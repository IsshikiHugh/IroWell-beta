// Installing and updating a host from the UI (fake ssh/scp, remote == a scratch $HOME on this machine,
// npm stubbed out so no network is needed). A host without IroWell gets it installed on the first
// start, by itself; a failed install leaves an "Install server" button. A server running older code,
// or an older Agent SDK, gets the new release installed by itself, and then shows "Reconnect to update":
// only a click on that (not reloading the page) makes the old daemon hand over and exit, once the new
// release's Claude Code is known to run. A release that fails is prepared again later, by itself.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, killDaemon, check, until, finish, answerDialogs } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4787;
const HOME = path.join(S, 'fakehome');
const RDIR = path.join(HOME, '.iro-coding');
const BIN = path.join(S, 'stubbin');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
// npm: logs its arguments and lends a fresh release the checkout's packages. It fails while NPM_FAIL
// exists, fetching @latest fails while NPM_LATEST_FAIL does, and the release it installs has a daemon
// that dies on start while NPM_BREAK does. While NPM_BAD_CLI exists, the release's packages come out
// with a damaged Claude Code (it answers like a bare Bun; the SDK itself is a copy, so it looks there
// too): once, or always (the file says which); or ("own") with a stand-in that answers like Claude Code,
// in the release's own folder, for the test to damage later.
const NPM_LOG = path.join(S, 'npm-calls.log');
const NPM_FAIL = path.join(S, 'npm-fail');
const NPM_LATEST_FAIL = path.join(S, 'npm-latest-fail');
const NPM_BREAK = path.join(S, 'npm-break');
const NPM_BAD_CLI = path.join(S, 'npm-bad-cli');
const MODULES = path.join(REPO, 'server', 'node_modules');
fs.writeFileSync(path.join(BIN, 'npm'), `#!/bin/sh
echo "$*" >> '${NPM_LOG}'
if [ -e '${NPM_FAIL}' ]; then echo "npm: no network" >&2; exit 1; fi
case "$*" in *@latest*) if [ -e '${NPM_LATEST_FAIL}' ]; then echo "npm error code E403" >&2; exit 1; fi;; esac
if [ -e '${NPM_BREAK}' ] && ! grep -q boom daemon.mjs; then { echo 'if (!process.argv.includes("--check-cli")) throw new Error("boom");'; cat daemon.mjs; } > daemon.tmp && mv daemon.tmp daemon.mjs; fi
if [ -e '${NPM_BAD_CLI}' ] && { [ ! -e node_modules ] || [ -L node_modules ]; }; then
  rm -f node_modules; mkdir -p node_modules/@anthropic-ai
  for f in '${MODULES}'/* '${MODULES}'/.[!.]*; do [ -e "$f" ] && [ "$(basename "$f")" != @anthropic-ai ] && ln -s "$f" node_modules/; done
  for f in '${MODULES}'/@anthropic-ai/*; do b=$(basename "$f"); case "$b" in
    claude-agent-sdk) cp -R "$f" node_modules/@anthropic-ai/;;
    claude-agent-sdk-*) mkdir "node_modules/@anthropic-ai/$b"; cp "$f/package.json" "node_modules/@anthropic-ai/$b/"
      if [ "$(cat '${NPM_BAD_CLI}')" = own ]; then v='2.1.296 (Claude Code)'; else v=1.4.3; fi
      printf '#!/bin/sh\\necho "%s"\\n' "$v" > "node_modules/@anthropic-ai/$b/claude"; chmod +x "node_modules/@anthropic-ai/$b/claude";;
    *) ln -s "$f" node_modules/@anthropic-ai/;; esac; done
  [ "$(cat '${NPM_BAD_CLI}')" = once ] && rm '${NPM_BAD_CLI}'
fi
[ -e node_modules ] || ln -s '${MODULES}' node_modules
exit 0
`, { mode: 0o755 });
// The remote commands run in a login shell (`$SHELL -lc`), and macOS's login profile rebuilds PATH,
// which would find the real npm (network, minutes). This shell ignores -l so the stub stays first.
const SH = path.join(BIN, 'sh');
// (IRO_SKILLS_DIR, the client's copy of skills/, is the client's only: a release has its own.)
fs.writeFileSync(SH, '#!/bin/sh\nunset IRO_SKILLS_DIR\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
// The client's skills/: a copy, so the test can edit it.
const SKILLS = path.join(S, 'update-client', 'skills'); // (named skills/: a release gets it under its own name)
fs.rmSync(SKILLS, { recursive: true, force: true });
fs.cpSync(path.join(REPO, 'skills'), SKILLS, { recursive: true });
const daemonPat = `${RDIR}/.*daemon[.]mjs`; // every release's daemon
const pid = () => { try { return execSync(`pgrep -f "${daemonPat}"`).toString().trim(); } catch { return ''; } };
const one = (p) => p && !p.includes('\n');
const args = (p) => execSync(`ps -o args= -p ${p}`).toString();
const current = () => { try { return fs.realpathSync(path.join(RDIR, 'current')); } catch { return ''; } };

// The daemon's npm check is faked: "the installed SDK is the newest", except where a phase says otherwise.
const SDK_NOW = JSON.parse(fs.readFileSync(path.join(REPO, 'server/node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version;
const LINGER = path.join(S, 'ssh-linger'); // see test/fakebin/ssh
const env = cleanEnv({ IRO_SKILLS_DIR: SKILLS, IRO_AUTO_UPDATE_MS: '500', IRO_TEST_SDK_LATEST: SDK_NOW, IRO_TEST_TAKEOVER_MS: '8000', FAKE_SSH_LINGER: LINGER, HOME, SHELL: SH, PATH:`${BIN}:${path.join(HERE, '..', 'fakebin')}:${process.env.PATH}` });
delete env.IRO_DIR;
const startClient = (extra = {}) => spawn(process.execPath, [CLIENT, '--host', 'fakebox', '--port', String(PORT)], { env: { ...env, ...extra }, stdio: 'inherit' });
const npmCalls = () => (fs.existsSync(NPM_LOG) ? fs.readFileSync(NPM_LOG, 'utf8') : '');

fs.writeFileSync(NPM_FAIL, '');
let client = startClient();
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await answerDialogs(page);
const button = () => page.locator('#updateServer');
const note = () => page.locator('#conn .conn-err').textContent().catch(() => '');
// Restart the client against a daemon that is gone, so the next hello comes from a fresh one.
async function restart(extra) {
  client.kill('SIGTERM');
  try { execSync(`pkill -f "${daemonPat}"`); } catch {}
  await until(() => !pid(), 5000);
  client = startClient(extra);
  await until(async () => { try { await page.goto(`http://127.0.0.1:${PORT}/`); return true; } catch { return false; } }, 10000);
  await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
}
const label = () => button().textContent().catch(() => '');
const RECONNECT = 'Reconnect to update';
const reason = () => button().getAttribute('title').catch(() => '');
// The update installed by itself: Reconnect shows, and the old daemon still runs its own release, which
// stays current (what a daemon started meanwhile would run); the new release waits beside it.
const newest = () => fs.readdirSync(path.join(RDIR, 'releases')).sort().pop();
async function prepared(what, ms = 30000) {
  const old = pid();
  check(await until(async () => (await label()) === RECONNECT, ms), `${what}: the update is prepared by itself, then Reconnect shows (${await label()})`);
  await new Promise((r) => setTimeout(r, 1500));
  check(pid() === old && args(old).includes(current()) && path.basename(current()) !== newest(),
    `${what}: nothing switches until asked (the old daemon still runs, and its release is still current; the new one waits in ${newest()})`);
}
// Click the button, then wait for a new release and a daemon (only one) running from it. `ahead`: the
// release was installed before the click.
async function update(what, { fixed = true, ahead = false } = {}) {
  const rel = current(), old = pid();
  await button().click();
  if (!ahead) await until(() => current() !== rel, 20000, `${what}: a new release is installed`);
  await until(() => one(pid()) && pid() !== old && args(pid()).includes(current()), 20000, `${what}: the old daemon hands over and exits (${old} -> ${pid()})`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 20000 }).catch(() => {});
  check(!fs.readdirSync(RDIR).some((f) => /^old-[0-9a-f]{8}\.sock$/.test(f)), `${what}: no retiring daemon left behind`);
  if (!fixed) return; // (the stub npm can't fetch a newer SDK)
  await page.waitForFunction(() => !document.getElementById('updateServer') && !document.querySelector('#conn .conn-err'), null, { timeout: 30000 }).catch(() => {});
  check(await button().count() === 0 && await page.locator('#conn .conn-err').count() === 0, `${what}: afterwards the button and the note are gone`);
}

try {
  // 1. A host without IroWell: the client installs it by itself. The first try fails (npm offline),
  //    which leaves the Install button; once npm works, the button installs it.
  for (let i = 0; i < 50; i++) { try { await page.goto(`http://127.0.0.1:${PORT}/`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  await until(async () => /Install failed/.test(await note()), 20000, 'the automatic install fails');
  check(/npm: no network/.test(await note()), `the failure says why (${await note()})`);
  check(await button().isVisible() && (await button().textContent()) === 'Install server', 'a failed install leaves an Install server button');
  check(!fs.existsSync(path.join(RDIR, 'attach.mjs')), 'nothing half-installed is taken for an install');
  await page.screenshot({ path: path.join(S, 'update-install-failed.png') });
  fs.rmSync(NPM_FAIL);
  await button().click();
  await page.locator('#conn .dot.up').waitFor({ timeout: 30000 }).catch(() => {});
  check(await page.locator('#conn .dot.up').count() === 1 && await button().count() === 0, 'Install server installs it and connects');
  check(fs.readFileSync(path.join(RDIR, 'current', 'daemon.mjs'), 'utf8') === fs.readFileSync(path.join(REPO, 'server', 'daemon.mjs'), 'utf8'), 'the daemon code was installed as a release');
  check(['system-prompt.md', '.claude-plugin/plugin.json'].every((f) => fs.readFileSync(path.join(RDIR, 'current', 'skills', f), 'utf8') === fs.readFileSync(path.join(REPO, 'skills', f), 'utf8')), 'skills/ was installed next to it');
  check(one(pid()) && args(pid()).includes(current()), 'the daemon runs from its release folder');
  client.kill('SIGUSR2'); // the ssh pipe drops
  check(await until(async () => (await page.locator('#conn .dot.up').count()) === 0, 5000) && await page.locator('#conn .dot.up').waitFor({ timeout: 15000 }).then(() => true, () => false), 'reconnects after the ssh connection drops');

  // 2. A server running older code: the update is installed by itself, Reconnect switches.
  // The new daemon dies on start: the update says so (it used to report success and leave the old
  // daemon retiring, after which the button did nothing), and it is prepared again later.
  const older = () => fs.appendFileSync(path.join(RDIR, 'current', 'daemon.mjs'), '\n// an older version\n');
  older();
  fs.writeFileSync(NPM_BREAK, '');
  await restart();
  await prepared('older code');
  check(/older/.test(await reason()) && !await page.locator('#conn .conn-err').count(), `no note, and the button says why (${await reason()})`);
  await page.screenshot({ path: path.join(S, 'update-ready.png') });
  const before = pid();
  await button().click();
  // While it switches, the steps show as a bar in the button's place (here it waits on the new daemon).
  const progress = page.locator('#updateProgress');
  await progress.waitFor({ timeout: 5000 }).catch(() => {});
  check(/Starting the new version… ?1\/2/.test(await progress.textContent().catch(() => '')) && await button().count() === 0
    && await progress.locator('.uc-bar').count() === 2 && await progress.locator('.uc-fill.now').count() === 1,
    `the switch shows its steps (${await progress.textContent().catch(() => '')})`);
  await page.screenshot({ path: path.join(S, 'update-progress.png') });
  await until(async () => /Update failed: the new daemon did not take over/.test(await note()), 30000, 'a new daemon that never comes up is an error');
  check(await button().count() === 0 && pid() === before, `the old daemon still serves, and no button for now (${await note()})`);
  fs.rmSync(NPM_BREAK);
  await prepared('older code, tried again later', 40000);
  await update('older code, the second try', { ahead: true });
  // A release whose Claude Code comes out damaged (it runs as a bare Bun, as a copy on an NFS home once
  // did): the install notices, fetches the packages again, and the update goes through. Damaged again
  // after that, preparing the update fails and says why, nothing switches, and no half-made release stays.
  fs.rmSync(NPM_LOG, { force: true });
  fs.writeFileSync(NPM_BAD_CLI, 'once');
  older();
  await restart();
  await prepared('a damaged Claude Code');
  check(npmCalls().split('\n').filter((l) => l === 'install --omit=dev --no-audit --no-fund').length === 2, `a damaged Claude Code: the packages are fetched again (${npmCalls().trim().split('\n').join(' | ')})`);
  await update('a damaged Claude Code, fetched again', { ahead: true });
  fs.writeFileSync(NPM_BAD_CLI, 'always');
  older();
  await restart();
  const running = pid();
  await until(async () => /Preparing the update failed: .*does not run \(--version: 1\.4\.3\)/.test(await note()), 30000, 'a Claude Code that stays damaged: preparing the update fails');
  check(await button().count() === 0 && pid() === running, `…says why, offers no switch, and the daemon in use goes on (${await note()})`);
  const releases = fs.readdirSync(path.join(RDIR, 'releases'));
  check(releases.every((r) => r <= path.basename(current())), `…and leaves no half-made release behind (${releases.join(' ')}; current ${path.basename(current())})`);
  fs.rmSync(NPM_BAD_CLI);
  await prepared('a damaged Claude Code, tried again later', 40000);
  await update('a damaged Claude Code, the second try', { ahead: true });
  // A release that breaks after its install: Reconnect asks it first, and when its Claude Code doesn't
  // run, nothing changes (the daemon in use doesn't retire, its sessions stay), and the update says why.
  fs.writeFileSync(NPM_BAD_CLI, 'own');
  older();
  await restart();
  await prepared('a release that breaks later');
  const broken = fs.readdirSync(path.join(RDIR, 'releases')).sort().pop();
  for (const f of fs.readdirSync(path.join(RDIR, 'releases', broken, 'node_modules', '@anthropic-ai')).filter((d) => d.startsWith('claude-agent-sdk-'))) {
    fs.writeFileSync(path.join(RDIR, 'releases', broken, 'node_modules', '@anthropic-ai', f, 'claude'), '#!/bin/sh\necho 1.4.3\n');
  }
  fs.rmSync(NPM_BAD_CLI);
  const serving = pid(), inUse = current(), t0 = Date.now();
  await button().click();
  await until(async () => /Update failed: Claude Code at .*does not run \(--version: 1\.4\.3\)/.test(await note()), 15000, 'Reconnect to a release whose Claude Code does not run: the update fails');
  check(Date.now() - t0 < 6000 && pid() === serving && current() === inUse && !fs.readdirSync(RDIR).some((f) => /^old-[0-9a-f]{8}\.sock$/.test(f)),
    `…at once, and says why; the daemon in use did not retire, and its release is still current (${Date.now() - t0} ms; ${await note()})`);
  await prepared('a release that broke, tried again later', 40000);
  await update('a release that broke, the second try', { ahead: true });
  // A daemon started while an update is only prepared (after a crash here; a reboot or an idle exit alike)
  // runs the release in use, not the prepared one. Reconnect then switches, and the new one is current.
  older();
  await restart();
  await prepared('prepared, then the daemon dies');
  const before2 = current(), waiting = newest();
  process.kill(Number(pid()), 'SIGKILL');
  await until(() => one(pid()), 20000, 'the client starts a daemon again');
  check(args(pid()).includes(before2) && current() === before2, `a daemon started meanwhile runs the release in use, not the prepared one (${path.basename(current())}; prepared: ${waiting})`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 20000 }).catch(() => {});
  check(await until(async () => (await label()) === RECONNECT, 10000), 'and Reconnect still offers the prepared one');
  const mark = '\n// (the prepared release)\n', rootAttach = () => fs.readFileSync(path.join(RDIR, 'attach.mjs'), 'utf8');
  fs.appendFileSync(path.join(RDIR, 'releases', waiting, 'attach.mjs'), mark);
  await update('prepared, then the daemon died', { ahead: true });
  check(path.basename(current()) === waiting && rootAttach().endsWith(mark), `Reconnect switched to the prepared release, which is now current, and so is its attach.mjs (${path.basename(current())})`);
  // Reloading the page while Reconnect shows switches nothing (it used to do what the button does): the
  // switch is the button's alone.
  older();
  await restart();
  await prepared('older code again');
  const kept = pid();
  await page.reload();
  await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
  await new Promise((r) => setTimeout(r, 3000));
  check(pid() === kept && (await label()) === RECONNECT && !fs.readdirSync(RDIR).some((f) => /^old-[0-9a-f]{8}\.sock$/.test(f)),
    `reloading the page switches nothing: the same daemon, nothing retiring, and Reconnect still shows (${await label()})`);
  await update('Reconnect after a reload', { ahead: true });
  // The checkout changes while an update waits: the release is prepared again from the new files.
  older();
  await restart();
  await prepared('before an edit');
  const first = newest();
  fs.appendFileSync(path.join(SKILLS, 'system-prompt.md'), '\nAn edit.\n');
  await until(() => newest() !== first, 10000, 'an edit: the release is prepared again'); // (Reconnect goes meanwhile, too briefly to see here)
  await prepared('after an edit');
  check(newest() !== first && !fs.existsSync(path.join(RDIR, 'releases', first)), `a new release replaces the one prepared before the edit (${first} -> ${newest()})`);
  await update('after an edit', { ahead: true });
  check(/An edit\./.test(fs.readFileSync(path.join(RDIR, 'current', 'skills', 'system-prompt.md'), 'utf8')), 'the server runs the edited files');

  // 3. Up-to-date code, but a newer Agent SDK (Claude Code) on npm: prepared the same way.
  fs.rmSync(NPM_LOG, { force: true });
  await restart({ IRO_TEST_SDK_LATEST: '99.0.0' });
  await prepared('newer SDK');
  check(/99\.0\.0 is out/.test(await reason()), `a newer Claude Code is the reason (${await reason()})`);
  await update('newer SDK', { fixed: false, ahead: true });
  check(/install .*@anthropic-ai\/claude-agent-sdk@latest/.test(npmCalls()), `the update installs the newest SDK (${npmCalls().trim().split('\n').join(' | ')})`);
  // (the stub can't really install 99.0.0: it is still out, but not offered again and again)
  await new Promise((r) => setTimeout(r, 2000));
  check(await button().count() === 0, 'a newest SDK that did not come is not offered again');
  // The host can't fetch the newest SDK: the update goes through on the pinned one, and says so.
  fs.writeFileSync(NPM_LATEST_FAIL, '');
  await restart({ IRO_TEST_SDK_LATEST: '99.0.0' });
  await prepared('newest SDK unavailable');
  await update('newest SDK unavailable', { fixed: false, ahead: true });
  await until(async () => /Updated, but could not fetch the newest Claude Code/.test(await note()), 10000, 'the note about the newest SDK');
  check(/E403/.test(await note()), `it says why (${await note()})`);
  fs.rmSync(NPM_LATEST_FAIL);
  // An ssh that outlives attach (a real one waits for its open forwarded connections): when the old daemon
  // lets the page go, the client still notices, reconnects to the new daemon, and the update goes through.
  // (It used to keep writing commands into that ssh, and the page froze until it exited.)
  fs.writeFileSync(LINGER, '');
  client.kill('SIGUSR2'); // (the connection the update ends must be one made since)
  await until(async () => (await page.locator('#conn .dot.up').count()) === 0, 5000);
  await page.locator('#conn .dot.up').waitFor({ timeout: 15000 });
  fs.appendFileSync(path.join(SKILLS, 'system-prompt.md'), '\nAnother edit.\n'); // (newer code here)
  await prepared('ssh outlives attach');
  await update('ssh outlives attach', { ahead: true });
  check(!/Update failed/.test(await note()), `ssh outlives attach: the client reconnected to the new daemon (${await note()})`);
  fs.rmSync(LINGER);
  // A daemon that stops answering while its pipe stays open (stopped here with SIGSTOP): the client's
  // heartbeat notices, and it reconnects once the daemon answers again (it used to wait forever).
  await restart({ IRO_PING_MS: '1000' });
  const stuck = Number(pid());
  process.kill(stuck, 'SIGSTOP');
  check(await until(async () => (await page.locator('#conn .dot.up').count()) === 0, 15000), 'a daemon that stops answering shows as not connected');
  process.kill(stuck, 'SIGCONT');
  check(await page.locator('#conn .dot.up').waitFor({ timeout: 15000 }).then(() => true, () => false), 'once it answers again, the page is connected again');
  // 4. client.mjs --stop over ssh: stops the daemon without starting one when none runs.
  const stopCli = () => execSync(`${process.execPath} ${CLIENT} --host fakebox --stop`, { env }).toString();
  check(/stopped the IroWell server on fakebox/.test(stopCli()) && !pid(), '--host fakebox --stop stops the daemon');
  check(/no IroWell server is running/.test(stopCli()) && !pid(), '--stop again: nothing runs, and nothing was started');

  // 5. This machine, with a newer SDK out: Reconnect installs it into server/ (without touching package.json
  //    or the lock file) before restarting the daemon. The stub npm stands in for the real one.
  client.kill('SIGTERM');
  const localDir = path.join(S, 'update-local');
  fs.rmSync(localDir, { recursive: true, force: true });
  fs.rmSync(NPM_LOG, { force: true });
  client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: { ...env, HOME: process.env.HOME, IRO_DIR: localDir, IRO_TEST_SDK_LATEST: '99.0.0', IRO_SKILLS_DIR: '' }, stdio: 'inherit' });
  await until(async () => { try { await page.goto(`http://127.0.0.1:${PORT}/`); return true; } catch { return false; } }, 10000);
  check(await until(async () => (await label()) === RECONNECT, 15000), `this machine: Reconnect (${await label()})`);
  check(/99\.0\.0 is out/.test(await reason()) && !/npm install/.test(await reason()), `this machine: the reason, and no npm by hand (${await reason()})`);
  check(/@latest/.test(npmCalls()) && !/--prefer-offline/.test(npmCalls()) && !fs.existsSync(path.join(localDir, 'sdk-fetch')),
    `this machine: the newest SDK is downloaded ahead, and installed into server/ only on Reconnect (${npmCalls().trim()})`);
  await button().click();
  await until(() => /install --no-save .*--prefer-offline @anthropic-ai\/claude-agent-sdk@latest/.test(npmCalls()), 10000, 'npm install --no-save --prefer-offline …@latest in server/');
  await until(() => fs.readdirSync(localDir).some((f) => /^old-/.test(f)) || /retired/.test(fs.readFileSync(path.join(localDir, 'daemon.log'), 'utf8')), 15000, 'the local daemon restarts');
  killDaemon(localDir);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} finally {
  await browser.close();
  client.kill('SIGTERM');
  try { execSync(`pkill -f "${daemonPat}"`); } catch {}
}
finish();
