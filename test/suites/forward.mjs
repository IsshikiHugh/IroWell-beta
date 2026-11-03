// Forward mode (server/forward.mjs): a session's conversation in a Slack thread, on a stand-in Slack (test/fakeslack.mjs)
// and the fake Claude (forward.fake.mjs: real turns, no model). On the daemon alone, and on the page.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, check, until, cleanEnv, startSuite, addFolder, workDir, daemonAsk, tempDaemon, endSuite } from '../lib.mjs';
import { fakeSlack } from '../fakeslack.mjs';
import { toSlack, parseAnswers, fromSlack, chunks } from '../../server/forward.mjs';

const ME = 'U0USER0001', APP = 'xapp-1-A0TEST-1234567890-abcdef', BOT = 'xoxb-1234567890-abcdefghij';
const files = workDir('forward-files');
const PLOT = path.join(files, 'plot.png');
fs.writeFileSync(PLOT, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
process.env.IRO_TEST_PLOT = PLOT; // (the fake Claude links to it: forward.fake.mjs)

// ---- what Claude writes, as Slack shows it; what the user writes, as the session gets it ----
function formats() {
  const t = toSlack(':::log\n\nsteps\n\n:::\n\n:::reply\n\n**Bold** and *it*, `a<b`, [docs](https://x.org/d), [p.png](/tmp/p.png), [train.py:3-9](/x/train.py:3-9).\n\n# Head\n- one\n\n| a | b |\n|---|---|\n| 中文 | 2 |\n\n```mermaid\ngraph TD\n```\n\n:::\n\n:::ask[2]\n\nDelete it?\n\n:::');
  check(t.text === '*Bold* and _it_, `a&lt;b`, <https://x.org/d|docs>, `p.png`, `train.py:3-9`.\n\n*Head*\n• one\n\n```\na     b\n中文  2\n```\n\n_(diagram: open in IroWell)_\n\n🙋 *2.*\n> Delete it?'
    && t.files.length === 1 && t.files[0] === '/tmp/p.png' && toSlack(':::log\n\nonly a log\n\n:::').text === '' && toSlack('No marker: a reply.').text === 'No marker: a reply.',
    `Claude's text in Slack's markup: logs left out, a question in a quote under its number, a table aligned, a picture to upload (${JSON.stringify(t)})`);
  const qs = [{ question: 'A?', options: [{ label: 'x' }, { label: 'y' }] }, { question: 'B?', options: [{ label: 'p' }, { label: 'q' }] }];
  check(JSON.stringify(parseAnswers(qs, '1a 2b').answers) === '{"A?":"x","B?":"q"}' && parseAnswers(qs, '1b 2 use sqlite').answers['B?'] === 'use sqlite'
    && /Answer each/.test(parseAnswers(qs, 'a').error) && parseAnswers([qs[0]], 'b').answers['A?'] === 'y' && parseAnswers([qs[0]], 'Y').answers['A?'] === 'y'
    && parseAnswers([qs[0]], '10 epochs').answers['A?'] === '10 epochs',
    'answers from a reply: `1a 2b`, the user\'s own words for one, a letter or a label for a single question');
  check(fromSlack('see <https://x.org/a|here> &lt;b&gt; &amp; <@U1>') === 'see here (https://x.org/a) <b> & @U1' && chunks('a'.repeat(3000) + '\n\nb').length === 2,
    'what the user writes on Slack, as plain text; a long text in parts');
}

// ---- the daemon alone ----
async function daemonOnly() {
  const slack = await fakeSlack();
  const work = workDir('forward-work');
  const { ask, evs, close } = await tempDaemon({ IRO_TEST_SLACK_API: slack.api }, 'iro-fwd-');
  const handled = async (env) => { await until(() => slack.acks.has(env), 3000, `the daemon acknowledges ${env}`); await ask({ type: 'forwardState' }); };
  const { data: { sid } } = await ask({ type: 'new', cwd: work, text: 'Reply with just: ready' });
  const ended = (n) => until(() => evs.filter((e) => e.sid === sid && e.kind === 'msg' && e.msg.type === 'result').length >= n, 15000, `turn ${n} of the session`);
  await ended(1);
  const cid = evs.find((e) => e.sid === sid && e.claudeSessionId)?.claudeSessionId || evs.find((e) => e.sid === sid && e.kind === 'init')?.claudeSessionId;

  const notSet = await ask({ type: 'forwardStart', sid });
  check(/Set up Slack first/.test(notSet.error || ''), `no Slack set up: forward mode says so (${notSet.error})`);
  await ask({ type: 'awaySlackSet', appToken: APP, botToken: BOT, userId: ME });
  const on = await ask({ type: 'forwardStart', sid });
  check(on.data?.sessions?.[0]?.cid === cid && slack.connected(), `on: the daemon connects to Slack (${JSON.stringify(on.data || on.error)})`);
  const root = slack.posts().find((p) => !p.thread_ts && /^📨 `[A-Z2-9]{4}` \*Reply with just: ready\*\n\n_Forwarding since/.test(p.text));
  check(!!root && root.blocks[1].elements.map((b) => b.action_id).join() === 'fwd_exit', `one message in the DM: the session's ID and title, with Exit (${slack.posts().map((p) => p.text.slice(0, 50)).join(' / ')})`);
  const inThread = () => slack.posts().filter((p) => p.thread_ts === root.ts);
  const edits = (ts) => slack.updates().filter((u) => u.ts === ts);
  const toldUser = () => evs.filter((e) => e.sid === sid && e.kind === 'user_text');

  // A message in the thread goes to the session (from Slack), with 👀; the turn's last message says it works, then
  // holds what Claude wrote (its log left out), and the picture follows
  const env1 = slack.message(ME, 'Start the work', root.ts);
  check(await until(() => toldUser().some((e) => e.text === 'Start the work' && e.via === 'slack'), 5000) && await until(() => slack.reactions().some((r) => r.name === 'eyes'), 3000),
    'what the user writes in the thread reaches the session, as from Slack, and gets 👀');
  await handled(env1);
  await ended(2);
  const ph = await until(() => inThread().some((p) => /^⏳ Working… · since/.test(p.text)), 3000) && inThread().find((p) => /^⏳ Working…/.test(p.text));
  check(!!ph && ph.blocks[1].elements[0].action_id === 'fwd_stop', 'while it works, the last message says so, with Stop');
  check(await until(() => edits(ph.ts).some((u) => u.text.startsWith('Done: *3 tests* pass. See `plot.png`.') && u.text.includes('🙋 *1.*\n> Delete `old.js` too?') && u.text.includes('```\na  b\n1  2\n```') && !/Looking at the tests/.test(u.text) && u.blocks.length === 1), 5000)
    && inThread().filter((p) => /^⏳/.test(p.text)).length === 1 && await until(() => slack.files().some((f) => f.thread_ts === root.ts && JSON.parse(f.files)[0].title === 'plot.png' && f.bytes?.length === 8), 5000),
    `the reply and the question are written into it (no log, no Stop), and the picture it links to is uploaded (${edits(ph.ts).map((u) => u.text.slice(0, 80)).join(' / ')})`);

  // A turn that leaves nothing for the user: its message goes again
  const n0 = inThread().length;
  slack.message(ME, 'Be quiet', root.ts);
  await ended(3);
  const ph2 = await until(() => inThread().length > n0, 3000) && inThread().slice(n0).find((p) => /^⏳/.test(p.text));
  check(!!ph2 && await until(() => slack.deletes().some((d) => d.ts === ph2.ts), 3000) && inThread().length === n0 + 1, 'a turn with only a log: its working message is taken away, nothing stays');

  // Two questions: answered in the thread (`1b 2 …`); one question: its options are buttons
  slack.message(ME, 'Ask me two', root.ts);
  const q2 = await until(() => slack.updates().concat(inThread()).some((p) => /Which database\?/.test(p.text)), 8000) && [...slack.updates(), ...inThread()].find((p) => /Which database\?/.test(p.text));
  check(!!q2 && /\*1\. Which database\?\*\na\. Postgres — _big_\nb\. SQLite — _small_/.test(q2.text) && /Or reply `1a 2b`/.test(q2.text) && q2.blocks[1].elements.map((b) => b.action_id).join() === 'fwd_deny',
    `two questions: numbered, their options lettered, answered by a reply (only Skip as a button) (${q2?.text})`);
  slack.message(ME, '1b 2 use 9090', root.ts);
  await ended(4);
  const qDone = evs.findLast((e) => e.sid === sid && e.kind === 'approval_done');
  check(qDone?.answers?.['Which database?'] === 'SQLite' && qDone.answers['Which port?'] === 'use 9090' && await until(() => edits(q2.ts).some((u) => /✅ Answered: SQLite; use 9090/.test(u.text) && u.blocks.length === 1), 3000),
    `the reply answers them, and the message says how (${JSON.stringify(qDone?.answers)})`);
  slack.message(ME, 'Ask me one', root.ts);
  const q1 = await until(() => [...slack.updates(), ...inThread()].some((p) => /Retry or fix\?/.test(p.text) && p.blocks?.[1]), 8000) && [...slack.updates(), ...inThread()].find((p) => /Retry or fix\?/.test(p.text));
  const fix = q1?.blocks[1].elements.find((b) => b.text.text === 'Fix');
  slack.click(ME, fix.action_id, JSON.parse(fix.value), q1.ts);
  await ended(5);
  check(evs.findLast((e) => e.sid === sid && e.kind === 'approval_done')?.answers?.['Retry or fix?'] === 'Fix', 'one question: a click on an option answers it');

  // A tool permission: the user's words in the thread deny it, and Claude is told them
  slack.message(ME, 'Clean the build', root.ts);
  const perm = await until(() => [...slack.updates(), ...inThread()].some((p) => /^🙋 \*Bash\* `rm -rf build`/.test(p.text)), 8000) && [...slack.updates(), ...inThread()].find((p) => /^🙋 \*Bash\*/.test(p.text));
  check(!!perm && perm.blocks[1].elements.map((b) => b.action_id).join() === 'fwd_allow,fwd_deny', 'a tool permission: Allow and Deny');
  slack.message(ME, 'no, keep the build', root.ts);
  await ended(6);
  check(evs.findLast((e) => e.sid === sid && e.kind === 'approval_done')?.allow === false && await until(() => edits(perm.ts).some((u) => /✋ Denied: “no, keep the build”/.test(u.text)), 3000)
    && !toldUser().some((e) => e.text === 'no, keep the build'), 'words in the thread while it waits deny it (they are not a new message), and the message says so');

  // Stop: the turn is interrupted, its message says so
  slack.message(ME, 'Work for long', root.ts);
  const ph3 = await until(() => inThread().some((p) => /^⏳/.test(p.text) && !slack.deletes().some((d) => d.ts === p.ts) && !edits(p.ts).length), 8000)
    && inThread().findLast((p) => /^⏳/.test(p.text));
  slack.click(ME, 'fwd_stop', { cid }, ph3.ts);
  check(await ended(7) && await until(() => edits(ph3.ts).some((u) => u.text === '✋ Stopped (by you)'), 3000) && !evs.some((e) => e.sid === sid && e.kind === 'msg' && /Finally done/.test(JSON.stringify(e.msg))),
    'Stop interrupts the turn, and its message says so');

  // Ignored: a message outside the thread, someone else's in it
  const told = toldUser().length;
  await handled(slack.message(ME, 'Reply with just: top'));
  await handled(slack.message('U0SOMEONE9', 'Reply with just: other', root.ts));
  await new Promise((r) => setTimeout(r, 500));
  check(toldUser().length === told, 'a message outside the thread, or by someone else, reaches nothing');

  // Slack out of reach: what happens meanwhile is posted once it is back, in order
  slack.outage(true);
  const n1 = inThread().length;
  await ask({ type: 'send', sid, text: 'Start the work' });
  await ended(8);
  await new Promise((r) => setTimeout(r, 1500));
  slack.outage(false);
  check(await until(() => inThread().length > n1 && inThread().slice(n1).some((p) => /^⏳/.test(p.text)), 15000)
    && await until(() => slack.updates().some((u) => u.ts === inThread().slice(n1).find((p) => /^⏳/.test(p.text))?.ts && /3 tests/.test(u.text)), 15000),
    'Slack out of reach: what came meanwhile goes once it is back, in order');

  // Away mode takes the session: forwarding ends; forwarded again, away mode lets it go
  await ask({ type: 'awayStart', sessions: [cid] });
  check(await until(async () => !(await ask({ type: 'forwardState' })).data.sessions.length, 3000)
    && await until(() => edits(root.ts).some((u) => /^`[A-Z2-9]{4}` \*Reply with just: ready\*\n\n_Forwarded .* – .*\(\d+ min\)_$/.test(u.text) && u.blocks.length === 1), 5000),
    'watched by away mode: forwarding ends, and its message says when it ran (no Exit)');
  await ask({ type: 'forwardStart', sid });
  check(await until(async () => !(await ask({ type: 'awayState' })).data.sessions.length, 3000), 'forwarded again: away mode watches it no more');
  await ask({ type: 'awayStop' });
  const root2 = slack.posts().findLast((p) => !p.thread_ts && /^📨/.test(p.text));
  check(root2.ts !== root.ts, 'each time forwarding starts, a message of its own');
  const n2 = toldUser().length;
  await handled(slack.message(ME, 'Reply with just: late', root.ts));
  check(toldUser().length === n2, 'a message in the thread of a forwarding that ended reaches nothing');

  // Exit on Slack ends it; detached, it ends too
  slack.click(ME, 'fwd_exit', { cid }, root2.ts);
  check(await until(async () => !(await ask({ type: 'forwardState' })).data.sessions.length, 3000) && await until(() => edits(root2.ts).some((u) => /_Forwarded/.test(u.text)), 3000), 'Exit on Slack ends it');
  await ask({ type: 'forwardStart', sid });
  await ask({ type: 'close', sid });
  check(await until(async () => !(await ask({ type: 'forwardState' })).data.sessions.length, 6000), 'detached: forwarding ends');
  await close();
  slack.close();
}

// ---- on the page: send held a second forwards the session (a ring fills round it); the conversation is read only, dimmed, the
// logo over it, send shows Slack's mark; what came from Slack has Slack's mark; held again, it is back ----
async function onPage() {
  const slack = await fakeSlack();
  const work = workDir('forward-page');
  const api = await startSuite(PORT, { env: cleanEnv({ IRO_TEST_SLACK_API: slack.api, IRO_NO_USAGE_RECORD: '1' }), viewport: { width: 1280, height: 800 } });
  const { page } = api;
  const ask = (cmd) => daemonAsk(process.env.IRO_DIR, cmd);
  await addFolder(page, work);
  await ask({ type: 'awaySlackSet', appToken: APP, botToken: BOT, userId: ME });
  await ask({ type: 'new', cwd: work, text: 'Reply with just: hi there' });
  await page.locator('.sess', { hasText: 'Reply with just: hi there' }).click();
  await page.locator('#feed .turn', { hasText: 'hi there' }).last().waitFor({ timeout: 15000 });
  const send = page.locator('#send');
  // a short press is a click: it does not forward
  await send.hover();
  await page.mouse.down();
  await page.waitForTimeout(600);
  check(await page.locator('#send.holding').count() === 1, 'pressing send starts the ring');
  await page.locator('#composer').screenshot({ path: path.join(files, 'holding.png') });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check(!(await ask({ type: 'forwardState' })).data.sessions.length, 'let go early: nothing happens');
  await page.locator('#input').fill('Reply with just: going now');
  await send.hover();
  await page.mouse.down();
  await page.waitForTimeout(1300);
  await page.mouse.up();
  check(await until(async () => (await ask({ type: 'forwardState' })).data.sessions.length === 1, 5000) && await until(async () => await page.locator('#send.fwd').count() === 1, 3000)
    && await page.locator('#send .ic-slack').isVisible() && await page.locator('#input').isDisabled() && await page.locator('.fwd-back svg').isVisible()
    && await page.locator('.sess.active .fwd-logo').count() === 1,
    'held a second: forwarded; send shows Slack\'s mark, the input is off, the logo turns over the dimmed conversation, the row has the logo');
  check(await until(async () => /going now/.test(await page.locator('#feed').textContent()), 5000) && await page.locator('#input').inputValue() === '', 'what was typed goes first, as the session\'s message');
  const root = slack.posts().find((p) => !p.thread_ts);
  slack.message(ME, 'Reply with just: from the phone', root.ts);
  check(await until(async () => await page.locator('.turn-q.slack .turn-q-slack').count() === 1, 8000), 'what came from Slack has Slack\'s mark in place of your initial');
  await page.screenshot({ path: path.join(files, 'forwarded.png') });
  await send.hover();
  await page.mouse.down();
  await page.waitForTimeout(1300);
  await page.mouse.up();
  check(await until(async () => !(await ask({ type: 'forwardState' })).data.sessions.length, 5000) && await until(async () => await page.locator('#send.fwd').count() === 0, 3000)
    && await page.locator('#input').isEnabled() && await page.locator('.fwd-back').isHidden(), 'held again: forwarding ends, and the page is as before');
  slack.close();
  return api;
}

formats();
const [, api] = await Promise.all([daemonOnly(), onPage()]);
await endSuite(api);
