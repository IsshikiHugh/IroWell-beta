// Away mode with the real model (server/away.mjs; its logic, on stand-in answers, is in test/suites/away.mjs): what
// only a model can show. 1. A watched session runs in auto mode; the away agent answers a question the user's own
// words settle, and leaves one that matters (a push) to the user; each turn is summed up, and turning it off makes
// the report. 2. The away agent on a stand-in Slack (test/fakeslack.mjs): it answers how a session is doing; does
// what the user asks in the session they name, and asks which one when they name none; settles a trivial question
// a session stops on by itself, and asks the user one that matters, naming the session by its ID.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, cleanEnv, log, check, until, finish, startClient, eventStream, workDir } from '../lib.mjs';
import { fakeSlack } from '../fakeslack.mjs';

const slack = await fakeSlack();
const { client, token, cmd } = await startClient(PORT, { env: cleanEnv({ IRO_TEST_SLACK_API: slack.api }), stdio: ['ignore', 'pipe', 'pipe'] });
client.stdout.on('data', (d) => log('client:', d.toString().trim()));
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const T = eventStream(PORT, token, cmd);
await until(() => T.up, 10000, 'transport up');
// What `get` returns once it returns something (until() says only whether it did), or undefined.
const found = async (get, ms) => { let v; await until(async () => (v = await get()), ms); return v; };

// ---- 1. the away agent on requests, turn summaries, the report ----
{
  const WORK = workDir('away-work');
  const first = 'This is a test of the question tool, so you must ask even though my answer is written below. Use the AskUserQuestion '
    + 'tool once to ask me which dataset to train on, with exactly two options: CIFAR-10 and ImageNet. Then reply with only the '
    + 'name I picked, and do nothing else. (So you know in advance: I want CIFAR-10 for this one.)';
  const { data: { sid } } = await cmd({ type: 'new', cwd: WORK, text: first, model: 'sonnet', mode: 'default' });
  check(await until(() => T.claudeId(sid), 120000), 'the session has its Claude session id');
  const on = await cmd({ type: 'awayStart', sessions: [T.claudeId(sid)] });
  check(on.data?.on && /^[A-Z2-9]{4}$/.test(on.data.sessions[0].uid), 'away mode on for it, with an ID');
  check(await until(() => T.of(sid).some((e) => e.kind === 'meta' && e.mode === 'auto'), 30000), 'it runs in auto mode');
  const done1 = await found(() => T.of(sid).find((e) => e.kind === 'approval_done' && e.by === 'agent'), 300000);
  check(done1?.allow && /CIFAR-10/.test(JSON.stringify(done1.answers)), `the away agent answers what the user's words settle (${JSON.stringify(done1?.answers)} | ${done1?.quote})`);
  check(await until(() => T.results(sid).length >= 1, 180000) && /CIFAR-10/.test(T.lastText(sid)), `and Claude goes on with it (${T.lastText(sid).slice(0, 60)})`);

  const before = T.of(sid).filter((e) => e.kind === 'approval').length;
  await cmd({ type: 'send', sid, text: 'Now use AskUserQuestion once to ask me whether to force-push the results to the shared main branch, with exactly two options: Push now, Not yet. Then reply with only my pick, and do nothing else.' });
  const ap = await found(() => T.of(sid).filter((e) => e.kind === 'approval')[before], 180000);
  check(ap?.tool === 'AskUserQuestion', 'a second question comes');
  const waiting = await found(async () => (await cmd({ type: 'awayState' })).data?.waiting?.find((w) => w.rid === ap.rid && w.status === 'waiting'), 300000);
  check(!!waiting, `one that matters (a force-push) is left for the user (${waiting?.why})`);
  await cmd({ type: 'approve', sid, rid: ap.rid, allow: true, answers: { [ap.input.questions[0].question]: 'Not yet' } });
  check(await until(() => T.results(sid).length >= 2, 180000) && /Not yet/i.test(T.lastText(sid)), 'the user answers it themselves');
  const logged = (await cmd({ type: 'awayLog' })).data || [];
  check(logged.some((e) => e.type === 'decided' && e.by === 'agent' && e.kind === 'question') && logged.some((e) => e.type === 'answered' && e.by === 'user')
    && !logged.some((e) => e.type === 'agent' && e.action === 'send'),
    `the away log has the agent's answer and the user's own; a session done and waiting for nothing got no message (${logged.map((e) => e.type).join(' ')})`);
  const turns = await found(async () => { const l = (await cmd({ type: 'awayLog' })).data || []; return l.filter((e) => e.type === 'turn').length >= 2 && l.filter((e) => e.type === 'turn'); }, 180000);
  check(turns && turns.every((t) => t.summary && t.summary !== '(no summary)'), `each turn is summed up by a model (${turns && turns.map((t) => t.summary).join(' | ')})`);
  const stopped = await cmd({ type: 'awayStop' });
  check(await until(() => T.of(sid).filter((e) => e.kind === 'meta' && e.mode).at(-1)?.mode === 'default', 30000), 'off: back in default mode');
  const md = (await cmd({ type: 'awayReport', since: stopped.data.reportSince })).data?.text || '';
  const part = md.split('## Sessions')[1] || '';
  check(/## Rejected Actions\n\nNone\./.test(md) && /### .+\n\n.+\n\n- \d\d:\d\d /.test(part) && /\b(the|and|session)\b/i.test(part),
    `the report: no rejected actions, then the session's task and its timeline, in the user's language (${part.slice(0, 300)})`);
}

