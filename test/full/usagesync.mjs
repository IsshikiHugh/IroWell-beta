// Plan-usage history, evened out between machines (no model calls): this machine's daemon and a server's
// (fake ssh; its own state dir under a scratch $HOME) each have samples the other missed, and the client
// copies them over, both ways, when the server connects and on a timer after. Only for the same Claude
// account, only whole samples on the clock, and the page can't send the commands that do it.
// What the work cost goes the same way: each machine totals its own transcripts by half hour, and gets the
// other's totals, so the Usage page of either shows both.
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
// Each machine has transcripts of its own (the daemons read these instead of ~/.claude/projects).
const LCOST = path.join(S, 'syncbox-cost-here'), RCOST = path.join(S, 'syncbox-cost-there');
fs.writeFileSync(SH, `#!/bin/sh\nunset IRO_DIR\nexport IRO_COST_DIR='${RCOST}'\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n`, { mode: 0o755 });
// Neither daemon samples by itself or asks the usage API; both are logged in to "the same account".
const env = cleanEnv({ HOME, SHELL: SH, PATH: `${path.join(HERE, '..', 'fakebin')}:${process.env.PATH}`, IRO_NO_USAGE_RECORD: '1', IRO_TEST_ACCOUNT: 'acct-one', IRO_USAGE_SYNC_MS: '1500', IRO_COST_DIR: LCOST });

