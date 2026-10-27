// Away mode (server/away.mjs) with no model: requests put as a session's CLI would (testAsk), events logged as a
// session's (testEmit), and files standing for the judge's and the summaries' replies. On the daemon alone, on a
// stand-in Slack (test/fakeslack.mjs), and on the page; the three at once, each with a daemon of its own.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, check, until, cleanEnv, startSuite, addFolder, workDir, daemonAsk, tempDaemon, endSuite } from '../lib.mjs';
import { fakeSlack } from '../fakeslack.mjs';

const write = (file, v) => fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));

// ---- the daemon alone: a watched session runs in auto mode; a question is answered only with the user's own words
// to quote; a tool permission and a risky plan wait for the user, are reminded, then denied with the cautious
// message; each turn is summed up (with what Claude did instead of what was refused), and off, the session's mode
// goes back and the report (a Markdown file) is made ----
async function daemonOnly() {
  const files = workDir('away-files'), work = workDir('away-work');
  const judgeFile = path.join(files, 'judge.json'), summaryFile = path.join(files, 'summary.json');
  const { ask, evs, close } = await tempDaemon({ IRO_TEST_ASK: '1', IRO_TEST_AWAY_MINUTE: '300', IRO_TEST_AWAY_JUDGE: judgeFile, IRO_TEST_AWAY_SUMMARY: summaryFile }, 'iro-away-');
  const ID = '0a0a0a0a-1111-2222-3333-444455556666';
  const { data: { sid } } = await ask({ type: 'new', cwd: work, blank: true, mode: 'default' });
  // (a blank session's CLI has no Claude session id until its first turn: one is logged for it, with what the user said)
  await ask({ type: 'testEmit', sid, ev: { kind: 'init', claudeSessionId: ID, mode: 'default' } });
  await ask({ type: 'testEmit', sid, ev: { kind: 'user_text', text: 'Train the model. If you have to pick a dataset, use the CIFAR-10 one, not ImageNet.', uuid: 'u1' } });
  const started = await ask({ type: 'awayStart', sessions: [ID], alignRemindMin: 1, giveUpMin: 3 });
  check(started.data?.on && started.data.sessions[0]?.cid === ID, `away mode on, watching the session (${JSON.stringify(started.data || started.error)})`);
  const modeIs = (m) => evs.some((e) => e.sid === sid && e.kind === 'meta' && e.mode === m);
  check(await until(() => modeIs('auto'), 15000), 'the watched session goes from default to auto mode');

  const question = { questions: [{ question: 'Which dataset should I use?', header: 'Dataset', multiSelect: false, options: [{ label: 'CIFAR-10', description: 'small' }, { label: 'ImageNet', description: 'big' }] }] };
  write(judgeFile, { decision: 'answer', answers: { 'Which dataset should I use?': 'CIFAR-10' }, quote: 'use the CIFAR-10 one, not ImageNet', why: 'The user named it.' });
  const r1 = await ask({ type: 'testAsk', sid, tool: 'AskUserQuestion', input: question });
  check(r1.data?.behavior === 'allow' && r1.data.updatedInput?.answers?.['Which dataset should I use?'] === 'CIFAR-10'
    && evs.some((e) => e.kind === 'approval_done' && e.by === 'away' && e.allow), `a question the user's words settle is answered for them (${JSON.stringify(r1.data)})`);

  // A quote that is not the user's (Claude's own words, or made up): it waits for the user
  write(judgeFile, { decision: 'answer', answers: { 'Which dataset should I use?': 'ImageNet' }, quote: 'ImageNet is the better choice', why: 'Bigger is better.' });
  const t0 = Date.now();
  const r2p = ask({ type: 'testAsk', sid, tool: 'AskUserQuestion', input: question });
  check(await until(async () => (await ask({ type: 'awayState' })).data?.waiting?.some((w) => w.status === 'waiting' && w.kind === 'question'), 5000),
    'a question whose quote is not the user\'s waits for the user');
  const r2 = await r2p;
  check(r2.data?.behavior === 'deny' && /user is away/.test(r2.data.message) && Date.now() - t0 >= 3 * 300 - 100,
    `after the time limit it is denied with the cautious message (${Date.now() - t0} ms, ${r2.data?.message?.slice(0, 40)})`);

  // A tool permission is never allowed by the judge (it isn't even asked), and a risky plan waits too
  write(judgeFile, { decision: 'approve', quote: 'Train the model.', why: 'The user asked for it.' });
  const r3p = ask({ type: 'testAsk', sid, tool: 'Bash', input: { command: 'rm -rf build' }, opts: { decisionReason: 'dangerous rm' } });
  const r4p = ask({ type: 'testAsk', sid, tool: 'ExitPlanMode', input: { plan: '1. Train the model\n2. git push the results' } });
  const r5 = await ask({ type: 'testAsk', sid, tool: 'ExitPlanMode', input: { plan: '1. Train the model on CIFAR-10 for 5 epochs' } });
  check(r5.data?.behavior === 'allow', 'a plan that is just what the user asked for is approved');
  const [r3, r4] = await Promise.all([r3p, r4p]);
  check(r3.data?.behavior === 'deny' && r4.data?.behavior === 'deny' && /user is away/.test(r3.data.message), 'a tool permission and a plan that pushes are left for the user, then denied');
  const logged = (await ask({ type: 'awayLog' })).data || [];
  const types = logged.map((e) => e.type);
  check(['start', 'watch', 'mode', 'decided', 'waiting', 'remind', 'blocked'].every((t) => types.includes(t))
    && logged.filter((e) => e.type === 'blocked' && e.by === 'timeout').length === 3 && logged.find((e) => e.type === 'waiting' && e.tool === 'ExitPlanMode')?.why.includes('push'),
    `the away log has it all (${types.join(' ')})`);

  // The user answers one themselves: noted as theirs
  write(judgeFile, '{"decision":"escalate","why":"not sure"}');
  const r6p = ask({ type: 'testAsk', sid, tool: 'AskUserQuestion', input: question });
  let rid6;
  await until(async () => (rid6 = evs.findLast((e) => e.kind === 'approval' && e.tool === 'AskUserQuestion')?.rid) && (await ask({ type: 'awayState' })).data.waiting.some((w) => w.rid === rid6), 5000);
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

// ---- on Slack: set up with the user's tokens (kept, never shown); on, it connects; what needs the user is posted
// with buttons into the session's thread (and the DM), and a click by the user answers it, a click or a message by
// anyone else does nothing; `status`; a reminder and a timeout are loud, a turn's summary quiet; off, it says so,
// with where the report is ----
async function onSlack() {
  const slack = await fakeSlack();
  const files = workDir('slack-files'), work = workDir('slack-work');
  const judgeFile = path.join(files, 'judge.json'), summaryFile = path.join(files, 'summary.json');
  write(judgeFile, '{"decision":"escalate","why":"The user never said."}');
  write(summaryFile, { summary: 'Ran the tests; 2 failed.', sessions: {} });
  const { dir, ask, evs, close } = await tempDaemon({ IRO_TEST_ASK: '1', IRO_TEST_AWAY_MINUTE: '400', IRO_TEST_AWAY_JUDGE: judgeFile, IRO_TEST_AWAY_SUMMARY: summaryFile, IRO_TEST_SLACK_API: slack.api }, 'iro-slack-');
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
  check(await until(() => slack.posts().some((p) => /Away mode is on/.test(p.text)) && slack.posts().some((p) => /Fix the flaky tests\*: watched/.test(p.text) && !p.thread_ts), 5000),
    'it says so in the DM, and starts a thread for the session');
  const root = slack.posts().find((p) => /: watched/.test(p.text));

  // A tool permission: posted loud into the thread, with Allow / Deny; someone else's click does nothing, the user's allows it
  let r1done = false;
  const r1p = ask({ type: 'testAsk', sid, tool: 'Bash', input: { command: 'rm -rf build/' }, opts: { decisionReason: 'dangerous rm' } }).then((r) => { r1done = true; return r; });
  await until(() => slack.posts().some((p) => /needs your permission/.test(p.text)), 5000);
  const req1 = slack.posts().find((p) => /needs your permission/.test(p.text));
  const rid1 = JSON.parse(req1.blocks[1].elements[0].value).rid;
  check(req1.thread_ts && req1.reply_broadcast && /rm -rf build/.test(req1.text) && req1.blocks[1].elements.map((b) => b.action_id).join() === 'iro_allow,iro_deny',
    'a tool permission goes to the session\'s thread, shown in the DM too, with Allow and Deny');
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
  check(await until(() => slack.posts().slice(before).some((p) => /Fix the flaky tests\*: (idle|working)/.test(p.text)), 3000), '`status` says where each session stands');
  check(slack.posts().slice(before).length === 1, `a message from someone else gets no answer (${slack.posts().slice(before).map((p) => p.text.slice(0, 40)).join(' / ')})`);
  slack.message(ME, 'If it asks about the CI config, keep the old one.', root.ts);
  check(await until(async () => ((await ask({ type: 'awayLog' })).data || []).some((e) => e.type === 'said' && e.cid === ID && /CI config/.test(e.text)), 3000),
    'what the user writes in a session\'s thread is noted for that session (the judge goes by it)');

  // Not answered: reminded (loud), then not allowed (loud), and its message says so
  const r3 = await ask({ type: 'testAsk', sid, tool: 'Write', input: { file_path: '/etc/hosts' } });
  check(r3.data?.behavior === 'deny' && await until(() => slack.posts().some((p) => /Still waiting/.test(p.text) && p.reply_broadcast) && slack.posts().some((p) => /Not allowed \(no answer/.test(p.text) && p.reply_broadcast)
    && slack.updates().some((u) => /Not allowed: no answer in time/.test(u.text)), 3000), `unanswered: a loud reminder, then a loud "not allowed", and the request's message says so (${r3.data?.behavior} | ${slack.posts().slice(-4).map((p) => `${p.reply_broadcast ? 'loud ' : ''}${p.text.slice(0, 50)}`).join(' / ')} | ${slack.updates().map((u) => u.text.slice(-40)).join(' / ')})`);

  // A turn's summary goes quietly into the thread
  await ask({ type: 'testEmit', sid, ev: { kind: 'msg', msg: { type: 'result', subtype: 'success' } } });
  check(await until(() => slack.posts().some((p) => /📝 Ran the tests; 2 failed/.test(p.text) && p.thread_ts && !p.reply_broadcast), 5000), 'a turn\'s summary goes quietly into the thread');

  // The connection drops: it comes back
  slack.drop();
  check(await until(() => slack.connected(), 6000), 'a dropped connection comes back');

  await ask({ type: 'awayStop' });
  check(await until(() => slack.posts().some((p) => /Away mode is off/.test(p.text) && /1 action was rejected/.test(p.text) && /away-.*\.md/.test(p.text)), 8000) && await until(() => !slack.connected(), 8000),
    'off: Slack hears it, with how many actions were rejected and where the report is, and the connection closes');
  await close();
  slack.close();
}

// ---- on the page: Away dims all but the sessions, whose boxes pick what is watched (at once); a click on the dimmed
// page ends the picking; a request sent for you while away has the logo (on its card and its anchor); a question
// answered for you says so; Back writes the report, which opens and exports as Markdown; Settings keeps the time
// limits and the Slack fields ----
async function onPage() {
  const files = workDir('page-files'), work = workDir('page-work');
  const judgeFile = path.join(files, 'judge.json'), summaryFile = path.join(files, 'summary.json');
  write(judgeFile, { decision: 'answer', answers: { 'Retry or fix?': 'Fix' }, quote: 'find the cause of each flaky check', why: 'said' });
  write(summaryFile, { summary: 'Fixed two checks.', sessions: {} });
  const env = cleanEnv({ IRO_TEST_ASK: '1', IRO_TEST_AWAY_JUDGE: judgeFile, IRO_TEST_AWAY_SUMMARY: summaryFile, IRO_NO_USAGE_RECORD: '1' });
  const api = await startSuite(PORT, { env, viewport: { width: 1280, height: 800 } });
  const { page, errors } = api;
  const ask = (cmd) => daemonAsk(process.env.IRO_DIR, cmd);
  await addFolder(page, work);
  const mk = async (cid, title, text) => {
    const sid = (await ask({ type: 'new', cwd: work, blank: true, mode: 'default' })).data.sid;
    for (const ev of [{ kind: 'init', claudeSessionId: cid, mode: 'default' }, { kind: 'meta', title }, { kind: 'user_text', text, uuid: 'u-' + cid },
      { kind: 'msg', msg: { type: 'result', subtype: 'success' } }]) await ask({ type: 'testEmit', sid, ev });
    return sid;
  };
  const A = '0c0c0c0c-1111-2222-3333-444455556666';
  const sidA = await mk(A, 'Fix the flaky checks', 'Fix the flaky checks; find the cause of each flaky check.');
  await mk('0d0d0d0d-1111-2222-3333-444455556666', 'Write the notes', 'Write the notes.');
  await page.locator('.sess', { hasText: 'Write the notes' }).waitFor({ timeout: 10000 });
  check(await page.locator('#awayBtn').textContent() === 'Away', 'the connection line has Away');
  await page.click('#awayBtn');
  check(await page.locator('.away-dim').isVisible() && await page.locator('.sess input.box').count() === 2 && await page.locator('.away-agent input.box').count() === 0
    && await page.locator('#awayBtn').textContent() === 'Back', 'Away dims the page; each live session gets a box (not the agent)');
  await page.locator('.sess', { hasText: 'Fix the flaky checks' }).click();
  check(await until(async () => (await ask({ type: 'awayState' })).data?.sessions.map((x) => x.cid).join() === A, 5000)
    && await page.locator('.sess', { hasText: 'Fix the flaky checks' }).locator('input.box').isChecked(), 'ticking a session watches it at once (away mode goes on)');
  check(await until(async () => (await page.locator('#list > .sess.away-agent.agent-loading .agent-logo svg').count()) === 1, 3000) && await page.locator('#list > :first-child').textContent() === 'Away agent',
    'away mode on: above the folders, the away agent\'s row, its logo turning until the agent is needed');
  await page.mouse.click(900, 400);
  check(await until(async () => await page.locator('.away-dim').count() === 0 && await page.locator('input.box').count() === 0 && await page.locator('#awayBtn').textContent() === 'Back', 5000),
    'a click on the dimmed page ends the picking; away mode stays on (Back)');
  await page.locator('.sess', { hasText: 'Fix the flaky checks' }).click();
  check(await page.locator('.away-view').isVisible() && await page.locator('#content').isHidden() && await page.locator('#rail').isHidden(),
    'while away the page shows no session: the logo turns in its place');
  // (the agent is started here: a CLI of its own, the fake Claude)
  await page.locator('.agent-loading').click();
  check(await until(async () => await page.locator('#list > .sess.away-agent:not(.agent-loading)').count() === 1 && await page.locator('#content').isVisible()
    && await page.locator('.away-view').isHidden() && /Away agent/.test(await page.locator('#title').textContent()), 15000),
    'a click on its row starts the away agent and opens it: its conversation shows, away mode or not');
  await page.locator('.sess', { hasText: 'Fix the flaky checks' }).click();
  check(await until(async () => await page.locator('#content').isHidden(), 3000), 'any other session still shows only the logo');
  await ask({ type: 'testEmit', sid: sidA, ev: { kind: 'user_text', text: 'Check the CI logs too.', uuid: 'u2', via: 'away' } });
  ask({ type: 'testAsk', sid: sidA, tool: 'AskUserQuestion', input: { questions: [{ question: 'Retry or fix?', header: 'Flaky', multiSelect: false, options: [{ label: 'Retry', description: '' }, { label: 'Fix', description: '' }] }] } });
  check(await until(async () => (await page.locator('.ask-done').textContent().catch(() => '')) === '✓ answered for you', 8000)
    && /find the cause of each flaky check/.test(await page.locator('.ask-done').getAttribute('title') || ''), 'a question answered for you says so, with your words on hover');
  check(await page.locator('.turn-q.away .turn-q-logo').count() === 1 && await page.locator('.turn-q:not(.away) .turn-q-logo').count() === 0
    && await page.locator('.ol-item', { hasText: 'Check the CI logs' }).locator('.ol-logo').count() === 1,
    'a request sent for you while away has the logo, on its card and its anchor');
  await page.click('#awayBtn');
  await page.locator('.modal-body.report .md h3').waitFor({ timeout: 10000 }).catch(() => {});
  const rep = await page.locator('.modal-body.report').textContent().catch(() => '');
  check(/While you were away/.test(rep) && /Rejected Actions/.test(rep) && /Fix the flaky checks/.test(rep) && /\/away\/away-.*\.md$/.test(await page.locator('.modal-title').textContent()),
    `Back turns away mode off and opens the report (${rep.slice(0, 80)})`);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.modal-act', { hasText: 'Export' }).click()]);
  check(/^away-\d{4}-\d\d-\d\d-\d{4}\.md$/.test(dl.suggestedFilename()) && /^# While you were away/.test(fs.readFileSync(await dl.path(), 'utf8')), `Export saves the Markdown (${dl.suggestedFilename()})`);
  await page.locator('.modal-head button', { hasText: '✕' }).click();
  check((await ask({ type: 'awayState' })).data?.on === false && await page.locator('#awayBtn').textContent() === 'Away'
    && await page.locator('#content').isVisible() && await page.locator('.away-view').isHidden(), 'and the button says Away again, and the session is back on the page');
  await page.click('#awayBtn');
  await page.mouse.click(900, 400);
  check((await ask({ type: 'awayState' })).data?.on === false, 'picking nothing leaves away mode off');
  await page.click('#settingsBtn');
  await page.locator('#awayApp').waitFor({ timeout: 10000 });
  const remind = page.locator('.set-row', { hasText: 'Alignment check remind after' }).locator('input');
  await remind.fill('45');
  await remind.press('Enter');
  await remind.blur();
  check(await until(async () => (await ask({ type: 'awayState' })).data?.alignRemindMin === 45, 5000)
    && await page.locator('.set-row', { hasText: 'Give up alignment and continue after' }).locator('input').inputValue() === '120'
    && await page.locator('#awayBot').getAttribute('placeholder') === 'xoxb-…', 'Settings: the time limits are kept on the server; the Slack fields are there');
  return api;
}

const [, , api] = await Promise.all([daemonOnly(), onSlack(), onPage()]);
await endSuite(api);
