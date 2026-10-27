// What the update suites share (update, update2, update3): a stand-in host (fake ssh, its home a scratch folder on
// this machine) whose npm is a stub, so no network is needed, and the page's update button, read and clicked.
// A server whose code differs from this client's gets the new release installed by itself and then shows
// "Reconnect to update": only a click on that makes the old daemon hand over and exit.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { REPO, PORT, browserPath, answerDialogs, onFail, outDir, check, until, fakeHost, startClient, workDir, seen } from '../lib.mjs';

export const RECONNECT = 'Reconnect to update';

// The rig for host `name` (short: see fakeHost); `installed`: IroWell is on it already (else the client installs
// it by itself on the first start); `env`: more for the client.
export async function updateRig(name, { installed = false, env: extra = {} } = {}) {
  const BIN = workDir(`${name}-bin`);
  // npm: logs its arguments and lends a release the checkout's packages. Switches (files): it fails while `fail`
  // exists, fetching @latest fails while `latestFail` does, and the release it installs has a daemon that dies on
  // start while `brk` does. `badCli` is a queue, one line taken by each fetch of a release's packages: "bad" makes
  // them with a damaged Claude Code (it answers like a bare Bun; the SDK itself is a copy, so it looks there too),
  // "own" with a stand-in that answers like Claude Code, in the release's own folder, for the test to damage later.
  const flag = { fail: path.join(BIN, 'fail'), latestFail: path.join(BIN, 'latest-fail'), brk: path.join(BIN, 'break'), badCli: path.join(BIN, 'bad-cli') };
  const NPM_LOG = path.join(BIN, 'npm-calls.log'), MODULES = path.join(REPO, 'server', 'node_modules');
  fs.writeFileSync(path.join(BIN, 'npm'), `#!/bin/sh
echo "$*" >> '${NPM_LOG}'
if [ -e '${flag.fail}' ]; then echo "npm: no network" >&2; exit 1; fi
case "$*" in *@latest*) if [ -e '${flag.latestFail}' ]; then echo "npm error code E403" >&2; exit 1; fi;; esac
if [ -e '${flag.brk}' ] && ! grep -q boom daemon.mjs; then { echo 'if (!process.argv.includes("--check-cli")) throw new Error("boom");'; cat daemon.mjs; } > daemon.tmp && mv daemon.tmp daemon.mjs; fi
if [ -s '${flag.badCli}' ] && { [ ! -e node_modules ] || [ -L node_modules ]; }; then
  kind=$(head -n 1 '${flag.badCli}'); tail -n +2 '${flag.badCli}' > '${flag.badCli}.t'; mv '${flag.badCli}.t' '${flag.badCli}'
  rm -f node_modules; mkdir node_modules
  ln -s '${MODULES}'/* '${MODULES}'/.[!.]* node_modules/ 2>/dev/null; rm node_modules/@anthropic-ai; mkdir node_modules/@anthropic-ai
  ln -s '${MODULES}'/@anthropic-ai/* node_modules/@anthropic-ai/
  for f in '${MODULES}'/@anthropic-ai/claude-agent-sdk*; do b=\${f##*/}; rm "node_modules/@anthropic-ai/$b"; case "$b" in
    claude-agent-sdk) cp -R "$f" node_modules/@anthropic-ai/;;
    *) mkdir "node_modules/@anthropic-ai/$b"; cp "$f/package.json" "node_modules/@anthropic-ai/$b/"
      if [ "$kind" = own ]; then v='2.1.296 (Claude Code)'; else v=1.4.3; fi
      printf '#!/bin/sh\\necho "%s"\\n' "$v" > "node_modules/@anthropic-ai/$b/claude"; chmod +x "node_modules/@anthropic-ai/$b/claude";;
    esac; done
fi
[ -e node_modules ] || ln -s '${MODULES}' node_modules
exit 0
`, { mode: 0o755 });
  // The client's skills/: a copy, so the test can edit it (an edit makes the server's code older than the client's).
  const SKILLS = path.join(workDir(`${name}-client`), 'skills'); // (named skills/: a release gets it under its own name)
  fs.cpSync(path.join(REPO, 'skills'), SKILLS, { recursive: true });
  const LINGER = path.join(BIN, 'ssh-linger'); // see test/fakebin/ssh
  // (IRO_SKILLS_DIR is the client's only: a release has its own skills/)
  const host = fakeHost(name, { installed, bin: [BIN], shellEnv: { IRO_SKILLS_DIR: '' },
    extra: { IRO_SKILLS_DIR: SKILLS, IRO_AUTO_UPDATE_MS: '500', IRO_UPDATE_RETRY_MS: '2000', FAKE_SSH_LINGER: LINGER, ...extra } });
  const RDIR = host.dir;

  const daemonPat = `${RDIR}/.*daemon[.]mjs`; // every release's daemon
  const pid = () => { try { return execSync(`pgrep -f "${daemonPat}"`).toString().trim(); } catch { return ''; } };
  const one = (p) => !!p && !p.includes('\n');
  const args = (p) => { try { return execSync(`ps -o args= -p ${p}`).toString(); } catch { return ''; } }; // ('' once it has exited)
  const current = () => { try { return fs.realpathSync(path.join(RDIR, 'current')); } catch { return ''; } };
  const newest = () => fs.readdirSync(path.join(RDIR, 'releases')).sort().pop();
  const retiring = () => fs.readdirSync(RDIR).some((f) => /^old-[0-9a-f]{8}\.sock$/.test(f));
  const npmCalls = () => (fs.existsSync(NPM_LOG) ? fs.readFileSync(NPM_LOG, 'utf8') : '');
  const npmReset = () => fs.rmSync(NPM_LOG, { force: true });
  const installs = () => npmCalls().split('\n').filter((l) => l === 'install --omit=dev --no-audit --no-fund').length;
  let edits = 0;
  const newer = () => fs.appendFileSync(path.join(SKILLS, 'system-prompt.md'), `\nAn edit (${++edits}).\n`); // (the server's code is older now)
  const killDaemons = () => { try { execSync(`pkill -f "${daemonPat}"`); } catch {} };

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: browserPath() });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await answerDialogs(page);
  onFail((n) => page.screenshot({ path: path.join(outDir(), `fail-${name}-${n}.png`) }).catch(() => {}));
  const up = page.locator('#conn .dot.up');
  const button = page.locator('#updateServer');
  // The note, and the button's label and its reason, as they are now ('' when there is none: a locator would wait).
  const note = () => page.evaluate(() => document.querySelector('#conn .conn-err')?.textContent || '').catch(() => '');
  const label = () => page.evaluate(() => document.getElementById('updateServer')?.textContent || '').catch(() => '');
  const reason = () => page.evaluate(() => document.getElementById('updateServer')?.title || '').catch(() => '');

  const r = { RDIR, SKILLS, LINGER, flag, env: host.env, page, browser, errors, button, up, client: null,
    pid, one, args, current, newest, retiring, npmCalls, npmReset, installs, newer, note, label, reason, killDaemons };
  // The client (`extra`: more for its environment), and the page on it (not waiting for the connection).
  r.start = async (more = {}) => {
    ({ client: r.client } = await startClient(PORT, { env: { ...host.env, ...more }, host: name, fresh: false }));
    await page.goto(`http://127.0.0.1:${PORT}/`);
  };
  // The client alone started again (`more` for its environment); its daemon runs on.
  r.restartClient = async (more) => {
    const exited = r.client.exitCode == null && r.client.signalCode == null && new Promise((res) => r.client.once('exit', res));
    r.client.kill('SIGTERM');
    await exited;
    await r.start(more);
    await up.waitFor({ timeout: 20000 });
  };
  // The client started again against a daemon that is gone, so the next hello comes from a fresh one.
  r.restart = async (more) => {
    r.client.kill('SIGTERM');
    killDaemons();
    await until(() => !pid(), 5000);
    await r.start(more);
    await up.waitFor({ timeout: 20000 });
  };
  // The update installed by itself: Reconnect shows, and the old daemon still runs its own release, which
  // stays current (what a daemon started meanwhile would run); the new release waits beside it.
  r.prepared = async (what, ms = 30000) => {
    const old = pid();
    check(await until(async () => (await label()) === RECONNECT, ms), `${what}: the update is prepared by itself, then Reconnect shows (${await label()})`);
    check(pid() === old && args(old).includes(current()) && path.basename(current()) !== newest(),
      `${what}: nothing switches until asked (the old daemon still runs, and its release is still current; the new one waits in ${newest()})`);
  };
  // Click the button, then wait for a new release and a daemon (only one) running from it. `ahead`: the
  // release was installed before the click. `fixed`: afterwards the server is up to date (no button, no note).
  r.update = async (what, { fixed = true, ahead = true } = {}) => {
    const rel = current(), old = pid();
    await button.click();
    if (!ahead) await until(() => current() !== rel, 20000, `${what}: a new release is installed`);
    await until(() => { const p = pid(); return one(p) && p !== old && args(p).includes(current()); }, 20000, `${what}: the old daemon hands over and exits (${old} -> ${pid()})`);
    await seen(up, 20000);
    check(!retiring(), `${what}: no retiring daemon left behind`);
    if (!fixed) return;
    check(await page.waitForFunction(() => !document.getElementById('updateServer') && !document.querySelector('#conn .conn-err'), null, { timeout: 30000 }).then(() => true, () => false),
      `${what}: afterwards the button and the note are gone`);
  };
  r.close = async () => {
    await browser.close();
    r.client?.kill('SIGTERM');
    killDaemons();
  };
  return r;
}
