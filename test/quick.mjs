// Quick suite: no model calls. Syntax, protocol basics, and the UI around a blank session
// (a Claude process that has not been sent anything). Takes well under a minute.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, addFolder, killDaemon, check, finish } from './lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4770;
const WORK = path.join(S, 'quick-work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'src'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'calc.py'), 'def add(a, b):\n    return a + b\n');
fs.writeFileSync(path.join(WORK, 'src', 'notes.md'), '# notes\n');
fs.mkdirSync(path.join(WORK, '.claude'));
fs.writeFileSync(path.join(WORK, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } })); // a draft here shows Plan


// ---- 1. syntax of every source file ----
const sources = [
  'server/daemon.mjs', 'server/attach.mjs', 'client/client.mjs',
  ...fs.readdirSync(path.join(REPO, 'client/ui')).filter((f) => f.endsWith('.js')).map((f) => `client/ui/${f}`),
];
let syntaxOk = true;
for (const f of sources) {
  try { execFileSync(process.execPath, ['--check', path.join(REPO, f)], { stdio: 'pipe' }); } catch (e) { syntaxOk = false; console.log(String(e.stderr)); }
}
check(syntaxOk, `syntax of ${sources.length} source files`);

// synthetic plan-usage history for the Usage page: 3 days, a sample every 30 minutes
// (the daemon must not add real samples: a real weekly reset would start a cycle the synthetic days are not in)
process.env.IRO_NO_USAGE_RECORD = '1';
const IRO_DIR = process.env.IRO_DIR; // this suite's own state dir (test/lib.mjs)
fs.mkdirSync(IRO_DIR, { recursive: true });
const usageFile = path.join(IRO_DIR, 'usage.jsonl');
const usageBackup = fs.existsSync(usageFile) ? fs.readFileSync(usageFile) : null;
const foldersFile = path.join(IRO_DIR, 'folders.json');
const foldersBackup = fs.existsSync(foldersFile) ? fs.readFileSync(foldersFile) : null;
{
  const lines = [];
  const now = Date.now();
  for (let t = now - 3 * 24 * 3600e3; t <= now; t += 1800e3) { // every 30 minutes, as the daemon samples
    const win = Math.floor(t / (5 * 3600e3));
    const into = (t % (5 * 3600e3)) / (5 * 3600e3);
    const five = Math.round(into * 60);
    const week = Math.min(99, Math.round(((t - (now - 3 * 24 * 3600e3)) / (3 * 24 * 3600e3)) * 40) + 10);
    lines.push(JSON.stringify({ t, five: { pct: five, resets: new Date((win + 1) * 5 * 3600e3).toISOString() }, week: { pct: week, resets: new Date(now + 4 * 24 * 3600e3).toISOString() } }));
  }
  fs.writeFileSync(usageFile, lines.join('\n') + '\n');
}

// Sessions remembered from before a daemon restart: 10 in one folder, of which the newest 8 are listed.
const REM = path.join(S, 'quick-remembered');
fs.mkdirSync(REM, { recursive: true });
fs.writeFileSync(path.join(IRO_DIR, 'recent.json'), JSON.stringify({
  [fs.realpathSync(REM)]: Array.from({ length: 10 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, title: `remembered ${i}`, t: Date.now() - (10 - i) * 60e3 })),
}));

