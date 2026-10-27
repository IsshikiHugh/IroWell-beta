// The sidebar: sessions remembered from before a daemon restart (/color, /rename, reattach), the rows of a
// folder, drafts (+ on a folder), each session's own input, and archiving.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, expectSoon, endSuite, command, addFolder, hold, newDraft, workDir } from '../lib.mjs';
import { start, work, openBlank } from './_qa.mjs';

const IRO_DIR = process.env.IRO_DIR;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(IRO_DIR, f), 'utf8')); } catch { return null; } };
// Sessions remembered from before a daemon restart: 10 in one folder, of which the newest 8 are listed. (The
// folder sorts before the work folder.)
const REM = workDir('sidebar-rem', { '.claude/settings.local.json': JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }) }); // a draft here shows Accept edits
const WORK = work('sidebar-work'); // a draft here shows Plan
const NINE = '00000000-0000-4000-8000-000000000009';
fs.writeFileSync(path.join(IRO_DIR, 'recent.json'), JSON.stringify({
  [REM]: Array.from({ length: 10 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, title: `remembered ${i}`, t: Date.now() - (10 - i) * 60e3 })),
}));
const S = await start();
const { page, cmd } = S;
const REMF = `.folder[data-dir="${REM}"]`, FOLDER = `.folder[data-dir="${WORK}"]`;

{
  // your avatar's letter: the first letter of the host's git user.name (else the login name)
  let name = '';
  try { name = execFileSync('git', ['config', '--global', 'user.name']).toString().trim(); } catch {}
  name ||= os.userInfo().username;
  const me = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--me').trim());
  check(me === JSON.stringify([...name][0].toUpperCase()), `the avatar shows your initial (${me}, from "${name}")`);
}
check(await page.title() === 'IroWell at local', `the browser tab names the server (${await page.title()})`);

// ---- sessions remembered from before a restart ----
await addFolder(page, REM);
{
  const rows = await page.locator(`${REMF} .sess`).evaluateAll((rows) => rows.map((r) => [r.querySelector('.sess-title').textContent, r.classList.contains('detached')]));
  check(rows.length === 8 && rows.every(([, d]) => d) && rows.map(([t]) => t).join() === [9, 8, 7, 6, 5, 4, 3, 2].map((i) => `remembered ${i}`).join(),
    `a restarted daemon lists the folder's 8 most recent sessions, newest first, detached (${rows.map(([t]) => t.replace('remembered ', '')).join(' ')})`);
}
await page.locator('.sess', { hasText: 'remembered 9' }).click();
check(!(await page.locator('#input').isDisabled()) && (await page.locator('#closeSess').textContent()) === 'Reattach', 'a remembered session can be reattached (or just written to)');
check(/inset/.test(await page.locator('.sess.active .dot').evaluate((d) => getComputedStyle(d).boxShadow)), 'the open row marks its status dot with an inner ring (nothing drawn over it)');
{
  const bg = () => page.locator('.sess.active').evaluate((r) => getComputedStyle(r).backgroundColor);
  const before = await bg();
  await command(page, '/color purple');
  await expectSoon(async () => await bg() !== before && readJson('colors.json')?.[NINE] === 'purple', '/color works on a session remembered from before a restart, and is saved', 5000);
}
// so does a rename, with no process to tell: the row and recent.json take the name (then back, for the checks below)
for (const name of ['renamed nine', 'remembered 9']) {
  await command(page, `/rename ${name}`);
  await expectSoon(async () => {
    const saved = readJson('recent.json')?.[REM] || [];
    return await page.locator('.sess.active .sess-title').textContent() === name && await page.textContent('#title') === name
      && saved.find((x) => x.id === NINE)?.title === name && saved[0].id === NINE && (await page.locator('#closeSess').textContent()) === 'Reattach';
  }, `a session remembered from before a restart is renamed without reattaching it, and the name is saved (${name})`, 5000);
}
await page.fill('#input', '');
// once you leave it, the coloured detached row goes grey like any other detached row
await page.locator('.sess', { hasText: 'remembered 8' }).click();
{
  const sc = (t) => page.locator('.sess', { hasText: t }).evaluate((r) => getComputedStyle(r).getPropertyValue('--sc').trim());
  // (the list redraws after the click: wait for it rather than read a row mid-update)
  await expectSoon(async () => { const [purple, plain] = [await sc('remembered 9'), await sc('remembered 7')]; return !!plain && purple === plain; },
    'a coloured detached row is grey when not open, like the others', 5000);
}

