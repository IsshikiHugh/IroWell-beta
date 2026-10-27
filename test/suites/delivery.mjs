// Delivery between the page's side (the client's HTTP + event stream) and the daemon, over the local
// transport: a bad token, a relative folder, the nonce, an approval that survives a client restart (history
// replayed in order), a transport drop with nothing lost or doubled, AskUserQuestion, and an interrupt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PORT, cleanEnv, log, check, until, finish, startClient, eventStream, workDir } from '../lib.mjs';

const WORK = workDir('work-delivery');
const env = cleanEnv(), stdio = ['ignore', 'pipe', 'pipe'];
const logOutput = (p) => {
  p.stdout.on('data', (d) => log('client:', d.toString().trim()));
  p.stderr.on('data', (d) => log('client err:', d.toString().trim()));
};
const contiguous = (evs) => evs.every((e, i) => i === 0 || e.seq === evs[i - 1].seq + 1);

let { client: c, token, req } = await startClient(PORT, { env, stdio });
logOutput(c);
const post = (body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body) }).then((r) => r.status);
// (the other HTTP guards: test/suites/basics.mjs)
check((await req('GET', '/events?t=bad')).status === 403, 'the event stream with a bad token -> 403');

let T = eventStream(PORT, token);
await until(() => T.up, 10000, 'transport up');

// ---- a relative folder, the nonce, and an approval pending across a restart of the client ----
const rel = path.relative(os.homedir(), WORK);
await post({ type: 'new', cwd: rel, text: 'Use the Write tool to create hi.txt here containing exactly: hi from remote. Then reply with just: done', nonce: 'n1', mode: 'default' });
await until(() => T.events.some((e) => e.kind === 'approval'), 10000, 'approval');
const created = T.events.find((e) => e.kind === 'created');
check(created?.cwd === WORK, `a relative folder "${rel.slice(0, 30)}…" is resolved against home -> ${created?.cwd}`);
check(created?.nonce === 'n1', 'the created event carries the nonce');
const sid = created.sid;
// (the state change follows the approval event: it may be a moment behind it)
check(await until(() => T.state(sid) === 'waiting', 3000), 'state -> waiting while an approval is pending');
const ap = T.events.find((e) => e.kind === 'approval');

log('killing the client while the approval is pending');
T.req.destroy();
await new Promise((r) => { c.once('exit', r); c.kill('SIGTERM'); });
({ client: c, token } = await startClient(PORT, { env, stdio, fresh: false }));
logOutput(c);
T = eventStream(PORT, token);
await until(() => T.up && T.events.some((e) => e.kind === 'approval'), 10000, 'history replay');
check(!T.events.some((e) => e.kind === 'approval_done'), 'the approval is still pending after the client restart');
check(contiguous(T.events) && T.events[0].seq === 1, 'the replayed history is complete and in order');
await post({ type: 'approve', sid, rid: ap.rid, allow: true });
await until(() => T.results(sid).length >= 1, 10000, 'result 1');
check(fs.readFileSync(path.join(WORK, 'hi.txt'), 'utf8').trim() === 'hi from remote', 'the file is written on the "server"');
check(T.state(sid) === 'idle', 'state idle after the result');

// ---- the transport drops (ssh dies) while the client runs on ----
process.kill(c.pid, 'SIGUSR2'); // the client drops its connection to the daemon
await until(() => !T.up, 5000, 'transport down');
await until(() => T.up, 10000, 'transport back up');
await post({ type: 'send', sid, text: 'Reply with just: still connected' });
await until(() => T.results(sid).length >= 2, 10000, 'result 2');
check(T.dupes === 0 && contiguous(T.events) && T.lastText(sid) === 'still connected', `no duplicated or missing events across the reconnect (dupes=${T.dupes})`);

// ---- AskUserQuestion: a question card, the answer goes back to Claude ----
const n3 = T.events.length;
await post({ type: 'send', sid, text: 'Ask me which color I prefer' });
await until(() => T.events.slice(n3).some((e) => e.kind === 'approval'), 10000, 'AskUserQuestion approval');
const q = T.events.slice(n3).find((e) => e.kind === 'approval');
check(q.tool === 'AskUserQuestion' && q.input.questions[0].options.length === 2, 'AskUserQuestion reaches the page as a question with its options');
await post({ type: 'approve', sid, rid: q.rid, allow: true, answers: { [q.input.questions[0].question]: 'Blue' } });
await until(() => T.results(sid).length >= 3, 10000, 'result 3');
const answer = T.events.slice(n3).flatMap((e) => (e.kind === 'msg' && e.msg.type === 'user' && Array.isArray(e.msg.message.content) ? e.msg.message.content : []))
  .find((b) => b.type === 'tool_result');
check(/"Which color do you prefer\?"="Blue"/.test(String(answer?.content)), `the answer is delivered to Claude (${JSON.stringify(answer?.content)})`);

// ---- interrupting a running command; the session goes on ----
const n4 = T.events.length;
await post({ type: 'send', sid, text: 'Run a 30-second command' });
await until(() => T.events.slice(n4).some((e) => e.kind === 'msg' && e.msg.type === 'assistant' && e.msg.message.content.some((x) => x.type === 'tool_use' && x.name === 'Bash')), 10000, 'Bash started');
check(T.state(sid) === 'running', 'state running during the command');
const tInt = Date.now();
await post({ type: 'interrupt', sid });
await until(() => T.state(sid) === 'idle', 10000, 'idle after the interrupt');
check(Date.now() - tInt < 5000 && !T.closed(sid), `the interrupt stops the 30 s command in ${((Date.now() - tInt) / 1000).toFixed(1)} s`);
await post({ type: 'send', sid, text: 'Reply with just: still here' });
await until(() => T.results(sid).length >= 5, 10000, 'result after the interrupt');
check(T.lastText(sid) === 'still here', 'the session is usable after the interrupt');

T.req.destroy();
c.kill('SIGTERM');
finish();
