// The server picker: a client started without --host / --local asks in the page which server to
// use. This machine comes first, then the servers connected to most recently, then the rest of
// ~/.ssh/config (Includes followed, patterns left out) in its own order. ssh is a stub that reaches no
// host (no network): the hosts are only listed and picked, never connected to.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, browserPath, cleanEnv, addFolder, check, until, finish, startClient, workDir, seen } from '../lib.mjs';

const HOME = workDir('picker-home', { // (only for ~/.ssh/config)
  '.ssh/config': ['Host iro-alpha', '  HostName alpha.example.com', '  User me', '',
    'Host *', '  ServerAliveInterval 30', '',
    'Include conf.d/*', '',
    'Host iro-beta iro-gamma', '  HostName 10.0.0.2',
    'Host !iro-nope iro-delta', ''].join('\n'),
  '.ssh/conf.d/extra': 'Host iro-epsilon\n  User root\n',
});
const BIN = workDir('picker-bin');
fs.writeFileSync(path.join(BIN, 'ssh'), '#!/bin/sh\nfor a; do [ "$a" = -G ] && exit 0; done\necho "ssh: connect to host: Network is unreachable" >&2\nexit 255\n', { mode: 0o755 });
const WORK = workDir('picker-work');
const env = cleanEnv({ HOME, PATH: `${BIN}:${process.env.PATH}` });

let { client } = await startClient(PORT, { env, host: null });
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const names = () => page.locator('#picker .pr-name').allTextContents();
const row = (name) => page.locator('#picker .picker-row', { has: page.locator('.pr-name', { hasText: new RegExp(`^${name}$`) }) });
const open = async () => { await page.goto(`http://127.0.0.1:${PORT}/`); return seen(page.locator('#picker .picker-row').first(), 10000); };
async function switchTo(name) {
  await page.click('#switchServer');
  await row(name).click();
  await page.locator('#picker').waitFor({ state: 'detached', timeout: 5000 });
}
// Connected, with this machine's one folder drawn (the folders come after the dot).
const home = () => seen(page.locator('#conn .dot.up'), 20000).then((up) => up && page.waitForFunction(() => document.querySelectorAll('.folder').length === 1, null, { timeout: 5000 }).then(() => true, () => false));

try {
  check(await open(), 'started without --host / --local, the page opens the picker');
  check(await page.locator('#picker .picker-close').isHidden(), 'it cannot be dismissed before a server is picked');
  check((await names()).join(',') === 'This machine,iro-alpha,iro-epsilon,iro-beta,iro-gamma,iro-delta',
    `this machine first, then ~/.ssh/config in its order with Includes, without patterns (${(await names()).join(', ')})`);
  check(/me@alpha\.example\.com/.test(await page.locator('#picker .picker-row').nth(1).textContent()), 'a host shows its user and HostName');

  await page.keyboard.press('Enter'); // the highlighted first row: this machine
  check(await seen(page.locator('#conn .dot.up'), 20000), 'Enter on "This machine" connects to the local daemon');
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
  await page.locator('#picker').waitFor({ state: 'detached', timeout: 5000 });
  await switchTo('This machine');
  check(await home(), 'back on this machine: its folder is back');

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
  check(await home(), 'a reload keeps the tab on its server');
  check(/iro-alpha/.test(await tab2.locator('#conn').textContent()), 'the other tab is still on its own');
  await tab2.close();

  // The order survives a restart of the client, which asks again.
  client.kill('SIGTERM');
  await new Promise((r) => client.on('exit', r));
  ({ client } = await startClient(PORT, { env, host: null, fresh: false }));
  check(await open(), 'a restarted client asks again');
  check((await names()).join(',') === 'This machine,iro-alpha,me@iro-typed,iro-gamma,iro-epsilon,iro-beta,iro-delta', `recent first, newest on top, this machine always first (${(await names()).join(', ')})`);

  // ✕ on a recent server takes it off the recent list: one from ~/.ssh/config goes back to its place
  // there, one typed in by hand leaves the list. Never-used hosts and this machine have none.
  check(await page.locator('#picker .pr-x').count() === 3 && await row('This machine').locator('.pr-x').count() === 0 && await row('iro-beta').locator('.pr-x').count() === 0,
    'only the recent servers have a ✕');
  await row('iro-alpha').hover();
  await row('iro-alpha').locator('.pr-x').click();
  await until(async () => (await names()).join(',') === 'This machine,me@iro-typed,iro-gamma,iro-alpha,iro-epsilon,iro-beta,iro-delta', 5000,
    '✕ on a host from ~/.ssh/config puts it back in its place there');
  check(await page.locator('#picker').count() === 1 && await page.locator('#conn .dot.up').count() === 0, 'the ✕ does not connect to it');
  await row('me@iro-typed').hover();
  await row('me@iro-typed').locator('.pr-x').click();
  await until(async () => (await names()).join(',') === 'This machine,iro-gamma,iro-alpha,iro-epsilon,iro-beta,iro-delta', 5000,
    '✕ on a typed-in host takes it off the list');
  await page.reload();
  await page.locator('#picker .picker-row').first().waitFor({ timeout: 10000 });
  check((await names()).join(',') === 'This machine,iro-gamma,iro-alpha,iro-epsilon,iro-beta,iro-delta', `and it stays that way (${(await names()).join(', ')})`);
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} finally {
  await browser.close();
  client.kill('SIGTERM');
}
finish();
