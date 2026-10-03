// --local on a laptop: the client talks to the daemon's socket itself (no attach.mjs), the first start
// writes config.json with the local defaults, a busy session keeps macOS awake (caffeinate), and a quiet one is detached after a while and reattaches.
import { spawn, execFileSync } from 'node:child_process';
import { CLIENT, outDir, cleanEnv, log, check, until, finish, clientApi, eventStream } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4790;
const DIR = process.env.IRO_DIR;
const CONFIG = path.join(DIR, 'config.json');
const WORK = fs.realpathSync(fs.mkdirSync(path.join(S, 'work-local'), { recursive: true }) || path.join(S, 'work-local'));
fs.rmSync(CONFIG, { force: true });

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
// This suite's daemon: the daemon.mjs whose working directory is $IRO_DIR.
function daemonPid() {
  for (const pid of sh('pgrep', ['-f', 'server/daemon[.]mjs']).split(/\s+/).filter(Boolean)) {
    const cwd = /^n(.*)$/m.exec(sh('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']))?.[1] || '';
    try { if (cwd && fs.realpathSync(cwd) === fs.realpathSync(DIR)) return pid; } catch {}
  }
  return null;
}
const caffeinated = (pid) => sh('pgrep', ['-f', `caffeinate -i -w ${pid}$`]).trim() !== '';

const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
client.stdout.on('data', (d) => log('client:', d.toString().trim()));
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const { token, cmd } = await clientApi(PORT);

const T = eventStream(PORT, token);
const of = (sid) => T.events.filter((e) => e.sid === sid);
const state = (sid) => of(sid).filter((e) => e.kind === 'state').pop()?.state;
const closed = (sid) => of(sid).some((e) => e.kind === 'closed');
const results = (sid) => of(sid).filter((e) => e.kind === 'msg' && e.msg.type === 'result');

try {
  await until(() => T.up, 15000, 'transport up');
  // ---- transport and config ----
  const kids = sh('pgrep', ['-lfP', String(client.pid)]);
  check(!/attach\.mjs/.test(kids), 'the local client talks to the daemon socket directly (no attach.mjs)');
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  check(cfg.detachIdleMinutes === 60 && cfg.keepAwake === true, `first local start writes the local defaults (${JSON.stringify(cfg)})`);
  const pid = daemonPid();
  check(!!pid, 'found this suite\'s daemon');

  // ---- a busy session keeps the machine awake ----
  const a = await cmd({ type: 'new', cwd: WORK, text: 'Use the AskUserQuestion tool to ask me which color I prefer, with options Red and Blue. After I answer, reply with just the color I picked.' });
  const A = a.data.sid;
  await until(() => of(A).some((e) => e.kind === 'approval'), 120000, 'A asks its question');
  if (process.platform === 'darwin') await until(() => caffeinated(pid), 10000, 'caffeinate while busy');
  if (process.platform === 'darwin') check(caffeinated(pid), 'macOS: caffeinate -i runs while a session waits for an answer');

  fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg, detachIdleMinutes: 0.1 }));

  // ---- quiet sessions are detached, and come back ----
  const q = of(A).find((e) => e.kind === 'approval');
  await cmd({ type: 'approve', sid: A, rid: q.rid, allow: true, answers: { [q.input.questions[0].question]: 'Blue' } });
  await until(() => results(A).length >= 1 && state(A) === 'idle', 120000, 'A answers');
  check(!closed(A), 'not detached while it was busy');
  if (process.platform === 'darwin') await until(() => !caffeinated(pid), 10000, 'caffeinate ends once idle');
  if (process.platform === 'darwin') check(!caffeinated(pid), 'macOS: caffeinate ends once nothing is busy');
  await until(() => closed(A), 30000, 'A detached after 6 s quiet');
  check(closed(A), 'a quiet session is detached (detachIdleMinutes)');
  const claudeSessionId = of(A).find((e) => e.kind === 'init')?.claudeSessionId;
  const back = await cmd({ type: 'resume', claudeSessionId, cwd: WORK, title: 'A' });
  check(back.data?.sid && !back.data.existing, 'it reattaches');
  fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg, detachIdleMinutes: 60 }));
  const B = back.data.sid;
  await cmd({ type: 'send', sid: B, text: 'Which color did I pick? Reply with just the color.' });
  await until(() => results(B).length >= 1, 120000, 'the reattached session answers');
  const said = of(B).filter((e) => e.kind === 'msg' && e.msg.type === 'assistant').flatMap((e) => e.msg.message.content.filter((x) => x.type === 'text').map((x) => x.text)).join(' ');
  check(/blue/i.test(said), `it kept its conversation (${said.slice(-40)})`);
} finally {
  client.kill('SIGTERM');
}
finish();
