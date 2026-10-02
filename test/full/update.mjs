// Installing and updating a host from the UI (fake ssh/scp, remote == a scratch $HOME on this machine,
// npm stubbed out so no network is needed). A host without IroWell gets it installed on the first
// start, by itself; a failed install leaves an "Install server" button. A server running older code,
// or an older Agent SDK, shows "Update server": the new release is installed and the old daemon
// hands over and exits.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, killDaemon, check, until, finish } from '../lib.mjs';
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
// exists, and fetching @latest fails while NPM_LATEST_FAIL does.
const NPM_LOG = path.join(S, 'npm-calls.log');
const NPM_FAIL = path.join(S, 'npm-fail');
const NPM_LATEST_FAIL = path.join(S, 'npm-latest-fail');
fs.writeFileSync(path.join(BIN, 'npm'), `#!/bin/sh
echo "$*" >> '${NPM_LOG}'
if [ -e '${NPM_FAIL}' ]; then echo "npm: no network" >&2; exit 1; fi
case "$*" in *@latest*) if [ -e '${NPM_LATEST_FAIL}' ]; then echo "npm error code E403" >&2; exit 1; fi;; esac
[ -e node_modules ] || ln -s '${path.join(REPO, 'server', 'node_modules')}' node_modules
exit 0
`, { mode: 0o755 });
// The remote commands run in a login shell (`$SHELL -lc`), and macOS's login profile rebuilds PATH,
// which would find the real npm (network, minutes). This shell ignores -l so the stub stays first.
const SH = path.join(BIN, 'sh');
fs.writeFileSync(SH, '#!/bin/sh\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
const daemonPat = `${RDIR}/.*daemon[.]mjs`; // every release's daemon
const pid = () => { try { return execSync(`pgrep -f "${daemonPat}"`).toString().trim(); } catch { return ''; } };
const one = (p) => p && !p.includes('\n');
const args = (p) => execSync(`ps -o args= -p ${p}`).toString();
const current = () => { try { return fs.realpathSync(path.join(RDIR, 'current')); } catch { return ''; } };

// The daemon's npm check is faked: "the installed SDK is the newest", except where a phase says otherwise.
const SDK_NOW = JSON.parse(fs.readFileSync(path.join(REPO, 'server/node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version;
const env = cleanEnv({ IRO_TEST_SDK_LATEST: SDK_NOW, HOME, SHELL: SH, PATH: `${BIN}:${path.join(HERE, '..', 'fakebin')}:${process.env.PATH}` });
delete env.IRO_DIR;
const startClient = (extra = {}) => spawn(process.execPath, [CLIENT, '--host', 'fakebox', '--port', String(PORT)], { env: { ...env, ...extra }, stdio: 'inherit' });
const npmCalls = () => (fs.existsSync(NPM_LOG) ? fs.readFileSync(NPM_LOG, 'utf8') : '');

fs.writeFileSync(NPM_FAIL, '');
let client = startClient();
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { console.log('DIALOG:', d.message()); d.accept(); });
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
// Click the button, then wait for a new release and a daemon (only one) running from it.
async function update(what, { fixed = true } = {}) {
  const rel = current(), old = pid();
  await button().click();
  await until(() => current() !== rel, 20000, `${what}: a new release is installed`);
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
  check(one(pid()) && args(pid()).includes(current()), 'the daemon runs from its release folder');
  client.kill('SIGUSR2'); // the ssh pipe drops
  check(await until(async () => (await page.locator('#conn .dot.up').count()) === 0, 5000) && await page.locator('#conn .dot.up').waitFor({ timeout: 15000 }).then(() => true, () => false), 'reconnects after the ssh connection drops');

  // 2. A server running older code: Update server.
  fs.appendFileSync(path.join(RDIR, 'current', 'daemon.mjs'), '\n// an older version\n');
  await restart();
  await button().waitFor({ timeout: 5000 }).catch(() => {});
  check(await button().isVisible() && (await button().textContent()) === 'Update server' && /older/.test(await note()), `older code shows Update server (${await note()})`);
  await page.screenshot({ path: path.join(S, 'update-stale.png') });
  await update('older code');

  // 3. Up-to-date code, but a newer Agent SDK (Claude Code) on npm: the same button updates it.
  await restart({ IRO_TEST_SDK_LATEST: '99.0.0' });
  await button().waitFor({ timeout: 10000 }).catch(() => {});
  check(await button().isVisible() && /99\.0\.0 is out/.test(await note()), `a newer Claude Code shows the button too (${await note()})`);
  fs.rmSync(NPM_LOG, { force: true });
  await update('newer SDK', { fixed: false });
  check(/install .*@anthropic-ai\/claude-agent-sdk@latest/.test(npmCalls()), `the update installs the newest SDK (${npmCalls().trim().split('\n').join(' | ')})`);
  // The host can't fetch the newest SDK: the update goes through on the pinned one, and says so.
  fs.writeFileSync(NPM_LATEST_FAIL, '');
  await update('newest SDK unavailable', { fixed: false });
  await until(async () => /Updated, but could not fetch the newest Claude Code/.test(await note()), 10000, 'the note about the newest SDK');
  check(/E403/.test(await note()), `it says why (${await note()})`);
  fs.rmSync(NPM_LATEST_FAIL);
  // 4. client.mjs --stop over ssh: stops the daemon without starting one when none runs.
  const stopCli = () => execSync(`${process.execPath} ${CLIENT} --host fakebox --stop`, { env }).toString();
  check(/stopped the IroWell server on fakebox/.test(stopCli()) && !pid(), '--host fakebox --stop stops the daemon');
  check(/no IroWell server is running/.test(stopCli()) && !pid(), '--stop again: nothing runs, and nothing was started');

  // 5. This machine, with a newer SDK out: Update installs it into server/ (without touching package.json
  //    or the lock file) before restarting the daemon. The stub npm stands in for the real one.
  client.kill('SIGTERM');
  const localDir = path.join(S, 'update-local');
  fs.rmSync(localDir, { recursive: true, force: true });
  fs.rmSync(NPM_LOG, { force: true });
  client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: { ...env, HOME: process.env.HOME, IRO_DIR: localDir, IRO_TEST_SDK_LATEST: '99.0.0' }, stdio: 'inherit' });
  await until(async () => { try { await page.goto(`http://127.0.0.1:${PORT}/`); return true; } catch { return false; } }, 10000);
  await button().waitFor({ timeout: 15000 }).catch(() => {});
  check(await button().isVisible() && /99\.0\.0 is out/.test(await note()) && !/npm install/.test(await note()), `this machine: the button, and no npm by hand (${await note()})`);
  const sock = path.join(localDir, 'daemon.sock');
  await button().click();
  await until(() => /install --no-save .*@anthropic-ai\/claude-agent-sdk@latest/.test(npmCalls()), 10000, 'npm install --no-save …@latest in server/');
  await until(() => fs.readdirSync(localDir).some((f) => /^old-/.test(f)) || /retired/.test(fs.readFileSync(path.join(localDir, 'daemon.log'), 'utf8')), 15000, 'the local daemon restarts');
  killDaemon(localDir);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} finally {
  await browser.close();
  client.kill('SIGTERM');
  try { execSync(`pkill -f "${daemonPat}"`); } catch {}
}
finish();
