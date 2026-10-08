// A server where Claude Code isn't logged in (a fresh machine): the page says so up front, with the
// command that logs in, and the CLI's "Not logged in" answer never becomes an input suggestion.
// No model calls: the daemon runs with an empty HOME and Claude config folder.
// (A fake apiKeyHelper then stands in for logging in.)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT, outDir, browserPath, cleanEnv, killDaemon, addFolder, wait, log, check, until, finish } from '../lib.mjs';

const PORT = 4768;
const S = outDir();
const HOME = fs.mkdtempSync(path.join(S, 'nologin-home-'));
const WORK = path.join(HOME, 'work');
fs.mkdirSync(WORK);
const env = cleanEnv({ HOME, CLAUDE_CONFIG_DIR: path.join(HOME, '.claude') });
delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;

killDaemon();
await wait(500);
const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let clientOut = '';
client.stdout.on('data', (d) => (clientOut += d));
client.stderr.on('data', (d) => (clientOut += d));
await wait(1000);
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 30000 });

  // ---- the notice, with the server's own Claude Code as the command ----
  await page.locator('#loginNotice').waitFor({ timeout: 20000 });
  const cmd = await page.locator('#loginNotice code').textContent();
  log('login command:', cmd);
  check(/claude-agent-sdk-[^/]+\/claude(\.exe)? auth login$/.test(cmd), 'the notice names the bundled Claude Code: … auth login');
  check(/not logged in/i.test(await page.locator('#loginNotice').textContent()), 'the notice says Claude is not logged in');
  await page.screenshot({ path: path.join(S, 'login-notice.png') });
  check(await until(() => /Claude is not logged in on this machine: run .* auth login/.test(clientOut), 5000), 'the client says it in the terminal too');

  // ---- logging in from the page: the dialog links to the sign-in page and takes its code back ----
  await page.click('#loginBtn');
  const signIn = page.locator('.modal-body.login .login-open');
  await signIn.waitFor({ timeout: 25000 });
  const href = await signIn.getAttribute('href');
  log('sign-in link:', href.slice(0, 100) + '…');
  check(/^https:\/\/[\w.]*claude\.(com|ai)\/.*oauth\/authorize\?/.test(href), 'the dialog links to the sign-in page');
  check(/redirect_uri=http%3A%2F%2Flocalhost/.test(href), 'on this machine the page calls back to a local port (no code to paste)');
  await page.screenshot({ path: path.join(S, 'login-dialog.png') });
  await page.fill('.login-code', 'not-a-code');
  await page.press('.login-code', 'Enter');
  await page.waitForFunction(() => /invalid/i.test(document.querySelector('.login-err')?.textContent || ''), null, { timeout: 15000 });
  check(await page.locator('.login-code').isEnabled(), 'a malformed code: it says so and takes another');
  await page.fill('.login-code', 'wrong-code#wrong-state'); // (the token exchange refuses it, or there is no network: either way it ends)
  await page.click('.login-row button');
  await page.locator('.login-steps button', { hasText: 'Start again' }).waitFor({ timeout: 30000 });
  log('wrong code:', await page.locator('.login-err').textContent());
  check(true, 'a wrong code ends the login, with Start again');
  await page.click('.modal-body.login .linkish'); // Anthropic Console instead: a new login
  await signIn.waitFor({ timeout: 25000 });
  check(/Console/.test(await page.locator('.modal-body.login').textContent()), 'the Console choice starts a new login');
  await page.click('#modal .modal-head button');
  check(await page.locator('#modal').count() === 0, 'the dialog closes');

  // ---- a message: the CLI answers "Not logged in"; no suggestion is made of that ----
  await addFolder(page, WORK);
  await page.click(`.folder[data-dir="${fs.realpathSync(WORK)}"] .folder-new`);
  await page.fill('#input', '/login');
  await page.press('#input', 'Escape'); // (the completion list)
  await page.press('#input', 'Enter');
  await page.locator('.modal-body.login').waitFor({ timeout: 5000 });
  check(true, '/login opens the login dialog');
  await page.click('#modal .modal-head button');
  await page.fill('#input', 'say hi');
  await page.click('#send');
  await page.waitForFunction(() => /not logged in/i.test(document.getElementById('feed').textContent), null, { timeout: 30000 });
  check(true, 'the CLI\'s "Not logged in" shows in the turn');
  await wait(3000); // (a suggestion comes a moment after the turn)
  await page.screenshot({ path: path.join(S, 'login-sent.png') });
  const ghost = await page.evaluate(() => document.getElementById('ghost')?.textContent || '');
  check(!/not logged in/i.test(ghost), `no "Not logged in" input suggestion (${JSON.stringify(ghost.trim().slice(0, 80))})`);
  check(await page.locator('#loginNotice').isVisible(), 'the notice stays while it is not logged in');

  // ---- logging in (a stand-in: an apiKeyHelper counts as a login) makes the notice go by itself ----
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo sk-ant-test-not-a-key' }));
  check(await until(() => page.locator('#loginNotice').count().then((n) => n === 0), 25000), 'after the login, the notice goes away within ~15 s');
  check(!errors.length, `no page errors (${errors.join(' | ')})`);
} catch (e) {
  check(false, `crashed: ${e.message}`);
}
await browser.close();
client.kill();
killDaemon();
finish();