const HALF = 1800e3;
const last = Math.floor(Date.now() / HALF) * HALF - 4 * HALF; // (well before the slot the samplers look at)
const sample = (i) => ({ t: last - (11 - i) * HALF, five: { pct: i, resets: new Date(last + 5 * 3600e3).toISOString() }, week: { pct: 40 + i, resets: new Date(last + 4 * 24 * 3600e3).toISOString() } });
const file = (dir) => path.join(dir, 'usage.jsonl');
const put = (dir, xs) => fs.writeFileSync(file(dir), xs.map((x) => JSON.stringify(x) + '\n').join(''));
const add = (dir, x) => fs.appendFileSync(file(dir), JSON.stringify(x) + '\n');
const read = (dir) => { try { return fs.readFileSync(file(dir), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const slots = (dir) => read(dir).map((x) => (x.t - last) / HALF + 11);
// An answer of a million output tokens on Opus 5.5 is $20: here at slots 2 and 3, there at 3 (twice) and 5.
const answers = (dir, list) => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '-project'), { recursive: true });
  fs.writeFileSync(path.join(dir, '-project', 'session.jsonl'), list.map(([name, i]) => JSON.stringify({ type: 'assistant', timestamp: new Date(sample(i).t + 60e3).toISOString(),
    message: { id: `msg_${name}`, model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 1e6 } } }) + '\n').join(''));
};
answers(LCOST, [['a', 2], ['b', 3]]);
answers(RCOST, [['c', 3], ['d', 3], ['e', 5]]);
const costOf = (rows) => (rows || []).map(([t, usd]) => `${(t - last) / HALF + 11}:${Math.round(usd)}`).join();
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

  // ---- what the work cost: each machine's half-hour totals reach the other, and either page shows the sum ----
  const both = '2:20,3:60,5:20';
  await until(async () => costOf((await cmd({ type: 'usageCost' })).data) === both && costOf((await on('local', { type: 'usageCost' })).data) === both, 20000, 'both machines know what the other spent');
  check(costOf((await cmd({ type: 'usageCost' })).data) === both, `the Usage page of the server shows both machines' cost (${costOf((await cmd({ type: 'usageCost' })).data)})`);
  check(costOf((await on('local', { type: 'usageCost' })).data) === both, `and so does this machine's (${costOf((await on('local', { type: 'usageCost' })).data)})`);
  const kept = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'cost.json'), 'utf8')); } catch { return {}; } };
  const idOf = (dir) => fs.readFileSync(path.join(dir, 'machine'), 'utf8').trim();
  check(JSON.stringify(Object.keys(kept(LDIR))) === JSON.stringify([idOf(RDIR)]) && JSON.stringify(Object.keys(kept(RDIR))) === JSON.stringify([idOf(LDIR)]) && idOf(LDIR) !== idOf(RDIR),
    'each keeps the other machine\'s totals under that machine\'s id, and not its own');
  check(Object.values(kept(LDIR)[idOf(RDIR)] || {}).join() === '40,20', `the totals by half hour, not the answers (${JSON.stringify(kept(LDIR))})`);
  // more work in a half hour already copied: its total grows on the other side, and nothing is counted twice
  fs.appendFileSync(path.join(RCOST, '-project', 'session.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date(sample(5).t + 120e3).toISOString(), message: { id: 'msg_f', model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 1e6 } } }) + '\n');
  await until(async () => costOf((await on('local', { type: 'usageCost' })).data) === '2:20,3:60,5:40', 20000, 'a half hour that went on costing is brought up to date');
  await wait(3500); // (a few more rounds of the timer)
  check(costOf((await on('local', { type: 'usageCost' })).data) === '2:20,3:60,5:40' && costOf((await cmd({ type: 'usageCost' })).data) === '2:20,3:60,5:40', 'round after round the sums stay the same');
  const pageCost = await req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ type: 'costMerge', account: 'acct-one', machines: { 'some-other-machine': [[sample(1).t, 99]] } }) });
  const otherCost = await ask(LDIR, { type: 'costMerge', account: 'acct-two', machines: { 'some-other-machine': [[sample(1).t, 99]] } });
  const junkCost = await ask(LDIR, { type: 'costMerge', account: 'acct-one', machines: { [idOf(LDIR)]: [[sample(1).t, 99]], 'x': [[sample(1).t, 99]], 'some-other-machine': [[sample(1).t + 60e3, 99], [Date.now() + 10 * HALF - (Date.now() % HALF), 99], [sample(1).t, -1], [sample(1).t, 'much'], null], 'not-rows': 7 } });
  check((pageCost.status !== 200 || JSON.parse(pageCost.body).error) && otherCost?.error && junkCost?.data?.changed === 0 && costOf((await on('local', { type: 'usageCost' })).data) === '2:20,3:60,5:40',
    `the page cannot send totals, another account's are refused, and its own machine's, off the half hour, in the future or not an amount are not taken (${pageCost.status} / ${otherCost?.error} / ${JSON.stringify(junkCost?.data || junkCost?.error)})`);
  const helloC = (await ask(LDIR, { type: 'ping' }))?.hello;
  check(helloC?.costSync === true && helloC.commands.includes('usageCost') && !helloC.commands.includes('costDump') && !helloC.commands.includes('costMerge'), 'a daemon says it can exchange the totals, and keeps those commands from the page');

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

  // ---- a usage API that gives nothing: asked again 3 times, further and further apart, then a message is sent for the numbers ----
  {
    const resets = (h) => new Date(Math.ceil(Date.now() / 3600e3) * 3600e3 + h * 3600e3);
    const R5 = resets(3);
    const TURN = JSON.stringify({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.07, resetsAt: R5 / 1000 }, seven_day: { utilization: 0.21, resetsAt: resets(90) / 1000 } } });
    // A daemon of its own that samples, with an API that answers `plan` call by call (then 200) and notes when it was asked.
    const refusing = async (name, plan, gapMin, fn) => {
      const dir = path.join(S, name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const hits = [];
      const api = http.createServer((q, res) => {
        const [status, headers = {}] = plan[hits.length] || [200];
        hits.push(Date.now());
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(status === 200 ? JSON.stringify({ five_hour: { utilization: 12, resets_at: resets(3).toISOString() }, seven_day: { utilization: 34, resets_at: resets(90).toISOString() } }) : '{}');
      });
      await new Promise((r) => api.listen(0, '127.0.0.1', r));
      const env3 = { ...env, IRO_DIR: dir, IRO_TEST_USAGE_API: `http://127.0.0.1:${api.address().port}/usage`, IRO_TEST_USAGE_TURN: TURN };
      if (gapMin) env3.IRO_USAGE_GAP_MIN = String(gapMin);
      delete env3.IRO_NO_USAGE_RECORD;
      const logFile = path.join(dir, 'daemon.log');
      const out = fs.openSync(logFile, 'a');
      const d = spawn(process.execPath, [path.join(REPO, 'server', 'daemon.mjs')], { cwd: dir, env: env3, detached: true, stdio: ['ignore', out, out] });
      d.unref();
      try {
        await until(() => fs.existsSync(path.join(dir, 'daemon.sock')), 10000, `the daemon with a refusing usage API is up (${name})`);
        const said = (re) => fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => re.test(l)).map((l) => l.replace(/^\S+ /, ''));
        // (`sample`: what the sampler does every minute, here on demand; `limits`: a page asking for the level)
        await fn({ dir, hits, said, limits: () => ask(dir, { type: 'limits' }), sample: (usageInterval = 30) => ask(dir, { type: 'setSettings', usageInterval }) });
      } finally {
        killDaemon(dir);
        api.close();
      }
    };
    const untilSlot = async (len, room) => { const left = len - (Date.now() % len); if (left < room) await wait(left + 200); }; // (the slot must not end mid-test)

    await untilSlot(HALF, 12000);
    await refusing('refused-dir', [[429, { 'retry-after': '2' }], [200]], 0.005, async ({ dir, hits, limits, sample }) => { // (asked again after 0.3 s)
      await limits(); await wait(450); // 429, Retry-After: 2
      await limits(); await wait(450);
      await sample(); await wait(450);
      check(hits.length === 1 && !read(dir).length, `after a 429 with Retry-After the API is not asked again before that, and no message is sent yet (${hits.length} call)`);
      await wait(1500);
      await sample(); await wait(450); // 200
      check(hits.length === 2 && read(dir).length === 1 && read(dir)[0].five.pct === 12 && read(dir)[0].t % HALF === 0, `once that has passed it is asked, and its answer is the slot's sample (${hits.length} calls, ${JSON.stringify(read(dir)[0])})`);
    });

    await untilSlot(HALF, 12000);
    const GAP = 600; // (IRO_USAGE_GAP_MIN 0.01: where the daemon waits 5, 10 and 15 minutes, here 0.6, 1.2 and 1.8 s)
    await refusing('retry-dir', Array(20).fill([429]), 0.01, async ({ dir, hits, said, limits, sample }) => {
      let early = 0; // (a sample before the 4th query: the message went out too soon)
      const t0 = Date.now();
      while (Date.now() - t0 < 12 * GAP) {
        await sample(); await limits();
        if (read(dir).length) { if (hits.length < 4) early++; if (Date.now() - hits.at(-1) > 2 * GAP) break; }
        await wait(100);
      }
      const gaps = hits.slice(1).map((t, i) => t - hits[i]);
      check(hits.length === 4 && gaps.every((g, i) => g >= (i + 1) * GAP && g < (i + 1) * GAP + 500), `an API that keeps refusing is asked 3 more times, 5, 10 and 15 minutes apart (here ${gaps.map((g) => `${g} ms`).join(', ')}), then no more (${hits.length} calls)`);
      const got = read(dir);
      check(!early && got.length === 1 && got[0].five?.pct === 7 && got[0].week?.pct === 21 && got[0].t % HALF === 0 && Date.parse(got[0].five.resets) === +R5,
        `then a message is sent, and what it brings back is the slot's sample (${JSON.stringify(got)})`);
      const lim = await limits();
      check(lim?.data?.five?.pct === 7 && lim.data.week?.pct === 21, `and the level on screen (${JSON.stringify(lim?.data)})`);
      const msgs = said(/usage: asked with a message/), again = said(/usage: nothing/);
      check(msgs.length === 1 && again.length === 4 && /in 1 s/.test(again[0]) && /not asked again/.test(again[3]), `once, and the log says each step (${[...again, ...msgs].join(' | ')})`);
    });

    // A slot too short for the next query (a sample every 5 minutes, asked again after 5): the message goes at once.
    await untilSlot(300e3, 8000);
    await refusing('short-dir', Array(20).fill([429]), 0, async ({ dir, hits, sample }) => {
      await sample(5);
      await until(() => read(dir).length === 1, 5000, 'a slot with no room for another query has its sample');
      check(hits.length === 1 && read(dir)[0]?.five?.pct === 7 && read(dir)[0].t % 300e3 === 0, `when the next query would come after the slot's end, the message is sent right away (${hits.length} call, ${JSON.stringify(read(dir)[0])})`);
    });
  }
} finally {
  client.kill();
  killDaemon(LDIR);
  killDaemon(RDIR);
}
finish();
