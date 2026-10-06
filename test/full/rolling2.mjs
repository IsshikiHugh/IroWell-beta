// Rolling updates, several in a row while a session stays busy on the first daemon: every update goes
// through, and that session stays fully usable from the page the whole time (opened, answered, detached,
// reattached), however many daemons came after it.
import { spawn } from 'node:child_process';
import { CLIENT, outDir, log, check, until, finish, cleanEnv, clientApi, eventStream } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

const S = outDir();
const PORT = 4792;
const DIR = process.env.IRO_DIR;
const LOG = path.join(DIR, 'daemon.log');
const WORK = path.join(S, 'work-rolling2');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);

const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
client.stdout.on('data', (d) => log('client:', d.toString().trim()));
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const { token, cmd } = await clientApi(PORT);
const T = eventStream(PORT, token);
const of = (sid) => T.events.filter((e) => e.sid === sid);
const state = (sid) => of(sid).filter((e) => e.kind === 'state').pop()?.state;
const closed = (sid) => of(sid).some((e) => e.kind === 'closed');
const daemonLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');
const oldSocks = () => fs.readdirSync(DIR).filter((f) => /^old-[0-9a-f]{8}\.sock$/.test(f));
const timed = async (what, p) => { const t = Date.now(); const r = await p; log(`${what}: ${Date.now() - t} ms`); return r; };

try {
  await until(() => T.up, 15000, 'transport up');
  const ask = (fruit) => `Use the AskUserQuestion tool to ask me which ${fruit} I prefer, with options Apple and Pear. After I answer, reply with just the fruit I picked.`;
  const a = await cmd({ type: 'new', cwd: WORK, text: ask('fruit') });
  const A = a.data.sid;
  await until(() => of(A).some((e) => e.kind === 'approval'), 120000, 'A asks its question');
  const aId = of(A).find((e) => e.kind === 'init')?.claudeSessionId;
  const b = await cmd({ type: 'new', cwd: WORK, text: 'Reply with just: ok' });
  const B = b.data.sid;
  await until(() => state(B) === 'idle' && of(B).some((e) => e.kind === 'msg' && e.msg.type === 'result'), 120000, 'B answered');

  for (let n = 1; n <= 3; n++) {
    const downs = T.downs;
    const r = await timed(`update ${n}`, cmd({ type: 'deploy' }));
    check(r.error == null, `update ${n} goes through${r.error ? ': ' + r.error : ''}`);
    await until(() => T.downs > downs && T.up, 20000, `update ${n}: the page is on the new daemon`);
    await until(() => of(A).length && of(B).length, 5000);
    check(oldSocks().length >= 1, `update ${n}: A's daemon is still there (${oldSocks().join(' ')})`);
    check(!closed(A) && state(A) === 'waiting', `update ${n}: A still runs, its question pending (closed=${closed(A)} state=${state(A)})`);
    const act = await timed(`update ${n}: activity(A)`, cmd({ type: 'activity', sid: A }));
    check(act.data?.state === 'waiting', `update ${n}: A answers commands (${JSON.stringify(act.data ?? act.error)})`);
    await until(() => !closed(B) && daemonLog().split('\n').filter((l) => l.includes(`[${B}] taken over`)).length >= n, 15000, `update ${n}: B moved over`);
    const st = await cmd({ type: 'activity', sid: B });
    check(st.data && !st.error, `update ${n}: B answers commands (${JSON.stringify(st.data ?? st.error)})`);
    await until(() => oldSocks().length === 1, 10000, `update ${n}: only A's daemon is left (${oldSocks().join(' ')})`);
  }

  // The link to A's daemon breaks while that daemon runs on (something else adopts it): the main daemon
  // takes it back, and A neither shows as detached nor gets its conversation twice.
  const created = () => of(A).filter((e) => e.kind === 'created').length;
  const nA = of(A).length;
  const thief = net.connect(path.join(DIR, oldSocks()[0]));
  let dropped = false;
  thief.on('error', () => {});
  thief.on('end', () => (dropped = true));
  thief.resume();
  thief.on('connect', () => thief.write(JSON.stringify({ type: 'adopt', id: 1 }) + '\n'));
  await until(() => /lost the link to old-/.test(daemonLog()), 5000, 'the main daemon notices the lost link');
  await until(() => dropped, 5000, 'it adopts that daemon again');
  thief.destroy();
  await until(async () => (await cmd({ type: 'activity', sid: A })).data?.state === 'waiting', 5000, 'A answers commands again');
  check(!closed(A) && created() === 1 && of(A).length === nA, `A is not detached, nor drawn twice (closed=${closed(A)} created=${created()} events ${nA} -> ${of(A).length})`);

  // Detach A, three daemons later
  const c = await timed('close(A)', cmd({ type: 'close', sid: A }));
  check(c.error == null, `A detaches${c.error ? ': ' + c.error : ''}`);
  await until(() => closed(A), 10000, 'A shows as detached');
  await until(() => oldSocks().length === 0, 15000, `the first daemon exits once A is gone (${oldSocks().join(' ')})`);
  const rc = await cmd({ type: 'resume', claudeSessionId: aId, cwd: WORK, title: 'A' });
  check(rc.error == null && rc.data?.sid && rc.data.sid !== A, `A reattaches (${JSON.stringify(rc.data ?? rc.error)})`);
  check(T.dupes === 0, 'no duplicate events');
} finally {
  client.kill('SIGTERM');
}
finish();
