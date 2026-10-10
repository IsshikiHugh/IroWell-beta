// Ports of a server at localhost on this computer (no model calls; fake ssh, whose "remote" is this
// machine): added from the page and by a session on the server (skills/remote/port.mjs), listed with the
// forwards of ~/.ssh/config, dropped again, and brought back when the forwards ssh restarts. And what a
// session on a server is told about being remote.
import { REPO, CLIENT, outDir, cleanEnv, killDaemon, check, until, finish, clientApi, wait, eventStream, browserPath, answerDialogs } from '../lib.mjs';
import { spawn, execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4771;
const HOME = path.join(S, 'portbox-home');
const RDIR = path.join(HOME, '.iro-coding'); // the server's state
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(RDIR, { recursive: true });
fs.symlinkSync(path.join(REPO, 'server', 'attach.mjs'), path.join(RDIR, 'attach.mjs')); // "installed": the checkout's daemon
// The server's shell: no IRO_DIR there, so its daemon keeps its state in its own ~/.iro-coding.
const SH = path.join(S, 'portbox-sh');
fs.writeFileSync(SH, '#!/bin/sh\nunset IRO_DIR\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
// What `ssh -G portbox` prints: one plain forward, and two that are no port of the host at localhost.
const SSH_G = path.join(S, 'portbox-ssh-g');
fs.writeFileSync(SSH_G, 'user me\nlocalforward 45991 [localhost]:45992\nlocalforward 45993 [otherhost]:80\nremoteforward 9000 [localhost]:9001\n');
const env = cleanEnv({ HOME, SHELL: SH, PATH: `${path.join(HERE, '..', 'fakebin')}:${process.env.PATH}`, IRO_NO_USAGE_RECORD: '1', FAKE_SSH_G: SSH_G });

// Something served on the "server": an HTTP server that says its name. (get: a new connection each time.)
const serve = (name) => new Promise((resolve) => {
  const s = http.createServer((q, res) => res.end(`hello from ${name}`));
  s.listen(0, '127.0.0.1', () => resolve(s));
});
const get = (port) => new Promise((resolve) => {
  const r = http.get({ host: 'localhost', port, path: '/', timeout: 3000, agent: false }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => resolve(b)); });
  r.on('error', () => resolve(null));
  r.on('timeout', () => { r.destroy(); resolve(null); });
});
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); }); });
// One command straight to the server daemon's socket (as client.mjs and the skill's script send theirs).
const ask = (cmd) => new Promise((resolve) => {
  const sock = net.connect(path.join(RDIR, 'daemon.sock'));
  let buf = '';
  const end = (v) => { sock.destroy(); resolve(v); };
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      let m;
      try { m = JSON.parse(buf.slice(0, i)); } catch {}
      buf = buf.slice(i + 1);
      if (m?.type === 'hello') sock.write(JSON.stringify({ ...cmd, id: 1 }) + '\n');
      else if (m?.type === 'reply' && m.id === 1) end(m);
    }
  });
  sock.on('error', () => end(null));
  setTimeout(() => end(null), 8000);
});
// The skill's script, run on the "server" as a session's Bash would.
const script = (...ports) => new Promise((resolve) => execFile(process.execPath, [path.join(REPO, 'skills', 'remote', 'port.mjs'), ...ports.map(String)],
  { env: { ...env, IRO_DIR: '' }, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: String(stdout) + String(stderr) })));

