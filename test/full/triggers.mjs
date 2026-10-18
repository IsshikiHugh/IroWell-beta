// Turns you didn't send: a bubble at the head says what started each one (a background task or subagent
// reporting back, another session's message, a schedule firing); one read mid-turn sits inside that turn;
// and the same heads come back when the conversation is read from its transcript.
import { outDir, startSession, check, until, finish, startSuite, killDaemon } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4818;
const A = path.join(S, 'work-trig-a'), B = path.join(S, 'work-trig-b');
for (const d of [A, B]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d); }
const realA = fs.realpathSync(A), realB = fs.realpathSync(B);
const { client, browser, page, errors } = await startSuite(PORT);

const results = () => page.locator('.turn-foot .meta.result').count();
async function settle(n, ms, what) { // until the open session has `n` finished turns (approving what it asks)
  await until(async () => {
    const allow = page.locator('.approval .btns button.primary');
    if (await allow.count()) await allow.first().click().catch(() => {});
    return (await results()) >= n;
  }, ms, what);
}
const open = async (dir) => { await page.click(`.folder[data-dir="${dir}"] .sess`); await page.waitForTimeout(800); };
const bubble = (src) => page.locator(`.turn.trigger .trig.src-${src}`);

// 1. A background command finishing while Claude is idle: a turn of its own, headed by the task's bubble.
await startSession(page, A, 'Start this with Bash using run_in_background: sleep 8; echo TRIG-DONE. Do not wait for it. Reply with just: started. When it finishes, reply with just: seen', { mode: 'bypassPermissions' });
await settle(2, 120000, 'the background command reported back and Claude answered');
const task = bubble('task').first();
check(await task.isVisible(), 'a turn headed by a Background task bubble');
const taskTurn = page.locator('.turn.trigger').first();
check(!(await taskTurn.locator('.turn-q').count()), 'that turn has no request card');
const taskText = await task.locator('.trig-btn').textContent();
check(/Background task/.test(taskText) && /exit 0/.test(taskText), `bubble names it and its exit code: ${taskText}`);
check(await task.evaluate((el) => getComputedStyle(el.closest('.trig-head')).position) !== 'sticky', 'the bubble does not stick');
await task.locator('.trig-btn').click();
check(/TRIG-DONE/.test(await task.locator('.trig-pane').textContent().catch(() => '')), 'it opens to what the command printed');
await task.locator('.trig-btn').click();
check(await task.locator('.trig-pane').isHidden(), 'a second click folds it again');
check(await page.locator('#outline .ol-item').count() === 1, 'it is no anchor: the outline lists only your request');
await page.screenshot({ path: path.join(S, 'triggers-task.png') });

// 2. A subagent reporting back while Claude is still working: a small bubble inside the turn running.
const before = await results();
await page.fill('#input', 'Use the Agent tool with run_in_background: true to launch a general-purpose subagent whose task is: reply with exactly MID-REPORT-3 and use no tools. Right after launching it, run this exact command with Bash in the foreground (not in the background): node -e "setTimeout(() => console.log(1), 25000)". Then reply with just: after');
await page.press('#input', 'Enter');
await settle(before + 1, 150000, 'the turn with the subagent ended');
await page.waitForTimeout(3000); // (a report that missed the turn starts one of its own)
const inline = page.locator('.turn:not(.trigger) .turn-body .trig.small.src-agent');
const agentTurn = bubble('agent');
console.log(`  subagent: ${await inline.count()} inside the turn, ${await agentTurn.count()} heading a turn`);
check(await inline.count() + await agentTurn.count() >= 1, 'the subagent\'s report has a bubble');
const agent = (await inline.count()) ? inline.first() : agentTurn.first();
if (await agent.isVisible()) {
  check(/Subagent/.test(await agent.locator('.trig-kind').textContent()), 'labelled Subagent');
  await agent.locator('.trig-btn').click();
  check(/MID-REPORT-3/.test(await agent.locator('.trig-pane').textContent().catch(() => '')), 'it opens to the report');
}
await page.screenshot({ path: path.join(S, 'triggers-agent.png') });

// 3. Another session sends A a message.
await startSession(page, B, `Load ListAgents and SendMessage with ToolSearch. Use ListAgents to find the other Claude session whose working directory is ${realA}, then SendMessage to it exactly this text: PING-FROM-B, reply with just ack. Then reply with just: sent`, { mode: 'bypassPermissions' });
await settle(1, 150000, 'B sent its message');
await open(realA);
await until(async () => (await bubble('session').count()) >= 1, 90000, 'A shows the message from B');
const sess = bubble('session').first();
const sessText = await sess.locator('.trig-btn').textContent();
check(/PING-FROM-B/.test(sessText), `the bubble shows the message: ${sessText}`);
await page.screenshot({ path: path.join(S, 'triggers-session.png') });

// 4. A schedule firing.
const n4 = await results();
await page.fill('#input', 'Load CronCreate with ToolSearch. Run date, then use CronCreate to schedule a one-shot (non-recurring) prompt with the text "Reply with just: TICK-9" for the next whole minute that is at least one minute from now. Reply with just: scheduled');
await page.press('#input', 'Enter');
await settle(n4 + 1, 120000, 'the schedule was set');
await until(async () => (await bubble('wakeup').count()) >= 1, 200000, 'the schedule fired');
if (!(await bubble('wakeup').count())) { // what came instead
  console.log('  bubbles:', await page.locator('.trig-btn').allTextContents());
  await page.screenshot({ path: path.join(S, 'triggers-wakeup-missing.png') });
}
const wake = bubble('wakeup').first();
check(/TICK-9/.test(await wake.locator('.trig-title').textContent()), `the bubble shows the scheduled prompt: ${await wake.locator('.trig-btn').textContent()}`);
await settle(n4 + 2, 90000, 'Claude answered the schedule');
await page.screenshot({ path: path.join(S, 'triggers-wakeup.png') });

// 5. Read back from the transcript (a daemon restart: the session is reopened from what the CLI wrote).
killDaemon();
await page.waitForTimeout(1500);
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
await open(realA);
await until(async () => (await page.locator('.turn').count()) >= 4, 30000, 'the transcript is read');
await page.waitForTimeout(1000);
const heads = {};
for (const src of ['task', 'session', 'wakeup']) heads[src] = await bubble(src).count();
check(heads.task >= 1 && heads.session >= 1 && heads.wakeup >= 1, `from the transcript: the same heads (${JSON.stringify(heads)})`);
check(!(await page.locator('.turn-q-text', { hasText: /^(PING-FROM-B|<task-notification>|Reply with just: TICK-9)/ }).count()), 'none of them shows as a request of yours');
await page.screenshot({ path: path.join(S, 'triggers-history.png'), fullPage: true });

check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
client.kill('SIGTERM');
finish();