// ---- a folder's rows ----
await openBlank(page, cmd, WORK);
check(await page.locator('.folder .folder-name', { hasText: 'sidebar-work' }).count() === 1, 'sessions are grouped under their directory');
check(await page.locator('.sess .waits .wait-user').count() >= 1 && await page.locator('.sess .waits .wait-agent').count() >= 1, 'each session shows user and agent waiting');
check(!(await page.locator('#list').textContent()).includes('safe to detach'), 'no "safe to detach" text');
// compact rows: the second line is symbols only (person / robot waits bottom left, ⚙n for background work bottom right), no status words
{
  const r = await page.locator('.sess').first().evaluate((row) => {
    const m = row.querySelector('.m'), w = row.querySelector('.waits').getBoundingClientRect(), t = row.querySelector('.t').getBoundingClientRect();
    return { text: m.textContent, icons: row.querySelectorAll('.waits svg').length, waitsInLine2: w.top >= t.bottom - 1, left: Math.abs(w.left - parseFloat(getComputedStyle(m).paddingLeft) - m.getBoundingClientRect().left) <= 1 };
  });
  check(/^\S+?(⚙︎\d+)?$/.test(r.text) && r.icons === 2 && !/busy|idle|detached|background/.test(r.text) && r.waitsInLine2 && r.left,
    `a row's second line is "⚙n" and the person / robot waits at the bottom left (${JSON.stringify(r.text)}, ${r.icons} icons)`);
  // the icons sit at the same place in every row, whatever the times read
  const xs = await page.evaluate(() => {
    const row = document.querySelector('.sess');
    const icons = () => [...row.querySelectorAll('.waits svg')].map((i) => Math.round(i.getBoundingClientRect().left));
    const a = icons();
    const ts = row.querySelectorAll('.wait-t');
    ts[0].textContent = '…'; ts[1].textContent = '120d';
    return [a, icons()];
  });
  check(JSON.stringify(xs[0]) === JSON.stringify(xs[1]), `the person / robot icons keep their place whatever the times read (${JSON.stringify(xs)})`);
}
await page.locator('.folder-head').first().click();
check(await page.locator('.folder.collapsed').count() === 1 && await page.locator('.folder.collapsed .sess').first().isHidden(), 'a folder collapses');
await page.locator('.folder-head').first().click();

// ---- drafts: + opens one that starts nothing until its first message, and has no sidebar row until then ----
await newDraft(page, WORK);
check(await page.locator('.draft-intro').isVisible() && await page.locator('.sess.active').count() === 0 && await page.locator(`${FOLDER} .sess`).count() === 1,
  '+ opens a draft session in the folder, with no row of its own until it starts');
check(!(await page.locator('#input').isDisabled()) && await page.locator('#closeSess').isDisabled(), 'the draft takes input; nothing to detach');
await expectSoon(async () => { const name = await page.locator('#modelBtn .mb-name').textContent(); return /^[A-Z][a-z]+ \d/.test(name) && name; },
  'a draft names the model it will run, not "Model"', 5000);
await expectSoon(async () => await page.inputValue('#mode') === 'plan', 'a draft shows the folder\'s permissions.defaultMode (plan)', 5000);
await page.click('#input');
await page.keyboard.press('Shift+Tab');
check(await page.inputValue('#mode') !== 'plan', '⇧Tab sets the draft\'s mode locally');
// a new session elsewhere does not inherit what another draft was changed to: it starts from its own defaults
await newDraft(page, REM);
await expectSoon(async () => await page.locator('.draft-intro').isVisible() && await page.inputValue('#mode') === 'acceptEdits',
  'a new draft starts in its folder\'s default mode, not the one picked in another draft (acceptEdits)', 5000);
await newDraft(page, WORK); // (the empty draft left behind is gone: open it again)
await page.fill('#input', 'half-written');
await page.locator(`${FOLDER} .sess`).first().click();
check(await page.locator('.draft-intro').count() === 0 && await page.inputValue('#input') === '', 'leaving a draft for a session');
{ // every session has its own input: another session's starts empty, and coming back finds yours again
  const remRow = page.locator(`${REMF} .sess`, { hasText: 'remembered 8' });
  await page.fill('#input', 'for the live one');
  await remRow.click();
  const other = await page.inputValue('#input');
  await page.fill('#input', 'for remembered 8');
  await page.locator(`${FOLDER} .sess`).first().click();
  const back = await page.inputValue('#input');
  await page.fill('#input', '');
  await remRow.click();
  const again = await page.inputValue('#input');
  await page.fill('#input', '');
  await page.locator(`${FOLDER} .sess`).first().click();
  check(other === '' && back === 'for the live one' && again === 'for remembered 8',
    `each session keeps its own input across switches (${JSON.stringify([other, back, again])})`);
}
await newDraft(page, WORK);
check(await page.inputValue('#input') === 'half-written', '+ on the folder again brings the draft back with its text');

// ---- right-click → Archive: the row goes, the next remembered one moves up, and a restart keeps it out ----
await page.locator(`${REMF} .sess`, { hasText: 'remembered 9' }).click({ button: 'right' });
await hold(page, page.locator('.ctx-item', { hasText: 'Archive' }));
{
  const titles = () => page.locator(`${REMF} .sess-title`).allTextContents();
  const t = await expectSoon(async () => { const t = await titles(); return t.length === 8 && !t.includes('remembered 9') && t.includes('remembered 1') && t; },
    'right-click archives a session: it leaves the sidebar, and the next one moves up', 10000);
  check(!Object.values(readJson('recent.json')).flat().some((x) => x.id === NINE) && readJson('archived.json')?.includes(NINE),
    `… and recent.json, into archived.json (${(t || []).map((x) => x.replace('remembered ', '')).join(' ')})`);
}
await page.fill('#input', '');
await page.locator(`${FOLDER} .sess`).first().click();
await newDraft(page, WORK);
check(await page.locator('.draft-intro').isVisible() && await page.inputValue('#input') === '', 'an empty draft goes away when you leave it');

await endSuite(S);
