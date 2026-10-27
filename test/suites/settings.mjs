// Settings: the defaults of a new session, the theme colour, the sampling interval; the UI skills and Output style
// pages; the folder's past sessions dialog, the folder picker, removing a folder, Detach. No model.
import fs from 'node:fs';
import path from 'node:path';
import { PORT, check, until, startClient, openPage, endSuite, addFolder, hold, outDir, routeCmd, workDir } from '../lib.mjs';
import { planFolder, editsFolder, skillsCopy, stylesHome, openSettings, answered, soon, drop400s, dropNotice } from './_qb.mjs';

const WORK = planFolder(), REM = editsFolder(); // (drafts in WORK start in Plan mode, in REM in Accept edits)
const SKILLS = skillsCopy();
const STYLES_HOME = stylesHome();
// (the folders registered before the page opens: one added in the moment the page connects can be lost to the
// page's own first look at the list, answered after it)
const { client, cmd: rpc } = await startClient(PORT);
for (const dir of [REM, WORK]) await rpc({ type: 'addFolder', path: dir });
const { browser, page, errors } = await openPage(PORT);
const FOLDER = `.folder[data-dir="${WORK}"]`, REMF = `.folder[data-dir="${REM}"]`;
const save = () => page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
const newDraft = async (folder) => { await page.locator(`${folder} .folder-head`).hover(); await page.click(`${folder} .folder-new`); };
const draftNow = async () => ({ mode: await page.inputValue('#mode'), effort: await page.inputValue('#effort'), model: await page.locator('#modelBtn .mb-name').textContent() });

// a blank session in WORK, open (and the page has the model list: a draft names the model it will run)
await rpc({ type: 'new', cwd: WORK, blank: true });
await page.locator(`${FOLDER} .sess`).first().click({ timeout: 10000 });
await page.waitForFunction(() => !document.getElementById('input').disabled, null, { timeout: 15000 });
const liveTitle = await page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);
await page.waitForFunction(() => !/^(Model|Default)?$/.test(document.querySelector('#modelBtn .mb-name')?.textContent || ''), null, { timeout: 10000 });

// ---- Settings: the defaults of a new session, the theme colour, and the usage sampling interval ----
await newDraft(FOLDER);
await page.waitForFunction(() => document.querySelector('#mode').value === 'plan', null, { timeout: 5000 });
{ // the model panel starts on the model the button names (it used to start on the first one while a draft had not chosen)
  const name = await page.locator('#modelBtn .mb-name').textContent();
  await page.click('#input');
  await page.keyboard.press('Alt+KeyM');
  await page.locator('.model-pop').waitFor({ timeout: 8000 });
  const marked = await page.locator('.model-pop .dd-item.hover .dd-label').first().textContent().catch(() => null);
  check(marked === name, `the model panel opens on the model the button shows (${marked} / ${name})`);
  await page.keyboard.press('Escape');
}
await openSettings(page);
const picker = (label) => page.locator(`.modal .set-row:has(.set-label:text-is("${label}")) select`);
const labels = await page.locator('.modal .set-row:has(select) .set-label').allTextContents();
check(labels.join() === 'Model,Effort,Permission mode,Theme colour,Sampling interval' && (await page.locator('.modal-title').textContent()) === 'Settings',
  `the Settings button below the usage card opens the panel: model, effort, mode, theme colour, sampling interval (${labels})`);
