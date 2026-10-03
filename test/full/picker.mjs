// The server picker: a client started without --host / --local asks in the page which server to
// use. This machine comes first, then the servers connected to most recently, then the rest of
// ~/.ssh/config (Includes followed, patterns left out) in its own order. No model calls.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT, outDir, browserPath, cleanEnv, addFolder, killDaemon, check, until, finish } from '../lib.mjs';

const S = outDir();
const PORT = 4769;
const HOME = path.join(S, 'picker-home'); // only for ~/.ssh/config: the ssh binary itself reads the real one
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, '.ssh', 'conf.d'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.ssh', 'config'), [
  'Host iro-alpha', '  HostName alpha.example.com', '  User me', '',
  'Host *', '  ServerAliveInterval 30', '',
  'Include conf.d/*', '',
  'Host iro-beta iro-gamma', '  HostName 10.0.0.2',
  'Host !iro-nope iro-delta', '',
].join('\n'));
fs.writeFileSync(path.join(HOME, '.ssh', 'conf.d', 'extra'), 'Host iro-epsilon\n  User root\n');
const WORK = path.join(S, 'picker-work');
fs.mkdirSync(WORK, { recursive: true });

const env = cleanEnv({ HOME });
let client = null;
const startClient = () => { client = spawn(process.execPath, [CLIENT, '--port', String(PORT)], { env, stdio: 'inherit' }); };
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const names = () => page.locator('#picker .pr-name').allTextContents();
async function open() {
  await until(async () => { try { await page.goto(`http://127.0.0.1:${PORT}/`); return true; } catch { return false; } }, 10000);
  return page.locator('#picker .picker-row').first().waitFor({ timeout: 10000 }).then(() => true, () => false);
}
async function switchTo(name) {
  await page.click('#switchServer');
  await page.locator('#picker .picker-row').first().waitFor({ timeout: 5000 });
  await page.locator('#picker .picker-row', { has: page.locator('.pr-name', { hasText: new RegExp(`^${name}$`) }) }).click();
  await page.locator('#picker').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

try {
  startClient();
  check(await open(), 'started without --host / --local, the page opens the picker');
  check(await page.locator('#picker .picker-close').isHidden(), 'it cannot be dismissed before a server is picked');
  check((await names()).join(',') === 'This machine,iro-alpha,iro-epsilon,iro-beta,iro-gamma,iro-delta',
    `this machine first, then ~/.ssh/config in its order with Includes, without patterns (${(await names()).join(', ')})`);
  check(/me@alpha\.example\.com/.test(await page.locator('#picker .picker-row').nth(1).textContent()), 'a host shows its user and HostName');

  await page.keyboard.press('Enter'); // the highlighted first row: this machine
  check(await page.locator('#conn .dot.up').waitFor({ timeout: 20000 }).then(() => true, () => false), 'Enter on "This machine" connects to the local daemon');
  check(await page.locator('#picker').count() === 0, 'the picker closes');
  await addFolder(page, WORK);

  await switchTo('iro-gamma');
  await until(async () => /iro-gamma/.test(await page.locator('#conn').textContent()), 5000, 'the page names the new server');
  check(await page.locator('.folder').count() === 0, 'nothing of the previous server stays on the page');
  await page.click('#switchServer');
  await page.locator('#picker .picker-row').first().waitFor({ timeout: 5000 });
  check((await names()).join(',') === 'This machine,iro-gamma,iro-alpha,iro-epsilon,iro-beta,iro-delta', `the server used last moves up, below this machine (${(await names()).join(', ')})`);
  check(/current/.test(await page.locator('#picker .picker-row').nth(1).textContent()), 'the current server is marked');

  // a host that isn't in ~/.ssh/config, typed in
  await page.fill('#picker .picker-filter', 'me@iro-typed');
  check((await names()).join(',') === 'Connect to me@iro-typed', 'a typed host is offered');
  await page.keyboard.press('Enter');
  await page.locator('#picker').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await switchTo('This machine');
  check(await page.locator('#conn .dot.up').waitFor({ timeout: 20000 }).then(() => true, () => false) && await page.locator('.folder').count() === 1, 'back on this machine: its folder is back');

  // Each tab has its own server: Ctrl+Enter in the picker opens another one in a new tab, and this tab
  // stays where it is (both connected at once).
  await page.click('#switchServer');
  await page.locator('#picker .picker-row').first().waitFor({ timeout: 5000 });
  await page.fill('#picker .picker-filter', 'iro-alpha');
  const [tab2] = await Promise.all([page.context().waitForEvent('page'), page.keyboard.press('Control+Enter')]);
  await tab2.waitForLoadState();
  tab2.on('pageerror', (e) => errors.push(e.message));
  await until(async () => /iro-alpha/.test(await tab2.locator('#conn').textContent()), 10000, 'the new tab shows the other server');
  check(new URL(tab2.url()).searchParams.get('server') === 'ssh:iro-alpha', `the new tab's URL names its server (${tab2.url()})`);
  check(await page.locator('#picker').count() === 0 && await page.locator('#conn .dot.up').count() === 1 && await page.locator('.folder').count() === 1,
    'this tab stays on this machine, connected, with its folder');
  check(new URL(page.url()).searchParams.get('server') === 'local', "this tab's URL names its server too");
  await page.reload();
  check(await page.locator('#conn .dot.up').waitFor({ timeout: 20000 }).then(() => true, () => false) && await page.locator('.folder').count() === 1, 'a reload keeps the tab on its server');
  check(/iro-alpha/.test(await tab2.locator('#conn').textContent()), 'the other tab is still on its own');
  await tab2.close();

  // The order survives a restart of the client, which asks again.
  client.kill('SIGTERM');
  await new Promise((r) => client.on('exit', r));
  startClient();
  check(await open(), 'a restarted client asks again');
  check((await names()).join(',') === 'This machine,iro-alpha,me@iro-typed,iro-gamma,iro-epsilon,iro-beta,iro-delta', `recent first, newest on top, this machine always first (${(await names()).join(', ')})`);
  await page.screenshot({ path: path.join(S, 'picker.png') });
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} finally {
  await browser.close();
  client?.kill('SIGTERM');
  killDaemon();
}
finish();
