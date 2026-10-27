// Branching and rewinding a conversation (/branch, a turn's "Branch from here" and "Rewind to here"): which
// point the CLI goes on from (the fake answers "what is the codeword" from the conversation it was resumed
// with, so a wrong point shows), files restored from their checkpoints, and the bookkeeping around it: a
// branch keeps the original's settings and leaves it untouched; a rewind point outlives a detach.
import { PORT, check, until, startClient, openPage, eventStream, transcript, hold, workDir, endSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const WORK = workDir('work-branch');
const RW = workDir('work-rewind', { 'a.txt': 'one\n' });
const A_TXT = path.join(RW, 'a.txt');
const aTxt = () => fs.readFileSync(A_TXT, 'utf8').trim();
const rewinds = () => JSON.parse(fs.readFileSync(path.join(process.env.IRO_DIR, 'rewinds.json'), 'utf8'));

const { client, token, cmd } = await startClient(PORT);
const T = eventStream(PORT, token, cmd);
const { of, results, assistants, claudeId, ask } = T;
const userTexts = (sid) => of(sid).filter((e) => e.kind === 'user_text');
// What the page shows: a `rewound` event drops the events from the rewound message on.
const shown = (sid) => { const ev = []; for (const e of of(sid)) { if (e.kind === 'rewound') { const k = ev.findIndex((x) => x.seq >= e.from); if (k >= 0) ev.length = k; } ev.push(e); } return ev; };
const ASK = 'What is the codeword now?';
await until(() => T.up, 15000, 'transport up');

// ---- branch ----
const A = (await cmd({ type: 'new', cwd: WORK, text: 'Remember the codeword PELICAN. Reply with just: ok', mode: 'default' })).data.sid;
await cmd({ type: 'rename', sid: A, title: 'original' });
await until(() => results(A).length >= 1, 10000, 'turn 1');
const at = assistants(A).pop()?.msg.uuid;
check(!!at, 'assistant messages carry their uuid');
await ask(A, 'The codeword is now HERON instead. Reply with just: ok');
const by = await cmd({ type: 'setMode', sid: A, mode: 'bypassPermissions' });
check(by.error == null, `bypass permissions can be switched on${by.error ? ': ' + by.error : ''}`);
await cmd({ type: 'setMode', sid: A, mode: 'acceptEdits' });
await cmd({ type: 'setEffort', sid: A, effort: 'low' });
const modelA = of(A).filter((e) => e.kind === 'stats').pop()?.model;

// from the first turn
const b = await cmd({ type: 'branch', sid: A, at, nonce: 'b1' });
const B = b.data?.sid;
check(!!B, `branch from a turn${b.error ? ': ' + b.error : ''}`);
const made = of(B)[0] || {};
check(!!modelA && made.model === modelA && made.effort === 'low' && made.mode === 'acceptEdits',
  `the branch keeps the original's model, effort and mode (${made.model} ${made.effort} ${made.mode}; the original: ${modelA} low acceptEdits)`);
check(userTexts(B).length === 1, 'the branch shows the conversation up to that turn');
const fromB = await ask(B, ASK);
check(fromB === 'PELICAN', `the branch continues from that point (${fromB})`);
check(claudeId(B) && claudeId(B) !== claudeId(A), 'the branch is a session of its own');

// /branch: the whole conversation
const C = (await cmd({ type: 'branch', sid: A, title: 'whole', nonce: 'c1' })).data?.sid;
check(of(C)[0]?.title === 'whole', 'a /branch name becomes its title');
const fromC = await ask(C, ASK);
check(fromC === 'HERON', `/branch copies the whole conversation (${fromC})`);

// the original is untouched
check(!transcript(claudeId(A)).includes(ASK), 'nothing asked in a branch reaches the original');
const fromA = await ask(A, ASK);
check(fromA === 'HERON', `the original carries on (${fromA})`);

// ---- rewind (the terminal's Esc Esc) ----
const R = (await cmd({ type: 'new', cwd: RW, text: 'Remember the codeword PELICAN. Reply with just: ok', mode: 'default' })).data.sid;
await until(() => results(R).length >= 1, 10000, 'turn 1');
await ask(R, 'Change "one" to "two" in a.txt. Also, the codeword is now HERON. Then reply with just: done');
check(aTxt() === 'two', 'the edit happened');
const u2 = userTexts(R)[1];
check(!!u2?.uuid, 'user messages carry a uuid');
const dry = await cmd({ type: 'rewind', sid: R, uuid: u2.uuid, dryRun: true });
check(dry.data?.filesChanged?.some((f) => f.endsWith('a.txt')) && aTxt() === 'two', `a dry run names the file to restore, and changes nothing (${JSON.stringify(dry.data || dry.error)})`);
const rw = await cmd({ type: 'rewind', sid: R, uuid: u2.uuid });
check(rw.data?.text === u2.text, 'the rewound message comes back (for the input)');
check(aTxt() === 'one', 'the file is restored');
check(userTexts(R).length === 2 && shown(R).filter((e) => e.kind === 'user_text').length === 1, 'the page drops the rewound turn');
const said = await ask(R, ASK);
check(said === 'PELICAN', `the conversation goes on from before it (${said})`);

// rewound, then detached before anything new is sent: a reattach must still start at the rewind point
await ask(R, 'The codeword is now OSPREY. Reply with just: ok');
const u4 = userTexts(R).pop();
// two rewinds at once (a double click, a second tab): one goes through, the other is turned away instead of
// restarting the CLI a second time and leaving the first new one running unseen
const both = await Promise.all([cmd({ type: 'rewind', sid: R, uuid: u4.uuid }), cmd({ type: 'rewind', sid: R, uuid: u4.uuid })]);
check(both.filter((r) => r.data).length === 1 && both.some((r) => /rewinding|can't be rewound|not running/.test(r.error || '')), `two rewinds at once: one goes through (${JSON.stringify(both.map((r) => r.error || 'ok'))})`);
const cid = claudeId(R);
check(!!rewinds()[cid], 'the rewind point is remembered until the next message');
await cmd({ type: 'close', sid: R });
await until(() => T.closed(R), 10000, 'detached');
const R2 = (await cmd({ type: 'resume', claudeSessionId: cid, cwd: RW, title: 'reattached' })).data.sid;
check(!userTexts(R2).some((e) => /OSPREY/.test(e.text)), 'the reattached conversation does not show the rewound turn');
const after = await ask(R2, ASK);
check(after === 'PELICAN', `a reattach starts at the rewind point (${after})`);
check(!rewinds()[cid], 'forgotten once the conversation goes on');

// ---- the page: each question's ⋯ menu ----
const { browser, page, errors } = await openPage(PORT);
await page.locator('.sess-title', { hasText: /^original$/ }).click();
await page.locator('.turn').first().waitFor({ timeout: 10000 });
check(await page.locator('.turn-q .turn-more').count() === await page.locator('.turn').count(), 'each question has a ⋯ menu');
await page.locator('.turn-q').last().hover();
check(await page.locator('.turn-q .turn-more').last().isVisible(), 'it shows on hover');
const n = await page.locator('.sess').count();
await page.locator('.turn-q').first().hover();
await page.locator('.turn-q .turn-more').first().click();
check(await page.locator('.ctx-menu .ctx-item', { hasText: 'Rewind to here' }).count() === 1, 'the menu offers Rewind to here');
// Branch from here: a stand-in shows at once (checked elsewhere, with a slow server); then the server's branch takes its place
await page.locator('.ctx-menu .ctx-item', { hasText: 'Branch from here' }).click();
await page.waitForFunction((k) => document.querySelectorAll('.sess').length > k && !document.querySelector('.pending-note') && document.querySelector('.turn-q .turn-more'), n, { timeout: 15000 }).catch(() => {});
check(await page.locator('.sess').count() === n + 1 && /branched/.test(await page.locator('#feed').textContent()) && await page.locator('.turn').count() === 1,
  'Branch from here opens the branch, with the conversation up to that turn');

// Rewind to here (held): the turn goes, its message comes back into the input
await page.locator('.sess-title', { hasText: /^reattached$/ }).click();
await page.locator('.turn').first().waitFor({ timeout: 10000 });
const nq = await page.locator('.turn').count();
const lastQ = (await page.locator('.turn-q-text').last().textContent()).trim();
await page.locator('.turn-q').last().hover();
await page.locator('.turn-q .turn-more').last().click();
await hold(page, page.locator('.ctx-menu .ctx-item', { hasText: 'Rewind to here' }));
await page.waitForFunction((k) => document.querySelectorAll('.turn').length < k, nq, { timeout: 15000 }).catch(() => {});
check(await page.locator('.turn').count() === nq - 1 && (await page.inputValue('#input')).trim() === lastQ, 'after the hold: the turn is gone, its message is back in the input');
check(/rewound/.test(await page.locator('#feed').textContent()), 'a divider marks the rewind');

await endSuite({ browser, client, errors });