check((await picker('Permission mode').locator('option').evaluateAll((os) => os.map((o) => o.value))).includes('bypassPermissions'), 'Bypass permissions can be the default mode');
const modelOpts = await picker('Model').locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
const [wantModel, wantModelName] = modelOpts.at(-1);
await picker('Model').selectOption(wantModel);
await picker('Effort').selectOption('max');
await picker('Permission mode').selectOption('default');
await picker('Sampling interval').selectOption('60');
{ // the theme colour: the page's where a session has none of its own, kept on the server (each machine its own)
  const base = () => page.evaluate(() => ({ base: getComputedStyle(document.documentElement).getPropertyValue('--base-accent').trim(), side: getComputedStyle(document.querySelector('aside')).getPropertyValue('--accent').trim() }));
  const before = await base();
  await picker('Theme colour').selectOption('blue');
  await soon(async () => ({ ...(await base()), kept: (await rpc({ type: 'getSettings' })).data?.color }), (v) => v.base !== before.base && v.side === v.base && v.kept === 'blue',
    `a theme colour picked in Settings colours the page and the sidebar, and is kept on the server (from ${before.base})`);
  await rpc({ type: 'setSettings', color: 'url(x)' });
  check((await rpc({ type: 'getSettings' })).data?.color === 'blue', 'a theme colour that is not one is refused');
  await picker('Theme colour').selectOption('');
  await soon(async () => ({ ...(await base()), kept: (await rpc({ type: 'getSettings' })).data?.color }), (v) => v.base === before.base && v.kept === null, 'the built-in colour comes back');
  const groups = await page.locator('.settings h4').allTextContents();
  check(groups.join() === 'Local(local),Global' && await page.locator('.settings .set-note').count() === 0, `the settings are grouped by where they hold: this machine (named), or every server (${groups})`);
}
await soon(async () => (await rpc({ type: 'getSettings' })).data || {}, (st) => st.defaults?.model === wantModel && st.defaults?.effort === 'max' && st.defaults?.mode === 'default' && st.usageInterval === 60,
  'the defaults and the interval are kept on the server');
{
  const bad = await rpc({ type: 'setSettings', usageInterval: 7 });
  check(/must be one of/.test(bad.error || '') && (await rpc({ type: 'getSettings' })).data?.usageInterval === 60, `an interval the clock cannot keep is refused (${bad.error})`);
  await soon(draftNow, (d) => d.effort === 'max' && d.mode === 'default' && d.model === wantModelName, 'the open, untouched draft follows the new defaults');
}
await page.locator('.modal-head button').click();

{ // Settings → UI skills: a page over the session that edits skills/ (here a copy)
  const sk = (sel) => page.locator(`#skillsView ${sel}`);
  const mermaidFile = path.join(SKILLS, 'mermaid', 'SKILL.md');
  await openSettings(page, 'UI skills');
  await sk('.sk-item').first().waitFor({ timeout: 5000 });
  const names = await sk('.sk-item .sk-name').allTextContents();
  check(names[0] === 'system-prompt.md' && names.includes('mermaid') && names.includes('session-context') && await page.locator('.modal').count() === 0 && await page.locator('#content').isHidden(),
    `Settings → UI skills opens a page over the session (${names})`);
  check(/about \d+ tokens/.test(await sk('.sk-note').first().textContent()) && (await sk('.sk-area').inputValue()) === fs.readFileSync(path.join(SKILLS, 'system-prompt.md'), 'utf8'), 'it opens on the system prompt, with its size');
  check(await sk('.sk-server.ok').count() === 1, 'this machine runs these files');
  await sk('.sk-item:has-text("mermaid")').click();
  check((await sk('.sk-item:has-text("mermaid") .sk-tag').textContent()) === 'passive' && await sk('.sk-mode.on:has-text("Passive")').count() === 1, 'mermaid shows as passive');
  await sk('.sk-desc').fill('Use when: testing # the page.');
  await sk('.sk-mode:has-text("/ only")').click();
  check(await sk('.sk-item.dirty').count() === 1 && (await sk('.sk-state').textContent()) === 'Not saved', 'an edit is a draft, marked in the list');
  await save();
  await sk('.sk-item.dirty').waitFor({ state: 'detached', timeout: 5000 });
  const file = fs.readFileSync(mermaidFile, 'utf8');
  check(file.includes('description: "Use when: testing # the page."') && file.includes('disable-model-invocation: true') && !file.includes('user-invocable') && file.includes('# Mermaid diagrams in IroWell'),
    'Save (⌘S) writes the description and the mode into the frontmatter, and keeps the text');
  check((await sk('.sk-item:has-text("mermaid") .sk-tag').textContent()) === '/ only' && await sk('.sk-server.ok').count() === 1, 'the list follows, and this machine already runs the new file');
  await sk('.sk-tabs button:has-text("Preview")').click();
  check(await sk('.sk-preview h1').count() === 1, 'Preview renders the text');
  await sk('.sk-tabs button:has-text("Edit")').click();
  await sk('.sk-area').fill('changed in the page');
  fs.appendFileSync(mermaidFile, 'changed on disk\n');
  const reread = answered(page, 'uiSkills'); // (refused, the page reads the files again and draws them)
  await sk('.sk-foot .primary').click(); // refused: the notice says so (answered by answerDialogs, it shows in the log)
  await reread;
  check(await dropNotice(page, sk('.sk-area')), 'a press elsewhere puts the notice away at once (it would cover what comes next)');
  const now = fs.readFileSync(mermaidFile, 'utf8');
  check(now.includes('changed on disk') && !now.includes('changed in the page'), 'a file changed on disk since is not overwritten');
  check(await sk('.sk-item.dirty').count() === 1 && (await sk('.sk-area').inputValue()) === 'changed in the page', 'and the edit stays as a draft');
  await hold(page, sk('.sk-foot button:has-text("Revert")'));
  await soon(async () => ({ dirty: await sk('.sk-item.dirty').count(), text: await sk('.sk-area').inputValue() }), (v) => !v.dirty && v.text.includes('changed on disk'), 'Revert goes back to the file as it is now');
  await sk('.sk-add').click();
  await sk('.sk-new input').fill('show-files');
  await sk('.sk-new input').press('Enter');
  await sk('.sk-item.on:has-text("show-files")').waitFor({ timeout: 5000 });
  check(fs.existsSync(path.join(SKILLS, 'show-files', 'SKILL.md')) && (await sk('.sk-item.on .sk-tag').textContent()) === 'off', 'New skill creates skills/<name>/SKILL.md, off until it is ready');
  await sk('.sk-item:has-text("session-context")').click();
  await sk('.sk-files button:has-text("sessions.mjs")').click();
  await page.locator('.modal .sk-file').waitFor({ timeout: 3000 });
  check((await page.locator('.modal-title').textContent()) === 'skills/session-context/sessions.mjs' && await page.locator('.modal .sk-file .hljs-keyword').count() > 0, 'a file beside the skill opens to look at');
  await page.locator('.modal-head button').click();
  await sk('.usage-bar > button').click();
  check(await page.locator('#skillsView').isHidden() && await page.locator('#content').isVisible(), 'Back returns to the session');
  // a client started before the page existed answers 400: the page says to restart it
  const unroute = await routeCmd(page, 'uiSkills', (route) => route.fulfill({ status: 400, body: '' }));
  await openSettings(page, 'UI skills');
  await sk('.sk-error').waitFor({ timeout: 5000 });
  check(/restart it \(client\.mjs\)/.test(await sk('.sk-error').textContent()) && await page.locator('.dlg, .toast.note', { hasText: /\b400\b|Command failed/ }).count() === 0, 'an older client: the page says to restart it, no bare 400');
  await unroute();
  drop400s(errors);
  await sk('.usage-bar > button').click();
}

