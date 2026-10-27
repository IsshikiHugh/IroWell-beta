// Away mode with the real model (server/away.mjs; its logic, on stand-in answers, is in the quick tier): what
// only a model can show. 1. A watched session runs in auto mode; a question the user's own words settle is
// answered for them by the judge, one they don't is left for the user; each turn is summed up, and turning it off
// makes the report. 2. The away agent, on a stand-in Slack (test/fakeslack.mjs): asked on Slack how a session is
// doing, it answers there; asked to pass a request on, it does so only once the user clicks "Do it".
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

// ---- 1. the judge, turn summaries, the report ----
{
  const WORK = workDir('away-work');
  const first = 'This is a test of the question tool, so you must ask even though my answer is written below. Use the AskUserQuestion '
    + 'tool once to ask me which dataset to train on, with exactly two options: CIFAR-10 and ImageNet. Then reply with only the '
    + 'name I picked, and do nothing else. (So you know in advance: I want CIFAR-10 for this one.)';
  const { data: { sid } } = await cmd({ type: 'new', cwd: WORK, text: first, model: 'sonnet', mode: 'default' });
  check(await until(() => T.claudeId(sid), 120000), 'the session has its Claude session id');
  const on = await cmd({ type: 'awayStart', sessions: [T.claudeId(sid)] });
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
}

// ---- 2. the away agent on Slack ----
{
  const WORK = workDir('agent-work', { 'train.log': Array.from({ length: 12 }, (_, i) => `epoch ${i + 1}/40 loss ${(2.3 - i * 0.12).toFixed(3)}`).join('\n') + '\n' });
  const ME = 'U0USER0001';
  check((await cmd({ type: 'awaySlackSet', appToken: 'xapp-1-A0TEST-1234567890-abcdef', botToken: 'xoxb-1234567890-abcdefghij', userId: ME })).data?.set, 'Slack set up');
  const { data: { sid } } = await cmd({ type: 'new', cwd: WORK, text: `Reply with just: ready. (Later I may ask you for small files here; the training log is ${path.join(WORK, 'train.log')}.)`, model: 'sonnet', mode: 'default' });
  check(await until(() => T.results(sid).length >= 1, 180000), 'the session has done a turn');
  await cmd({ type: 'awayStart', sessions: [T.claudeId(sid)] });
  check(await until(() => slack.connected(), 10000), 'away mode on, Slack connected');

  const n0 = slack.posts().length;
  slack.message(ME, 'How far is the training of my session? Read its train.log and tell me the last epoch, in one line.');
  const answer = await found(() => slack.posts().slice(n0).find((p) => /\b12\b/.test(p.text) && !/watched|Away mode/.test(p.text)), 240000);
  check(!!answer, `the away agent answers on Slack, from the log (${answer?.text?.slice(0, 120)})`);
  const agentRow = T.events.find((e) => e.kind === 'created' && e.own === 'away');
  check(!!agentRow, 'the away agent is a session of its own, which the page shows');
  // (what the agent did, in the log: its tool calls and what they returned)
  const dumpAgent = () => {
    for (const e of T.of(agentRow?.sid)) {
      if (e.kind === 'user_text') log('agent <-', e.text.slice(0, 200));
      if (e.kind === 'approval' || e.kind === 'approval_done') log('agent', e.kind, e.tool || '', e.allow ?? '');
      if (e.kind !== 'msg') continue;
      for (const b of e.msg.message?.content || []) {
        if (b.type === 'tool_use') log('agent tool', b.name, JSON.stringify(b.input).slice(0, 300));
        else if (b.type === 'tool_result') log('agent result', JSON.stringify(b.content).slice(0, 400));
        else if (b.type === 'text') log('agent says', b.text.slice(0, 300));
      }
    }
  };

  const n1 = slack.posts().length;
  slack.message(ME, 'Ask my session to create a file named done.txt containing the word ok.');
  const ask = await found(() => slack.posts().slice(n1).find((p) => /away agent wants to send/.test(p.text)), 240000);
  dumpAgent();
  check(!!ask && ask.blocks?.[1]?.elements?.[0]?.action_id === 'iro_allow', `it asks before passing it on (${ask?.text?.slice(0, 160)})`);
  check(!fs.existsSync(path.join(WORK, 'done.txt')) && T.of(sid).filter((e) => e.kind === 'user_text').length === 1, 'nothing reached the session yet');
  slack.click(ME, 'iro_allow', JSON.parse(ask.blocks[1].elements[0].value));
  check(await until(() => T.of(sid).filter((e) => e.kind === 'user_text').length === 2, 60000), 'once the user clicks "Do it", the message goes to the session');
  check(await until(() => fs.existsSync(path.join(WORK, 'done.txt')), 240000), 'and the session does it');
  const tools = T.of(agentRow?.sid).filter((e) => e.kind === 'msg' && e.msg.type === 'assistant').flatMap((e) => e.msg.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name));
  check(tools.every((t) => ['Read', 'Grep', 'Glob'].includes(t) || t.startsWith('mcp__away__')), `the agent used only its own tools (${[...new Set(tools)].join(', ')})`);
  await cmd({ type: 'awayStop' });
}
client.kill('SIGTERM');
slack.close();
finish();
