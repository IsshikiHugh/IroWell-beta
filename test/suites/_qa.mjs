// What the suites split from the old quick suite's part A share (basics, render, input, files, sidebar, shell).
import { PORT, startClient, openPage, workDir, addFolder, check, expectSoon } from '../lib.mjs';

// A project folder: a Python file, src/notes.md, and a .claude/settings.local.json that makes a draft here start
// in Plan mode. `name` must be the suite's own (the suites of a run share its output folder).
export const work = (name) => workDir(name, {
  'calc.py': 'def add(a, b):\n    return a + b\n',
  'src/notes.md': '# notes\n',
  '.claude/settings.local.json': JSON.stringify({ permissions: { defaultMode: 'plan' } }),
});

// A fresh daemon, this checkout's client, and a page on it (openPage's options). A native confirm or alert is
// counted with the page's errors: the page draws its own dialogs (ui/dialog.js).
export async function start(opts = {}) {
  const api = await startClient(PORT);
  const pg = await openPage(PORT, opts);
  pg.page.on('dialog', (d) => { pg.errors.push(`native dialog: ${d.message()}`); d.dismiss(); });
  return { ...api, ...pg };
}

// A blank session (a Claude process sent nothing yet) in folder `dir`, open on the page: its sid. The folder is
// added first, as a user would: else, right after the page connects, its folder list (fetched as it came up) can
// arrive after the one the new session pushed, and hide the unlisted folder's row.
export async function openBlank(page, cmd, dir) {
  await addFolder(page, dir);
  const r = await cmd({ type: 'new', cwd: dir, blank: true }), sid = r.data?.sid;
  if (!sid) check(false, `a blank session starts (${JSON.stringify(r)})`);
  await page.locator(`.folder[data-dir="${dir}"] .sess`).first().click({ timeout: 10000 });
  await expectSoon(() => page.locator('#input').isEnabled(), 'a blank session opens and takes input', 15000);
  return sid;
}
