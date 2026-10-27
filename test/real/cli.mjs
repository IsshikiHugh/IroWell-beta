// What only the real Claude Code shows (the suites in test/suites run on a stand-in): the tools a headless
// CLI is given as in the terminal; its own fork (forkSession + resumeSessionAt), file checkpoints and resume
// going on from the right point; a settings hook's output in the turn; and Claude following IroWell's skills
// (irowell:progress, and the workplace note a PostToolUse hook leaves). Few turns, answers fixed by the prompt.
import { PORT, check, until, log, startSuite, startSession, eventStream, transcript, turn, workDir, endSuite } from '../lib.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RW = workDir('work-cli', {
  'a.txt': 'one\n',
  '.claude/settings.local.json': JSON.stringify({
    permissions: { allow: ['Edit', 'Write'] },
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hook-said-hi' }] }] },
  }),
});
const aTxt = () => fs.readFileSync(path.join(RW, 'a.txt'), 'utf8').trim();
const ASK = 'What is the codeword now? Reply with just the word.';

const { client, token, cmd, browser, page, errors } = await startSuite(PORT);
const T = eventStream(PORT, token, cmd);
const { of, results, assistants, claudeId, ask } = T;
const userTexts = (sid) => of(sid).filter((e) => e.kind === 'user_text');
await until(() => T.up, 15000, 'transport up');

