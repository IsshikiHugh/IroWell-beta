// --local on a laptop: the client talks to the daemon's socket itself (no attach.mjs), the first start writes
// config.json with the local defaults, a busy session keeps macOS awake (caffeinate), a quiet one is detached
// after a while and reattaches with its conversation, and a reopened one runs with the defaults from Settings.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, log, check, until, finish, startClient, eventStream, daemonPids, workDir } from '../lib.mjs';

// (the daemon looks for quiet and busy sessions every 10 s and 5 s: here every half second)
process.env.IRO_IDLE_CHECK_MS = '500';
process.env.IRO_AWAKE_CHECK_MS = '500';
const DIR = process.env.IRO_DIR;
const CONFIG = path.join(DIR, 'config.json');
const WORK = workDir('work-local');
fs.rmSync(CONFIG, { force: true });

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
const caffeinated = (pid) => sh('pgrep', ['-f', `caffeinate -i -w ${pid}$`]).trim() !== '';
const mac = process.platform === 'darwin';

const { client, token, cmd } = await startClient(PORT, { stdio: ['ignore', 'pipe', 'pipe'] });
client.stdout.on('data', (d) => log('client:', d.toString().trim()));
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const T = eventStream(PORT, token, cmd);
const { of, state, closed, results } = T;

try {
  await until(() => T.up, 15000, 'transport up');
  // ---- transport and config ----
  check(!/attach\.mjs/.test(sh('pgrep', ['-lfP', String(client.pid)])), 'the local client talks to the daemon socket directly (no attach.mjs)');
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  check(cfg.detachIdleMinutes === 60 && cfg.keepAwake === true, `the first local start writes the local defaults (${JSON.stringify(cfg)})`);
  const pid = daemonPids(DIR)[0] ?? null; // this suite's daemon
  check(!!pid, 'found this suite\'s daemon');

  // ---- a busy session keeps the machine awake ----
  const A = (await cmd({ type: 'new', cwd: WORK, text: 'Remember the codeword BLUEJAY and ask me which color I prefer.' })).data.sid;
  await until(() => of(A).some((e) => e.kind === 'approval'), 10000, 'A asks its question');
  if (mac) check(await until(() => caffeinated(pid), 5000), 'macOS: caffeinate -i runs while a session waits for an answer');
  fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg, detachIdleMinutes: 0.05 })); // 3 s

  // ---- quiet sessions are detached, and come back ----
  const q = of(A).find((e) => e.kind === 'approval');
  await cmd({ type: 'approve', sid: A, rid: q.rid, allow: true, answers: { [q.input.questions[0].question]: 'Blue' } });
  await until(() => results(A).length >= 1 && state(A) === 'idle', 10000, 'A answers');
  check(!closed(A), 'not detached while it was busy');
  if (mac) check(await until(() => !caffeinated(pid), 5000), 'macOS: caffeinate ends once nothing is busy');
  check(await until(() => closed(A), 10000), 'a quiet session is detached (detachIdleMinutes)');
  const claudeSessionId = T.claudeId(A);
  const back = await cmd({ type: 'resume', claudeSessionId, cwd: WORK, title: 'A' });
  check(back.data?.sid && !back.data.existing, 'it reattaches');
  fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg, detachIdleMinutes: 60 }));
  const B = back.data.sid;
  const said = await T.ask(B, 'What was the codeword?');
  check(said === 'BLUEJAY', `it kept its conversation (${said})`);

  // ---- reopened (from Past sessions, or reattached): it runs with the defaults from Settings ----
  await cmd({ type: 'close', sid: B });
  await until(() => closed(B), 10000, 'B detached');
  await cmd({ type: 'setSettings', defaults: { model: 'opus', effort: 'low', mode: 'plan' } });
  const C = (await cmd({ type: 'resume', claudeSessionId, cwd: WORK, title: 'A' })).data?.sid;
  const made = of(C).find((e) => e.kind === 'created');
  check(made?.model === 'opus' && made.effort === 'low' && made.mode === 'plan', `it starts with the defaults (${JSON.stringify(made && { model: made.model, effort: made.effort, mode: made.mode })})`);
  const again = await T.ask(C, 'What was the codeword?');
  await until(() => of(C).some((e) => e.kind === 'stats' && e.model), 5000, 'the reopened session\'s stats');
  // (what its CLI was started with, as the fake reports it: not the model the conversation ran on before)
  const init = of(C).find((e) => e.kind === 'init'), st = of(C).filter((e) => e.kind === 'stats' && e.model).at(-1);
  const before = of(A).find((e) => e.kind === 'init')?.model;
  check(!/opus/i.test(before || 'opus') && init?.mode === 'plan' && /opus/i.test(init?.model || '') && /opus/i.test(st?.model || '') && st?.effort === 'low' && again === 'BLUEJAY',
    `its CLI runs them, with the conversation (${init?.mode}, ${init?.model} (was ${before}), ${st?.model}, ${st?.effort}, ${again})`);
  await cmd({ type: 'setSettings', defaults: { model: null, effort: null, mode: null } });
} finally {
  T.req.destroy();
  client.kill('SIGTERM');
}
finish();