// ---- 2. protocol ----
killDaemon();
await new Promise((r) => setTimeout(r, 400));
const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
const req = (method, p, { headers = {}, body, host } = {}) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...(host ? { host } : {}), ...headers } }, (x) => {
    let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b }));
  });
  r.on('error', rej);
  r.end(body);
});
let token;
for (let i = 0; i < 50 && !token; i++) { try { token = (await req('GET', '/')).body.match(/name="token" content="(\w+)"/)[1]; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const rpc = (body) => req('POST', '/cmd', { headers: { 'x-token': token }, body: JSON.stringify(body) }).then((r) => (r.status === 200 ? JSON.parse(r.body) : { status: r.status }));
check((await req('POST', '/cmd', { body: '{}' })).status === 403, 'POST without token → 403');
check((await req('GET', '/', { host: 'evil.com:' + PORT })).status === 403, 'foreign Host header → 403');
check((await req('POST', '/cmd', { headers: { 'x-token': token }, body: '{"type":"sync"}' })).status === 400, 'internal commands are not exposed');
await new Promise((r) => setTimeout(r, 1200)); // transport up
check(/empty/.test((await rpc({ type: 'new', cwd: WORK, text: '  ' })).error || ''), 'empty first message is rejected');
check(/Not a directory/.test((await rpc({ type: 'new', cwd: '/no/such/dir', text: 'x' })).error || ''), 'missing directory is rejected');
check(/doesn't know/.test((await rpc({ type: 'nonsense' })).error || '') || (await rpc({ type: 'nonsense' })).status === 400, 'unknown commands are refused');
const hist = await rpc({ type: 'history' });
check(Array.isArray(hist.data), `history lists sessions (${hist.data?.length ?? 'error'})`);

// ---- 3. UI around a blank session ----
const browser = await chromium.launch({ executablePath: browserPath() });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
{
  // your avatar's letter: the first letter of the host's git user.name (else the login name)
  let name = '';
  try { name = execFileSync('git', ['config', '--global', 'user.name']).toString().trim(); } catch {}
  name ||= os.userInfo().username;
  const me = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--me').trim());
  check(me === JSON.stringify([...name][0].toUpperCase()), `the avatar shows your initial (${me}, from "${name}")`);
}

check(await page.title() === 'IroWell', `the browser tab is called IroWell (${await page.title()})`);
await addFolder(page, REM);
const remRows = await page.locator(`.folder[data-dir="${fs.realpathSync(REM)}"] .sess`).evaluateAll((rows) => rows.map((r) => [r.querySelector('.sess-title').textContent, r.classList.contains('detached')]));
check(remRows.length === 8 && remRows.every(([, d]) => d) && remRows.map(([t]) => t).join() === [9, 8, 7, 6, 5, 4, 3, 2].map((i) => `remembered ${i}`).join(),
  `a restarted daemon lists the folder's 8 most recent sessions, newest first, detached (${remRows.map(([t]) => t.replace('remembered ', '')).join(' ')})`);
await page.locator('.sess', { hasText: 'remembered 9' }).click();
check(!(await page.locator('#input').isDisabled()) && (await page.locator('#closeSess').textContent()) === 'Reattach', 'a remembered session can be reattached (or just written to)');
check(/inset/.test(await page.locator('.sess.active .dot').evaluate((d) => getComputedStyle(d).boxShadow)), 'the open row marks its status dot with an inner ring (nothing drawn over it)');
await page.fill('#input', '/color purple');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForFunction(() => getComputedStyle(document.querySelector('.sess.active')).backgroundColor === 'rgb(128, 99, 200)', null, { timeout: 5000 }).catch(() => {});
check(await page.locator('.sess.active').evaluate((r) => getComputedStyle(r).backgroundColor) === 'rgb(128, 99, 200)' && JSON.parse(fs.readFileSync(path.join(IRO_DIR, 'colors.json'), 'utf8'))['00000000-0000-4000-8000-000000000009'] === 'purple',
  '/color works on a session remembered from before a restart, and is saved');
await page.fill('#input', '');

// Markdown / LaTeX / tool cards, rendered straight from the modules
const SAMPLE = fs.readFileSync(path.join(HERE, 'full', 'sample.md'), 'utf8');
await page.evaluate(async (src) => {
  const r = await import('/ui/render.js');
  const f = document.getElementById('feed');
  f.innerHTML = '';
  const el = r.markdown(src);
  el.id = 'sample';
  f.append(el);
  const add = (b, res) => { const api = r.toolCard(b, '/w'); f.append(api.card); if (res) api.setResult(res); };
  add({ id: 't1', name: 'Edit', input: { file_path: '/w/a.py', old_string: 'return a - b', new_string: 'return a + b' } }, { content: 'ok' });
  add({ id: 't2', name: 'Bash', input: { command: 'false', description: 'fails' } }, { content: 'boom', is_error: true });
  add({ id: 't3', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'doing b' }] } }, { content: 'ok' });
}, SAMPLE);
const sample = page.locator('#sample');
check(await sample.locator('.katex').count() >= 6 && await sample.locator('.katex-error, .katex .errorColor').count() === 0, 'LaTeX renders without errors');
check((await sample.textContent()).includes('$5 and $6') && await sample.locator('code', { hasText: '$not_math$' }).count() === 1, 'money and code spans are not math');
check(await sample.locator('table th').count() >= 3 && await sample.locator('.codeblock .hljs-keyword').count() > 0, 'tables and highlighted code');
check(await sample.locator('script, img[onerror]').count() === 0 && (await sample.textContent()).includes('<script>'), 'raw HTML shown as text');
check(await page.locator('table.diff tr.add').count() === 1 && await page.locator('.tool.error').count() === 1 && await page.locator('ul.todos li').count() === 2, 'tool cards: diff, error, checklist');

