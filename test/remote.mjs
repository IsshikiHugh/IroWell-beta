// Real remote test against an ssh host.
import { spawn, execSync, execFileSync } from 'node:child_process';
import { CLIENT, wait, log, check, until, finish } from './lib.mjs';
import path from 'node:path';
import http from 'node:http';

const HOST = process.argv[2];

const PORT = 4796;
const RDIR = '.iro-coding/e2e'; // remote test dir, removed at the end
const ssh = (cmd) => execFileSync('ssh', ['-o', 'ClearAllForwardings=yes', HOST, cmd]).toString();

ssh(`rm -rf ${RDIR} && mkdir -p ${RDIR}`);

function startClient() {
  const p = spawn(process.execPath, [CLIENT, '--host', HOST, '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => log('client:', d.toString().trim()));
  p.stderr.on('data', (d) => log('client err:', d.toString().trim()));
  return p;
}
async function attach() {
  let token;
  for (let i = 0; i < 50 && !token; i++) {
    try { token = await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b.match(/name="token" content="(\w+)"/)[1])); }).on('error', rej)); } catch { await wait(200); }
  }
  const st = { token, events: [], up: false, dupes: 0, last: 0, error: '' };
  st.req = http.get(`http://127.0.0.1:${PORT}/events?t=${token}`, (r) => {
    let b = '';
    r.on('data', (c) => { b += c; let i; while ((i = b.indexOf('\n\n')) >= 0) { const m = JSON.parse(b.slice(6, i)); b = b.slice(i + 2);
      if (m.type === 'transport') { st.up = m.up; if (m.error) st.error = m.error; }
      if (m.type === 'reset') { st.events = []; st.last = 0; }
      if (m.type === 'event') { if (m.seq <= st.last) st.dupes++; else { st.last = m.seq; st.events.push(m); } } } });
  });
  st.req.on('error', () => {});
  st.post = (body) => new Promise((res) => { const q = http.request({ host: '127.0.0.1', port: PORT, path: '/cmd', method: 'POST', headers: { 'x-token': token } }, (r) => { r.resume(); res(r.statusCode); }); q.end(JSON.stringify(body)); });
  return st;
}
const results = (st) => st.events.filter((e) => e.kind === 'msg' && e.msg.type === 'result');

let c = startClient();
let st = await attach();
check(await until(() => st.up, 20000), `connected to ${HOST} over ssh (error: ${st.error || 'none'})`);

await st.post({ type: 'new', cwd: `~/${RDIR}`, text: 'Use the Write tool to create hi.txt here containing exactly: hi from the server. Then use Bash to run `hostname`, and reply with just the hostname.' });
const hasApproval = () => st.events.some((e) => e.kind === 'approval' && !st.events.some((d) => d.kind === 'approval_done' && d.rid === e.rid));
const gotWrite = () => st.events.some((e) => e.kind === 'msg' && e.msg.type === 'user' && JSON.stringify(e.msg).includes('hi.txt'));
await until(() => hasApproval() || gotWrite(), 180000);
const created = st.events.find((e) => e.kind === 'created');
check(created?.cwd?.endsWith('/.iro-coding/e2e') && !created.cwd.includes('~'), `session cwd on the server: ${created?.cwd}`);

if (hasApproval()) {
  log('approval pending -> killing the whole local client (laptop goes away)');
  st.req.destroy(); c.kill('SIGTERM');
  await wait(4000);
  check(ssh('pgrep -f "[.]iro-coding/daemon[.]mjs" >/dev/null && echo alive || echo dead').trim() === 'alive', 'daemon still alive on the server with no client connected');
  c = startClient();
  st = await attach();
  check(await until(() => st.up && hasApproval(), 20000), 'reconnected; pending approval replayed');
} else log('(Write was auto-approved by settings; skipping the pending-approval disconnect case)');

// Approve whatever comes up until the turn finishes, dropping ssh once midway.
let dropped = false;
while (!(await until(() => results(st).length >= 1, 1000))) {
  for (const e of st.events.filter((x) => x.kind === 'approval')) {
    if (!st.events.some((d) => d.kind === 'approval_done' && d.rid === e.rid)) { log('approving', e.tool); await st.post({ type: 'approve', sid: e.sid, rid: e.rid, allow: true }); await wait(500); }
  }
  if (!dropped) {
    dropped = true;
    log('killing the local ssh process (network drop)');
    try { execSync(`pkill -f "ssh -T -o ClearAllForwardings=yes .* ${HOST} "`); } catch {}
    check(await until(() => !st.up, 5000) && await until(() => st.up, 30000), 'ssh reconnected by itself');
  }
  if (Date.now() - t0 > 400000) break;
}
check(results(st).length >= 1, 'turn finished');
const reply = st.events.filter((e) => e.kind === 'msg' && e.msg.type === 'assistant').flatMap((e) => e.msg.message.content.filter((b) => b.type === 'text').map((b) => b.text)).join(' ');
log('reply:', JSON.stringify(reply));
check(reply.toLowerCase().includes(ssh('hostname').trim().toLowerCase().split('.')[0]), 'Bash ran on the server (hostname in reply)');
check(ssh(`cat ${RDIR}/hi.txt`).trim() === 'hi from the server', 'hi.txt written on the server');
check(st.dupes === 0 && st.events.every((e, i) => i === 0 || e.seq === st.events[i - 1].seq + 1), `event stream complete, no duplicates (dupes=${st.dupes})`);

c.kill('SIGTERM');
ssh(`rm -rf ${RDIR}`);
finish();
