// Where a session works, with a real session: the title shows its folder's branch; a file written in another
// worktree asks Claude (a PostToolUse hook) whether it works there now, and it says so through the
// irowell:workplace skill; a checkout there shows at once.
import { outDir, startSession, check, finish, startSuite, until, turn, log } from '../lib.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4800;
const WORK = path.join(S, 'work-place');
const WT = WORK + '-feat';
for (const d of [WORK, WT]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(WORK);
const git = (...args) => execFileSync('git', args, { cwd: WORK, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(WORK, 'a.txt'), 'a\n');
git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
git('worktree', 'add', '-q', '-b', 'feat', WT);
const { client, browser, page, errors } = await startSuite(PORT, { viewport: { width: 1400, height: 900 } });

const work = () => page.evaluate(() => { const el = document.getElementById('sb-work'); return el.hidden ? null : { wt: el.querySelector('.wt')?.textContent ?? null, text: el.textContent }; });

await startSession(page, WORK, 'Reply with just: ready');
await page.locator('.meta.result').first().waitFor({ timeout: 120000 });
await until(async () => (await work())?.text === 'main', 10000);
check((await work())?.text === 'main', `the title shows the folder's branch (${JSON.stringify(await work())})`);

check(await turn(page, `From now on all the work of this task happens in the git worktree ${fs.realpathSync(WT)}, not in this folder. Start it: with the Write tool, create ${fs.realpathSync(WT)}/notes.txt containing "start". Do what a note after that tool call asks, then reply with just: ok`, { results: '.meta.result', timeout: 240000 }), 'the turn that moves to the worktree');
// Claude sometimes just answers "ok" and leaves the hook's question unanswered: ask it once to answer it.
// The title still moves only through the skill.
if (!await until(async () => (await work())?.wt === 'work-place-feat', 15000)) {
  log('the title did not move: asking Claude to answer the note after its Write call');
  check(await turn(page, `A note after your Write call asked whether this session now works in that worktree. Answer it as the note says. Then reply with just: ok`, { results: '.meta.result', timeout: 240000 }), 'the turn that answers the note');
  await until(async () => (await work())?.wt === 'work-place-feat', 15000);
}
const moved = await work();
check(moved?.wt === 'work-place-feat' && moved.text === 'work-place-featfeat', `Claude says where it works now, and the title shows the worktree and its branch (${JSON.stringify(moved)})`);
await page.screenshot({ path: path.join(S, 'workplace-1-moved.png') });

check(await turn(page, `In ${fs.realpathSync(WT)}, run: git checkout -q -b feat-two. Reply with just: ok`, { results: '.meta.result', timeout: 240000 }), 'the turn that checks out a branch there');
await until(async () => (await work())?.text === 'work-place-featfeat-two', 15000);
check((await work())?.text === 'work-place-featfeat-two', `a checkout there shows at once (${JSON.stringify(await work())})`);

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
finish();
