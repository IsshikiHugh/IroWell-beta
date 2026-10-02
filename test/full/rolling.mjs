// Rolling update: "Update server" never interrupts a session. A busy session (a question pending) stays
// on the old daemon until it is answered and idle; an idle one moves over at once, keeping its sid and
// its conversation. The UI sees one daemon throughout (local transport; the update restarts the daemon
// from this checkout).
import { spawn } from 'node:child_process';
import { CLIENT, outDir, log, check, until, finish, cleanEnv, clientApi } from '../lib.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4791;
const DIR = process.env.IRO_DIR;
const LOG = path.join(DIR, 'daemon.log');
const WORK = path.join(S, 'work-rolling');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const env = cleanEnv();


const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
client.stdout.on('data', (d) => log('client:', d.toString().trim()));
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const { token, cmd } = await clientApi(PORT);

// The page's view of the stream: resets on a new daemon, then the whole log again.
const T = { events: [], up: false, resets: 0, downs: 0, dupes: 0, lastSeq: 0 };
http.get({ host: '127.0.0.1', port: PORT, path: '/events?t=' + token }, (r) => {
  let b = '';
  r.on('data', (c) => {
    b += c; let i;
    while ((i = b.indexOf('\n\n')) >= 0) {
      const f = b.slice(0, i); b = b.slice(i + 2);
      if (!f.startsWith('data: ')) continue;
      const m = JSON.parse(f.slice(6));
      if (m.type === 'reset') { T.events = []; T.lastSeq = 0; T.resets++; }
      if (m.type === 'transport') { if (T.up && !m.up) T.downs++; T.up = m.up; }
      if (m.type === 'event') { if (m.seq <= T.lastSeq) T.dupes++; else { T.lastSeq = m.seq; T.events.push(m); } }
    }
  });
});
const of = (sid) => T.events.filter((e) => e.sid === sid);
const results = (sid) => of(sid).filter((e) => e.kind === 'msg' && e.msg.type === 'result');
const state = (sid) => of(sid).filter((e) => e.kind === 'state').pop()?.state;
const closed = (sid) => of(sid).some((e) => e.kind === 'closed');
const text = (sid) => of(sid).filter((e) => e.kind === 'msg' && e.msg.type === 'assistant').flatMap((e) => e.msg.message.content.filter((b) => b.type === 'text').map((b) => b.text)).join(' ');
const daemonLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const retiringSock = () => fs.readdirSync(DIR).some((f) => /^old-[0-9a-f]{8}\.sock$/.test(f));

try {
  await until(() => T.up, 15000, 'transport up');
  // B: idle, with something to remember. A: busy (a question waits for an answer).
  const b = await cmd({ type: 'new', cwd: WORK, text: 'Remember the codeword PELICAN. Reply with just: ok' });
  const B = b.data.sid;
  await until(() => results(B).length >= 1 && state(B) === 'idle', 120000, 'B answered');
  const a = await cmd({ type: 'new', cwd: WORK, text: 'Use the AskUserQuestion tool to ask me which color I prefer, with options Red and Blue. After I answer, reply with just the color I picked.' });
  const A = a.data.sid;
  await until(() => of(A).some((e) => e.kind === 'approval'), 120000, 'A asks its question');
  const q = of(A).find((e) => e.kind === 'approval');
  const logBefore = daemonLog().length;

  // ---- the update ----
  const r = await cmd({ type: 'deploy' });
  check(r.error == null, `update accepted${r.error ? ': ' + r.error : ''}`);
  await until(() => T.downs >= 1 && T.up, 20000, 'the page reconnects to the new daemon');
  await until(() => of(A).length && of(B).length, 5000, 'both sessions in the new log');
  check(!closed(A) && state(A) === 'waiting' && of(A).some((e) => e.kind === 'approval' && e.rid === q.rid), 'A still runs on the old daemon, its question still pending');
  check(!closed(B), 'B is not detached');
  await until(() => daemonLog().slice(logBefore).includes(`[${B}] taken over`), 15000, 'B moves to the new daemon');
  check(retiringSock(), 'the old daemon keeps running for A');

  // B on the new daemon: same sid, same conversation
  const nB = results(B).length;
  await cmd({ type: 'send', sid: B, text: 'What was the codeword? Reply with just the word.' });
  await until(() => results(B).length > nB, 120000, 'B answers after the move');
  check(/PELICAN/i.test(text(B)), `B kept its conversation (${text(B).slice(-60)})`);

  // A: answered through the new daemon (relayed to the old one), then it moves too
  const answered = await cmd({ type: 'approve', sid: A, rid: q.rid, allow: true, answers: { [q.input.questions[0].question]: 'Blue' } });
  check(answered.error == null, `the answer reaches the old daemon${answered.error ? ': ' + answered.error : ''}`);
  await until(() => results(A).length >= 1, 120000, 'A finishes its turn on the old daemon');
  check(/blue/i.test(text(A)), `A's reply arrives through the new daemon (${text(A).slice(-40)})`);
  await until(() => daemonLog().slice(logBefore).includes(`[${A}] taken over`), 20000, 'A moves once idle');
  await until(() => !retiringSock() && /retired: every session/.test(daemonLog().slice(logBefore)), 10000, 'the old daemon exits');
  check(!retiringSock(), 'no old daemon left');
  const n = results(A).length;
  await cmd({ type: 'send', sid: A, text: 'Which color did I pick? Reply with just the color.' });
  await until(() => results(A).length > n, 120000, 'A answers on the new daemon');
  check(/blue/i.test(text(A).slice(-40)), `A kept its conversation (${text(A).slice(-40)})`);
  check(T.dupes === 0 && T.events.every((e, i) => !i || e.seq === T.events[i - 1].seq + 1), 'one gapless event log throughout');
  check(!closed(A) && !closed(B), 'no session was ever detached');
} finally {
  client.kill('SIGTERM');
}
finish();
