// Full delivery test for iro-coding (local transport).
import { spawn } from 'node:child_process';
import { CLIENT, outDir, browserPath, cleanEnv, killDaemon, wait, log, check, until, finish, eventStream } from '../lib.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = outDir();

const PORT = 4799;
const WORK = path.join(S, 'work2');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const env = cleanEnv();


function startClient() {
  const p = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => log('client:', d.toString().trim()));
  p.stderr.on('data', (d) => log('client err:', d.toString().trim()));
  return p;
}
const req = (method, p, { headers = {}, body, host } = {}) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...(host ? { host } : {}), ...headers } }, (x) => {
    let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b }));
  });
  r.on('error', rej);
  r.end(body);
});
async function getToken() {
  for (let i = 0; i < 50; i++) { try { const r = await req('GET', '/'); return r.body.match(/name="token" content="([0-9a-f]+)"/)[1]; } catch { await wait(200); } }
  throw new Error('client never came up');
}
const stream = (token) => eventStream(PORT, token);
const post = (token, body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body) }).then((r) => r.status);
const contiguous = (evs) => evs.every((e, i) => i === 0 || e.seq === evs[i - 1].seq + 1);
const ofSid = (st, sid) => st.events.filter((e) => e.sid === sid);
const results = (st, sid) => ofSid(st, sid).filter((e) => e.kind === 'msg' && e.msg.type === 'result');
const texts = (evs) => evs.filter((e) => e.kind === 'msg' && e.msg.type === 'assistant').flatMap((e) => e.msg.message.content.filter((b) => b.type === 'text').map((b) => b.text)).join(' ');

// fresh daemon with the current code
killDaemon();
await wait(500);

let c = startClient();
let token = await getToken();

// ---- security / validation ----
check((await req('POST', '/cmd', { body: '{}' })).status === 403, 'POST without token -> 403');
check((await req('GET', '/events?t=bad')).status === 403, 'SSE with bad token -> 403');
check((await req('GET', '/', { host: 'evil.com:4799' })).status === 403, 'foreign Host header -> 403');
check((await post(token, { type: 'sync', since: 0 })) === 400, 'browser cannot send raw sync -> 400');

const A = stream(token), B = stream(token); // two tabs
await until(() => A.up && B.up, 10000, 'transport up');

log('errors:');
const postBody = (body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body) }).then((r) => JSON.parse(r.body));
const e1 = await postBody({ type: 'new', cwd: WORK, text: '   ' });
const e2 = await postBody({ type: 'new', cwd: '/definitely/not/here', text: 'hi' });
check(/empty/.test(e1.error) && /Not a directory/.test(e2.error), `errors come back in the reply (${e1.error} | ${e2.error})`);

// ---- 1. relative dir + approval + disconnect/restart of the local client ----
const rel = path.relative(os.homedir(), WORK);
await post(token, { type: 'new', cwd: rel, text: 'Use the Write tool to create hi.txt here containing exactly: hi from remote. Then reply with just: done', nonce: 'n1', mode: 'default' }); // asks before the write, whatever settings.json says
await until(() => A.events.some((e) => e.kind === 'approval'), 120000, 'approval');
const created = A.events.find((e) => e.kind === 'created');
check(created.cwd === fs.realpathSync(WORK), `relative dir "${rel.slice(0, 30)}…" resolved against home -> ${created.cwd}`);
check(created.nonce === 'n1', 'created event carries the nonce');
const sid = created.sid;
// (the state change follows the approval event: it may be a moment behind it)
check(await until(() => A.events.some((e) => e.kind === 'state' && e.state === 'waiting'), 3000), 'state -> waiting while approval pending');
const ap = A.events.find((e) => e.kind === 'approval');

log('killing local client while approval pending');
A.req.destroy(); B.req.destroy(); c.kill('SIGTERM');
await wait(1500);
c = startClient();
token = await getToken();
let T = stream(token);
await until(() => T.up && T.events.some((e) => e.kind === 'approval'), 10000, 'history replay');
check(!T.events.some((e) => e.kind === 'approval_done'), 'approval still pending after client restart');
check(contiguous(T.events) && T.events[0].seq === 1, 'replayed history is complete and in order');
await post(token, { type: 'approve', sid, rid: ap.rid, allow: true });
await until(() => results(T, sid).length >= 1, 120000, 'result 1');
check(fs.existsSync(path.join(WORK, 'hi.txt')) && fs.readFileSync(path.join(WORK, 'hi.txt'), 'utf8').trim() === 'hi from remote', 'file written on the "server"');
check(sessionState(T, sid) === 'idle', 'state idle after result');