{ // Settings → Output style: Claude Code's output styles (here STYLES_HOME stands for ~/.claude), to pick, and the user's own to make, edit and delete
  const st = (sel) => page.locator(`#stylesView ${sel}`);
  const dir = path.join(STYLES_HOME, 'output-styles');
  const settingsNow = () => JSON.parse(fs.readFileSync(path.join(STYLES_HOME, 'settings.json'), 'utf8'));
  const state = () => st('.sk-state').textContent();
  await openSettings(page, 'Output style');
  await st('.sk-item').first().waitFor({ timeout: 5000 });
  const names = await st('.sk-item .sk-name').allTextContents();
  check(names.join() === 'Default,Explanatory,Learning,Mine' && await page.locator('.modal').count() === 0 && await page.locator('#content').isHidden(),
    `Settings → Output style opens a page with the built-in styles and the user's own (${names.join(', ')})`);
  check((await st('.sk-item.on .sk-name').textContent()) === 'Default' && (await st('.sk-item.on .sk-tag').textContent()) === 'in use' && await st('.sk-tag').count() === 1 && await st('.sk-foot button:has-text("In use")').isDisabled(),
    'with none set, Default is in use and shown first');
  await st('.sk-item:has-text("Explanatory")').click();
  check(await st('.sk-area').count() === 0 && await st('.sk-foot button:has-text("Use this style")').isEnabled() && await st('.sk-foot button:has-text("Delete")').count() === 0, 'a built-in style can be picked, not edited');
  await st('.sk-item:has-text("Mine")').click();
  check((await st('.sk-desc').inputValue()) === 'A style of my own' && (await st('.sk-area').inputValue()).trim() === 'Answer in haiku.' && !await st('.hall input').isChecked(),
    'a style of the user\'s shows its description, its text, and keep-coding-instructions (off when not set)');
  await st('.sk-add').click();
  await st('.sk-new input').fill('Quick Style');
  await st('.sk-new input').press('Enter');
  await st('.sk-item.on:has-text("Quick Style")').waitFor({ timeout: 5000 });
  const made = path.join(dir, 'Quick Style.md');
  check(fs.existsSync(made) && /^name: "Quick Style"$/m.test(fs.readFileSync(made, 'utf8')) && await st('.hall input').isChecked(), 'New style makes a file of that name, empty, keeping the coding instructions');
  await st('.sk-desc').fill('For the quick suite');
  await st('.sk-area').fill('QUICK-STYLE-TEXT: answer in one line.');
  await st('.hall input').uncheck();
  check((await state()) === 'Not saved' && await st('.sk-item.dirty').count() === 1 && !fs.readFileSync(made, 'utf8').includes('QUICK-STYLE-TEXT'), 'an edit is a draft until it is saved');
  await st('.usage-bar > button').click();
  check(await page.locator('#stylesView').isHidden() && await page.locator('#content').isVisible(), 'Back returns to the session');
  await openSettings(page, 'Output style');
  await st('.sk-area').waitFor({ timeout: 5000 });
  check((await st('.sk-area').inputValue()) === 'QUICK-STYLE-TEXT: answer in one line.' && (await state()) === 'Not saved', 'and the draft is still there when the page is opened again');
  await save();
  await page.waitForFunction(() => /^Saved/.test(document.querySelector('#stylesView .sk-state')?.textContent || ''), null, { timeout: 5000 });
  let text = fs.readFileSync(made, 'utf8');
  check(text.includes('description: "For the quick suite"') && text.includes('keep-coding-instructions: false') && text.endsWith('---\n\nQUICK-STYLE-TEXT: answer in one line.\n'), 'Save (⌘S) writes the front matter and the text');
  await st('.sk-foot button:has-text("Use this style")').click();
  await soon(async () => ({ style: settingsNow().outputStyle, model: settingsNow().model, tags: await st('.sk-tag').allTextContents(), inUse: await st('.sk-foot button:has-text("In use")').isDisabled({ timeout: 500 }) }),
    (v) => v.style === 'Quick Style' && v.model === 'opus' && v.tags.length === 1 && v.inUse,
    'Use this style sets outputStyle in settings.json (the rest of it kept), and the list follows');
  // (the file changed on disk meanwhile, by the terminal or an editor: not written over)
  await st('.sk-area').fill('changed in the page');
  fs.appendFileSync(made, 'changed on disk\n');
  const reread = answered(page, 'outputStyles'); // (refused, the page reads the styles again and draws them)
  await st('.sk-foot .primary').click(); // refused: the notice says so (answered by answerDialogs)
  await reread;
  await dropNotice(page, st('.sk-area'));
  text = fs.readFileSync(made, 'utf8');
  check(text.includes('changed on disk') && !text.includes('changed in the page') && (await st('.sk-area').inputValue()) === 'changed in the page', 'a style changed on disk since is not written over, and the edit stays as a draft');
  await hold(page, st('.sk-foot button:has-text("Revert")'));
  await soon(async () => ({ dirty: await st('.sk-item.dirty').count(), text: await st('.sk-area').inputValue() }), (v) => !v.dirty && v.text.includes('changed on disk'), 'Revert goes back to the file as it is now');
  await hold(page, st('.sk-foot button:has-text("Delete")'));
  await st('.sk-item.on:has-text("Default")').waitFor({ timeout: 5000 });
  check(!fs.existsSync(made) && !('outputStyle' in settingsNow()) && (await st('.sk-item.on .sk-tag').textContent()) === 'in use', 'Delete (held) removes the file; it was in use, so Default is again');
  await st('.sk-item:has-text("Mine")').click();
  await st('.sk-foot button:has-text("Use this style")').click();
  await soon(() => settingsNow().outputStyle, (v) => v === 'Mine' && fs.readFileSync(path.join(dir, 'mine.md'), 'utf8').includes('color: blue'), 'a style of the user\'s, untouched, is picked as it is');
  await st('.sk-item:has-text("Default")').click();
  await st('.sk-foot button:has-text("Use this style")').click();
  await soon(() => 'outputStyle' in settingsNow(), (v) => !v, 'Default again: outputStyle is taken out of settings.json');
  await st('.usage-bar > button').click();
  // a server from before the page answers 400 through the client: the page says to update it
  const unroute = await routeCmd(page, 'outputStyles', (route) => route.fulfill({ status: 400, body: '' }));
  await openSettings(page, 'Output style');
  await st('.sk-error').waitFor({ timeout: 5000 });
  check(/update it \(Update server\)/.test(await st('.sk-error').textContent()) && await page.locator('.dlg, .toast.note', { hasText: /\b400\b|Command failed/ }).count() === 0, 'an older server: the page says to update it, no bare 400');
  await unroute();
  drop400s(errors);
  await st('.usage-bar > button').click();
}

