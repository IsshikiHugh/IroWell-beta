// A server where Claude Code isn't logged in (a fresh machine): the page says so up front, with the
// command that logs in, and the CLI's "Not logged in" answer never becomes an input suggestion. Logging in
// from the page takes the sign-in page's code; logged in from a terminal, the notice goes by itself.
// (login.fake.mjs plays the logged-out Claude Code: no network.)
import fs from 'node:fs';
import { PORT, cleanEnv, addFolder, check, until, startSuite, endSuite, workDir, seen, command, expectSoon } from '../lib.mjs';
import { LOGGED_IN, GOOD_CODE } from './login.fake.mjs';

const WORK = workDir('login-work');
const { client, page, browser, errors } = await startSuite(PORT, { env: cleanEnv({ IRO_AUTH_POLL_MS: '500' }), stdio: ['ignore', 'pipe', 'pipe'] });
let clientOut = '';
client.stdout.on('data', (d) => (clientOut += d));
client.stderr.on('data', (d) => (clientOut += d));
const notice = page.locator('#loginNotice');
const dialog = page.locator('.modal-body.login');
const signIn = dialog.locator('.login-open');

// ---- the notice, with the server's own Claude Code as the command ----
await notice.waitFor({ timeout: 20000 });
check(/claude-agent-sdk-[^/]+\/claude(\.exe)? auth login$/.test(await notice.locator('code').textContent()), 'the notice names the bundled Claude Code: … auth login');
check(/not logged in/i.test(await notice.textContent()), 'the notice says Claude is not logged in');
check(await until(() => /Claude is not logged in on this machine: run .* auth login/.test(clientOut), 5000), 'the client says it in the terminal too');

// ---- logging in from the page: the dialog links to the sign-in page and takes its code back ----
await page.click('#loginBtn');
await signIn.waitFor({ timeout: 10000 });
const href = await signIn.getAttribute('href');
check(/^https:\/\/[\w.]*claude\.(com|ai)\/.*oauth\/authorize\?/.test(href), 'the dialog links to the sign-in page');
check(/redirect_uri=http%3A%2F%2Flocalhost/.test(href), 'on this machine the page calls back to a local port (no code to paste)');
await page.fill('.login-code', 'not-a-code');
await page.press('.login-code', 'Enter');
await expectSoon(async () => /invalid/i.test(await dialog.locator('.login-err').textContent()) && await page.locator('.login-code').isEnabled(), 'a malformed code: it says so and takes another');
await page.fill('.login-code', 'wrong-code#wrong-state');
await page.click('.login-row button');
check(await seen(page.locator('.login-steps button', { hasText: 'Start again' }), 10000) && /Login failed/.test(await dialog.locator('.login-err').textContent()),
  `a wrong code ends the login, says why, and offers Start again (${await dialog.locator('.login-err').textContent()})`);
await dialog.locator('.linkish').click(); // Anthropic Console instead: a new login
await signIn.waitFor({ timeout: 10000 });
check(/Console/.test(await dialog.textContent()) && /platform\.claude\.com/.test(await signIn.getAttribute('href')), 'the Console choice starts a new login');
await page.click('#modal .modal-head button');
check(await page.locator('#modal').count() === 0, 'the dialog closes');

// ---- a message: the CLI answers "Not logged in"; no suggestion is made of that ----
await addFolder(page, WORK);
await page.click(`.folder[data-dir="${WORK}"] .folder-new`);
await command(page, '/login');
check(await seen(dialog), '/login opens the login dialog');
await page.click('#modal .modal-head button');
await page.fill('#input', 'say hi');
await page.click('#send');
check(await seen(page.locator('.turn-foot .meta.result'), 15000) && /not logged in/i.test(await page.locator('#feed').textContent()), 'the CLI\'s "Not logged in" shows in the turn');
const ghost = await page.evaluate(() => document.getElementById('ghost')?.textContent || '');
check(!/not logged in/i.test(ghost), `no "Not logged in" input suggestion (${JSON.stringify(ghost.trim().slice(0, 80))})`);
check(await notice.isVisible(), 'the notice stays while it is not logged in');

// ---- logged in from a terminal: the notice goes by itself (the daemon asks again while logged out) ----
fs.writeFileSync(LOGGED_IN, '');
check(await until(async () => await notice.count() === 0, 10000), 'after a login elsewhere, the notice goes away by itself');

// ---- a code the sign-in page gave: the login ends, the dialog closes and says so ----
await command(page, '/login');
await signIn.waitFor({ timeout: 10000 });
check(/logged in already/.test(await dialog.textContent()), 'logged in, the dialog says it replaces that login');
await page.fill('.login-code', GOOD_CODE);
await page.press('.login-code', 'Enter');
check(await page.locator('#modal').waitFor({ state: 'detached', timeout: 10000 }).then(() => true, () => false)
  && await seen(page.locator('.toast', { hasText: 'Claude is logged in' })), 'a good code logs in: the dialog closes, and the page says so');

await endSuite({ browser, client, errors });
