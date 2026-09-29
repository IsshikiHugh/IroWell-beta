// "Update server" button: a stale deployed daemon is updated from the UI (fake ssh/scp, remote ==
// a scratch $HOME on this machine, npm stubbed out so no network is needed). First from the old
// single-folder layout (a daemon from before rolling updates: restarted once idle), then from one
// release to the next (the old daemon hands over and exits).
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath } from '../lib.mjs';
import { spawn, execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4787;
const HOME = path.join(S, 'fakehome');
const RDIR = path.join(HOME, '.iro-coding');
const BIN = path.join(S, 'stubbin');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(RDIR, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
const NPM_LOG = path.join(S, 'npm-calls.log');
fs.writeFileSync(path.join(BIN, 'npm'), `#!/bin/sh\necho "$*" >> '${NPM_LOG}'\nexit 0\n`, { mode: 0o755 });
// The remote commands run in a login shell (`$SHELL -lc`), and macOS's login profile rebuilds PATH,
// which would find the real npm (network, minutes). This shell ignores -l so the stub stays first.
const SH = path.join(BIN, 'sh');
fs.writeFileSync(SH, '#!/bin/sh\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
// An "older" deploy in the old layout: the daemon of the first commit (before rolling updates).
const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: REPO }).toString().trim();
for (const f of ['package.json', 'daemon.mjs', 'attach.mjs']) fs.writeFileSync(path.join(RDIR, f), execFileSync('git', ['show', `${first}:server/${f}`], { cwd: REPO }));
fs.symlinkSync(path.join(REPO, 'server', 'node_modules'), path.join(RDIR, 'node_modules'));
const daemonPat = `${RDIR}/.*daemon[.]mjs`; // the old layout's daemon.mjs and every release's
const pid = () => { try { return execSync(`pgrep -f "${daemonPat}"`).toString().trim(); } catch { return ''; } };

// The daemon's npm check is faked: first "the installed SDK is the newest", later "a newer one is out".
const SDK_NOW = JSON.parse(fs.readFileSync(path.join(REPO, 'server/node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version;
const env = { ...process.env, IRO_TEST_SDK_LATEST: SDK_NOW, HOME, SHELL: SH, PATH: `${BIN}:${path.join(HERE, '..', 'fakebin')}:${process.env.PATH}` };
delete env.IRO_DIR;
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k)) delete env[k];
let failures = 0;
const check = (ok, what) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };
const startClient = (extra = {}) => spawn(process.execPath, [CLIENT, '--host', 'fakebox', '--port', String(PORT)], { env: { ...env, ...extra }, stdio: 'inherit' });
let client = startClient();
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { console.log('DIALOG:', d.message()); d.accept(); });
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
  await page.locator('#updateServer').waitFor({ timeout: 5000 }).catch(() => {});
  check(await page.locator('#updateServer').isVisible() && /older/.test(await page.locator('#conn .conn-err').textContent().catch(() => '')), 'a stale server shows an Update server button');
  await page.screenshot({ path: path.join(S, 'update-stale.png') });
  const before = pid();
  await page.click('#updateServer');
  const released = () => { const p = pid(); return p && !p.includes('\n') && execSync(`ps -o args= -p ${p}`).toString().includes('/releases/'); };
  for (let i = 0; i < 150 && !released(); i++) await new Promise((r) => setTimeout(r, 200));
  await page.waitForFunction(() => !document.getElementById('updateServer') && !!document.querySelector('#conn .dot.up') && !document.querySelector('#conn .conn-err'), null, { timeout: 30000 }).catch(() => {});
  check(await page.locator('#updateServer').count() === 0 && await page.locator('#conn .conn-err').count() === 0, 'after the update the button and the warning are gone');
  check(fs.readFileSync(path.join(RDIR, 'current', 'daemon.mjs'), 'utf8') === fs.readFileSync(path.join(REPO, 'server', 'daemon.mjs'), 'utf8'), 'the new daemon code was installed as a release');
  const after = pid();
  check(before && after && before !== after && !after.includes('\n'), `the old-layout daemon was restarted, once idle (${before} -> ${after})`);
  const rel1 = fs.realpathSync(path.join(RDIR, 'current'));
  check(execSync(`ps -o args= -p ${after}`).toString().includes(rel1), 'the new daemon runs from its release folder');

  // Up-to-date code, but a newer Agent SDK (Claude Code) on npm: the same button updates it.
  client.kill('SIGTERM');
  try { execSync(`pkill -f "${daemonPat}"`); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  client = startClient({ IRO_TEST_SDK_LATEST: '99.0.0' });
  await new Promise((r) => setTimeout(r, 1000));
  await page.reload();
  await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
  await page.locator('#updateServer').waitFor({ timeout: 10000 }).catch(() => {});
  const note = await page.locator('#conn .conn-err').textContent().catch(() => '');
  check(await page.locator('#updateServer').isVisible() && /99\.0\.0 is out/.test(note), `a newer Claude Code shows the button too (${note})`);
  await page.screenshot({ path: path.join(S, 'update-sdk.png') });
  fs.rmSync(NPM_LOG, { force: true });
  await page.click('#updateServer');
  for (let i = 0; i < 100 && !/@latest/.test(fs.existsSync(NPM_LOG) ? fs.readFileSync(NPM_LOG, 'utf8') : ''); i++) await new Promise((r) => setTimeout(r, 200));
  const calls = fs.existsSync(NPM_LOG) ? fs.readFileSync(NPM_LOG, 'utf8') : '';
  check(/install .*@anthropic-ai\/claude-agent-sdk@latest/.test(calls), `the update installs the newest SDK (${calls.trim().split('\n').join(' | ')})`);
  // release to release: the running daemon hands over to the new one and exits
  const old = pid();
  for (let i = 0; i < 100 && fs.realpathSync(path.join(RDIR, 'current')) === rel1; i++) await new Promise((r) => setTimeout(r, 200));
  const rel2 = fs.realpathSync(path.join(RDIR, 'current'));
  check(rel2 !== rel1, 'a second release was installed');
  for (let i = 0; i < 100 && !(pid() && pid() !== old && !pid().includes('\n')); i++) await new Promise((r) => setTimeout(r, 200));
  const now = pid();
  check(now && now !== old && !now.includes('\n') && execSync(`ps -o args= -p ${now}`).toString().includes(rel2), `the old daemon handed over and exited (${old} -> ${now})`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
  check(!fs.readdirSync(RDIR).some((f) => /^old-[0-9a-f]{8}\.sock$/.test(f)), 'no retiring daemon left behind');
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} finally {
  await browser.close();
  client.kill('SIGTERM');
  try { execSync(`pkill -f "${daemonPat}"`); } catch {}
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
