// Exercise the --host code path with fake ssh/scp (remote == this machine, $HOME/.iro-coding).
import { spawn, execSync } from 'node:child_process';
import { REPO, CLIENT, outDir, browserPath, cleanEnv } from './lib.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();

const PORT = 4797;
const env = { ...process.env, PATH: `${path.join(HERE, 'fakebin')}:${process.env.PATH}` };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k)) delete env[k];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };
async function until(pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await wait(200); } return false; }

const client = spawn(process.execPath, [CLIENT, '--host', 'fakebox', '--port', String(PORT)], { env, stdio: 'inherit' });
let token;
for (let i = 0; i < 50 && !token; i++) {
  try { token = await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/`, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b.match(/name="token" content="(\w+)"/)[1])); }).on('error', rej)); } catch { await wait(200); }
}
const st = { events: [], up: false, resets: 0 };
http.get(`http://127.0.0.1:${PORT}/events?t=${token}`, (r) => {
  let b = '';
  r.on('data', (c) => { b += c; let i; while ((i = b.indexOf('\n\n')) >= 0) { const m = JSON.parse(b.slice(6, i)); b = b.slice(i + 2);
    if (m.type === 'transport') st.up = m.up; if (m.type === 'reset') { st.resets++; st.events = []; } if (m.type === 'event') st.events.push(m); } });
});
const post = (body) => new Promise((res) => { const q = http.request({ host: '127.0.0.1', port: PORT, path: '/cmd', method: 'POST', headers: { 'x-token': token } }, (r) => { r.resume(); res(r.statusCode); }); q.end(JSON.stringify(body)); });

check(await until(() => st.up, 15000), 'connected through ssh + login shell');
check(execSync('pgrep -fl "[.]iro-coding/daemon[.]mjs" || true').toString().includes('.iro-coding/daemon.mjs'), 'daemon runs from the deployed copy');
await post({ type: 'new', cwd: '~', text: 'Reply with just: pong (no tools)' });
check(await until(() => st.events.some((e) => e.kind === 'msg' && e.msg.type === 'result'), 120000), 'session ran on the "remote"');
check(st.events.find((e) => e.kind === 'created')?.cwd === os.homedir(), '~ resolved to remote home');

execSync('pkill -f "node attach[.]mjs"');
check(await until(() => !st.up, 5000) && await until(() => st.up, 15000), 'reconnects after ssh drop');
const resetsBefore = st.resets;

// redeploy while running: daemon must be restarted by the pkill in deploy
const oldPid = execSync('pgrep -f "[.]iro-coding/daemon[.]mjs"').toString().trim();
execSync(`node ${REPO}/client/client.mjs deploy --host fakebox`, { env, stdio: 'ignore' });
check(await until(() => st.resets > resetsBefore && st.up, 20000), 'client resets after daemon restart');
const newPid = execSync('pgrep -f "[.]iro-coding/daemon[.]mjs"').toString().trim();
check(oldPid !== newPid && !newPid.includes('\n'), `deploy restarted the daemon (${oldPid} -> ${newPid})`);

client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