// ---- the CLI's own conversation bookkeeping ----
const A = (await cmd({ type: 'new', cwd: RW, text: 'Remember the codeword PELICAN. Reply with just: ok', mode: 'default' })).data.sid;
await until(() => results(A).length >= 1, 120000, 'turn 1');
const at = assistants(A).pop().msg.uuid;
const snap = transcript(claudeId(A)).split('\n').filter((l) => l.includes('"prompt_snapshot"') && l.includes('"tools"')).pop() || '';
check(/"name":"Artifact"/.test(snap), 'the Artifact tool is available (as in the terminal)');
check(/subagent_type: \\?"fork/.test(snap), 'forked subagents are offered (as in the terminal)');

await ask(A, 'Use the Edit tool to change "one" to "two" in a.txt. Also, the codeword is now HERON. Then reply with just: done');
check(aTxt() === 'two', 'the edit happened');
check(of(A).some((e) => e.kind === 'sys' && e.subtype === 'hook' && /hook-said-hi/.test(e.text)), 'the PostToolUse hook\'s output shows in the turn');

const B = (await cmd({ type: 'branch', sid: A, at, nonce: 'b1' })).data?.sid;
const fromB = await ask(B, ASK);
check(/PELICAN/i.test(fromB) && !/HERON/i.test(fromB), `a branch from the first turn continues from there (${fromB})`);

const u2 = userTexts(A)[1];
const rw = await cmd({ type: 'rewind', sid: A, uuid: u2.uuid });
check(rw.data && aTxt() === 'one', `a rewind restores the file from its checkpoint (${JSON.stringify(rw.data || rw.error)})`);
const said = await ask(A, ASK);
check(/PELICAN/i.test(said) && !/HERON/i.test(said), `the conversation goes on from before the rewound message (${said})`);

await cmd({ type: 'close', sid: A });
await until(() => T.closed(A), 10000, 'detached');
const A2 = (await cmd({ type: 'resume', claudeSessionId: claudeId(A), cwd: RW, title: 'A' })).data.sid;
const resumed = await ask(A2, 'The codeword is still the same. ' + ASK);
check(/PELICAN/i.test(resumed), `a resumed session remembers its conversation (${resumed})`);

// ---- irowell:progress: Claude starts a list through the skill; the user's edits reach it with the next message ----
const items = () => page.evaluate(() => [...document.querySelectorAll('#progress .pg-item')].map((r) => `${r.className.replace('pg-item ', '')}:${r.querySelector('.pg-text').textContent}`).join(' | '));
const item = (text) => page.locator('#progress .pg-item', { hasText: text });
// (the last turn, not the feed's last child: the logo that turns while Claude works can come after it)
const lastAnswer = () => page.evaluate(() => [...document.querySelectorAll('#feed .turn')].at(-1)?.textContent || '');
const PG = workDir('work-progress');
// (the skill is a command only: Claude doesn't load it by itself)
await startSession(page, PG, '/irowell:progress Start a progress list with exactly these three items, in this order: "Alpha step", "Beta step", "Gamma step". Then mark "Alpha step" done. Reply with just: ok');
await page.locator('.meta.result').first().waitFor({ timeout: 240000 });
await until(async () => (await items()) === 'done:Alpha step | todo:Beta step | todo:Gamma step', 10000);
check(await items() === 'done:Alpha step | todo:Beta step | todo:Gamma step' && await page.locator('#progress .pg-count').textContent() === '1/3',
  `Claude starts the list through the skill, and it shows at the rail's foot (${await items()})`);
await page.fill('#progress .pg-add', 'Delta step');
await page.press('#progress .pg-add', 'Enter');
await item('Delta step').waitFor({ timeout: 5000 });
await item('Beta step').locator('.pg-state').click();
await page.locator('#progress .pg-item.doing', { hasText: 'Beta step' }).waitFor({ timeout: 5000 });
await item('Gamma step').hover();
await item('Gamma step').locator('.pg-x').click();
await until(async () => (await items()) === 'done:Alpha step | doing:Beta step | todo:Delta step', 5000, 'the edited list');
const tools = await page.locator('#feed .tool').count();
check(await turn(page, 'Run no command and use no tool for this one. I just edited the progress list: which item did I add, which did I remove, and which did I mark as being done now (doing)? Answer in one line as: added=<text>; removed=<text>; doing=<text>', { results: '.meta.result', timeout: 240000 }), 'the turn after the user\'s edits');
const answer = await lastAnswer();
check(/added=\W*Delta step/i.test(answer) && /removed=\W*Gamma step/i.test(answer) && /doing=\W*Beta step/i.test(answer) && await page.locator('#feed .tool').count() === tools,
  `the user's changes came with their message: Claude names them without a tool call (${JSON.stringify(answer.slice(-200))})`);
check(await page.locator('#feed .turn').last().locator('.hook-note').count() === 0, 'and the turn shows no note about how they came');

// ---- irowell:workplace: a file written in another worktree asks Claude (a PostToolUse hook) whether it works
// there now; it says so through the skill, and the title follows; a checkout there shows at once ----
const WORK = workDir('work-place');
const WT = WORK + '-feat';
fs.rmSync(WT, { recursive: true, force: true });
const git = (...args) => execFileSync('git', args, { cwd: WORK, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(WORK, 'a.txt'), 'a\n');
git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
git('worktree', 'add', '-q', '-b', 'feat', WT);
const work = () => page.evaluate(() => { const el = document.getElementById('sb-work'); return el.hidden ? null : { wt: el.querySelector('.wt')?.textContent ?? null, text: el.textContent }; });
await startSession(page, WORK, `From now on all the work of this task happens in the git worktree ${WT}, not in this folder. Start it: with the Write tool, create ${WT}/notes.txt containing "start". Do what a note after that tool call asks, then reply with just: ok`);
await page.locator('.meta.result').first().waitFor({ timeout: 240000 });
// Claude sometimes just answers "ok" and leaves the hook's question unanswered: ask it once to answer it.
// The title still moves only through the skill.
if (!await until(async () => (await work())?.wt === 'work-place-feat', 15000)) {
  log('the title did not move: asking Claude to answer the note after its Write call');
  check(await turn(page, 'A note after your Write call asked whether this session now works in that worktree. Answer it as the note says. Then reply with just: ok', { results: '.meta.result', timeout: 240000 }), 'the turn that answers the note');
  await until(async () => (await work())?.wt === 'work-place-feat', 15000);
}
const moved = await work();
check(moved?.wt === 'work-place-feat' && moved.text === 'work-place-featfeat', `Claude says where it works now, and the title shows the worktree and its branch (${JSON.stringify(moved)})`);
check(await turn(page, `In ${WT}, run: git checkout -q -b feat-two. Reply with just: ok`, { results: '.meta.result', timeout: 240000 }), 'the turn that checks out a branch there');
await until(async () => (await work())?.text === 'work-place-featfeat-two', 15000);
check((await work())?.text === 'work-place-featfeat-two', `a checkout there shows at once (${JSON.stringify(await work())})`);

await endSuite({ browser, client, errors });