// ---- 2. transport drop (ssh dies) while client keeps running ----
const before = T.events.length;
log('dropping the transport (simulated network drop)');
process.kill(c.pid, "SIGUSR2"); // the client drops its connection to the daemon
await until(() => !T.up, 5000, 'transport down');
await until(() => T.up, 10000, 'transport back up');
await post(token, { type: 'send', sid, text: 'What file did you create? Reply in 5 words or fewer, no tools.' });
await until(() => results(T, sid).length >= 2, 120000, 'result 2');
check(T.dupes === 0 && contiguous(T.events), `no duplicated or missing events across reconnect (dupes=${T.dupes})`);
log('  turn 2:', JSON.stringify(texts(T.events.slice(before))));

// ---- 3. AskUserQuestion ----
const n3 = T.events.length;
await post(token, { type: 'send', sid, text: 'Use the AskUserQuestion tool to ask me which color I prefer, with options Red and Blue. After I answer, reply with just the color I picked.' });
await until(() => T.events.slice(n3).some((e) => e.kind === 'approval'), 120000, 'AskUserQuestion approval');
const q = T.events.slice(n3).find((e) => e.kind === 'approval');
check(q.tool === 'AskUserQuestion', 'AskUserQuestion reaches the UI as a question card');
fs.writeFileSync(path.join(S, 'pending-question.json'), JSON.stringify(q)); // for the screenshot
await takeShot(path.join(S, 'shot-question.png'));
await post(token, { type: 'approve', sid, rid: q.rid, allow: true, answers: { [q.input.questions[0].question]: 'Blue' } });
await until(() => results(T, sid).length >= 3, 120000, 'result 3');
const reply3 = texts(T.events.slice(n3));
check(/blue/i.test(reply3), `answer delivered to Claude (reply: ${JSON.stringify(reply3)})`);

// ---- 4. interrupt a running Bash command ----
const n4 = T.events.length;
await post(token, { type: 'send', sid, text: 'Run this exact bash command in the foreground (do not use run_in_background): node -e \"setTimeout(() => console.log(1), 30000)\"' });
// The user's settings may auto-approve `sleep` (auto mode), so approve only if asked.
const bashStarted = () => T.events.slice(n4).some((e) => e.kind === 'approval' || (e.kind === 'msg' && e.msg.type === 'assistant' && e.msg.message.content.some((x) => x.type === 'tool_use' && x.name === 'Bash')));
await until(bashStarted, 120000, 'bash started');
// The tool_use message can arrive just before the approval for it: give that a moment to come.
await until(() => T.events.slice(n4).some((e) => e.kind === 'approval'), 2000).catch(() => {});
const b = T.events.slice(n4).find((e) => e.kind === 'approval');
if (b) await post(token, { type: 'approve', sid, rid: b.rid, allow: true });
await wait(3000);
check(sessionState(T, sid) === 'running', 'state running during the Bash command');
const tInt = Date.now();
await post(token, { type: 'interrupt', sid });
await until(() => sessionState(T, sid) === 'idle', 20000, 'idle after interrupt');
check(Date.now() - tInt < 15000, `interrupt stopped the 30s command in ${((Date.now() - tInt) / 1000).toFixed(1)}s`);
const n5 = T.events.length;
await post(token, { type: 'send', sid, text: 'Reply with just: still here' });
await until(() => T.events.slice(n5).some((e) => e.kind === 'msg' && e.msg.type === 'result'), 120000, 'result after interrupt');
check(/still here/i.test(texts(T.events.slice(n5))), 'session usable after interrupt');

fs.writeFileSync(path.join(S, 'events.json'), JSON.stringify(T.events.slice(n4), null, 1));
await takeShot(path.join(S, 'shot-final.png'));
c.kill('SIGTERM');
finish();

function sessionState(st, s) {
  const e = ofSid(st, s).filter((x) => x.kind === 'state').pop();
  return e?.state;
}
async function takeShot(file) {
  const B = browserPath();
  if (!B) return log('(no headless Chromium found; skipping screenshot)');
  await new Promise((res) => {
    const p = spawn(B, ['--disable-gpu', `--screenshot=${file}`, '--window-size=1300,900', '--timeout=3000', `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' });
    const k = setTimeout(() => p.kill('SIGKILL'), 20000);
    p.on('exit', () => { clearTimeout(k); res(); });
  });
  log('screenshot', path.basename(file));
}
