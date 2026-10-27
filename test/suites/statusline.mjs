// The status line under the composer and the header above the feed: what they show (mode, model and effort,
// folder and branch, tokens, cost, context, plan limits, session id, title), the model/effort panel (button and
// ⌥M), the mode picker and ⇧Tab, menus closing on a click outside, and copying the session id.
import { execSync } from 'node:child_process';
import { PORT, startSuite, startSession, check, until, expectSoon, waitResults, eventStream, workDir, endSuite } from '../lib.mjs';

const WORK = workDir('statusline');
execSync('git init -q -b feature-x && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: WORK });
const suite = await startSuite(PORT, { clipboard: true });
const { page, token } = suite;
const T = eventStream(PORT, token);
// The daemon confirming a mode change, for the `n`th time (the conversation has no line for it).
const modeSet = (mode, n = 1) => until(() => T.events.filter((e) => e.kind === 'meta' && e.mode === mode).length >= n, 10000, `the daemon setting mode ${mode}`);
const txt = async (id) => ((await page.locator('#' + id).textContent()) || '').trim();
const tip = async (id) => (await page.locator('#' + id).getAttribute('title')) || '';
const effortIs = (v) => page.waitForFunction((v) => document.getElementById('effort').title === 'Effort: ' + v, v, { timeout: 10000 }).then(() => true, () => false);

await startSession(page, WORK, 'Remember the codeword PELICAN. Reply with just: ok', { mode: 'default' });
check(await waitResults(page, 1, { timeout: 30000 }), 'first turn');
await expectSoon(async () => /\d%/.test(await txt('sb-5h')) && /\d%/.test(await txt('sb-7d')) && !(await page.locator('#sb-ctx').isHidden()), 'the plan limits and the context meter come in');

// ---- the layout: one settings line under the composer, the folder and session id under the title ----
check(await page.locator('#statusbar').isVisible(), 'the status line is shown');
const rows = await page.evaluate(() => [...document.querySelectorAll('#statusbar .sb-row')].map((r) => [...r.children].filter((c) => !c.classList.contains('dd-native'))
  .map((c) => c.id || (c.classList.contains('sess-slot') && c.firstElementChild.id) || c.className.split(' ')[0])));
check(rows.length === 1 && rows[0][0] === 'modelBtn' && rows[0][1] === 'dd-btn' && rows[0].includes('sb-ctx') && rows[0].at(-2) === 'stop' && rows[0].at(-1) === 'closeSess',
  `one settings line: model, mode, context … Stop, Detach (${rows})`);
check(await page.locator('header #stop, header #closeSess').count() === 0 && await page.locator('.input-wrap #send').count() === 1, 'Send sits in the pill, Stop and Detach on the line under it');
check(await page.locator('header .head-sub #sb-sid').count() === 1 && await page.locator('#statusbar #sb-sid').count() === 0 && await page.locator('header #sb-dir').isVisible(),
  'the folder and session id sit under the title');
check(await page.evaluate(() => [...document.querySelectorAll('#statusbar select')].every((s) => getComputedStyle(s).opacity === '0' || !s.offsetParent)), 'the native selects are hidden');
check(await page.locator('#statusbar .dd-btn').count() === 2, 'two pickers: mode, and model with effort');
check(await page.locator('#statusbar .dd-modepick .mode-dot').count() === 1, 'the mode picker shows a coloured dot');
check(await page.locator('#modelBtn .bars > span').count() === 5 && /Sonnet|Opus/.test(await page.locator('#modelBtn').textContent()), 'one button shows the model and the effort');

// ---- what it shows ----
check(await page.inputValue('#mode') === 'default', `the mode (${await page.inputValue('#mode')})`);
check((await txt('sb-dir')).includes('statusline') && (await txt('sb-dir')).includes('feature-x'), `the folder and its git branch (${await txt('sb-dir')})`);
check(/↑\S+ ↓\S+/.test(await txt('sb-tokens')), `tokens (${await txt('sb-tokens')})`);
check(/^\$\d/.test(await txt('sb-cost')), `cost (${await txt('sb-cost')})`);
check(/\d[\d.]*[kM]? \/ \d[\d.]*[kM]?/.test(await txt('sb-ctx')), `the context meter: used / window beside its bar (${await txt('sb-ctx')})`);
check(/5-hour window12%/.test(await txt('sb-5h')) && /resets in \d\dh\d\dm/.test(await tip('sb-5h')), `the 5-hour limit in the usage card, its countdown on hover (${await txt('sb-5h')} / ${await tip('sb-5h')})`);
check(/Weekly34%/.test(await txt('sb-7d')) && /resets in \d\dd\d\dh/.test(await tip('sb-7d')), `the weekly limit in the usage card, its countdown on hover (${await txt('sb-7d')} / ${await tip('sb-7d')})`);
{
  const sep = await page.evaluate(() => { const e = document.getElementById('sb-sid'), r = e.getBoundingClientRect(), prev = document.getElementById('sb-time').getBoundingClientRect(); const b = getComputedStyle(e, '::before'); return { content: b.content, abs: b.position === 'absolute', gap: r.left - prev.right }; });
  check(sep.content === '"·"' && sep.abs && sep.gap > 12, `the separator before the session id sits outside its hover box (${JSON.stringify(sep)})`);
}
check(/^[0-9a-f]{8}$/.test(await txt('sb-sid')), `the session id, its first 8 characters (${await txt('sb-sid')})`);
check((await txt('title')).includes('codeword'), `the session's name in the header (${await txt('title')})`);

// ---- the model button opens the panel ⌥M opens: → raises the effort, Enter applies ----
const effBefore = await page.inputValue('#effort');
await page.locator('#modelBtn').click();
await page.locator('.model-pop').waitFor({ timeout: 3000 });
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Enter');
const effAfter = await page.inputValue('#effort');
check(effAfter !== effBefore && await effortIs(effAfter), `button → panel → → raises the effort, confirmed by the CLI (${effBefore} → ${effAfter})`);

// ⌥M toggles it: open, then ⌥M again closes it, applying the change (←); Esc closes it too
await page.click('#input');
await page.keyboard.press('Alt+KeyM');
await page.locator('.model-pop').waitFor({ timeout: 3000 });
check(await page.locator('.model-pop .dd-item').count() >= 2 && await page.locator('.model-pop input[type=range]').count() === 1, '⌥M opens the models and the effort');
const labels = await page.locator('.model-pop .dd-label').allTextContents();
const on = await page.locator('.model-pop .dd-item.hover .dd-label').textContent().catch(() => '');
check(!labels.some((l) => /^keep\b|default/i.test(l)) && new Set(labels).size === labels.length, `no "Keep current" or "Default" entries, no duplicates (${labels})`);
check(!!on && (await page.locator('#modelBtn .mb-name').textContent()) === on, `the panel starts on the model in use (${on})`);
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('Alt+KeyM');
check(await page.locator('.model-pop').count() === 0, '⌥M again closes the panel');
check(await effortIs(effBefore), '… and applies the change');
await page.keyboard.press('Alt+KeyM');
await page.locator('.model-pop').waitFor({ timeout: 3000 });
await page.keyboard.press('Escape');
check(await page.locator('.model-pop').count() === 0, 'Esc closes it too');

// ---- the mode: ⇧Tab cycles it, the picker's menu sets it ----
await page.click('#input');
await page.keyboard.press('Shift+Tab');
await modeSet('acceptEdits');
check(await page.inputValue('#mode') === 'acceptEdits', '⇧Tab: Ask before edits → Accept edits');
check(await page.locator('.toast').waitFor({ timeout: 5000 }).then(() => true, () => false) && await page.locator('.toast').count() === 1, '⇧Tab shows a toast');
await page.keyboard.press('Shift+Tab');
await modeSet('plan');
check(await page.inputValue('#mode') === 'plan', '⇧Tab again: → Plan mode');
check(await page.evaluate(() => document.activeElement.id) === 'input', 'the focus stays in the input');
await page.locator('#statusbar .dd-modepick').click();
await page.locator('.dd-menu .dd-item', { hasText: 'Accept edits' }).click();
await modeSet('acceptEdits', 2);
check(await page.inputValue('#mode') === 'acceptEdits', 'the mode menu picks Accept edits');
await page.locator('#statusbar .dd-modepick').click();
await page.locator('.dd-menu').waitFor({ timeout: 3000 });
await page.mouse.click(1300, 400);
check(await page.locator('.dd-menu').count() === 0, 'clicking outside closes the menu');

// ---- copying the session id ----
await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 10000 }).catch(() => {}); // (⇧Tab's)
await page.locator('#sb-sid').click();
check(await page.locator('.toast', { hasText: 'Session ID copied' }).waitFor({ timeout: 3000 }).then(() => true, () => false), 'copying the session id shows a toast');
const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
check(/^[0-9a-f-]{36}$/.test(clip) && clip.startsWith(await txt('sb-sid')), `the whole id is on the clipboard (${clip})`);
await expectSoon(async () => await page.locator('.toast').count() === 0, 'the toast fades away', 5000);

await endSuite(suite);