// a draft opened later starts with the defaults from Settings too, over its folder's own mode
await newDraft(REMF);
await soon(draftNow, (d) => d.mode === 'default' && d.effort === 'max' && d.model === wantModelName, 'a new draft starts with the defaults from Settings, over its folder\'s own mode');
await rpc({ type: 'setSettings', defaults: { model: null, effort: null, mode: null }, usageInterval: 30 });

// ---- the folder's past sessions; its filter and checkbox wear the theme, not the browser's blue focus ring and stock checkbox ----
await page.locator(`${FOLDER} .sess`).first().click();
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-btn[title^="Past"]`);
check((await page.locator('.modal-title').textContent()).startsWith('Past sessions · '), 'the folder\'s history button opens its past sessions');
const hLook = await page.evaluate(() => {
  const f = document.querySelector('.hfilter'), c = document.querySelector('.hall input'), cs = getComputedStyle(f);
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
  const probe = document.body.appendChild(Object.assign(document.createElement('i'), { style: `color:${accent}` }));
  const accentRgb = getComputedStyle(probe).color; probe.remove();
  return { focused: document.activeElement === f, outline: cs.outlineStyle, border: cs.borderTopColor, accentRgb, box: getComputedStyle(c).appearance };
});
check(hLook.focused && hLook.outline === 'none' && hLook.border === hLook.accentRgb && hLook.box === 'none', `no browser blue: the history filter's focus and its checkbox follow the theme (${JSON.stringify(hLook)})`);
await page.keyboard.press('Escape');

