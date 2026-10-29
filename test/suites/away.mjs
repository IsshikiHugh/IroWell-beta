// Away mode (server/away.mjs) with no model: requests put as a session's CLI would (testAsk), events logged as a
// session's (testEmit), a file standing for the summaries' replies, and the away agent's tools called as it would. On the daemon alone, on a
// stand-in Slack (test/fakeslack.mjs), and on the page; the three at once, each with a daemon of its own.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, check, until, cleanEnv, startSuite, addFolder, workDir, daemonAsk, tempDaemon, endSuite } from '../lib.mjs';
import { fakeSlack } from '../fakeslack.mjs';

const write = (file, v) => fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));

// ---- the daemon alone: a watched session runs in auto mode and has an ID; a question goes to the away agent, which
// answers it; one it leaves, a tool permission and a risky plan wait for the user, are reminded, then denied with
// the cautious message; each turn is summed up (with what Claude did instead of what was refused), and off, the session's mode
// goes back and the report (a Markdown file) is made ----
async function daemonOnly() {
  const files = workDir('away-files'), work = workDir('away-work');
  const summaryFile = path.join(files, 'summary.json');
  const { ask, evs, close } = await tempDaemon({ IRO_TEST_ASK: '1', IRO_TEST_AWAY_MINUTE: '300', IRO_TEST_AWAY_SUMMARY: summaryFile }, 'iro-away-');
  const ID = '0a0a0a0a-1111-2222-3333-444455556666';
  const { data: { sid } } = await ask({ type: 'new', cwd: work, blank: true, mode: 'default' });
  // (a blank session's CLI has no Claude session id until its first turn: one is logged for it, with what the user said)
  await ask({ type: 'testEmit', sid, ev: { kind: 'init', claudeSessionId: ID, mode: 'default' } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'user_text', text: 'Train the model. If you have to pick a dataset, use the CIFAR-10 one, not ImageNet.', uuid: 'u1' } });
  const started = await ask({ type: 'awayStart', sessions: [ID], alignRemindMin: 1, giveUpMin: 3 });
  check(started.data?.on && started.data.sessions[0]?.cid === ID, `away mode on, watching the session (${JSON.stringify(started.data || started.error)})`);
  const modeIs = (m) => evs.some((e) => e.sid === sid && e.kind === 'meta' && e.mode === m);
  check(await until(() => modeIs('auto'), 15000), 'the watched session goes from default to auto mode');

  const UID = started.data.sessions[0].uid;
  check(/^[A-Z2-9]{4}$/.test(UID || ''), `the session gets a 4-character ID (${UID})`);
  check(await until(() => evs.some((e) => e.kind === 'created' && e.own === 'away'), 10000) && evs.find((e) => e.kind === 'created' && e.own === 'away').effort === 'high',
    'a minute on with no word from the user, the away agent starts by itself, at high effort');
  // (what the away agent is told: its session's messages; its own tools are called here, as it would)
  const agentText = () => { const a = evs.find((e) => e.kind === 'created' && e.own === 'away')?.sid; return evs.filter((e) => e.sid === a && e.kind === 'user_text').map((e) => e.text); };
  const tool = (name, args) => ask({ type: 'testAwayTool', name, args });
  const ridOf = async (t) => { let rid; await until(() => (rid = evs.findLast((e) => e.kind === 'approval' && e.tool === t && !evs.some((d) => d.kind === 'approval_done' && d.rid === e.rid))?.rid), 5000); return rid; };

  // A question goes to the away agent, named by the session's ID; it answers it (the user's words settle it)
  const question = { questions: [{ question: 'Which dataset should I use?', header: 'Dataset', multiSelect: false, options: [{ label: 'CIFAR-10', description: 'small' }, { label: 'ImageNet', description: 'big' }] }] };
  const r1p = ask({ type: 'testAsk', sid, tool: 'AskUserQuestion', input: question });
  const rid1 = await ridOf('AskUserQuestion');
  check(await until(() => agentText().some((t) => t.startsWith(`[Away] Session [${UID}] "New session" asks the user a question (request ${rid1})`) && t.includes('Which dataset')), 15000),
    `the question goes to the away agent, with the session's ID and the request (${agentText().map((t) => t.slice(0, 80)).join(' / ')})`);
  const bad = await tool('act', { session: UID, action: 'answer', request: rid1, answers: [{ question: 'Which dataset should I use?', label: 'MNIST' }], why: 'x' });
  const good = await tool('act', { session: UID, action: 'answer', request: rid1, answers: [{ question: 'Which dataset should I use?', label: 'CIFAR-10' }], why: 'use the CIFAR-10 one, not ImageNet' });
  const r1 = await r1p;
  check(/No answer among the options/.test(bad.error || '') && good.data === 'Answered.' && r1.data?.behavior === 'allow' && r1.data.updatedInput?.answers?.['Which dataset should I use?'] === 'CIFAR-10'
    && evs.some((e) => e.kind === 'approval_done' && e.rid === rid1 && e.by === 'agent' && e.quote === 'use the CIFAR-10 one, not ImageNet'),
    `the agent answers it by the session's ID (an answer not among the options is refused) (${JSON.stringify(r1.data)} ${bad.error})`);

  // One the agent leaves (its turn ends without settling it): it waits for the user, is reminded, then denied
  const t0 = Date.now();
  const r2p = ask({ type: 'testAsk', sid, tool: 'AskUserQuestion', input: question });
  check(await until(async () => (await ask({ type: 'awayState' })).data?.waiting?.some((w) => w.status === 'waiting' && w.kind === 'question' && /left it for you/.test(w.why)), 15000),
    'a question the agent leaves waits for the user');
  const r2 = await r2p;
  check(r2.data?.behavior === 'deny' && /user is away/.test(r2.data.message) && Date.now() - t0 >= 3 * 300 - 100,
    `after the time limit it is denied with the cautious message (${Date.now() - t0} ms, ${r2.data?.message?.slice(0, 40)})`);

  // A tool permission is the user's alone, and a risky plan too; a plan that is just the work is the agent's to approve
  const r3p = ask({ type: 'testAsk', sid, tool: 'Bash', input: { command: 'rm -rf build' }, opts: { decisionReason: 'dangerous rm' } });
  const rid3 = await ridOf('Bash');
  const r4p = ask({ type: 'testAsk', sid, tool: 'ExitPlanMode', input: { plan: '1. Train the model\n2. git push the results' } });
  const rid4 = await ridOf('ExitPlanMode');
  const no3 = await tool('act', { session: UID, action: 'allow', request: rid3, why: 'x' });
  const no4 = await tool('act', { session: UID, action: 'allow', request: rid4, why: 'x' });
  check(/the user's alone/.test(no3.error || '') && /mentions "git push"/.test(no4.error || ''), `the agent can't allow a tool permission or a plan that pushes (${no3.error} | ${no4.error})`);
  const r5p = ask({ type: 'testAsk', sid, tool: 'ExitPlanMode', input: { plan: '1. Train the model on CIFAR-10 for 5 epochs' } });
  const rid5 = await until(async () => { const r = evs.findLast((e) => e.kind === 'approval' && e.tool === 'ExitPlanMode' && e.rid !== rid4)?.rid; return r; }, 5000) && evs.findLast((e) => e.kind === 'approval' && e.tool === 'ExitPlanMode' && e.rid !== rid4).rid;
  await tool('act', { session: UID, action: 'allow', request: rid5, why: 'Train the model.' });
  check((await r5p).data?.behavior === 'allow', 'a plan that is just what the user asked for is approved by the agent');
  const [r3, r4] = await Promise.all([r3p, r4p]);
  check(r3.data?.behavior === 'deny' && r4.data?.behavior === 'deny' && /user is away/.test(r3.data.message), 'the tool permission and the plan that pushes are left for the user, then denied');
  const logged = (await ask({ type: 'awayLog' })).data || [];
  const types = logged.map((e) => e.type);
  check(['start', 'watch', 'mode', 'decided', 'waiting', 'remind', 'blocked'].every((t) => types.includes(t))
    && logged.filter((e) => e.type === 'blocked' && e.by === 'timeout').length === 3 && logged.some((e) => e.type === 'decided' && e.by === 'agent' && e.why),
    `the away log has it all (${types.join(' ')})`);

  // The user answers one themselves: noted as theirs
  const r6p = ask({ type: 'testAsk', sid, tool: 'AskUserQuestion', input: question });
  const rid6 = await ridOf('AskUserQuestion');
  await ask({ type: 'approve', sid, rid: rid6, allow: true, answers: { 'Which dataset should I use?': 'ImageNet' } });
  check((await r6p).data?.updatedInput?.answers?.['Which dataset should I use?'] === 'ImageNet'
    && await until(async () => ((await ask({ type: 'awayLog' })).data || []).some((e) => e.type === 'answered' && e.by === 'user' && e.rid === rid6), 3000), 'what the user answers themselves is theirs, and logged as theirs');

  // A turn ends (and the plan's limit warns, and an error comes): the turn is summed up, with what Claude did instead
  write(summaryFile, { summary: 'Trained the model on CIFAR-10 for 5 epochs.', instead: 'It skipped the push and stopped to wait.',
    sessions: { [ID]: { intro: 'Trains a model on CIFAR-10.', timeline: [{ time: '14:20', text: 'Trained for 5 epochs; the push waits for you.' }] } } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'msg', msg: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'python train.py' } }, { type: 'text', text: 'Done training.' }] } } } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'limit', status: 'allowed_warning', limit: 'five_hour' } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'msg', msg: { type: 'result', subtype: 'success' } } });
  let turnNote;
  await until(async () => (turnNote = ((await ask({ type: 'awayLog' })).data || []).find((e) => e.type === 'turn')), 5000);
  check(turnNote?.summary.startsWith('Trained the model') && turnNote.blocked?.length === 3 && turnNote.instead.startsWith('It skipped'),
    `the turn is summed up, with what Claude did instead of the three refusals (${JSON.stringify(turnNote)?.slice(0, 200)})`);
  check(await until(() => agentText().some((t) => t.startsWith(`[Away] Session [${UID}] "New session" ended its turn.`) && t.includes('Done training.')), 5000),
    'the turn\'s end goes to the away agent, with the session\'s last message');
  // The agent tells the session something (queued here: the session's turn is still on); asking the user needs Slack
  const sent = await tool('act', { session: UID, action: 'send', text: 'Use 5 epochs.', why: 'the user said so' });
  const asked = await tool('ask_user', { session: UID, text: 'Which learning rate?' });
  check(sent.data === 'Sent.' && await until(() => evs.some((e) => e.sid === sid && e.kind === 'queue' && e.items.some((x) => x.text === 'Use 5 epochs.')), 5000) && /Slack is not connected/.test(asked.error || ''),
    `the agent sends to the session; with no Slack it cannot ask the user (${asked.error})`);

  const stopped = await ask({ type: 'awayStop' });
  check(!stopped.data?.on && await until(() => evs.filter((e) => e.sid === sid && e.kind === 'meta' && e.mode).at(-1)?.mode === 'default', 10000), 'off: the session is back in default mode');
  const b = (await ask({ type: 'awayReport', since: stopped.data.reportSince })).data;
  const md = b?.text || '';
  const label = path.basename(work); // (the folder's name, before the title)
  check(/\/away\/away-\d{4}-\d\d-\d\d-\d{4}\.md$/.test(b?.path || '') && fs.readFileSync(b.path, 'utf8') === md
    && /^# While you were away\n/.test(md) && /## Rejected Actions\n\n\| Session \| Action \| Instead \|/.test(md)
    && (md.match(new RegExp(`^\\| \\[${label} / New session · 0a0a0a0a\\]\\(#${label.toLowerCase()}--new-session--0a0a0a0a\\) \\| .* \\| It skipped the push`, 'gm')) || []).length === 3
    && /`rm -rf build`/.test(md) && md.includes(`### ${label} / New session · 0a0a0a0a\n\nTrains a model on CIFAR-10.\n\n- 14:20 Trained for 5 epochs`),
    `the report is a Markdown file: the rejected actions in a table (which session, what, what Claude did instead), then each session (named by its folder, title and id), its task and what happened, in time order (${md.slice(0, 400)})`);
  await close();
}