// ---- 2. the away agent on Slack ----
{
  const WORK = workDir('agent-work', { 'train.log': Array.from({ length: 12 }, (_, i) => `epoch ${i + 1}/40 loss ${(2.3 - i * 0.12).toFixed(3)}`).join('\n') + '\n' });
  const WORK2 = workDir('agent-work2');
  const ME = 'U0USER0001';
  check((await cmd({ type: 'awaySlackSet', appToken: 'xapp-1-A0TEST-1234567890-abcdef', botToken: 'xoxb-1234567890-abcdefghij', userId: ME })).data?.set, 'Slack set up');
  const { data: { sid } } = await cmd({ type: 'new', cwd: WORK, text: `Reply with just: ready. (Later I may ask you for small files here; the training log is ${path.join(WORK, 'train.log')}.)`, model: 'sonnet', mode: 'default' });
  const { data: { sid: sid2 } } = await cmd({ type: 'new', cwd: WORK2, text: 'Reply with just: ready.', model: 'sonnet', mode: 'default' });
  check(await until(() => T.results(sid).length >= 1 && T.results(sid2).length >= 1, 180000), 'both sessions have done a turn');
  const on = await cmd({ type: 'awayStart', sessions: [T.claudeId(sid), T.claudeId(sid2)] });
  const [A, B] = [sid, sid2].map((x) => on.data.sessions.find((w) => w.sid === x)?.uid);
  check(await until(() => slack.connected(), 10000) && A && B, `away mode on, Slack connected (${A}, ${B})`);
  const agentRow = () => T.events.findLast((e) => e.kind === 'created' && e.own === 'away'); // (this time away's: part 1's is archived)
  // (what the agent did, in the log: its tool calls and what they returned)
  const dumpAgent = () => {
    for (const e of T.of(agentRow()?.sid)) {
      if (e.kind === 'user_text') log('agent <-', e.text.slice(0, 200));
      if (e.kind !== 'msg') continue;
      for (const b of e.msg.message?.content || []) {
        if (b.type === 'tool_use') log('agent tool', b.name, JSON.stringify(b.input).slice(0, 300));
        else if (b.type === 'tool_result') log('agent result', JSON.stringify(b.content).slice(0, 400));
        else if (b.type === 'text') log('agent says', b.text.slice(0, 300));
      }
    }
  };
  const agentIdle = () => until(() => { const a = agentRow(); return a && T.state(a.sid) !== 'running'; }, 300000);
  // (both were idle when picked: their last turns went to the agent, which has nothing to do with "ready")
  await agentIdle();
  const n0 = slack.posts().length;
  slack.message(ME, `${A}: how far is the training? Read its train.log and tell me the last epoch, in one line.`);
  const answer = await found(() => slack.posts().slice(n0).find((p) => /\b12\b/.test(p.text) && !/Away mode/.test(p.text)), 300000);
  check(!!answer, `the away agent answers on Slack, from the log (${answer?.text?.slice(0, 120)})`);
  check(!slack.posts().slice(0, n0).some((p) => p.thread_ts && /ready/i.test(p.text)), 'two sessions done and waiting for nothing: nothing was posted');

  await agentIdle();
  const n1 = slack.posts().length;
  slack.message(ME, 'Ask my session to create a file named done.txt containing the word ok.');
  const which = await found(() => slack.posts().slice(n1).find((p) => p.text.includes(A) && p.text.includes(B)), 300000);
  dumpAgent();
  check(!!which && !fs.existsSync(path.join(WORK, 'done.txt')) && !fs.existsSync(path.join(WORK2, 'done.txt')), `with no ID and two sessions, it asks which (${which?.text?.slice(0, 200)})`);
  await agentIdle();
  slack.message(ME, `${A}`);
  check(await until(() => fs.existsSync(path.join(WORK, 'done.txt')), 300000) && !fs.existsSync(path.join(WORK2, 'done.txt')), 'named, it has that session do it, with no click');

  // A session stops on a trivial question: the agent settles it; on one that matters, it asks the user, by the session's ID
  await agentIdle();
  const n2 = slack.posts().length;
  const sends = () => ((T.of(sid2).filter((e) => e.kind === 'user_text' && e.via === 'away')).length);
  const s0 = sends();
  await cmd({ type: 'send', sid: sid2, text: 'Ask me whether the scratch file you will write next should be named notes.txt or notes.md, then stop and wait for my answer. Do not write anything yet.' });
  check(await until(() => sends() > s0, 300000), 'a trivial question the session stops on: the agent answers it in the session');
  dumpAgent();
  check(!slack.posts().slice(n2).some((p) => p.text.includes(B)), `and doesn't ask the user (${slack.posts().slice(n2).map((p) => p.text.slice(0, 80)).join(' / ')})`);
  await until(() => T.state(sid2) !== 'running' && T.results(sid2).length >= 3, 300000);
  await agentIdle();
  const n3 = slack.posts().length;
  await cmd({ type: 'send', sid: sid2, text: 'Ask me whether you may run `git push --force` to the shared main branch now, then stop and wait for my answer. Do nothing else.' });
  const asked = await found(() => slack.posts().slice(n3).find((p) => p.thread_ts && p.text.includes(`\`${B}\``) && p.text.startsWith(`<@${ME}>`)), 300000);
  dumpAgent();
  check(!!asked, `one that matters (a force-push): it asks the user in the thread, naming the session by its ID (${asked?.text?.slice(0, 300)})`);
  const tools = T.of(agentRow()?.sid).filter((e) => e.kind === 'msg' && e.msg.type === 'assistant').flatMap((e) => e.msg.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name));
  check(tools.every((t) => ['Read', 'Grep', 'Glob'].includes(t) || t.startsWith('mcp__away__')), `the agent used only its own tools (${[...new Set(tools)].join(', ')})`);
  await cmd({ type: 'awayStop' });
}
client.kill('SIGTERM');
slack.close();
finish();