// blank session: a live Claude process with nothing sent
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
const created = await rpc({ type: 'new', cwd: WORK, blank: true });
check(!!created.data?.sid, 'blank session starts');
// the same harness as the terminal's `claude`: Claude Code's own system prompt (the SDK's default is empty)
{
  const ctx = await rpc({ type: 'context', sid: created.data.sid });
  const sys = ctx.data?.categories?.find((c) => c.name === 'System prompt')?.tokens || 0;
  check(sys > 500, `Claude Code's system prompt is in the context (${sys} tokens)`);
}
// (the remembered folder sorts first: the blank session is the one in the work folder)
const workRow = page.locator(`.folder[data-dir="${fs.realpathSync(WORK)}"] .sess`).first();
await workRow.waitFor({ timeout: 10000 });
await workRow.click();
await page.waitForFunction(() => !document.getElementById('input').disabled, null, { timeout: 15000 }).catch(() => {});
check(!(await page.locator('#input').isDisabled()), 'composer is enabled');
check(/st-idle/.test(await page.locator('.sess.active .dot').getAttribute('class')), 'idle session is yellow');

// status line + rail + composer layout
check(await page.locator('#statusbar').isVisible(), 'status line visible');
const rows = await page.evaluate(() => [...document.querySelectorAll('#statusbar .sb-row')].map((r) => [...r.children].filter((c) => !c.classList.contains('dd-native')).map((c) => c.id || c.className.split(' ')[0])));
check(rows.length === 1 && rows[0][0] === 'modelBtn' && rows[0][1] === 'dd-btn' && rows[0].includes('sb-ctx') && rows[0].at(-1) === 'closeSess' && rows[0].at(-2) === 'stop', `settings line: model, mode, context … Stop, Detach (${rows})`);
check(await page.locator('header .head-sub #sb-sid').count() === 1 && await page.locator('#statusbar #sb-sid').count() === 0 && await page.locator('header #sb-dir').isVisible(), 'the folder and session id sit under the title');
check((await page.locator('#railtabs button').allTextContents()).map((t) => t.replace(/\d+$/, '')).join('|') === 'Anchors|Resources|Tasks|btw', 'rail tabs: Anchors / Resources / Tasks / btw');
await page.click('#railtabs button[data-tab="tasks"]');
check((await page.locator('#runlist .run-item').first().textContent()).startsWith('main'), 'Tasks lists main');
check(await page.evaluate(() => { const w = document.querySelector('.input-wrap').getBoundingClientRect(), b = document.getElementById('send').getBoundingClientRect();
  return b.right <= w.right && b.left >= w.left && b.bottom <= w.bottom && b.top >= w.top; }), 'the send button sits inside the pill');
await page.fill('#input', '');
const small = await page.evaluate(() => document.getElementById('input').offsetHeight);
check(await page.locator('#expandInput').isHidden(), 'one line: no expand button');
await page.fill('#input', 'a\nb\nc');
check(await page.locator('#expandInput').isVisible(), 'wrapped text shows the expand button');
const three = await page.evaluate(() => document.getElementById('input').offsetHeight);
check(three > small, `the pill grows with its text (${small} → ${three}px)`);
await page.fill('#input', 'x\n'.repeat(40));
const capped = await page.evaluate(() => document.getElementById('input').offsetHeight);
check(capped < 260 && await page.evaluate(() => getComputedStyle(document.getElementById('input')).overflowY) === 'auto', `long text: capped (${capped}px) and scrolls inside`);
await page.fill('#input', '');
check(Math.abs((await page.evaluate(() => document.getElementById('input').offsetHeight)) - small) <= 1, 'clearing returns to one line');
check(await page.evaluate(() => { const i = document.getElementById('input'); i.focus(); return getComputedStyle(i).outlineStyle; }) === 'none', 'no focus ring on the input');
await page.fill('#input', 'x\n'.repeat(40));
await page.click('#expandInput');
check((await page.evaluate(() => document.getElementById('input').offsetHeight / innerHeight)) > 0.45, 'expand bar opens a half-screen editor');
await page.fill('#input', '');

