// --local on a laptop: the client talks to the daemon's socket itself (no attach.mjs), the first start
// writes config.json with the local defaults, a busy session keeps macOS awake (caffeinate), and a quiet one is detached after a while and reattaches.
import { execFileSync } from 'node:child_process';
import { outDir, log, check, until, finish, startClient, eventStream, daemonPids } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4790;
const DIR = process.env.IRO_DIR;
const CONFIG = path.join(DIR, 'config.json');
fs.mkdirSync(path.join(S, 'work-local'), { recursive: true });
const WORK = fs.realpathSync(path.join(S, 'work-local'));
fs.rmSync(CONFIG, { force: true });

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
const caffeinated = (pid) => sh('pgrep', ['-f', `caffeinate -i -w ${pid}$`]).trim() !== '';

const { client, token, cmd } = await startClient(PORT, { stdio: ['ignore', 'pipe', 'pipe'] });
client.stdout.on('data', (d) => log('client:', d.toString().trim()));
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));

const T = eventStream(PORT, token);
const { of, state, closed, results } = T;

try {
  await until(() => T.up, 15000, 'transport up');
  // ---- transport and config ----
  const kids = sh('pgrep', ['-lfP', String(client.pid)]);
  check(!/attach\.mjs/.test(kids), 'the local client talks to the daemon socket directly (no attach.mjs)');
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  check(cfg.detachIdleMinutes === 60 && cfg.keepAwake === true, `first local start writes the local defaults (${JSON.stringify(cfg)})`);
  const pid = daemonPids(DIR)[0] ?? null; // this suite's daemon
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

  // ---- reopened (from Past sessions, or reattached): it runs with the defaults from Settings ----
  await cmd({ type: 'close', sid: B });
  await until(() => closed(B), 10000, 'B detached');
  await cmd({ type: 'setSettings', defaults: { model: 'sonnet', effort: 'low', mode: 'plan' } });
  const past = await cmd({ type: 'resume', claudeSessionId, cwd: WORK, title: 'A' });
  const C = past.data?.sid;
  const made = of(C).find((e) => e.kind === 'created');
  check(made?.model === 'sonnet' && made.effort === 'low' && made.mode === 'plan', `it starts with the defaults (${JSON.stringify(made && { model: made.model, effort: made.effort, mode: made.mode })})`);
  await cmd({ type: 'send', sid: C, text: 'Which color did I pick? Reply with just the color.' });
  await until(() => results(C).length >= 1 && of(C).some((e) => e.kind === 'stats' && e.model), 120000, 'the reopened session answers');
  const init = of(C).find((e) => e.kind === 'init'), st = of(C).filter((e) => e.kind === 'stats' && e.model).at(-1);
  check(init?.mode === 'plan' && /sonnet/i.test(init?.model || '') && /sonnet/i.test(st?.model || '') && st?.effort === 'low',
    `its CLI runs them: not the transcript's model (${init?.mode}, ${init?.model}, ${st?.model}, ${st?.effort})`);
  await cmd({ type: 'setSettings', defaults: { model: null, effort: null, mode: null } });
} finally {
  client.kill('SIGTERM');
}
finish();
