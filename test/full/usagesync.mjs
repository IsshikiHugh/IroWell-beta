// Plan-usage history, evened out between machines (no model calls): this machine's daemon and a server's
// (fake ssh; its own state dir under a scratch $HOME) each have samples the other missed, and the client
// copies them over, both ways, when the server connects and on a timer after. Only for the same Claude
// account, only whole samples on the clock, and the page can't send the commands that do it.
import { REPO, CLIENT, outDir, cleanEnv, killDaemon, check, until, finish, clientApi, wait } from '../lib.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4767;
const LDIR = process.env.IRO_DIR; // this machine's daemon state
const HOME = path.join(S, 'syncbox-home');
const RDIR = path.join(HOME, '.iro-coding'); // the server's
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(RDIR, { recursive: true });
fs.mkdirSync(LDIR, { recursive: true });
fs.symlinkSync(path.join(REPO, 'server', 'attach.mjs'), path.join(RDIR, 'attach.mjs')); // "installed": the checkout's daemon
// The server's shell: no IRO_DIR there, so its daemon keeps its state in its own ~/.iro-coding.
const SH = path.join(S, 'syncbox-sh');
fs.writeFileSync(SH, '#!/bin/sh\nunset IRO_DIR\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n', { mode: 0o755 });
// Neither daemon samples by itself or asks the usage API; both are logged in to "the same account".
const env = cleanEnv({ HOME, SHELL: SH, PATH: `${path.join(HERE, '..', 'fakebin')}:${process.env.PATH}`, IRO_NO_USAGE_RECORD: '1', IRO_TEST_ACCOUNT: 'acct-one', IRO_USAGE_SYNC_MS: '1500' });

const HALF = 1800e3;
const last = Math.floor(Date.now() / HALF) * HALF - 4 * HALF; // (well before the slot the samplers look at)
const sample = (i) => ({ t: last - (11 - i) * HALF, five: { pct: i, resets: new Date(last + 5 * 3600e3).toISOString() }, week: { pct: 40 + i, resets: new Date(last + 4 * 24 * 3600e3).toISOString() } });
const file = (dir) => path.join(dir, 'usage.jsonl');
const put = (dir, xs) => fs.writeFileSync(file(dir), xs.map((x) => JSON.stringify(x) + '\n').join(''));
const add = (dir, x) => fs.appendFileSync(file(dir), JSON.stringify(x) + '\n');
const read = (dir) => { try { return fs.readFileSync(file(dir), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const slots = (dir) => read(dir).map((x) => (x.t - last) / HALF + 11);
put(LDIR, [0, 1, 2, 6, 7, 11].map(sample));
put(RDIR, [0, 1, 3, 4, 5, 8, 9, 10].map(sample));

// One command straight to a daemon's socket (as client.mjs sends its own).
const ask = (dir, cmd) => new Promise((resolve) => {
  const sock = net.connect(path.join(dir, 'daemon.sock'));
  let buf = '', hello = null;
  const end = (v) => { sock.destroy(); resolve(v); };
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let m;
      try { m = JSON.parse(buf.slice(0, i)); } catch {}
      buf = buf.slice(i + 1);
      if (m?.type === 'hello') { hello = m; sock.write(JSON.stringify({ ...cmd, id: 1 }) + '\n'); }
      else if (m?.type === 'reply' && m.id === 1) end({ hello, ...m });
    }
  });
  sock.on('error', () => end(null));
  setTimeout(() => end(null), 8000);
});

