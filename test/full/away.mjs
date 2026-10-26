// Away mode with real turns (server/away.mjs): a watched session runs in auto mode; a question the user's own
// words settle is answered for them by the judge (a real model), one they don't is left for the user; each turn is
// summed up, and turning it off makes the report.
import fs from 'node:fs';
import path from 'node:path';
import { outDir, cleanEnv, log, check, until, finish, startClient, eventStream } from '../lib.mjs';

const S = outDir();
const PORT = 4819;
const WORK = path.join(S, 'away-work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const { client, token, cmd } = await startClient(PORT, { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
client.stdout.on('data', (d) => log('client:', d.toString().trim()));
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const T = eventStream(PORT, token, cmd);
await until(() => T.up, 10000, 'transport up');
// What `get` returns once it returns something (until() says only whether it did), or undefined.
const found = async (get, ms) => { let v; await until(async () => (v = await get()), ms); return v; };

const first = 'This is a test of the question tool, so you must ask even though my answer is written below. Use the AskUserQuestion '
  + 'tool once to ask me which dataset to train on, with exactly two options: CIFAR-10 and ImageNet. Then reply with only the '
  + 'name I picked, and do nothing else. (So you know in advance: I want CIFAR-10 for this one.)';
const { data: { sid } } = await cmd({ type: 'new', cwd: WORK, text: first, model: 'sonnet', mode: 'default' });
check(await until(() => T.claudeId(sid), 120000), 'the session has its Claude session id');
const cid = T.claudeId(sid);
const on = await cmd({ type: 'awayStart', sessions: [cid] });
check(on.data?.on, 'away mode on for it');
check(await until(() => T.of(sid).some((e) => e.kind === 'meta' && e.mode === 'auto'), 30000), 'it runs in auto mode');
const done1 = await found(() => T.of(sid).find((e) => e.kind === 'approval_done' && e.by === 'away'), 240000);
check(done1?.allow && /CIFAR-10/.test(JSON.stringify(done1.answers)), `the judge answers what the user's words settle (${JSON.stringify(done1?.answers)})`);
check(await until(() => T.results(sid).length >= 1, 180000) && /CIFAR-10/.test(T.lastText(sid)), `and Claude goes on with it (${T.lastText(sid).slice(0, 60)})`);

const before = T.of(sid).filter((e) => e.kind === 'approval').length;
await cmd({ type: 'send', sid, text: 'Now use AskUserQuestion once to ask me which learning rate to use, with exactly two options: 0.1 and 0.01. Then reply with only my pick.' });
const ap = await found(() => T.of(sid).filter((e) => e.kind === 'approval')[before], 180000);
check(ap?.tool === 'AskUserQuestion', 'a second question comes');
const waiting = await found(async () => (await cmd({ type: 'awayState' })).data?.waiting?.find((w) => w.rid === ap.rid && w.status === 'waiting'), 240000);
check(!!waiting, `one the user's words don't settle waits for the user (${waiting?.why})`);
await cmd({ type: 'approve', sid, rid: ap.rid, allow: true, answers: { [ap.input.questions[0].question]: '0.01' } });
check(await until(() => T.results(sid).length >= 2, 180000) && /0\.01/.test(T.lastText(sid)), 'the user answers it themselves');
const logged = (await cmd({ type: 'awayLog' })).data || [];
check(logged.some((e) => e.type === 'decided' && e.kind === 'question' && e.quote) && logged.some((e) => e.type === 'answered' && e.by === 'user'),
  `the away log has the judge's answer with its quote, and the user's own (${logged.map((e) => e.type).join(' ')})`);
const turns = await found(async () => { const l = (await cmd({ type: 'awayLog' })).data || []; return l.filter((e) => e.type === 'turn').length >= 2 && l.filter((e) => e.type === 'turn'); }, 180000);
check(turns && turns.every((t) => t.summary && t.summary !== '(no summary)'), `each turn is summed up by a model (${turns && turns.map((t) => t.summary).join(' | ')})`);
const stopped = await cmd({ type: 'awayStop' });
check(await until(() => T.of(sid).filter((e) => e.kind === 'meta' && e.mode).at(-1)?.mode === 'default', 30000), 'off: back in default mode');
const md = (await cmd({ type: 'awayReport', since: stopped.data.reportSince })).data?.text || '';
const part = md.split('## Sessions')[1] || '';
check(/## Rejected Actions\n\nNone\./.test(md) && /### .+\n\n.+\n\n- \d\d:\d\d /.test(part) && /\b(the|and|session)\b/i.test(part),
  `the report: no rejected actions, then the session's task and its timeline, in the user's language (${part.slice(0, 300)})`);
client.kill('SIGTERM');
finish();
