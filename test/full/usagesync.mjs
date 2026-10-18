// Plan-usage history, evened out between machines (no model calls): this machine's daemon and a server's
// (fake ssh; its own state dir under a scratch $HOME) each have samples the other missed, and the client
// copies them over, both ways, when the server connects and on a timer after. Only for the same Claude
// account, only whole samples on the clock, and the page can't send the commands that do it.
// What the work cost goes one way only: each daemon totals its own machine's transcripts by half hour and
// knows of no other; the client collects the totals and keeps them all on this computer, and the Usage
// page of either machine shows the sum.
import { REPO, CLIENT, outDir, cleanEnv, killDaemon, check, until, finish, clientApi, eventStream, wait } from '../lib.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
fs.writeFileSync(SH, `#!/bin/sh\nunset IRO_DIR IRO_TEST_PRICES\nexport IRO_COST_DIR='${RCOST}'\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n`, { mode: 0o755 });
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
// This machine's daemon prices them by a table with a newer price from slot 3 on ($30): the answer before
// it keeps the old price.
const DATED = JSON.stringify([{ model: 'opus-5-5', input: 4, output: 30, read: 0.2, since: new Date(last - 8 * HALF).toISOString() }, { model: 'opus-5-5', input: 4, output: 20, read: 0.2 }]);
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
  const T = eventStream(PORT, token); // (what a page is sent: its sync bar is checked below)
  const on = (target, body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token, 'x-target': target }, body: JSON.stringify(body) }).then((r) => JSON.parse(r.body));
  await until(async () => (await cmd({ type: 'usageHistory', days: 35 })).data?.length === 8, 30000, 'the server is connected and lists its 8 samples');

  // ---- no daemon on this machine: nothing to compare the server with, and its file is left alone ----
  await wait(4000);
  check(slots(LDIR).join() === '0,1,2,6,7,11' && slots(RDIR).join() === '0,1,3,4,5,8,9,10', `with no daemon running here nothing is copied (${slots(LDIR)} / ${slots(RDIR)})`);

  // ---- this machine's daemon comes up (no tab shows it): each side gets what it lacked ----
  localDaemon = spawn(process.execPath, [path.join(REPO, 'server', 'daemon.mjs')], { cwd: LDIR, env: { ...env, IRO_TEST_PRICES: DATED }, detached: true, stdio: 'ignore' });
  localDaemon.unref();
  const whole = '0,1,2,3,4,5,6,7,8,9,10,11';
  await until(() => slots(LDIR).join() === whole && slots(RDIR).join() === whole, 20000, 'both machines have all 12 samples, in order');
  check(slots(LDIR).join() === whole, `this machine got the server's samples (${slots(LDIR)})`);
  check(slots(RDIR).join() === whole, `the server got this machine's (${slots(RDIR)})`);
  check(JSON.stringify(read(LDIR)) === JSON.stringify(read(RDIR)) && JSON.stringify(read(LDIR)[3]) === JSON.stringify(sample(3)), 'a copied sample is the same on both, windows and reset times included');
  check((await cmd({ type: 'usageHistory', days: 35 })).data?.length === 12, 'the Usage page of the server now gets 12 samples');

  // ---- the Usage page's sync bar: each round of questions to the machines, as far as their answers have arrived ----
  // What a page has been sent about the rounds: each as { text, levels (percent, in order), waiting (at each level) }.
  const syncRounds = () => {
    const out = [];
    let cur = null;
    for (const m of T.msgs) {
      if (m.type !== 'partial' || m.op !== 'usageSync') continue;
      if (!m.sync) { cur = null; continue; }
      if (!cur || cur.text !== m.sync.text || m.sync.pct < cur.levels.at(-1)) out.push((cur = { text: m.sync.text, levels: [], waiting: [] }));
      cur.levels.push(m.sync.pct);
      cur.waiting.push(m.sync.waiting.slice().sort().join());
    }
    return out;
  };
  const syncIdle = () => T.msgs.filter((m) => m.type === 'partial' && m.op === 'usageSync').at(-1)?.sync === null;
  {
    // (rounds go on, on the timer: what was sent up to a moment with none under way)
    let rounds = [];
    const whole = (r) => r.levels[0] === 0 && r.levels.at(-1) === 100;
    const of = (text) => rounds.filter((r) => r.text === text && whole(r));
    await until(() => { rounds = syncRounds(); return of('Copying the samples a machine missed').length > 0 && syncIdle(); }, 10000, 'the page has been told of the rounds, and that the last one is over');
    check(of('Reading the usage samples').length > 0 && of('Reading what the work cost').length > 0 && of('Comparing the machines’ samples').length > 0,
      `a page is told of each round from start to end: the machines' samples, their costs, the comparison (${rounds.map((r) => `${r.text} ${r.levels.join('>')}`).slice(0, 4).join(' | ')})`);
    check(rounds.every((r) => r.levels.every((v, i) => !i || v >= r.levels[i - 1])), 'and its level never goes back');
    const read = of('Reading the usage samples')[0];
    check(read?.waiting[0] === 'syncbox,this machine' && read.waiting.at(-1) === '', `with the machines it still waits for (${read?.waiting.join(' → ')})`);
    // by the amount of data: this machine lacked 6 samples and the server 4, so the first to confirm is 60% or 40% of the copying, not half
    const copy = of('Copying the samples a machine missed')[0], mid = copy?.levels.find((v) => v > 0 && v < 100);
    check((Math.abs(mid - 60) <= 3 || Math.abs(mid - 40) <= 3) && syncIdle(), `the copying counts a machine for the samples that go to it; no round is left showing (${copy?.levels.join(' > ')})`);
  }

  // ---- what the work cost: a daemon counts its own machine only; the client keeps every machine's totals here and adds them up ----
  const both = '2:20,3:70,5:20';
  await until(async () => costOf((await cmd({ type: 'usageCost' })).data) === both && costOf((await on('local', { type: 'usageCost' })).data) === both, 20000, 'the client knows what both machines spent');
  check(costOf((await cmd({ type: 'usageCost' })).data) === both, `the Usage page of the server shows both machines' cost (${costOf((await cmd({ type: 'usageCost' })).data)})`);
  check(costOf((await on('local', { type: 'usageCost' })).data) === both, `and so does this machine's (${costOf((await on('local', { type: 'usageCost' })).data)})`);
  const own = async (dir) => costOf((await ask(dir, { type: 'usageCost' }))?.data);
  check(await own(RDIR) === '3:40,5:20' && await own(LDIR) === '2:20,3:30', `each daemon counts its own machine only, at the prices of the time of each answer (${await own(RDIR)} / ${await own(LDIR)})`);
  const STORE = path.join(LDIR, 'cost-machines.json');
  const kept = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; } };
  const idOf = (dir) => fs.readFileSync(path.join(dir, 'machine'), 'utf8').trim();
  check(JSON.stringify(Object.keys(kept()).sort()) === JSON.stringify([idOf(LDIR), idOf(RDIR)].sort()) && idOf(LDIR) !== idOf(RDIR) && kept()[idOf(RDIR)].account === 'acct-one',
    'the totals of both are kept on this computer, by machine, with the account');
  check(Object.values(kept()[idOf(RDIR)]?.slots || {}).join() === '40,20', `as totals by half hour, not the answers (${JSON.stringify(kept()[idOf(RDIR)])})`);
  check(!fs.existsSync(path.join(RDIR, 'cost-machines.json')) && !fs.existsSync(path.join(RDIR, 'cost.json')) && !fs.existsSync(path.join(LDIR, 'cost.json')), 'nothing of it is written on the server, and no daemon keeps another machine\'s');
  // more work in a half hour already collected: its total grows here, and nothing is counted twice
  fs.appendFileSync(path.join(RCOST, '-project', 'session.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date(sample(5).t + 120e3).toISOString(), message: { id: 'msg_f', model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: 1e6 } } }) + '\n');
  const grown = '2:20,3:70,5:40';
  check(costOf((await on('local', { type: 'usageCost' })).data) === grown, `the page gets the totals as they are now, not as they were at the last round (${costOf((await on('local', { type: 'usageCost' })).data)})`);
  await wait(3500); // (a few rounds of the timer)
  check(costOf((await on('local', { type: 'usageCost' })).data) === grown && costOf((await cmd({ type: 'usageCost' })).data) === grown, 'round after round the sums stay the same');
  // totals on file from another price table (prices mended since): taken as they are now, lower ones too;
  // a half hour no transcript is left for keeps what it had. With the same table, a lower total is not taken.
  const R = idOf(RDIR), table = (await ask(RDIR, { type: 'costDump' }))?.data?.prices;
  check(/^[0-9a-f]{12}$/.test(table || '') && kept()[R].prices === table && kept()[idOf(LDIR)].prices && kept()[idOf(LDIR)].prices !== table,
    `a machine says which price table priced its totals, and it is kept with them (${table} / ${JSON.stringify(kept()[R])})`);
  const reprice = (prices, slots) => fs.writeFileSync(STORE, JSON.stringify({ ...kept(), [R]: { ...kept()[R], prices, slots: { ...kept()[R].slots, ...slots } } }));
  reprice('an-older-table', { [sample(5).t]: 99, [sample(6).t]: 7 });
  check(costOf((await on('local', { type: 'usageCost' })).data) === `${grown},6:7` && kept()[R].prices === table && kept()[R].slots[sample(5).t] === 40,
    `totals priced by an older table are replaced by the new prices, lower ones too (${costOf((await on('local', { type: 'usageCost' })).data)})`);
  reprice(table, { [sample(5).t]: 99 });
  check(costOf((await on('local', { type: 'usageCost' })).data) === '2:20,3:70,5:99,6:7', 'with the same table a total only grows');
  fs.writeFileSync(STORE, JSON.stringify({ ...kept(), [R]: { ...kept()[R], slots: Object.fromEntries(Object.entries(kept()[R].slots).filter(([t]) => +t !== sample(6).t).map(([t, v]) => [t, +t === sample(5).t ? 40 : v])) } }));
  check(costOf((await on('local', { type: 'usageCost' })).data) === grown, `(back as it was: ${costOf((await on('local', { type: 'usageCost' })).data)})`);
  // a machine that is out of reach stays on file; one logged in to another account is not added in
  fs.writeFileSync(STORE, JSON.stringify({ ...kept(), 'machine-away': { account: 'acct-one', slots: { [sample(7).t]: 5 } }, 'machine-of-another': { account: 'acct-two', slots: { [sample(8).t]: 9 } } }));
  check(costOf((await cmd({ type: 'usageCost' })).data) === `${grown},7:5`, `a machine not connected now still counts, another account's does not (${costOf((await cmd({ type: 'usageCost' })).data)})`);
  const helloC = (await ask(LDIR, { type: 'ping' }))?.hello;
  const pageDump = await req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ type: 'costDump' }) });
  check(helloC.commands.includes('usageCost') && !helloC.commands.includes('costDump') && pageDump.status !== 200, `the page asks for the cost only through usageCost (${pageDump.status})`);

  // ---- with a tab on this machine too (its connection is the one used), on the timer: later gaps are filled both ways ----
  check((await on('local', { type: 'usageHistory', days: 35 })).data?.length === 12, 'and so does the Usage page of this machine');
  const older = (k) => ({ ...sample(0), t: sample(0).t - k * HALF });
  add(RDIR, older(1));
  add(LDIR, older(2));
  await until(() => read(LDIR).length === 14 && read(RDIR).length === 14, 20000, 'a sample only one side has reaches the other, either way');
  const sorted = (xs) => xs.every((x, i) => !i || xs[i - 1].t < x.t);
  check(sorted(read(LDIR)) && sorted(read(RDIR)), 'the files stay in time order');

  // ---- the pages read what this computer keeps, not their own daemon's: the same history, estimate and level on both ----
  {
    // a slot each machine took at its own moment (the server's reading is the later one), and a newer level only the server has
    const at = (k, week) => ({ ...older(k), week: { pct: week, resets: sample(0).week.resets } });
    add(LDIR, at(3, 30));
    add(RDIR, at(3, 33));
    const fresh = { t: last + HALF, five: { pct: 12, resets: sample(0).five.resets }, week: { pct: 60, resets: sample(0).week.resets } };
    await ask(RDIR, { type: 'usageMerge', account: 'acct-one', samples: [fresh] }); // (its level is now 60%)
    const page = async (get) => JSON.stringify([(await get({ type: 'usageHistory', days: 35 })).data, (await get({ type: 'usageForecast' })).data, (await get({ type: 'limits' })).data]);
    const there = await page(cmd), here = await page((b) => on('local', b));
    const h = JSON.parse(there);
    check(there === here, 'the Usage page of the server and of this machine get the same history, estimate and level');
    check(h[0].find((x) => x.t === older(3).t)?.week.pct === 33, `a slot both machines took shows the later reading (${JSON.stringify(h[0].find((x) => x.t === older(3).t)?.week)})`);
    check(h[2]?.week?.pct === 60 && h[1]?.week?.pct === 60, `the newest level any machine has is the level, and the estimate starts from it (${JSON.stringify(h[2]?.week)} / ${h[1]?.week?.pct})`);
    const own = (dir) => read(dir).find((x) => x.t === older(3).t)?.week.pct;
    check(own(LDIR) === 30 && own(RDIR) === 33, `(each daemon's own file still has its own reading: ${own(LDIR)} / ${own(RDIR)})`);
    const acct = JSON.parse(fs.readFileSync(path.join(LDIR, 'usage-accounts.json'), 'utf8'))['acct-one'];
    check(Object.keys(acct.samples).length === h[0].length && acct.live.week.pct === 60 && !fs.existsSync(path.join(RDIR, 'usage-accounts.json')), 'the account\'s history and level are kept on this computer, not on the server');
    await until(() => read(LDIR).length === 16 && read(RDIR).length === 16, 20000, 'the newer sample reaches this machine\'s daemon too');
  }

  // ---- what a daemon takes ----
  const hello = (await ask(LDIR, { type: 'ping' }))?.hello;
  check(hello?.usageSync === true && !hello.commands.includes('usageDump') && !hello.commands.includes('usageMerge'), 'a daemon says it can compare usage, and keeps the commands from the page');
  const viaPage = await req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify({ type: 'usageMerge', account: 'acct-one', samples: [older(5)] }) });
  await wait(500);
  check((viaPage.status !== 200 || JSON.parse(viaPage.body).error) && read(RDIR).length === 16, `the page cannot send them (${viaPage.status} ${viaPage.body.slice(0, 80)})`);
  const other = await ask(LDIR, { type: 'usageMerge', account: 'acct-two', samples: [older(5)] });
  check(other?.error && read(LDIR).length === 16, `samples of another account are refused (${other?.error})`);
  const junk = await ask(LDIR, { type: 'usageMerge', account: 'acct-one', samples: [
    { ...older(5), t: older(5).t + 7 * 60e3 }, // not on the clock
    { ...older(5), t: Date.now() + HALF }, // not yet
    { t: older(5).t }, // no level
    { t: older(5).t, five: { pct: 'many' }, week: null },
    sample(4), // already here
    null, 'x',
  ] });
  check(junk?.data?.added === 0 && read(LDIR).length === 16, `off the clock, in the future, without a level or already on file: not taken (${JSON.stringify(junk?.data || junk?.error)})`);
  const dump = await ask(RDIR, { type: 'usageDump', days: 35 });
  check(dump?.data?.account === 'acct-one' && dump.data.samples.length === 16, 'a daemon hands out its samples with its account');

  // ---- the sync bar goes by how much of the answers has arrived, not by how many machines have answered ----
  {
    // the server has far more to send than this machine: 19 days of samples every 5 minutes (close to a megabyte)
    const from = sample(0).t - 20 * 24 * 3600e3, many = [];
    for (let t = from; t < from + 19 * 24 * 3600e3; t += 300e3) many.push(JSON.stringify({ ...sample(0), t }) + '\n');
    const before = T.msgs.length;
    fs.appendFileSync(file(RDIR), many.join(''));
    // (the round after the one that first saw it: by then the client knows how much the server sends)
    const big = () => syncRounds().filter((r) => r.text === 'Reading the usage samples' && r.levels.at(-1) === 100 && new Set(r.levels.filter((v) => v > 0 && v < 100)).size >= 3);
    await until(() => T.msgs.slice(before).some((m) => m.op === 'usageSync') && big().length >= 2, 30000, 'rounds that read the server\'s long answer have been shown');
    const r = big().at(-1);
    check(r && r.levels.every((v, i) => !i || v >= r.levels[i - 1]), `a long answer moves the bar as it arrives, chunk by chunk (${r?.levels.join(' > ')})`);
    const alone = r ? r.levels.filter((v, i) => r.waiting[i] === 'syncbox') : [];
    check(alone.length > 0 && alone[0] < 10, `and this machine's short answer, already in, is a small part of it: one of two machines is not half (${alone[0]}% with the server still sending)`);
    check((await cmd({ type: 'usageHistory', days: 35 })).data?.length === 16 + many.length, 'the answers are read as before');
  }

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
      while (Date.now() - t0 < 16 * GAP) {
        await sample(); await limits();
        if (read(dir).length) { if (hits.length < 4) early++; if (Date.now() - hits.at(-1) > 2 * GAP) break; }
        await wait(100);
      }
      const gaps = hits.slice(1).map((t, i) => t - hits[i]);
      check(hits.length === 4 && gaps.every((g, i) => g >= (i + 1) * GAP && g < (i + 1) * GAP + 1500), `an API that keeps refusing is asked 3 more times, 5, 10 and 15 minutes apart (here ${gaps.map((g) => `${g} ms`).join(', ')}), then no more (${hits.length} calls)`);
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