const client = spawn(process.execPath, [CLIENT, '--host', 'syncbox', '--port', String(PORT)], { env, stdio: 'inherit' });
let localDaemon = null;
try {
  const { token, req, cmd } = await clientApi(PORT);
  const on = (target, body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token, 'x-target': target }, body: JSON.stringify(body) }).then((r) => JSON.parse(r.body));
  await until(async () => (await cmd({ type: 'usageHistory', days: 35 })).data?.length === 8, 30000, 'the server is connected and lists its 8 samples');

  // ---- no daemon on this machine: nothing to compare the server with, and its file is left alone ----
  await wait(4000);
  check(slots(LDIR).join() === '0,1,2,6,7,11' && slots(RDIR).join() === '0,1,3,4,5,8,9,10', `with no daemon running here nothing is copied (${slots(LDIR)} / ${slots(RDIR)})`);

  // ---- this machine's daemon comes up (no tab shows it): each side gets what it lacked ----
  localDaemon = spawn(process.execPath, [path.join(REPO, 'server', 'daemon.mjs')], { cwd: LDIR, env, detached: true, stdio: 'ignore' });
  localDaemon.unref();
  const whole = '0,1,2,3,4,5,6,7,8,9,10,11';
  await until(() => slots(LDIR).join() === whole && slots(RDIR).join() === whole, 20000, 'both machines have all 12 samples, in order');
  check(slots(LDIR).join() === whole, `this machine got the server's samples (${slots(LDIR)})`);
  check(slots(RDIR).join() === whole, `the server got this machine's (${slots(RDIR)})`);
  check(JSON.stringify(read(LDIR)) === JSON.stringify(read(RDIR)) && JSON.stringify(read(LDIR)[3]) === JSON.stringify(sample(3)), 'a copied sample is the same on both, windows and reset times included');
  check((await cmd({ type: 'usageHistory', days: 35 })).data?.length === 12, 'the Usage page of the server now gets 12 samples');

  // ---- with a tab on this machine too (its connection is the one used), on the timer: later gaps are filled both ways ----
  check((await on('local', { type: 'usageHistory', days: 35 })).data?.length === 12, 'and so does the Usage page of this machine');
  const older = (k) => ({ ...sample(0), t: sample(0).t - k * HALF });
  add(RDIR, older(1));
  add(LDIR, older(2));
  await until(() => read(LDIR).length === 14 && read(RDIR).length === 14, 20000, 'a sample only one side has reaches the other, either way');
  const sorted = (xs) => xs.every((x, i) => !i || xs[i - 1].t < x.t);
  check(sorted(read(LDIR)) && sorted(read(RDIR)), 'the files stay in time order');

  // ---- what a daemon takes ----
  const hello = (await ask(LDIR, { type: 'ping' }))?.hello;
  check(hello?.usageSync === true && !hello.commands.includes('usageDump') && !hello.commands.includes('usageMerge'), 'a daemon says it can compare usage, and keeps the commands from the page');
  const viaPage = await req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ type: 'usageMerge', account: 'acct-one', samples: [older(5)] }) });
  await wait(500);
  check((viaPage.status !== 200 || JSON.parse(viaPage.body).error) && read(RDIR).length === 14, `the page cannot send them (${viaPage.status} ${viaPage.body.slice(0, 80)})`);
  const other = await ask(LDIR, { type: 'usageMerge', account: 'acct-two', samples: [older(5)] });
  check(other?.error && read(LDIR).length === 14, `samples of another account are refused (${other?.error})`);
  const junk = await ask(LDIR, { type: 'usageMerge', account: 'acct-one', samples: [
    { ...older(5), t: older(5).t + 7 * 60e3 }, // not on the clock
    { ...older(5), t: Date.now() + HALF }, // not yet
    { t: older(5).t }, // no level
    { t: older(5).t, five: { pct: 'many' }, week: null },
    sample(4), // already here
    null, 'x',
  ] });
  check(junk?.data?.added === 0 && read(LDIR).length === 14, `off the clock, in the future, without a level or already on file: not taken (${JSON.stringify(junk?.data || junk?.error)})`);
  const dump = await ask(RDIR, { type: 'usageDump', days: 35 });
  check(dump?.data?.account === 'acct-one' && dump.data.samples.length === 14, 'a daemon hands out its samples with its account');

  // ---- a usage API that refuses is left alone for a while (the CLI is asked meanwhile), not asked every few minutes ----
  {
    const DIR3 = path.join(S, 'refused-dir');
    fs.rmSync(DIR3, { recursive: true, force: true });
    fs.mkdirSync(DIR3, { recursive: true });
    const plan = [[429, { 'retry-after': '2' }], [200], [429], [429], [429]]; // what the API answers, call by call; then 200
    let hits = 0;
    const api = http.createServer((q, res) => {
      const [status, headers = {}] = plan[hits++] || [200];
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(status === 200 ? JSON.stringify({ five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600e3).toISOString() }, seven_day: { utilization: 34, resets_at: new Date(Date.now() + 86400e3).toISOString() } }) : '{}');
    });
    await new Promise((r) => api.listen(0, '127.0.0.1', r));
    const env3 = { ...env, IRO_DIR: DIR3, IRO_TEST_USAGE_API: `http://127.0.0.1:${api.address().port}/usage`, IRO_USAGE_GAP_MIN: '0.005' }; // (asked again after 0.3 s)
    delete env3.IRO_NO_USAGE_RECORD;
    const log3 = path.join(DIR3, 'daemon.log');
    const out3 = fs.openSync(log3, 'a');
    const d3 = spawn(process.execPath, [path.join(REPO, 'server', 'daemon.mjs')], { cwd: DIR3, env: env3, detached: true, stdio: ['ignore', out3, out3] });
    d3.unref();
    try {
      await until(() => fs.existsSync(path.join(DIR3, 'daemon.sock')), 10000, 'the third daemon is up');
      const poke = async (type = 'limits') => { await ask(DIR3, type === 'limits' ? { type } : { type, usageInterval: 30 }); await wait(450); };
      await poke(); // 429, Retry-After: 2
      await poke(); await poke();
      check(hits === 1, `after a 429 with Retry-After the API is not asked again before that (${hits} call)`);
      await wait(1500);
      await poke('setSettings'); // the sampler: 200
      check(hits === 2 && read(DIR3).length === 1 && read(DIR3)[0].five.pct === 12 && read(DIR3)[0].t % HALF === 0, `once that has passed it is asked, and its answer is the slot's sample (${hits} calls, ${JSON.stringify(read(DIR3)[0])})`);
      for (let i = 0; i < 3; i++) await poke(); // 429, three times
      const refused = hits;
      await poke(); await poke();
      check(refused === 5 && hits === 5, `refused 3 times in a row, it is left alone (${refused} calls, then ${hits})`);
      const said = fs.readFileSync(log3, 'utf8').split('\n').filter((l) => /usage API: left alone/.test(l)).map((l) => l.replace(/^\S+ /, ''));
      check(said.length === 2 && /for 2 s,/.test(said[0]) && /for 30 min/.test(said[1]), `and the log says for how long (${said.join(' | ')})`);
    } finally {
      killDaemon(DIR3);
      api.close();
    }
  }
} finally {
  client.kill();
  killDaemon(LDIR);
  killDaemon(RDIR);
}
finish();