// ---- the first minute away: on with no session yet (off again, no report); the agent starts when the minute is
// over (with the page's nonce), with all that came in it as one message: the user's words, then away mode's news ----
async function firstMinute() {
  const work = workDir('first-work');
  const { ask, evs, close } = await tempDaemon({ IRO_TEST_ASK: '1', IRO_TEST_AWAY_MINUTE: '4000' }, 'iro-first-');
  const none = await ask({ type: 'awayStart', sessions: [] });
  const off = await ask({ type: 'awayStop' });
  check(none.data?.on && !none.data.sessions.length && !off.data?.on && off.data.reportSince == null, `away mode goes on with no session yet; off with none ever watched, no report (${JSON.stringify(off.data || off.error).slice(0, 80)})`);
  const ID = '0e0e0e0e-1111-2222-3333-444455556666';
  const { data: { sid } } = await ask({ type: 'new', cwd: work, blank: true, mode: 'default' });
  for (const ev of [{ kind: 'init', claudeSessionId: ID, mode: 'default' }, { kind: 'meta', title: 'Train the model' },
    { kind: 'msg', msg: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Trained: loss 0.12.' }] } } }, { kind: 'msg', msg: { type: 'result', subtype: 'success' } }]) await ask({ type: 'testEmit', sid, ev });
  await ask({ type: 'awayStart', sessions: [] });
  await ask({ type: 'awayWatch', add: [ID] });
  await new Promise((r) => setTimeout(r, 600));
  check(!evs.some((e) => e.kind === 'created' && e.own === 'away'), 'in the first minute, a picked session\'s turn end waits: the agent is not started for it');
  const BG = `When ${ID} is done, give its result to the notes session.`;
  const t1 = Date.now();
  const started = await ask({ type: 'awayAgent', text: BG, nonce: 'n-first' });
  await new Promise((r) => setTimeout(r, 300));
  check(started.data?.waits && !evs.some((e) => e.kind === 'created' && e.own === 'away'), 'the user\'s message in the first minute waits for its end');
  await until(() => evs.some((e) => e.kind === 'created' && e.own === 'away'), 8000);
  const agent = evs.find((e) => e.kind === 'created' && e.own === 'away');
  const told = () => evs.filter((e) => e.sid === agent?.sid && e.kind === 'user_text').map((e) => e.text);
  await until(() => told().length, 3000);
  await new Promise((r) => setTimeout(r, 500));
  check(Date.now() - t1 >= 2000 && agent?.nonce === 'n-first' && told().length === 1
    && told()[0].startsWith(`${BG}\n\n[Away] Session [`) && /\] "Train the model" ended its turn, before you were given it/.test(told()[0]),
    `the minute over, the agent starts (with the page's nonce) with the user's message, then what waited, in one message (${told().map((t) => t.slice(0, 90)).join(' / ')})`);
  await ask({ type: 'awayStop' });
  const t0 = Date.now();
  await ask({ type: 'awayStart', sessions: [] });
  const agents = () => evs.filter((e) => e.kind === 'created' && e.own === 'away').length;
  check(await until(() => agents() === 2, 10000) && Date.now() - t0 >= 3900, `no word in the first minute: the agent starts by itself a minute on (${Date.now() - t0} ms)`);
  await ask({ type: 'awayStop' });
  await close();
}

// ---- on Slack: set up with the user's tokens (kept, never shown); on, it connects and posts one message for this
// time away, edited as sessions are picked; what needs the user is posted with buttons into its thread (naming the
// user), and a click by the user answers it, a click or a message by anyone else does nothing; `status`; a reminder
// names the user; what a session did is not posted; off, the report goes into the thread and the message says how
// long it lasted ----
async function onSlack() {
  const slack = await fakeSlack();
  const files = workDir('slack-files'), work = workDir('slack-work');
  const summaryFile = path.join(files, 'summary.json');
  write(summaryFile, { summary: 'Ran the tests; 2 failed.', sessions: {} });
  const { dir, ask, evs, close } = await tempDaemon({ IRO_TEST_ASK: '1', IRO_TEST_AWAY_MINUTE: '400', IRO_TEST_AWAY_SUMMARY: summaryFile, IRO_TEST_SLACK_API: slack.api }, 'iro-slack-');
  const ME = 'U0USER0001', APP = 'xapp-1-A0TEST-1234567890-abcdef', BOT = 'xoxb-1234567890-abcdefghij';
  // (Slack's frames are handled as they come, in order, and acknowledged first: a frame acknowledged and a round
  // trip to the daemon after it means it was handled)
  const handled = async (env) => { await until(() => slack.acks.has(env), 3000, `the daemon acknowledges ${env}`); await ask({ type: 'awayState' }); };

  check(/xoxb-/.test((await ask({ type: 'awaySlackSet', appToken: APP, botToken: 'xoxp-nope-1234567890', userId: ME })).error || '')
    && /invalid_auth/.test((await ask({ type: 'awaySlackSet', appToken: APP, botToken: 'xoxb-bad-1234567890', userId: ME })).error || ''),
    'a token of the wrong kind, or one Slack refuses, is not kept');
  const set = await ask({ type: 'awaySlackSet', appToken: APP, botToken: BOT, userId: ME });
  const secretsFile = path.join(dir, 'away', 'secrets.json');
  check(set.data?.set && !JSON.stringify(set.data).includes(BOT) && !JSON.stringify(set.data).includes(APP) && /socket_mode_enabled: true/.test(set.data.manifest)
    && (fs.statSync(secretsFile).mode & 0o777) === 0o600 && slack.calls.some((c) => c.method === 'conversations.open' && c.body.users === ME),
    `Slack set up: the tokens are kept where only this user reads them, and never shown (${JSON.stringify(set.data || set.error).slice(0, 120)})`);
  check(!slack.connected(), 'no connection while away mode is off');

  const ID = '0b0b0b0b-1111-2222-3333-444455556666';
  const { data: { sid } } = await ask({ type: 'new', cwd: work, blank: true, mode: 'default' });
  await ask({ type: 'testEmit', sid, ev: { kind: 'init', claudeSessionId: ID, mode: 'default' } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'meta', title: 'Fix the flaky tests' } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'user_text', text: 'Fix the flaky tests in test/.', uuid: 'u1' } });
  await ask({ type: 'awayStart', sessions: [ID], alignRemindMin: 1, giveUpMin: 3 });
  check(await until(() => slack.connected(), 8000), 'away mode on: the daemon connects to Slack (Socket Mode)');
  check(await until(() => slack.posts().some((p) => /Away mode is on/.test(p.text) && /• `[A-Z2-9]{4}` \*Fix the flaky tests\*/.test(p.text) && !p.thread_ts), 5000)
    && slack.posts().length === 1, `it posts one message in the DM, naming the session (${slack.posts().map((p) => p.text.slice(0, 60)).join(' / ')})`);
  const root = slack.posts()[0];
  const ID2 = '0c0c0c0c-1111-2222-3333-444455556666';
  const { data: { sid: sid2 } } = await ask({ type: 'new', cwd: work, blank: true, mode: 'default' });
  await ask({ type: 'testEmit', sid: sid2, ev: { kind: 'init', claudeSessionId: ID2, mode: 'default' } });
  await ask({ type: 'testEmit', sid: sid2, ev: { kind: 'meta', title: 'Train the model' } });
  await ask({ type: 'testEmit', sid: sid2, ev: { kind: 'msg', msg: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Should I train for 3 or 5 epochs?' }] } } } });
  await ask({ type: 'testEmit', sid: sid2, ev: { kind: 'msg', msg: { type: 'result', subtype: 'success' } } });
  await ask({ type: 'awayWatch', add: [ID2] });
  check(await until(() => slack.updates().some((u) => u.ts === root.ts && /Fix the flaky tests/.test(u.text) && /Train the model/.test(u.text)), 3000) && slack.posts().length === 1,
    'a session picked later: the message is edited to name it too, nothing new is posted');
  const told = () => evs.filter((e) => e.kind === 'user_text' && /^\[Away\]/.test(e.text)).map((e) => e.text);
  check(await until(() => told().some((t) => /^\[Away\] Session \[[A-Z2-9]{4}\] "Train the model" ended its turn, before you were given it\. Its last message:\nShould I train for 3 or 5 epochs\?/.test(t)), 8000),
    `picked while idle: its last message goes to the away agent at once (${told().map((t) => t.slice(0, 90)).join(' / ')})`);

  // A tool permission: posted loud into the thread, with Allow / Deny; someone else's click does nothing, the user's allows it
  let r1done = false;
  const r1p = ask({ type: 'testAsk', sid, tool: 'Bash', input: { command: 'rm -rf build/' }, opts: { decisionReason: 'dangerous rm' } }).then((r) => { r1done = true; return r; });
  await until(() => slack.posts().some((p) => /needs your permission/.test(p.text)), 5000);
  const req1 = slack.posts().find((p) => /needs your permission/.test(p.text));
  const rid1 = JSON.parse(req1.blocks[1].elements[0].value).rid;
  check(req1.thread_ts === root.ts && !req1.reply_broadcast && req1.text.startsWith(`<@${ME}>`) && /rm -rf build/.test(req1.text) && req1.blocks[1].elements.map((b) => b.action_id).join() === 'iro_allow,iro_deny',
    'a tool permission goes to the thread, naming the user, with Allow and Deny');
  await handled(slack.click('U0SOMEONE9', 'iro_allow', { rid: rid1 }));
  check(!r1done && evs.every((e) => !(e.kind === 'approval_done' && e.rid === rid1)), 'a click by someone else is acknowledged and ignored');
  slack.click(ME, 'iro_allow', { rid: rid1 });
  const r1 = await r1p;
  check(r1.data?.behavior === 'allow' && evs.find((e) => e.kind === 'approval_done' && e.rid === rid1)?.by === undefined
    && await until(() => slack.updates().some((u) => /Allowed\. \(by you\)/.test(u.text) && !u.blocks.some((b) => b.type === 'actions')), 3000),
    'the user\'s click allows it, as theirs, and the message loses its buttons');

  // A question: its options as buttons; the user picks one
  const question = { questions: [{ question: 'Retry flaky tests or fix them?', header: 'Flaky', multiSelect: false, options: [{ label: 'Retry', description: 'rerun' }, { label: 'Fix', description: 'find the cause' }] }] };
  const r2p = ask({ type: 'testAsk', sid, tool: 'AskUserQuestion', input: question });
  await until(() => slack.posts().some((p) => /asks you/.test(p.text)), 5000);
  const req2 = slack.posts().find((p) => /asks you/.test(p.text));
  const pick = req2.blocks[1].elements.find((b) => b.text.text === 'Fix');
  check(!!pick && req2.blocks[1].elements.length === 3, 'a question\'s options are buttons (and Deny)');
  slack.click(ME, pick.action_id, JSON.parse(pick.value));
  check((await r2p).data?.updatedInput?.answers?.['Retry flaky tests or fix them?'] === 'Fix', 'the user\'s pick answers it');

  // status, and a message from someone else (answered, it would be before the user's own `status` is)
  const before = slack.posts().length;
  await handled(slack.message('U0SOMEONE9', 'status'));
  slack.message(ME, 'status');
  check(await until(() => slack.posts().slice(before).some((p) => /Fix the flaky tests\* · (idle|working)/.test(p.text)), 3000), '`status` says where each session stands');
  check(slack.posts().slice(before).length === 1, `a message from someone else gets no answer (${slack.posts().slice(before).map((p) => p.text.slice(0, 40)).join(' / ')})`);
  slack.message(ME, 'If it asks about the CI config, keep the old one.', root.ts);
  check(await until(async () => ((await ask({ type: 'awayLog' })).data || []).some((e) => e.type === 'said' && /CI config/.test(e.text)), 3000),
    'what the user writes in the thread is noted');

  // The away agent asks the user: in the thread, naming them and the session by its ID
  const uid1 = (await ask({ type: 'awayState' })).data.sessions.find((x) => x.cid === ID).uid;
  await ask({ type: 'testAwayTool', name: 'ask_user', args: { session: uid1, text: 'Commit now, or look into `queue` first?' } });
  check(await until(() => slack.posts().some((p) => p.thread_ts === root.ts && p.text.startsWith(`<@${ME}> 🙋 \`${uid1}\` *Fix the flaky tests*\n\nCommit now`)), 3000),
    'what the away agent asks the user goes into the thread, naming them and the session by its ID');

  // The away agent sends the user a file: into the thread, under the session's name; never a file of keys
  const plot = path.join(files, 'loss.png');
  fs.writeFileSync(plot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  const sentFile = await ask({ type: 'testAwayTool', name: 'send_file', args: { path: plot, session: uid1, text: 'The loss curve' } });
  const keys = await ask({ type: 'testAwayTool', name: 'send_file', args: { path: path.join(files, '.ssh', 'id_rsa') } });
  const f = slack.files()[0];
  check(sentFile.data === 'Sent.' && slack.files().length === 1 && f.thread_ts === root.ts && f.channel_id === 'D0DM0001' && JSON.parse(f.files)[0].title === 'loss.png'
    && f.bytes?.length === 8 && f.bytes[0] === 0x89 && f.initial_comment === `\`${uid1}\` *Fix the flaky tests*\n\nThe loss curve` && /keys or passwords/.test(keys.error || ''),
    `the away agent sends a file into the thread, named by the session; a file of keys is not sent (${JSON.stringify({ ...f, bytes: f?.bytes?.length })} ${keys.error})`);

  // Not answered: reminded (naming the user), then not allowed: its message says so, nothing new is posted
  const beforeR3 = slack.posts().length;
  const r3p = ask({ type: 'testAsk', sid, tool: 'Write', input: { file_path: '/etc/hosts' } });
  check(await until(() => slack.posts().slice(beforeR3).some((p) => /still waiting.*\/etc\/hosts/s.test(p.text) && p.thread_ts === root.ts && p.text.startsWith(`<@${ME}>`)), 5000), 'unanswered: a reminder in the thread, naming the user');
  const afterRemind = slack.posts().length;
  const r3 = await r3p;
  check(r3.data?.behavior === 'deny' && await until(() => slack.updates().some((u) => /Not allowed: no answer in time/.test(u.text)), 3000) && !slack.posts().slice(afterRemind).some((p) => /hosts|not allowed/i.test(p.text)),
    `then not allowed: the request's message says so, and no message is posted for it (${r3.data?.behavior} | ${slack.posts().slice(afterRemind).map((p) => p.text.slice(0, 60)).join(' / ')})`);

  // What a session did is not posted (it goes into the report): a turn's end, a refusal by auto mode, an error
  const beforeNews = slack.posts().length;
  await ask({ type: 'testEmit', sid, ev: { kind: 'denied', tool: 'Bash', input: { command: 'git push' }, reason: 'pushes' } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'error', text: 'Something broke' } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'msg', msg: { type: 'result', subtype: 'success' } } });
  check(await until(async () => ((await ask({ type: 'awayLog' })).data || []).some((e) => e.type === 'turn' && /Ran the tests/.test(e.summary)), 5000) && !slack.posts().slice(beforeNews).some((p) => /Ran the tests|git push|Something broke/.test(p.text)),
    `what a session did is noted for the report, not posted (${slack.posts().slice(beforeNews).map((p) => p.text.slice(0, 60)).join(' / ')})`);

  // The connection drops: it comes back
  slack.drop();
  check(await until(() => slack.connected(), 6000), 'a dropped connection comes back');

  // The away agent's session (started by the user's message above) shows what Slack got, edits included
  const agentSid = evs.find((e) => e.kind === 'created' && e.own === 'away')?.sid;
  const shown = () => { const m = new Map(); for (const e of evs) if (e.sid === agentSid && e.kind === 'away_post') m.set(e.id, e.text); return m; };
  check(!!agentSid && /\*\*Away mode is on\*\*/.test(shown().get(root.ts) || '') && /Train the model/.test(shown().get(root.ts) || '')
    && /needs your permission/.test(shown().get(req1.ts) || '') && /Allowed\. \(by you\)/.test(shown().get(req1.ts) || '') && !/<@/.test([...shown().values()].join()),
    `the away agent's session shows what was posted to Slack, as Markdown, edits included (${[...shown().values()].map((t) => t.slice(0, 50)).join(' / ')})`);

  await ask({ type: 'awayStop' });
  check(await until(() => evs.some((e) => e.sid === agentSid && e.kind === 'archived'), 5000), 'off: the away agent\'s session ends (archived)');
  const ended = () => slack.updates().find((u) => u.ts === root.ts && /Away mode: .* – .*\(\d+ min\)/.test(u.text));
  check(await until(() => ended(), 8000) && await until(() => !slack.connected(), 8000)
    && slack.posts().some((p) => p.thread_ts === root.ts && /\*While you were away\*/.test(p.text) && /\*Rejected Actions\*/.test(p.text) && /• .*Fix the flaky tests.*: Write/.test(p.text) && !/\|/.test(p.text))
    && slack.posts().some((p) => p.thread_ts === root.ts && /Saved as `.*away-.*\.md`/.test(p.text))
    && /Fix the flaky tests/.test(ended().text) && /Train the model/.test(ended().text),
    `off: the report goes into the thread (as Slack shows it), then the message says how long away lasted; the connection closes (${slack.posts().slice(-2).map((p) => p.text.slice(0, 200)).join(" / ")} | ${ended()?.text})`);
  await close();
  slack.close();
}

// ---- on the page: Away dims all but the sessions, whose boxes pick what is watched (at once); a click on the dimmed
// page ends the picking; a request sent for you while away has the logo (on its card and its anchor); a question
// answered for you says so; Back writes the report, which opens and exports as Markdown; Settings keeps the time
// limits and the Slack fields ----
async function onPage() {
  const files = workDir('page-files'), work = workDir('page-work');
  const summaryFile = path.join(files, 'summary.json');
  write(summaryFile, { summary: 'Fixed two checks.', sessions: {} });
  // (a minute of away mode, while the agent waits for the user's first word: 4 s)
  const env = cleanEnv({ IRO_TEST_ASK: '1', IRO_TEST_AWAY_SUMMARY: summaryFile, IRO_NO_USAGE_RECORD: '1', IRO_TEST_AWAY_MINUTE: '4000' });
  const api = await startSuite(PORT, { env, viewport: { width: 1280, height: 800 }, clipboard: true });
  const { page, errors } = api;
  const ask = (cmd) => daemonAsk(process.env.IRO_DIR, cmd);
  await addFolder(page, work);
  // (`done`: its turn ended; a session picked idle has its last turn's end go to the away agent at once, which starts it)
  const mk = async (cid, title, text, done = true) => {
    const sid = (await ask({ type: 'new', cwd: work, blank: true, mode: 'default' })).data.sid;
    for (const ev of [{ kind: 'init', claudeSessionId: cid, mode: 'default' }, { kind: 'meta', title }, { kind: 'user_text', text, uuid: 'u-' + cid },
      ...(done ? [{ kind: 'msg', msg: { type: 'result', subtype: 'success' } }] : [])]) await ask({ type: 'testEmit', sid, ev });
    return sid;
  };
  const A = '0c0c0c0c-1111-2222-3333-444455556666';
  const sidA = await mk(A, 'Fix the flaky checks', 'Fix the flaky checks; find the cause of each flaky check.', false);
  await mk('0d0d0d0d-1111-2222-3333-444455556666', 'Write the notes', 'Write the notes.');
  await page.locator('.sess', { hasText: 'Write the notes' }).waitFor({ timeout: 10000 });
  check(await page.locator('#awayBtn').textContent() === 'Away', 'the connection line has Away');
  await page.locator('.sess', { hasText: 'Fix the flaky checks' }).click();
  const awayAt = Date.now();
  await page.click('#awayBtn');
  check(await until(async () => (await ask({ type: 'awayState' })).data?.on === true && /Away agent/.test(await page.locator('#title').textContent()) && await page.locator('.draft-intro').isVisible(), 5000)
    && !(await ask({ type: 'awayState' })).data.sessions.length && await page.locator('#input').isEnabled() && await page.locator('.away-dim').isHidden()
    && await page.locator('#list > .sess.away-agent.agent-loading.active').count() === 1
    && await page.locator('.sess input.box').count() === 2 && await page.locator('.away-agent input.box').count() === 0 && await page.locator('#awayBtn').textContent() === 'Back',
    'Away turns away mode on and opens the away agent\'s conversation at once (not started yet), beside a box on each live session (not the agent)');
  await page.locator('.sess', { hasText: 'Write the notes' }).click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: 'Copy session ID' }).click();
  check(await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === '0d0d0d0d-1111-2222-3333-444455556666', 3000), 'right-click on a session: Copy session ID');
  await page.locator('.sess', { hasText: 'Fix the flaky checks' }).click();
  check(await until(async () => (await ask({ type: 'awayState' })).data?.sessions.map((x) => x.cid).join() === A, 5000)
    && await page.locator('.sess', { hasText: 'Fix the flaky checks' }).locator('input.box').isChecked(), 'ticking a session watches it at once');
  await page.locator('#input').fill('When the flaky checks are fixed, have 0d0d0d0d-1111-2222-3333-444455556666 write the notes.');
  await page.locator('#input').press('Enter');
  check(await until(async () => /first minute away is over/.test(await page.locator('#feed').textContent()), 3000) && await page.locator('#list > .sess.away-agent.agent-loading').count() === 1,
    'sent in the first minute: it waits, and says so');
  check(await until(async () => await page.locator('#list > .sess.away-agent:not(.agent-loading)').count() === 1 && /Away agent/.test(await page.locator('#title').textContent())
    && /have 0d0d0d0d-1111-2222-3333-444455556666 write the notes/.test(await page.locator('#feed').textContent()), 10000),
    'the minute over, the agent starts with it, and its conversation stays open');
  await page.waitForTimeout(Math.max(0, awayAt + 5000 - Date.now()));
  check(await page.locator('.sess input.box').count() === 2 && await page.locator('.away-dim').isHidden(),
    'a minute on, with the agent open: the boxes stay, and the page is not dimmed');
  check(await page.locator('#statusbar .dd-modepick').isHidden() && await page.locator('#effort').isVisible(), 'the agent\'s status line has no mode picker');
  const agentSid = (await ask({ type: 'awayAgent' })).data?.sid;
  await ask({ type: 'testEmit', sid: agentSid, ev: { kind: 'away_post', id: '7.1', text: '**Fix the flaky checks** needs your permission' } });
  await ask({ type: 'testEmit', sid: agentSid, ev: { kind: 'away_post', id: '7.1', text: '**Fix the flaky checks** needs your permission  \n✅ Allowed.' } });
  check(await until(async () => await page.locator('.away-post').count() === 1 && /Allowed/.test(await page.locator('.away-post').textContent())
    && await page.locator('.away-post strong').textContent() === 'Fix the flaky checks', 3000),
    'what went to Slack shows in the agent\'s conversation; an edit replaces it');
  await ask({ type: 'testEmit', sid: sidA, ev: { kind: 'user_text', text: 'Check the CI logs too.', uuid: 'u2', via: 'away' } });
  ask({ type: 'testAsk', sid: sidA, tool: 'AskUserQuestion', input: { questions: [{ question: 'Retry or fix?', header: 'Flaky', multiSelect: false, options: [{ label: 'Retry', description: '' }, { label: 'Fix', description: '' }] }] } });
  let ridQ;
  await until(async () => (ridQ = (await ask({ type: 'awayState' })).data?.waiting?.find((w) => w.sid === sidA)?.rid), 5000);
  const uidA = (await ask({ type: 'awayState' })).data.sessions[0].uid;
  await ask({ type: 'testAwayTool', name: 'act', args: { session: uidA, action: 'answer', request: ridQ, answers: [{ question: 'Retry or fix?', label: 'Fix' }], why: 'find the cause of each flaky check' } });
  await until(async () => !(await ask({ type: 'awayState' })).data?.waiting?.length, 5000);
  await page.click('#awayBtn');
  await page.locator('.modal-body.report .md h3').waitFor({ timeout: 10000 }).catch(() => {});
  const rep = await page.locator('.modal-body.report').textContent().catch(() => '');
  check(/While you were away/.test(rep) && /Rejected Actions/.test(rep) && /Fix the flaky checks/.test(rep) && /\/away\/away-.*\.md$/.test(await page.locator('.modal-title').textContent()),
    `Back turns away mode off and opens the report (${rep.slice(0, 80)})`);
  check(await until(async () => await page.locator('#list .sess.away-agent').count() === 0, 5000), 'the away agent\'s row goes with it');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.modal-act', { hasText: 'Export' }).click()]);
  check(/^away-\d{4}-\d\d-\d\d-\d{4}\.md$/.test(dl.suggestedFilename()) && /^# While you were away/.test(fs.readFileSync(await dl.path(), 'utf8')), `Export saves the Markdown (${dl.suggestedFilename()})`);
  await page.locator('.modal-head button', { hasText: '✕' }).click();
  check((await ask({ type: 'awayState' })).data?.on === false && await page.locator('#awayBtn').textContent() === 'Away'
    && /Fix the flaky checks/.test(await page.locator('#title').textContent()) && await page.locator('#content').isVisible() && await page.locator('.away-view').isHidden(), 'and the button says Away again, and the session open before Away is back on the page');
  check(await until(async () => (await page.locator('.ask-done').textContent().catch(() => '')) === '✓ answered by the away agent', 8000)
    && /find the cause of each flaky check/.test(await page.locator('.ask-done').getAttribute('title') || ''), 'a question the away agent answered says so, with why on hover');
  check(await page.locator('.turn-q.away .turn-q-logo').count() === 1 && await page.locator('.turn-q:not(.away) .turn-q-logo').count() === 0
    && await page.locator('.ol-item', { hasText: 'Check the CI logs' }).locator('.ol-logo').count() === 1,
    'a request sent for you while away has the logo, on its card and its anchor');
  await page.click('#awayBtn');
  await until(async () => /Away agent/.test(await page.locator('#title').textContent()), 5000);
  await page.click('#awayBtn');
  check(await until(async () => (await ask({ type: 'awayState' })).data?.on === false && /Fix the flaky checks/.test(await page.locator('#title').textContent()), 5000)
    && await page.locator('.modal-back').count() === 0, 'Back with nothing picked: away mode off, no report, and the session open before is back');
  await page.click('#settingsBtn');
  await page.locator('#awayApp').waitFor({ timeout: 10000 });
  const remind = page.locator('.set-row', { hasText: 'Alignment check remind after' }).locator('input');
  await remind.fill('45');
  await remind.press('Enter');
  await remind.blur();
  check(await until(async () => (await ask({ type: 'awayState' })).data?.alignRemindMin === 45, 5000)
    && await page.locator('.set-row', { hasText: 'Give up alignment and continue after' }).locator('input').inputValue() === '120'
    && await page.locator('#awayBot').getAttribute('placeholder') === 'xoxb-…', 'Settings: the time limits are kept on the server; the Slack fields are there');
  await page.locator('.set-row', { hasText: 'Away agent prompt' }).locator('button').click();
  const area = page.locator('.sk-area');
  await area.waitFor({ timeout: 5000 });
  check(/^You are the away agent of IroWell/.test(await area.inputValue()), 'Settings: the away agent\'s prompt opens, as it comes');
  await area.fill('You are my stand-in. Ask me about anything risky.');
  await page.locator('.modal-body button.primary', { hasText: 'Save' }).click();
  check(await until(async () => (await ask({ type: 'awayAgentPrompt' })).data?.own === true && (await ask({ type: 'awayAgentPrompt' })).data.text === 'You are my stand-in. Ask me about anything risky.', 3000),
    'an edited prompt is kept on the server');
  await page.locator('.modal-body .set-saved', { hasText: 'Saved' }).waitFor({ timeout: 3000 }); // (the editor is drawn again: then it is cleared)
  await area.fill('');
  await page.locator('.modal-body button.primary', { hasText: 'Save' }).click();
  check(await until(async () => (await ask({ type: 'awayAgentPrompt' })).data?.own === false && /^You are the away agent/.test(await area.inputValue()), 3000), 'saved empty, the prompt it comes with is back');
  return api;
}

const [, , , api] = await Promise.all([daemonOnly(), firstMinute(), onSlack(), onPage()]);
await endSuite(api);
