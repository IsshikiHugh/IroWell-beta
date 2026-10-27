// The workplace (irowell:workplace): beside the title, the git worktree and branch the session works in. The
// session sets it with the skill's script (on the fake, a Bash step that runs it: workplace.fake.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, PORT, check, until, startSuite, addFolder, workDir, outDir, endSuite } from '../lib.mjs';
import { rpcOf, blankSession } from './_qc.mjs';

process.env.IRO_HOLD_MS = '0'; // (a message goes at once: the hold before it is the turns suite's)
const GIT = workDir('wp-git', { 'a.txt': 'a\n' }), FEAT = path.join(outDir(), 'wp-git-feat');
fs.rmSync(FEAT, { recursive: true, force: true });
const git = (...args) => execFileSync('git', args, { cwd: GIT, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
git('worktree', 'add', '-q', '-b', 'feat', FEAT);
const PLAIN = workDir('wp-plain');

const api = await startSuite(PORT);
const { page } = api;
const rpc = rpcOf(api);
await addFolder(page, GIT);
const work = () => page.evaluate(() => { const el = document.getElementById('sb-work'); return el.hidden ? null : { text: el.textContent, wt: el.querySelector('.wt')?.textContent ?? null, title: el.title }; });
const sid = await blankSession(rpc, GIT, 'in git', page);
await page.waitForFunction(() => !document.getElementById('sb-work').hidden, null, { timeout: 5000 }).catch(() => {});
const home = await work();
check(home?.text === 'main' && home.wt === null && home.title.includes(GIT), `workplace: in a git folder the title shows its branch (${JSON.stringify(home)})`);

// the session says it works in another worktree
await rpc({ type: 'send', sid, text: `workplace set ${JSON.stringify(fs.realpathSync(FEAT))}` });
await page.waitForFunction(() => !!document.querySelector('#sb-work .wt'), null, { timeout: 10000 }).catch(() => {});
const other = await work();
check(other?.wt === 'wp-git-feat' && other.text === 'wp-git-featfeat' && /^Worktree: .*wp-git-feat\nBranch: feat$/.test(other.title), `another worktree: its name, then its branch (${JSON.stringify(other)})`);
const box = await page.evaluate(() => { const t = document.getElementById('title').getBoundingClientRect(), w = document.getElementById('sb-work').getBoundingClientRect(); return { right: w.left >= t.right, mid: Math.abs((t.top + t.bottom) / 2 - (w.top + w.bottom) / 2) }; });
check(box.right && box.mid <= 3, `it sits right of the title, on its line (${JSON.stringify(box)})`);

// the session's script: only the session uses it, and only on a git working tree
check((await rpc({ type: 'workplaceCli', session: 'x', op: 'reset' })).status === 400, 'the page can\'t set it as the session');
// (CLAUDE_PID: a CLI that runs, as a live session's Bash tool has it)
const cli = (...args) => {
  try { return execFileSync(process.execPath, [path.join(REPO, 'skills', 'workplace', 'workplace.mjs'), ...args], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-0000000000bb', CLAUDE_PID: String(process.pid) }, stdio: 'pipe' }).toString(); }
  catch (e) { return String(e.stdout) + String(e.stderr); }
};
check(/^Not in a git working tree: /.test(cli('set', PLAIN)) && /^No such directory: /.test(cli('set', path.join(PLAIN, 'nowhere'))) && /^Unknown command: go\nusage:/.test(cli('go')),
  'a directory outside git, one that isn\'t there, a command it doesn\'t have: said so');
// not in git: nothing beside the title
const plain = await rpc({ type: 'new', cwd: PLAIN, blank: true });
let st;
await until(async () => (st = await rpc({ type: 'stats', sid: plain.data?.sid })).data, 5000);
check(st.data && st.data.work === null, `a folder outside git shows none (${JSON.stringify(plain)} ${JSON.stringify(st.data?.work)})`);

await endSuite(api);