// ---- the folder picker: walk the server's directories by clicking ----
const OTHER = workDir('settings-other', { 'inner/.keep': '' });
const OTHERF = `.folder[data-dir="${OTHER}"]`;
const removeFolder = async () => {
  await page.locator(`${OTHERF} .folder-head`).click({ button: 'right' });
  await hold(page, page.locator('.ctx-item', { hasText: 'Remove from sidebar' }));
  await page.locator(OTHERF).waitFor({ state: 'detached', timeout: 5000 });
};
await page.click('#addFolder');
await page.fill('.fp-input', fs.realpathSync(outDir()) + '/');
await page.locator('.fp-row', { hasText: 'settings-other/' }).click();
await page.locator('.fp-row', { hasText: 'inner/' }).waitFor({ timeout: 5000 });
check(await page.inputValue('.fp-input') === OTHER + '/' && await page.locator('.fp-row.fp-add').count() === 1, 'clicking a folder opens it in the picker');
await page.press('.fp-input', 'Enter');
await page.locator(OTHERF).waitFor({ timeout: 5000 });
check(await page.locator(`${OTHERF} .folder-empty`).count() === 1, 'Enter adds it; an empty folder is listed');
await removeFolder();
check(await page.locator(OTHERF).count() === 0, 'right-click removes a folder');
// removing a folder detaches its live sessions (nothing runs where the sidebar can't show it); adding it back lists them, detached
{
  const hid = (await rpc({ type: 'new', cwd: OTHER, blank: true })).data?.sid;
  await page.locator(`${OTHERF} .sess`).waitFor({ timeout: 10000 });
  check(await page.locator(`${OTHERF} .sess`).count() === 1, 'a session started in a removed folder lists the folder again');
  await page.locator(`${OTHERF} .sess`).click();
  await page.waitForFunction(() => !document.getElementById('input').disabled, null, { timeout: 15000 });
  check(/st-idle/.test(await page.locator('.sess.active .dot').getAttribute('class')), 'it runs there');
  await removeFolder();
  check(await page.locator('.sess.active').count() === 0, 'its sessions are hidden with it');
  check(await until(async () => /not running/.test((await rpc({ type: 'context', sid: hid })).error || ''), 10000), 'and detached: its Claude process is not left running out of sight');
  await addFolder(page, OTHER);
  await soon(() => page.locator(`${OTHERF} .sess .dot`).getAttribute('class', { timeout: 1000 }), (c) => /st-detached/.test(c), 'adding the folder back shows them again, detached');
}

// folders are sorted by path and stay put when a session in another one is opened
await page.locator(`${FOLDER} .sess`, { hasText: liveTitle || '' }).first().click();
const folderOrder = () => page.locator('.folder').evaluateAll((fs) => fs.map((f) => f.dataset.dir).join());
const order1 = await folderOrder();
await page.locator('.folder').last().locator('.sess').first().click();
const order2 = await folderOrder();
check(order1.split(',').length >= 2 && order1 === order1.split(',').sort().join() && order1 === order2,
  `folders are sorted by path and stay put when a session in another one is opened (${order1.split(',').map((d) => d.split('/').pop()).join(', ')})`);

// Detach
await page.locator(`${FOLDER} .sess`, { hasText: liveTitle || '' }).first().click();
await hold(page, '#closeSess');
await soon(() => page.locator('.sess.active .dot').getAttribute('class', { timeout: 1000 }), (c) => /st-detached/.test(c), 'Detach turns the session grey');

await endSuite({ browser, client, errors });
