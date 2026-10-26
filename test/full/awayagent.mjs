// The away agent with real turns, on a stand-in Slack (test/fakeslack.mjs): the user asks it on Slack how a session
// is doing and gets an answer there; asks it to pass a request on, and it does so only once the user clicks "Do it".
import fs from 'node:fs';
import path from 'node:path';
import { outDir, cleanEnv, log, check, until, finish, startClient, eventStream } from '../lib.mjs';
import { fakeSlack } from '../fakeslack.mjs';

const S = outDir();
const PORT = 4820;
const WORK = path.join(S, 'agent-work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
fs.writeFileSync(path.join(WORK, 'train.log'), Array.from({ length: 12 }, (_, i) => `epoch ${i + 1}/40 loss ${(2.3 - i * 0.12).toFixed(3)}`).join('\n') + '\n');
const slack = await fakeSlack();
const { client, token, cmd } = await startClient(PORT, { env: cleanEnv({ IRO_TEST_SLACK_API: slack.api }), stdio: ['ignore', 'pipe', 'pipe'] });
client.stdout.on('data', (d) => log('client:', d.toString().trim()));
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const T = eventStream(PORT, token, cmd);
await until(() => T.up, 10000, 'transport up');
const found = async (get, ms) => { let v; await until(async () => (v = await get()), ms); return v; };
const ME = 'U0USER0001';
check((await cmd({ type: 'awaySlackSet', appToken: 'xapp-1-A0TEST-1234567890-abcdef', botToken: 'xoxb-1234567890-abcdefghij', userId: ME })).data?.set, 'Slack set up');

const { data: { sid } } = await cmd({ type: 'new', cwd: WORK, text: `Reply with just: ready. (Later I may ask you for small files here; the training log is ${path.join(WORK, 'train.log')}.)`, model: 'sonnet', mode: 'default' });
check(await until(() => T.results(sid).length >= 1, 180000), 'the session has done a turn');
const cid = T.claudeId(sid);
await cmd({ type: 'awayStart', sessions: [cid] });
check(await until(() => slack.connected(), 10000), 'away mode on, Slack connected');

const n0 = slack.posts().length;
slack.message(ME, `How far is the training of my session? Read its train.log and tell me the last epoch, in one line.`);
const answer = await found(() => slack.posts().slice(n0).find((p) => /\b12\b/.test(p.text) && !/watched|Away mode/.test(p.text)), 240000);
check(!!answer, `the away agent answers on Slack, from the log (${answer?.text?.slice(0, 120)})`);
const agentRow = T.events.find((e) => e.kind === 'created' && e.own === 'away');
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
check(!!agentRow, 'the away agent is a session of its own, which the page shows');

const n1 = slack.posts().length;
slack.message(ME, 'Ask my session to create a file named done.txt containing the word ok.');
const ask = await found(() => slack.posts().slice(n1).find((p) => /away agent wants to send/.test(p.text)), 240000);
dumpAgent();
check(!!ask && ask.blocks?.[1]?.elements?.[0]?.action_id === 'iro_allow', `it asks before passing it on (${ask?.text?.slice(0, 160)})`);
check(!fs.existsSync(path.join(WORK, 'done.txt')) && T.of(sid).filter((e) => e.kind === 'user_text').length === 1, 'nothing reached the session yet');
slack.click(ME, 'iro_allow', JSON.parse(ask.blocks[1].elements[0].value));
check(await until(() => T.of(sid).filter((e) => e.kind === 'user_text').length === 2, 60000), 'once the user clicks "Do it", the message goes to the session');
check(await until(() => fs.existsSync(path.join(WORK, 'done.txt')), 240000), 'and the session does it');
const agentSid = agentRow?.sid;
const tools = T.of(agentSid).filter((e) => e.kind === 'msg' && e.msg.type === 'assistant').flatMap((e) => e.msg.message.content.filter((b) => b.type === 'tool_use').map((b) => b.name));
check(tools.every((t) => ['Read', 'Grep', 'Glob'].includes(t) || t.startsWith('mcp__away__')), `the agent used only its own tools (${[...new Set(tools)].join(', ')})`);
await cmd({ type: 'awayStop' });
client.kill('SIGTERM');
slack.close();
finish();