const [A, B, C, D] = await Promise.all(['A', 'B', 'C', 'D'].map(serve));
const [a, b, c] = [A, B, C].map((s) => s.address().port);
const client = spawn(process.execPath, [CLIENT, '--host', 'portbox', '--port', String(PORT)], { env, stdio: 'inherit' });
let browser = null;
try {
  const { token, req, cmd } = await clientApi(PORT);
  const st = eventStream(PORT, token);
  const ports = () => st.msgs.filter((m) => m.type === 'transport').at(-1)?.ports || [];
  const of = (remote) => ports().find((p) => p.remote === remote);
  await until(() => st.up, 30000, 'the server is connected');

  // ---- ~/.ssh/config's forwards are listed, and a port they cover is answered as it is ----
  await until(() => ports().length === 1, 10000, 'the forward of ~/.ssh/config is listed');
  check(JSON.stringify(ports()) === JSON.stringify([{ remote: 45992, local: 45991, by: 'config' }]), `only a port of the host at localhost counts (${JSON.stringify(ports())})`);
  check((await cmd({ type: 'openPort', port: 45992 })).data?.local === 45991 && ports().length === 1, 'asking for a port ~/.ssh/config forwards answers with that forward');
  check(/ssh\/config/.test((await cmd({ type: 'closePort', port: 45992 })).error || ''), 'and it is not closed from here');

  // ---- a port added from the page ----
  const opened = await cmd({ type: 'openPort', port: a });
  const la = opened.data?.local;
  check(opened.data?.remote === a && la && la !== a && opened.data.why === 'taken', `a port that is taken on this computer gets another local port, and says why (${a} → ${la}; ${opened.error || opened.data?.why})`);
  check(await get(la) === 'hello from A', `localhost:${la} reaches the server's port ${a}`);
  await until(() => of(a) && !of(a).opening, 5000);
  check(of(a)?.local === la && of(a).by === 'user' && of(a).why === 'taken' && !of(a).error, `the page lists it (${JSON.stringify(of(a))})`);
  check((await cmd({ type: 'openPort', port: a })).data?.local === la && ports().filter((p) => p.remote === a).length === 1, 'asked again, it is the same forward');
  const free = await freePort();
  const kept = await cmd({ type: 'openPort', port: free });
  check(kept.data?.local === free && kept.data.why === '', `a port that is free here keeps its number (${free})`);
  // the local port can be named: that one, or (when it is not free here) nothing
  const [d, ld] = [D.address().port, await freePort()];
  const chosen = await cmd({ type: 'openPort', port: d, local: ld });
  check(chosen.data?.local === ld && chosen.data.why === 'chosen' && await get(ld) === 'hello from D' && of(d)?.why === 'chosen', `a port forwarded to a local port of your choice (${d} → localhost:${ld}; ${chosen.error || 'ok'})`);
  const e = await freePort();
  const taken = await cmd({ type: 'openPort', port: e, local: a });
  await until(() => !of(e), 3000); // (the page's stream is another connection than the reply's)
  check(/localhost:\d+ is not free on this computer/.test(taken.error || '') && !of(e), `a local port that is taken here is refused, and nothing is forwarded (${taken.error})`);
  const move = await cmd({ type: 'openPort', port: d, local: e });
  check(/already: remove that forward first/.test(move.error || '') && of(d)?.local === ld, `a port that is forwarded stays where it is (${move.error})`);
  check((await cmd({ type: 'openPort', port: d })).data?.local === ld, 'and asked for without a local port, it answers where it is');
  check(/ssh\/config/.test((await cmd({ type: 'openPort', port: 45992, local: e })).error || ''), 'one of ~/.ssh/config is moved there, not here');
  const bad = await Promise.all([...['abc', 0, 70000, 1.5].map((port) => ({ port })), ...['x', 0, 70000].map((local) => ({ port: e, local }))].map((x) => cmd({ type: 'openPort', ...x })));
  check(bad.every((r) => /number from 1 to 65535/.test(r.error || '')) && !of(e), `what is not a port is refused, as a local port too (${[...new Set(bad.map((r) => r.error || 'ok'))].join(' | ')})`);

  // ---- a session on the server asks for one (skills/remote/port.mjs → daemon → this client) ----
  const viaPage = await req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ type: 'portRequest', port: b }) });
  check(viaPage.status === 400 && !of(b), `the page cannot send the daemon's side of it (${viaPage.status})`);
  const asked = await script(b, a);
  const lb = Number(new RegExp(`^${b} -> http://localhost:(\\d+)/`, 'm').exec(asked.out)?.[1]);
  check(asked.code === 0 && lb && lb !== b && asked.out.includes(`${a} -> http://localhost:${la}/`) && asked.out.includes(`(port ${b} here is local port ${lb} for the user: ${b} is taken on the user's computer)`),
    `the script prints where each port is on the user's computer, and why that is another number (${asked.out.trim().replace(/\n/g, ' | ')})`);
  const [f, lf] = [await freePort(), await freePort()];
  const named = await script(`${f}:${lf}`, `${d}`, `${e}:${la}`);
  await until(() => of(f) && !of(f).opening && !of(e), 3000);
  check(named.code === 1 && named.out.includes(`${f} -> http://localhost:${lf}/   (port ${f} here is local port ${lf} for the user: the local port chosen for it)`) && named.out.includes(`${d} -> http://localhost:${ld}/`)
    && new RegExp(`^${e}: localhost:${la} is not free on the user's computer`, 'm').test(named.out) && of(f)?.local === lf && !of(e),
    `<port>:<local port> names the local port; one forwarded already answers where it is; a local port that is taken is said (${named.out.trim().replace(/\n/g, ' | ')})`);
  check(await get(lb) === 'hello from B', `localhost:${lb} reaches the server's port ${b}`);
  check(of(b)?.by === 'claude' && of(a)?.by === 'user', 'the page lists it as asked for by Claude; one the user added stays theirs');
  const none = await script('nope');
  check(none.code === 2 && /usage/.test(none.out), 'the script refuses what is not a port');

  // ---- whether each side has a port: something listens on the server's, something has the local one ----
  const idle = await freePort();
  const busy = (await cmd({ type: 'portStatus', local: [la, lf, idle], remote: [a, f, 'x', 0], free: [a, la, idle] })).data;
  check(JSON.stringify(busy?.remote) === JSON.stringify({ [a]: true, [f]: false }), `the server says which of its ports something listens on (${JSON.stringify(busy?.remote)})`);
  check(busy?.local[la] === true && busy.local[lf] === true && busy.local[idle] === false, `a forward's local port is in use here, an unused one is not (${JSON.stringify(busy?.local)})`);
  check(busy?.free[a] === false && busy.free[la] === false && busy.free[idle] === true, `and a forward could take only the one nothing has (${JSON.stringify(busy?.free)})`);
  const viaPage2 = await req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ type: 'portsBusy', ports: [a] }) });
  check(viaPage2.status === 400, `the page asks the client, not the daemon (${viaPage2.status})`);

  // ---- what a session there is told: it is remote, by which ssh name, and to hand out localhost URLs ----
  const prompt = (await ask({ type: 'uiPrompt' }))?.data || '';
  check(prompt.includes('# IroWell UI') && prompt.includes('# Remote machine') && prompt.includes('SSH as `portbox`') && prompt.includes(`\`${os.hostname()}\``) && !prompt.includes('{{'),
    `the system prompt of a session on a server has the remote part, with the ssh name and the host's own (${prompt.split('# Remote machine')[1]?.trim().split('\n')[1]?.slice(0, 90)})`);
  check(JSON.parse(fs.readFileSync(path.join(RDIR, 'reach.json'), 'utf8')).ssh === 'portbox', 'the daemon keeps where the user is, for a session that starts with no client connected');

  // ---- the page: the plug next to the server's name ----
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath: browserPath() });
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await answerDialogs(page);
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 15000 });
  check(ports().length === 6 && await page.locator('#portsBtn .conn-count').textContent() === '6', 'the connection line has a Ports button with the number forwarded');
  await page.click('#portsBtn');
  const rows = page.locator('.modal-body.ports .pt-row');
  await rows.first().waitFor({ timeout: 5000 });
  const text = async (port) => (await page.locator(`.pt-row[data-port="${port}"]`).textContent()).replace(/\s+/g, ' ');
  check(await rows.count() === 6 && (await text(45992)).includes('~/.ssh/config') && (await text(b)).includes('Claude') && (await text(a)).includes('you'), `its dialog lists each port and who added it (${await text(b)})`);
  check((await text(a)).includes(`localhost:${la}→ portbox:${a}`) && (await text(a)).includes(`${a} taken here`) && (await text(d)).includes('chosen · you') && !/taken|chosen/.test(await text(free)),
    `a local port that is another number than the server's says why (${await text(a)} / ${await text(d)} / ${await text(free)})`);
  await page.locator(`.pt-row[data-port="${a}"][data-remote="busy"]`).waitFor({ timeout: 8000 });
  const sides = (port) => page.locator(`.pt-row[data-port="${port}"]`).evaluate((r) => `${r.dataset.local}/${r.dataset.remote}/${[...r.querySelectorAll('.pt-dot')].map((d) => (d.classList.contains('on') ? 'on' : d.classList.contains('off') ? 'off' : '?')).join('')}`);
  check(await sides(a) === 'busy/busy/on' && await sides(f) === 'busy/free/off' && await page.locator('.pt-legend').count() === 0,
    `each port has one dot, for the server's side: filled only when something listens there (its local port is its forward's, always) (${await sides(a)} | ${await sides(f)} | ${await text(f)})`);
  check(await page.locator('.pt-row[data-port="45992"] .pt-x').count() === 0 && await page.locator(`.pt-row[data-port="${a}"] .pt-x`).count() === 1, 'a forward of ~/.ssh/config has no Remove button; the others do');
  check(await page.locator(`.pt-row[data-port="${a}"] a.pt-local`).getAttribute('href') === `http://localhost:${la}/`, 'the local address is a link');
  const focus = await page.evaluate(() => {
    const inp = document.querySelector('.pt-input'), cs = getComputedStyle(inp);
    const probe = document.body.appendChild(Object.assign(document.createElement('i'), { style: 'color: var(--accent)' }));
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { on: document.activeElement === inp, outline: cs.outlineStyle, border: cs.borderTopColor, accent };
  });
  check(focus.on && focus.outline === 'none' && focus.border === focus.accent, `the port box has the focus, marked in the accent colour (${JSON.stringify(focus)})`);
  const below = await page.evaluate(() => { const m = document.querySelector('.modal-body.ports'), r = document.querySelector('.pt-add'); return Math.round(m.getBoundingClientRect().bottom - r.getBoundingClientRect().bottom); });
  check(below <= 16 && await page.locator('.pt-want').getAttribute('placeholder') === 'same', `nothing typed: no room is kept under the boxes, and the local port's box says "same" (${below}px to the dialog's edge)`);
  await page.screenshot({ path: path.join(S, 'ports-idle.png') });
  await page.fill('.pt-remote', String(c));
  check(await page.locator('.pt-want').getAttribute('placeholder') === String(c) && await page.inputValue('.pt-want') === '', 'a port typed shows in grey as the local port, which stays empty');
  await page.locator('.pt-probe[data-remote="busy"][data-local="busy"]').waitFor({ timeout: 5000 });
  await page.screenshot({ path: path.join(S, 'ports-typing.png') });
  check(/in use.*localhost:\d+ in use: a free local port will be used/.test(await page.locator('.pt-probe').textContent()), `a port being typed says whether each side has it (${await page.locator('.pt-probe').textContent()})`);
  await page.keyboard.press('Enter');
  await page.locator(`.pt-row[data-port="${c}"] a.pt-local`).waitFor({ timeout: 10000 });
  const lc = Number(new URL(await page.locator(`.pt-row[data-port="${c}"] a.pt-local`).getAttribute('href')).port);
  check(await get(lc) === 'hello from C' && await page.inputValue('.pt-remote') === '', `a port typed there is forwarded (localhost:${lc} → ${c})`);
  await page.fill('.pt-remote', String(e));
  await page.fill('.pt-want', String(a));
  await page.locator('.pt-probe[data-remote="free"][data-local="busy"]').waitFor({ timeout: 5000 });
  check(/free: nothing listens there yet.*in use: pick another local port/.test(await page.locator('.pt-probe').textContent()), `also for the local port typed (${await page.locator('.pt-probe').textContent()})`);
  await page.click('.pt-add button');
  await until(async () => new RegExp(`localhost:${a} is not free on this computer`).test(await page.locator('.pt-msg').textContent()), 5000, 'a local port that is taken is said under the boxes');
  await page.screenshot({ path: path.join(S, 'ports-dialog.png') });
  check(await page.inputValue('.pt-remote') === String(e) && await page.inputValue('.pt-want') === String(a) && await page.locator(`.pt-row[data-port="${e}"]`).count() === 0, 'and what was typed stays, with nothing forwarded');
  const le = await freePort();
  await page.fill('.pt-want', String(le));
  await page.keyboard.press('Enter');
  await page.locator(`.pt-row[data-port="${e}"] a.pt-local`).waitFor({ timeout: 10000 });
  check(await page.locator(`.pt-row[data-port="${e}"] a.pt-local`).getAttribute('href') === `http://localhost:${le}/` && await page.inputValue('.pt-want') === '' && await page.locator('.pt-want').getAttribute('placeholder') === 'same', `with a free one, the port is at the local port typed (${e} → localhost:${le})`);
  await page.fill('.pt-remote', 'http');
  await page.click('.pt-add button');
  await until(async () => /number from 1 to 65535/.test(await page.locator('.pt-msg').textContent()), 5000, 'what is not a port is refused under the box');
  await page.click(`.pt-row[data-port="${c}"] .pt-x`);
  await until(async () => await page.locator(`.pt-row[data-port="${c}"]`).count() === 0, 5000, 'Remove takes the port off the list');
  check(await get(lc) === null && !of(c), 'and nothing listens on its local port any more');
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);

  // ---- the forwards ssh ends (the network dropped): its ports come back on the local ports they had ----
  execFileSync('pkill', ['-f', 'fakebin/ssh -T -M .* portbox ']);
  await until(async () => await get(lb) === null, 5000, 'with the forwards ssh gone the ports are down');
  await until(async () => await get(lb) === 'hello from B' && await get(la) === 'hello from A', 20000, 'the forwards ssh is started again, and each port is back where it was');
  check(of(a)?.local === la && of(b)?.local === lb && !of(a).error && !of(b).error, 'the page lists them as before');

  // ---- no client that can forward: the script says so ----
  st.req.destroy();
  await page.close();
  client.kill();
  await until(async () => await get(lb) === null, 10000, 'the ports go with the client');
  const alone = await script(b);
  check(alone.code === 1 && /No IroWell client/.test(alone.out), `with no client connected the script says nothing can forward (${alone.out.trim()})`);
} finally {
  await browser?.close();
  client.kill();
  killDaemon(RDIR);
  for (const s of [A, B, C, D]) s.close();
}
finish();