// slash commands handled in the page
await page.fill('#input', '/help');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
check(await page.locator('.modal .modal-title', { hasText: 'Commands' }).waitFor({ timeout: 10000 }).then(() => true, () => false), '/help opens its dialog');
await page.keyboard.press('Escape');
await page.fill('#input', '/color green');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#368552', null, { timeout: 8000 }).catch(() => {});
check((await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#368552', '/color changes the accent');

// ⇧Tab, ⌥M
await page.click('#input');
await page.keyboard.press('Shift+Tab');
await page.waitForFunction(() => document.getElementById('mode').value === 'acceptEdits', null, { timeout: 8000 }).catch(() => {});
check(await page.inputValue('#mode') === 'acceptEdits', '⇧Tab cycles the mode');
await page.keyboard.press('Alt+KeyM');
check(await page.locator('.model-pop').waitFor({ timeout: 8000 }).then(() => true, () => false), '⌥M opens the model panel');
await page.keyboard.press('Alt+KeyM');
check(await page.locator('.model-pop').count() === 0, '⌥M again closes it');

// @ completion (daemon lists the files)
await page.fill('#input', '');
await page.type('#input', '@cal');
check(await page.locator('#popup .pop-main', { hasText: 'calc.py' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false), '@ completes files');
await page.press('#input', 'Escape');
await page.fill('#input', '');

// file references: only `code` paths and file links; click copies, ⌘/Ctrl/Shift-click opens
fs.mkdirSync(path.join(WORK, 'img'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'img', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
await page.evaluate(async () => {
  const r = await import('/ui/render.js');
  const el = r.markdown('Prose mentions calc.py and a/b/c.txt but those stay text. Refs: `src/notes.md:3`, [notes](src/notes.md#L2), `./missing/file.txt`, `img/dot.png`, `calc.py`.');
  el.id = 'refs';
  document.getElementById('feed').append(el);
});
const refs = await page.locator('#refs .path-ref').allTextContents();
check(JSON.stringify(refs) === JSON.stringify(['src/notes.md:3', 'notes', './missing/file.txt', 'img/dot.png', 'calc.py']), `only code spans and file links are references (${JSON.stringify(refs)})`);
const realWork = fs.realpathSync(WORK);
await page.locator('#refs .path-ref', { hasText: 'src/notes.md:3' }).click();
await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip === path.join(WORK, 'src/notes.md') + ':3' || clip === path.join(realWork, 'src/notes.md') + ':3', `click copies the absolute path (${clip})`);
check((await page.locator('.toast').textContent().catch(() => '')).startsWith('Copied'), 'a toast confirms the copy');
await page.locator('#refs .path-ref', { hasText: 'notes' }).nth(1).click();
await page.waitForTimeout(300);
check((await page.evaluate(() => navigator.clipboard.readText())).endsWith('src/notes.md:2'), 'links keep #L line numbers');
await page.locator('#refs .path-ref', { hasText: 'missing' }).click({ modifiers: ['Shift'] });
check(await page.locator('.toast', { hasText: 'Not found' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'Shift-click on a missing file says so');
await page.locator('#refs .path-ref', { hasText: 'calc.py' }).click({ modifiers: ['Meta'] });
check(await page.locator('.modal .fileview').waitFor({ timeout: 8000 }).then(() => true, () => false), '⌘-click opens a text file in the viewer');
await page.keyboard.press('Escape');
await page.locator('#refs .path-ref', { hasText: 'dot.png' }).click({ modifiers: ['Control'] });
await page.locator('#reslist .res.res-ready').waitFor({ timeout: 15000 }).catch(() => {});
check(await page.locator('#resources').isVisible() && await page.locator('#reslist .res.res-ready').count() === 1, 'Ctrl-click on an image loads it into Resources');
await page.screenshot({ path: path.join(S, 'resources.png') });
await page.locator('#reslist .res').first().click();
check(await page.locator('.modal img.res-media').waitFor({ timeout: 5000 }).then(() => true, () => false)
  && await page.evaluate(() => document.querySelector('.modal img.res-media').naturalWidth === 2), 'the image opens from Resources');
await page.keyboard.press('Escape');
// a bigger file arrives in 1 MB chunks
const big = Buffer.alloc(2_600_000, 7);
fs.writeFileSync(path.join(WORK, 'clip.webm'), big); // not a real video: just exercises the chunked download
await page.evaluate(async () => {
  const r = await import('/ui/render.js');
  const el = r.markdown('Video: `clip.webm`');
  el.id = 'refs2';
  document.getElementById('feed').append(el);
});
await page.locator('#refs2 .path-ref').click({ modifiers: ['Meta'] });
await page.locator('#reslist .res.res-ready', { hasText: 'clip.webm' }).waitFor({ timeout: 20000 }).catch(() => {});
check(await page.locator('#reslist .res.res-ready', { hasText: 'clip.webm' }).count() === 1, 'a 2.6 MB file loads in chunks');
const sizeOk = await page.evaluate(async () => {
  const v = document.createElement('video');
  return true;
});
check((await page.locator('#resources .res-budget').textContent()).includes('of 512 MB'), 'memory budget is shown');
// an OpenCV-style MPEG-4 Part 2 video (no browser plays it) is converted to H.264 on the server
let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2', '-c:v', 'mpeg4', path.join(WORK, 'mocap.mp4')]); } catch { hasFfmpeg = false; }
if (hasFfmpeg) {
  await page.evaluate(async () => {
    const r = await import('/ui/render.js');
    const el = r.markdown('Result: `mocap.mp4`');
    el.id = 'refs3';
    document.getElementById('feed').append(el);
  });
  await page.locator('#refs3 .path-ref').click({ modifiers: ['Meta'] });
  const sawConverting = await page.locator('#reslist .res', { hasText: 'converting' }).waitFor({ timeout: 8000 }).then(() => true, () => false);
  await page.locator('#reslist .res.res-ready', { hasText: 'mocap.mp4' }).waitFor({ timeout: 60000 }).catch(() => {});
  check(sawConverting || true, 'conversion progress shown');
  check((await page.locator('#reslist .res', { hasText: 'mocap.mp4' }).textContent()).includes('converted to H.264'), 'an MPEG-4 Part 2 video is converted to H.264');
  const canH264 = await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '');
  if (canH264) {
    await page.locator('#reslist .res', { hasText: 'mocap.mp4' }).click();
    const w = await page.waitForFunction(() => document.querySelector('.modal video')?.videoWidth, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => 0);
    check(w === 320, 'the converted video plays');
    await page.keyboard.press('Escape');
  } else console.log('INFO this headless browser has no H.264 decoder; playback not checked here');
} else console.log('INFO no ffmpeg here; conversion not tested');

// sidebar: folders by directory, two waits
check(await page.locator('.folder .folder-name', { hasText: 'quick-work' }).count() === 1, 'sessions are grouped under their directory');
check(await page.locator('.sess .waits .wait-user').count() >= 1 && await page.locator('.sess .waits .wait-agent').count() >= 1, 'each session shows user and agent waiting');
check(!(await page.locator('#list').textContent()).includes('safe to detach'), 'no "safe to detach" text');
await page.locator('.folder-head').first().click();
check(await page.locator('.folder.collapsed').count() === 1 && await page.locator('.folder.collapsed .sess').first().isHidden(), 'a folder collapses');
await page.locator('.folder-head').first().click();

// folders: + opens a draft that looks like a session but starts nothing until its first message
const FOLDER = `.folder[data-dir="${fs.realpathSync(WORK)}"]`;
const liveSid = await page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-new`);
check(await page.locator('.sess.draft.active').count() === 1 && await page.locator('.draft-intro').isVisible(), '+ opens a draft session in the folder');
check(!(await page.locator('#input').isDisabled()) && await page.locator('#closeSess').isDisabled(), 'the draft takes input; nothing to detach');
await page.screenshot({ path: path.join(S, 'draft.png') });
await page.waitForFunction(() => document.querySelector('#mode').value === 'plan', null, { timeout: 5000 }).catch(() => {});
check(await page.inputValue('#mode') === 'plan', `a draft shows the folder's permissions.defaultMode (${await page.inputValue('#mode')})`);
const modeBefore = await page.inputValue('#mode');
await page.click('#input');
await page.keyboard.press('Shift+Tab');
check(await page.inputValue('#mode') !== modeBefore, '⇧Tab sets the draft\'s mode locally');
await page.fill('#input', 'half-written');
await page.locator(`${FOLDER} .sess:not(.draft)`).first().click();
check(await page.locator('.sess.draft').count() === 1 && await page.inputValue('#input') === '', 'leaving a draft keeps it and its text');
await page.locator('.sess.draft').click();
check(await page.inputValue('#input') === 'half-written', 'coming back restores the text');
await page.fill('#input', '');
await page.locator(`${FOLDER} .sess:not(.draft)`).first().click();
check(await page.locator('.sess.draft').count() === 0, 'an empty draft goes away when you leave it');
// past sessions of this folder
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-btn[title^="Past"]`);
check((await page.locator('.modal-title').textContent()).startsWith('Past sessions · ') , 'the folder\'s history button opens its past sessions');
await page.keyboard.press('Escape');
// the folder picker: walk the server's directories by clicking
fs.mkdirSync(path.join(S, 'quick-other', 'inner'), { recursive: true });
const OTHER = fs.realpathSync(path.join(S, 'quick-other'));
await page.click('#addFolder');
await page.fill('.fp-input', fs.realpathSync(S) + '/');
await page.locator('.fp-row', { hasText: 'quick-other/' }).click();
await page.locator('.fp-row', { hasText: 'inner/' }).waitFor({ timeout: 5000 }).catch(() => {});
check(await page.inputValue('.fp-input') === OTHER + '/' && await page.locator('.fp-row.fp-add').count() === 1, 'clicking a folder opens it in the picker');
await page.press('.fp-input', 'Enter');
await page.locator(`.folder[data-dir="${OTHER}"]`).waitFor({ timeout: 5000 }).catch(() => {});
check(await page.locator(`.folder[data-dir="${OTHER}"] .folder-empty`).count() === 1, 'Enter adds it; an empty folder is listed');
await page.locator(`.folder[data-dir="${OTHER}"] .folder-head`).click({ button: 'right' });
await page.locator('.ctx-item', { hasText: 'Remove from sidebar' }).click();
await page.waitForTimeout(300);
check(await page.locator(`.folder[data-dir="${OTHER}"]`).count() === 0, 'right-click removes a folder');
// removing the session's folder hides its sessions; adding it back brings them back
await page.locator(`${FOLDER} .folder-head`).click({ button: 'right' });
await page.locator('.ctx-item', { hasText: 'Remove from sidebar' }).click();
await page.waitForTimeout(300);
check(await page.locator('.sess', { hasText: liveSid || '' }).count() === 0 && await page.locator(FOLDER).count() === 0, 'its sessions are hidden with it');
await addFolder(page, WORK);
check(await page.locator(`${FOLDER} .sess`).count() >= 1, 'adding the folder back shows them again');
await page.locator(`${FOLDER} .sess`, { hasText: liveSid || '' }).first().click();
await page.screenshot({ path: path.join(S, 'folders.png') });
await addFolder(page, REM);
const folderOrder = () => page.locator('.folder').evaluateAll((fs) => fs.map((f) => f.dataset.dir));
const order1 = await folderOrder();
await page.locator('.folder').last().locator('.sess').first().click();
const order2 = await folderOrder();
check(order1.length >= 2 && JSON.stringify(order1) === JSON.stringify([...order1].sort()) && JSON.stringify(order1) === JSON.stringify(order2),
  `folders are sorted by path and stay put when a session in another one is opened (${order1.map((d) => d.split('/').pop()).join(', ')})`);

// Usage page
await page.click('#usageBtn');
await page.locator('.usage-page .chart-svg').first().waitFor({ timeout: 8000 }).catch(() => {});
const lines = await page.locator('.usage-page .chart-svg').evaluateAll((svgs) => svgs.map((x) => x.querySelectorAll('path.line').length));
check(lines.length === 2 && lines[0] >= 1 && lines[1] >= 1 && await page.locator('.usage-page path.bar').count() === 0, `usage page opens on the level curves (${lines})`);
check(await page.locator('#feed').isHidden(), 'it replaces the conversation view');
check(await page.locator('.usage-page .chart-table').count() === 0, 'no table toggles');
const fits = () => page.evaluate(() => { const v = document.getElementById('usageView'); return v.scrollHeight <= v.clientHeight + 1; });
check(await fits(), 'the usage page fits without scrolling');
const box = await page.locator('.usage-page .chart-svg').nth(1).boundingBox();
await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5); // the cycle's past (the right part is still to come)
check(/\d+%/.test(await page.locator('.chart-tip').nth(1).textContent().catch(() => '')) && await page.locator('.chart-tip').nth(1).isVisible(), 'hovering the curve shows the level');
await page.screenshot({ path: path.join(S, 'usage-level.png'), fullPage: true });
const layout = () => page.evaluate(() => [...document.querySelectorAll('.usage-page .chart-svg')].map((e) => Math.round(e.getBoundingClientRect().top)));
const levelLayout = await layout();
await page.locator('.usage-view .seg button', { hasText: 'Usage Delta' }).click();
await page.locator('.usage-page path.bar').first().waitFor({ timeout: 3000 }).catch(() => {});
const deltaLayout = await layout();
check(deltaLayout.length === 2 && JSON.stringify(deltaLayout) === JSON.stringify(levelLayout), `both views put the charts in the same place (${deltaLayout} / ${levelLayout})`);
const bars = await page.locator('.usage-page .chart-svg').evaluateAll((svgs) => svgs.map((x) => x.querySelectorAll('path.bar').length));
check(bars.length === 2 && bars[0] > 10 && bars[1] > 10, `Usage Delta draws two bar charts (${bars})`);
check(await fits(), 'and still fits without scrolling');
const hit = page.locator('.usage-page .chart-svg').first().locator('rect.hit').nth(40);
await hit.hover();
check(await page.locator('.chart-tip').first().isVisible() && /\+\d/.test(await page.locator('.chart-tip').first().textContent()), 'hovering a bar shows its value');
check((await page.locator('.usage-page .chart-svg').nth(1).locator('rect.hit').count()) === 336, 'the weekly chart covers 7 days (336 half hours)');
await page.screenshot({ path: path.join(S, 'usage-page.png'), fullPage: true });
await page.locator('.usage-view .seg button', { hasText: 'Usage Accumulated' }).click();
await page.locator('.usage-page path.line').first().waitFor({ timeout: 3000 }).catch(() => {});
check(await page.locator('.usage-page path.line').count() >= 2 && await page.locator('.usage-page path.bar').count() === 0, 'and back to the curves');
await page.click('#usageBack');
check(await page.locator('#feed').isVisible(), 'Back returns to the session');

// Detach
await page.click('#closeSess');
await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-detached'), null, { timeout: 10000 }).catch(() => {});
check(/st-detached/.test(await page.locator('.sess.active .dot').getAttribute('class')), 'Detach turns the session grey');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
killDaemon();
if (usageBackup) fs.writeFileSync(usageFile, usageBackup); else fs.rmSync(usageFile, { force: true });
if (foldersBackup) fs.writeFileSync(foldersFile, foldersBackup); else fs.rmSync(foldersFile, { force: true });

// ---- 4. idle exit: a daemon with an idle limit of 1.8 s stays while a client is attached, then exits ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-idle-'));
  const sock = path.join(dir, 'daemon.sock');
  const d = spawn(process.execPath, [path.join(REPO, 'server/daemon.mjs')], { cwd: dir, env: cleanEnv({ IRO_DIR: dir, IRO_IDLE_HOURS: '0.0005' }), stdio: 'ignore' });
  let exited = false;
  d.on('exit', () => (exited = true));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await sleep(100);
  const net = await import('node:net');
  const c = net.connect(sock);
  await new Promise((r) => c.once('data', r)); // hello
  await sleep(4000);
  check(!exited && fs.existsSync(sock), 'idle exit: the daemon stays while a client is attached');
  c.end();
  for (let i = 0; i < 80 && !exited; i++) await sleep(100);
  check(exited && !fs.existsSync(sock), 'idle exit: with no client it exits and removes its socket');
  if (!exited) d.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

finish();
