// The real Claude Code's messages for turns you didn't send: what test/suites/background.fake.mjs imitates, so it
// can be re-checked when the CLI changes. For each source, the transcript entry as written (the shape the fake
// writes) and the note the daemon makes of it (a notify event):
// - a background Bash call's end: a user entry, origin { kind: 'task-notification' }, `<task-notification>` with
//   'Background command "…" completed (exit code 0)'
// - a background subagent's report: a note of source 'agent' with its report (read mid-turn or in a turn of its own)
// - another session's message (SendMessage): isMeta, turnOrigin 'peer', origin { kind: 'peer', name, body }
// - a schedule firing (CronCreate): isMeta, turnOrigin 'scheduled', the prompt as it is, no origin
// Slow by nature: the schedule fires at the next whole minute.
import { PORT, startSuite, startSession, check, until, waitResults, eventStream, transcript, workDir, endSuite } from '../lib.mjs';

const A = workDir('work-trig-a'), B = workDir('work-trig-b');
const suite = await startSuite(PORT);
const { page, token, cmd } = suite;
const T = eventStream(PORT, token);
await until(() => T.up, 15000, 'event stream up');
const results = () => page.locator('.turn-foot .meta.result').count();
const notes = (sid, src) => T.of(sid).filter((e) => e.kind === 'notify' && e.source === src);
const entries = (sid) => transcript(T.claudeId(sid)).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'user');
const sidA = async () => (await cmd({ type: 'overview' })).data[0]?.sid;

// 1. A background command finishing while Claude is idle.
await startSession(page, A, 'Start this with Bash using run_in_background: sleep 5; echo TRIG-DONE. Do not wait for it. Reply with just: started. When it finishes, reply with just: seen', { mode: 'bypassPermissions' });
await waitResults(page, 2, { timeout: 120000, what: 'the background command reported back and Claude answered' });
const a = await sidA();
const task = entries(a).find((e) => e.origin?.kind === 'task-notification');
check(/^<task-notification>/.test(task?.message?.content) && /Background command "[^"]+" completed \(exit code 0\)/.test(task.message.content),
  `the report: a user entry, origin task-notification, <task-notification> with the exit code (${JSON.stringify(task)?.slice(0, 300)})`);
check(notes(a, 'task').some((e) => e.turn === true && e.exit === 0), 'the daemon makes it a task note heading a turn');

// 2. A background subagent reporting back.
let n = await results();
await page.fill('#input', 'Use the Agent tool with run_in_background: true to launch a general-purpose subagent whose task is: reply with exactly MID-REPORT-3 and use no tools. Right after launching it, run this exact command with Bash in the foreground: sleep 15. Then reply with just: after');
await page.press('#input', 'Enter');
await waitResults(page, n + 1, { timeout: 150000, what: 'the turn with the subagent ended' });
check(await until(() => notes(a, 'agent').some((e) => /MID-REPORT-3/.test(e.body || '')), 30000), `a subagent note with its report (${JSON.stringify(notes(a, 'agent').map((e) => [e.turn, e.title]))})`);

// 3. Another session sends A a message.
await startSession(page, B, `Load ListAgents and SendMessage with ToolSearch. Use ListAgents to find the other Claude session whose working directory is ${A}, then SendMessage to it exactly this text: PING-FROM-B, reply with just ack. Then reply with just: sent`, { mode: 'bypassPermissions' });
await waitResults(page, 1, { timeout: 150000, what: 'B sent its message' });
check(await until(() => notes(a, 'session').some((e) => /PING-FROM-B/.test(e.title)), 90000), 'A gets a session note with the message');
const peer = entries(a).find((e) => e.turnOrigin === 'peer');
check(peer?.isMeta === true && peer.origin?.kind === 'peer' && !!peer.origin.name && /PING-FROM-B/.test(peer.origin.body || '') && /^Another Claude session sent a message:/.test(peer.message?.content),
  `the message: isMeta, turnOrigin peer, origin peer with name and body, the envelope (${JSON.stringify(peer)?.slice(0, 400)})`);

// 4. A schedule firing.
await page.click(`.folder[data-dir="${A}"] .sess`);
n = await results();
await page.fill('#input', 'Load CronCreate with ToolSearch. Run date, then use CronCreate to schedule a one-shot (non-recurring) prompt with the text "Reply with just: TICK-9" for the next whole minute that is at least one minute from now. Reply with just: scheduled');
await page.press('#input', 'Enter');
await waitResults(page, n + 1, { timeout: 120000, what: 'the schedule was set' });
check(await until(() => notes(a, 'wakeup').some((e) => /TICK-9/.test(e.title)), 200000), 'the schedule fired: a wakeup note with the prompt');
const sched = entries(a).find((e) => e.turnOrigin === 'scheduled');
check(sched?.isMeta === true && sched.message?.content === 'Reply with just: TICK-9' && !sched.origin,
  `the prompt: isMeta, turnOrigin scheduled, as it is, no origin (${JSON.stringify(sched)?.slice(0, 300)})`);

await endSuite(suite);
