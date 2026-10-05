// Quick suite: no model calls. Syntax, protocol basics, and the UI around a blank session
// (a Claude process that has not been sent anything). Takes well under a minute.
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, addFolder, killDaemon, check, until, wait, finish } from './lib.mjs';

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
  'server/daemon.mjs', 'server/attach.mjs', 'client/client.mjs', 'client/main.mjs',
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
process.env.IRO_COMPACT_MS = '500'; // the event log is trimmed every half second (else every minute)
const IRO_DIR = process.env.IRO_DIR; // this suite's own state dir (test/lib.mjs)
fs.mkdirSync(IRO_DIR, { recursive: true });
const usageFile = path.join(IRO_DIR, 'usage.jsonl');
const usageBackup = fs.existsSync(usageFile) ? fs.readFileSync(usageFile) : null;
const foldersFile = path.join(IRO_DIR, 'folders.json');
const foldersBackup = fs.existsSync(foldersFile) ? fs.readFileSync(foldersFile) : null;
{
  const lines = [];
  const now = Date.now();
  const slot0 = Math.ceil((now - 3 * 24 * 3600e3) / 1800e3) * 1800e3; // on the :00/:30 marks, as the daemon stamps them
  for (let t = slot0; t <= now; t += 1800e3) {
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
fs.mkdirSync(path.join(REM, '.claude'), { recursive: true });
fs.writeFileSync(path.join(REM, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } })); // a draft here shows Accept edits
fs.writeFileSync(path.join(IRO_DIR, 'recent.json'), JSON.stringify({
  [fs.realpathSync(REM)]: Array.from({ length: 10 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, title: `remembered ${i}`, t: Date.now() - (10 - i) * 60e3 })),
}));

// ---- 2. protocol ----
killDaemon();
await new Promise((r) => setTimeout(r, 400));
const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
const req = (method, p, { headers = {}, body, host } = {}) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...(host ? { host } : {}), ...headers } }, (x) => {
    let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
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
check((await Promise.all(['adopt', 'retire', 'toString'].map((type) => req('POST', '/cmd', { headers: { 'x-token': token }, body: JSON.stringify({ type }) })))).every((r) => r.status === 400),
  'nor the ones between daemons, nor names that are not commands');
check(/img-src 'self' data: blob:/.test((await req('GET', '/')).headers['content-security-policy']), 'the page may load images only from itself');
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

check(await page.title() === `IroWell at ${os.hostname()}`, `the browser tab names the server (${await page.title()})`);
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
// once you leave it, the coloured detached row goes grey like any other detached row
await page.locator('.sess', { hasText: 'remembered 8' }).click();
{
  const sc = (t) => page.locator('.sess', { hasText: t }).evaluate((r) => getComputedStyle(r).getPropertyValue('--sc').trim());
  const [purple, plain] = [await sc('remembered 9'), await sc('remembered 7')];
  check(purple === plain && !!plain, `a coloured detached row is grey when not open, like the others (${purple} vs ${plain})`);
}

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
{
  const imgs = await page.evaluate(async () => {
    const r = await import('/ui/render.js');
    const el = r.markdown('![leak](https://example.com/p.png?d=secret) ![x](//example.com/a.png) ![dot](data:image/png;base64,iVBORw0KGgo=)');
    return { imgs: [...el.querySelectorAll('img')].map((i) => i.getAttribute('src').slice(0, 10)), links: [...el.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]) };
  });
  check(JSON.stringify(imgs.imgs) === '["data:image"]' && imgs.links.length === 2 && imgs.links[0][1] === 'https://example.com/p.png?d=secret' && imgs.links[1][1] === null,
    `remote Markdown images become links, data: images stay (${JSON.stringify(imgs)})`);
}
check(await page.locator('table.diff tr.add').count() === 1 && await page.locator('.tool.error').count() === 1 && await page.locator('ul.todos li').count() === 2, 'tool cards: diff, error, checklist');

// blank session: a live Claude process with nothing sent
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
// before any session runs, the model list comes from a CLI started only to ask (a new session's draft names its model)
{
  const list = (await rpc({ type: 'models' })).data || [];
  check(list.some((m) => m.value === 'default' && m.resolvedModel), `the model list is there with no session running (${list.length})`);
}
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

// a send that takes a while (a reattach first) clears only what it sent: text typed meanwhile stays
{
  await page.route('**/cmd', async (route) => {
    if (JSON.parse(route.request().postData() || '{}').type !== 'send') return route.continue();
    await wait(1000);
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: null }) });
  });
  await page.fill('#input', 'sent message');
  await page.press('#input', 'Enter');
  await wait(200);
  await page.evaluate(() => { const i = document.getElementById('input'); i.value += '\n\ntyped meanwhile'; });
  await wait(1500);
  check(await page.inputValue('#input') === 'typed meanwhile', `text typed during a send stays in the input (${JSON.stringify(await page.inputValue('#input'))})`);
  await page.unroute('**/cmd');
  await page.fill('#input', '');
}

// menus and popovers: one at a time, and a click elsewhere closes them
{
  const n = (sel) => page.locator(sel).count();
  await page.click('#statusbar .dd-btn.dd-modepick');
  const dd = await n('.dd-menu');
  await page.locator('.folder-head').first().click({ button: 'right' });
  const swapped = (await n('.dd-menu')) === 0 && (await n('.ctx-menu')) === 1;
  await page.keyboard.press('Escape');
  const escaped = (await n('.ctx-menu')) === 0;
  await page.click('#input');
  await page.keyboard.press('Alt+KeyM');
  await page.locator('.model-pop').waitFor({ timeout: 8000 }).catch(() => {});
  const pop = await n('.model-pop');
  await page.click('#statusbar .dd-btn.dd-modepick');
  const popToDd = (await n('.model-pop')) === 0 && (await n('.dd-menu')) === 1;
  await page.mouse.click(700, 300);
  check(dd === 1 && swapped && escaped && pop === 1 && popToDd && (await n('.dd-menu')) === 0,
    `one menu at a time: a dropdown, a right-click menu and the model panel close one another (${[dd, swapped, escaped, pop, popToDd]})`);
}

// status line + rail + composer layout
check(await page.locator('#statusbar').isVisible(), 'status line visible');
const rows = await page.evaluate(() => [...document.querySelectorAll('#statusbar .sb-row')].map((r) => [...r.children].filter((c) => !c.classList.contains('dd-native')).map((c) => c.id || c.className.split(' ')[0])));
check(rows.length === 1 && rows[0][0] === 'modelBtn' && rows[0][1] === 'dd-btn' && rows[0].includes('sb-ctx') && rows[0].at(-1) === 'closeSess' && rows[0].at(-2) === 'stop', `settings line: model, mode, context … Stop, Detach (${rows})`);
check(await page.locator('header .head-sub #sb-sid').count() === 1 && await page.locator('#statusbar #sb-sid').count() === 0 && await page.locator('header #sb-dir').isVisible(), 'the folder and session id sit under the title');
check((await page.locator('#railtabs button').allTextContents()).map((t) => t.replace(/\d+$/, '')).join('|') === 'Anchors|Resources|Tasks|btw', 'rail tabs: Anchors / Resources / Tasks / btw');
check(await page.evaluate(() => { // a badge never changes a tab's width
  const c = document.getElementById('resCount'), widths = () => [...document.querySelectorAll('#railtabs button')].map((b) => b.getBoundingClientRect().width).join();
  const was = [c.hidden, c.textContent];
  c.hidden = true; const a = widths();
  c.hidden = false; c.textContent = '128'; const b = widths();
  [c.hidden, c.textContent] = was;
  return a === b;
}), 'rail tabs keep their width when a badge shows');
await page.click('#railtabs button[data-tab="tasks"]');
check((await page.locator('#runlist .run-item').first().textContent()).startsWith('main'), 'Tasks lists main');
check(await page.evaluate(() => { const w = document.querySelector('.input-wrap').getBoundingClientRect(), b = document.getElementById('send').getBoundingClientRect();
  return b.right <= w.right && b.left >= w.left && b.bottom <= w.bottom && b.top >= w.top; }), 'the send button sits inside the pill');

// shells: the icon in the header's corner drops a terminal in the session's folder, one tab per shell
{
  const sid = created.data.sid;
  const screen = () => page.evaluate(() => document.querySelector('#shell .sh-term:not([hidden]) .xterm-rows')?.textContent || '');
  check(await page.locator('#shellBtn').isVisible(), 'the shell icon is in the header');
  const off = await page.evaluate(() => { const b = document.getElementById('shellBtn').getBoundingClientRect(), hd = document.querySelector('header').getBoundingClientRect(); return [Math.round(hd.right - b.right), Math.round(hd.bottom - b.bottom)]; });
  check(off[0] <= 12 && off[1] <= 10, `… in its bottom-right corner (${off})`);
  await page.click('#shellBtn');
  await page.locator('#shell .sh-term:not([hidden]) .xterm').waitFor({ timeout: 10000 });
  check(await page.evaluate(() => { const p = document.getElementById('shell').getBoundingClientRect(), m = document.getElementById('middle').getBoundingClientRect(); return Math.abs(p.top - m.top) < 2 && p.height < m.height; }), 'the panel drops over the conversation, under the header');
  // the login shell's prompt (startup files that cd elsewhere, e.g. a config.fish's `cd ~`, are sent back)
  await until(async () => /quick-work/.test(await screen()), 10000);
  await page.waitForTimeout(600);
  await page.keyboard.type("printf 'IRO_%s\\n' 42; printf 'DIR=%s\\n' \"$PWD\"\n");
  await until(async () => /IRO_42/.test(await screen()), 15000);
  const text = await screen();
  check(/IRO_42/.test(text) && text.includes(`DIR=${fs.realpathSync(WORK)}`), `a shell runs commands in the session's folder (${process.env.SHELL})`);
  await page.click('#shell .sh-add');
  await page.locator('#shell .sh-tab').nth(1).waitFor();
  await page.locator('#shell .sh-tab').first().click();
  await page.screenshot({ path: path.join(S, 'shell.png') });
  await page.locator('#shell .sh-tab .sh-x').nth(1).click();
  await until(async () => (await page.locator('#shell .sh-tab').count()) === 1, 5000);
  const mode0 = await page.inputValue('#mode');
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(300);
  check(await page.inputValue('#mode') === mode0, 'keys typed in the shell stay there (⇧Tab does not cycle the mode)');
  await page.click('#shell .sh-add');
  await until(async () => (await page.locator('#shell .sh-tab').count()) === 2, 10000);
  check(await page.locator('#shell .sh-tab.on').getAttribute('data-tid') === (await page.locator('#shell .sh-tab').nth(1).getAttribute('data-tid')), '+ opens a second shell in its own tab');
  await page.locator('#shell .sh-tab').first().dblclick();
  await page.locator('#shell .sh-tab input').fill('build');
  await page.keyboard.press('Enter');
  await until(async () => ((await rpc({ type: 'shellList', sid })).data || []).some((t) => t.name === 'build'), 5000);
  check(await page.locator('#shell .sh-tab').first().textContent() === 'build', 'double-clicking a tab renames the shell');
  await page.keyboard.press('Control+Backquote');
  check(await page.locator('#shell').evaluate((el) => el.classList.contains('sh-lifting')), '⌃` folds the panel away, animated');
  await page.locator('#shell').waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
  check(await page.locator('#shell').isHidden(), '… and then it is hidden');
  // a reload shows the shells again, with their recent output
  await page.reload();
  await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  await workRow.click();
  await page.keyboard.press('Control+Backquote');
  await page.locator('#shell .sh-tab').first().waitFor({ timeout: 10000 });
  await until(async () => /IRO_42/.test(await screen()), 5000);
  check((await page.locator('#shell .sh-tab').allTextContents()).join('|') === 'build|zsh 2'.replace('zsh', path.basename(process.env.SHELL || 'sh')) && /IRO_42/.test(await screen()), 'after a reload the shells and their output are still there');
  const before = ((await rpc({ type: 'shellList', sid })).data || []).map((t) => t.tid);
  await page.locator('#shell .sh-tab .sh-x').first().click();
  await until(async () => ((await rpc({ type: 'shellList', sid })).data || []).length === 1, 5000);
  check(((await rpc({ type: 'shellList', sid })).data || []).map((t) => t.tid).join() === before[1], '× closes a shell');
  await page.locator('#shell .sh-tab .sh-x').first().click();
  await until(async () => { const l = (await rpc({ type: 'shellList', sid })).data || []; return l.length === 1 && l[0].tid !== before[1]; }, 5000);
  const after = (await rpc({ type: 'shellList', sid })).data || [];
  check(after.length === 1 && !before.includes(after[0].tid) && await page.locator('#shell .sh-tab').count() === 1, 'closing the last shell opens a fresh one');
  await page.locator('#shell .sh-term:not([hidden]) .xterm').waitFor({ timeout: 5000 });
  await until(async () => /quick-work/.test(await screen()), 10000);
  check(/quick-work/.test(await screen()), '… in the session\'s folder, at once');
  await rpc({ type: 'shellClose', sid, tid: after[0].tid });
  await page.keyboard.press('Control+Backquote');
  await page.waitForFunction(() => document.getElementById('shell').hidden, null, { timeout: 3000 }).catch(() => {});
}
await page.fill('#input', '');
const small = await page.evaluate(() => document.getElementById('input').offsetHeight);
check(await page.locator('#expandInput').isHidden(), 'one line: no expand button');
await page.fill('#input', 'a\nb');
check(await page.locator('#expandInput').isHidden(), 'two lines: still no expand button');
await page.fill('#input', 'a\nb\nc');
check(await page.locator('#expandInput').isVisible(), 'three lines show the expand button');
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

// ⌥M is a dead key on US Extended: the system composes an accent into the input anyway
{
  const cdp = await page.context().newCDPSession(page);
  await page.fill('#input', 'hi');
  await page.click('#input');
  await page.keyboard.press('Alt+KeyM');
  await page.locator('.model-pop').waitFor({ timeout: 8000 }).catch(() => {});
  await cdp.send('Input.imeSetComposition', { text: '¯', selectionStart: 1, selectionEnd: 1 });
  await wait(200);
  check(await page.inputValue('#input') === 'hi', `⌥M's dead-key accent doesn't stay in the input (${JSON.stringify(await page.inputValue('#input'))})`);
  // a pending composition can deliver one ← → press twice; it moves effort one level
  const level = () => page.evaluate(() => Number(document.querySelector('.model-pop input[type=range]').value));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); // off the low end, so two steps would show
  const l0 = await level();
  const arrow = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...arrow });
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...arrow });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...arrow });
  const l1 = await level();
  await page.keyboard.press('ArrowRight');
  const l2 = await level();
  check(l1 === Math.max(0, l0 - 1) && l2 === l1 + 1, `one ← → press is one effort level (${l0} → ${l1} → ${l2})`);
  await page.keyboard.press('Escape');
  await page.fill('#input', '');
  await cdp.detach();
}

// keyboard shortcuts: /keybindings rebinds them, the new key works and the old one doesn't
{
  await page.fill('#input', '/keybindings');
  await page.press('#input', 'Escape');
  await page.press('#input', 'Enter');
  const btn = page.locator('.key-btn[data-action="model.panel"]');
  check(await btn.waitFor({ timeout: 8000 }).then(() => true, () => false), '/keybindings opens the shortcuts dialog');
  await btn.click();
  await page.keyboard.press('KeyK');
  const msg = page.locator('.key-msg').filter({ hasText: /\S/ });
  check(await msg.count() === 1, 'a key that types on its own is refused');
  await page.keyboard.press('Shift+Tab');
  check(/Already used/.test(await msg.textContent()), 'a key another action has is refused');
  await page.keyboard.press('Alt+KeyK');
  await until(async () => /K/.test(await page.locator('.key-btn[data-action="model.panel"]').textContent()), 3000);
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('iro-keybindings'))['model.panel']) === 'Alt+KeyK', 'the new key is saved');
  check(await page.locator('.modal').count() === 1 && await page.locator('.model-pop').count() === 0, 'the key being recorded does nothing else');
  await page.screenshot({ path: path.join(S, 'keys.png') });
  await page.keyboard.press('Escape');
  check(/K\)$/.test(await page.getAttribute('#modelBtn', 'title')), `the button's tooltip shows the new key (${await page.getAttribute('#modelBtn', 'title')})`);
  await page.click('#input');
  await page.keyboard.press('Alt+KeyM');
  await wait(200);
  check(await page.locator('.model-pop').count() === 0, 'the old key no longer opens the model panel');
  await page.keyboard.press('Alt+KeyK');
  check(await page.locator('.model-pop').waitFor({ timeout: 8000 }).then(() => true, () => false), 'the new key opens it');
  await page.keyboard.press('Escape');
  await page.fill('#input', '/keybindings');
  await page.press('#input', 'Escape');
  await page.press('#input', 'Enter');
  await page.locator('.keys-foot button').click();
  check(await page.evaluate(() => localStorage.getItem('iro-keybindings')) === null && !(await page.locator('.key-btn.changed').count()), 'Restore all defaults clears them');
  await page.keyboard.press('Escape');
  await page.fill('#input', '');
  await wait(200); // the click blurred the input, and a blur closes the completion popup 150ms later
  // (a second copy of the module, which reads the stored keys as a fresh page would)
  const k = await page.evaluate(async () => {
    localStorage.setItem('iro-keybindings', JSON.stringify({ 'model.panel': 5, 'mode.cycle': 'Alt+KeyK', 'gone.action': 'Alt+KeyX' }));
    const m = await import('/ui/keys.js?fresh');
    const out = { loaded: [m.keyOf('model.panel'), m.keyOf('mode.cycle')], label: m.label('model.panel') };
    m.setKey('model.panel', 'Alt+KeyJ');
    m.setKey('mode.cycle', 'Alt+KeyM');
    out.reset = m.resetKey('model.panel');
    out.after = m.keyOf('model.panel');
    out.refused = [m.problem('shell.toggle', 'Ctrl+KeyR'), m.problem('model.next', 'Enter')];
    localStorage.removeItem('iro-keybindings');
    return out;
  });
  check(k.loaded[0] === 'Alt+KeyM' && k.loaded[1] === 'Alt+KeyK' && !!k.label, `a stored key of the wrong shape is ignored (${JSON.stringify(k.loaded)})`);
  check(/Already used/.test(k.reset) && k.after === 'Alt+KeyJ', `Default is refused when another action has taken that key (${k.reset})`);
  check(k.refused.every(Boolean), `keys the shell or the model panel need are refused (${JSON.stringify(k.refused)})`);
}

// @ completion (daemon lists the files)
await page.fill('#input', '');
await page.type('#input', '@cal');
check(await page.locator('#popup .pop-main', { hasText: 'calc.py' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false), '@ completes files');
await page.press('#input', 'Escape');
await page.fill('#input', '');
// paths like ./x and ../x list that folder
await page.type('#input', '@./sr');
check(await page.locator('#popup .pop-main', { hasText: './src/' }).first().waitFor({ timeout: 8000 }).then(() => true, () => false), '@./ lists the folder');
await page.press('#input', 'Escape');
await page.fill('#input', '');
await page.type('#input', '@../quick-work/s');
await page.locator('#popup .pop-main', { hasText: '../quick-work/src/' }).first().waitFor({ timeout: 8000 }).catch(() => {});
await page.press('#input', 'Tab');
await page.locator('#popup .pop-main', { hasText: '../quick-work/src/notes.md' }).first().waitFor({ timeout: 8000 }).catch(() => {});
check(await page.inputValue('#input') === '@../quick-work/src/' && await page.locator('#popup .pop-main', { hasText: '../quick-work/src/notes.md' }).count() > 0, `@../ works, and picking a folder lists its entries (${await page.inputValue('#input')})`);
await page.press('#input', 'Escape');
await page.fill('#input', '');

// file references: only Markdown links to files (click copies the target, ⌘/Ctrl/Shift-click opens it);
// a path in `code` is plain code that a click copies as written
fs.mkdirSync(path.join(WORK, 'img'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'img', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
const mdRefs = async (id, text) => page.evaluate(async ([id, text]) => {
  const r = await import('/ui/render.js');
  const el = r.markdown(text);
  el.id = id;
  document.getElementById('feed').append(el);
}, [id, text]);
await mdRefs('refs', `Prose mentions calc.py and a/b/c.txt but those stay text. Code: \`src/notes.md:3\`, \`img/dot.png\`. Links: [notes](src/notes.md#L2), [missing](./missing/file.txt), [dot.png](${WORK}/img/dot.png), [calc.py](${WORK}/calc.py).`);
const refs = await page.locator('#refs .path-ref').allTextContents();
const codes = await page.locator('#refs code.code-copy').allTextContents();
check(JSON.stringify(refs) === JSON.stringify(['notes', 'missing', 'dot.png', 'calc.py']) && JSON.stringify(codes) === JSON.stringify(['src/notes.md:3', 'img/dot.png']),
  `only file links are references; path-like code is copyable code (${JSON.stringify({ refs, codes })})`);
const codeLook = await page.evaluate(() => getComputedStyle(document.querySelector('#refs code.code-copy')).textDecorationLine);
check(codeLook === 'none', `path-like code is not underlined (${codeLook})`);
await page.locator('#refs code.code-copy', { hasText: 'src/notes.md:3' }).click();
await page.waitForTimeout(300);
check(await page.evaluate(() => navigator.clipboard.readText()) === 'src/notes.md:3', 'a click on path-like code copies its text as written');
check((await page.locator('.toast').last().textContent().catch(() => '')).startsWith('Copied'), 'a toast confirms the copy');
await page.locator('#refs code.code-copy', { hasText: 'img/dot.png' }).click({ modifiers: ['Meta'] });
await page.waitForTimeout(400);
check(await page.locator('.modal').count() === 0 && await page.locator('#reslist .res', { hasText: 'dot.png' }).count() === 0, '⌘-click on path-like code opens nothing');
const realWork = fs.realpathSync(WORK);
await page.locator('#refs .path-ref', { hasText: 'notes' }).click();
await page.waitForTimeout(300);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(clip === path.join(WORK, 'src/notes.md') + ':2' || clip === path.join(realWork, 'src/notes.md') + ':2', `a link click copies the absolute path, keeping #L line numbers (${clip})`);
await page.locator('#refs .path-ref', { hasText: 'missing' }).click({ modifiers: ['Shift'] });
check(await page.locator('.toast', { hasText: 'Not found' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'Shift-click on a link to a missing file says so');
await page.locator('#refs .path-ref', { hasText: 'calc.py' }).click({ modifiers: ['Meta'] });
check(await page.locator('.modal .fileview').waitFor({ timeout: 8000 }).then(() => true, () => false), '⌘-click opens a text file in the viewer');
await page.keyboard.press('Escape');
check(await page.locator('#reslist .res.res-remote', { hasText: 'calc.py' }).count() === 1, 'a small text file is listed in Resources too, read again on each open');
fs.appendFileSync(path.join(WORK, 'calc.py'), '\n# edited after the first open\n');
await page.locator('#reslist .res', { hasText: 'calc.py' }).click();
await page.locator('.modal .fileview').waitFor({ timeout: 8000 }).catch(() => {});
check((await page.locator('.modal .fileview .src').textContent()).includes('edited after the first open'), 'opening it again shows the file as it is now');
await page.keyboard.press('Escape');
// a big text file is fetched into memory first, then opens from there
fs.writeFileSync(path.join(WORK, 'big.log'), 'line of a big log\n'.repeat(20000));
// a folder never opens: ⌘-click does nothing, a plain click still copies its path
await mdRefs('refs4', `Log: [big.log](${WORK}/big.log), folder: [img](${WORK}/img)`);
await page.locator('#refs4 .path-ref', { hasText: 'big.log' }).click({ modifiers: ['Meta'] });
await page.locator('#reslist .res.res-ready', { hasText: 'big.log' }).waitFor({ timeout: 15000 }).catch(() => {});
check(await page.locator('#reslist .res.res-ready', { hasText: 'big.log' }).count() === 1, 'a big text file loads into Resources');
await page.locator('#reslist .res', { hasText: 'big.log' }).click();
await page.locator('.modal .fileview').waitFor({ timeout: 8000 }).catch(() => {});
check((await page.locator('.modal .fileview .src').textContent()).startsWith('line of a big log'), 'it opens from memory in the viewer');
await page.keyboard.press('Escape');
await page.locator('#refs4 .path-ref', { hasText: 'img' }).hover();
await page.waitForTimeout(400);
await page.locator('#refs4 .path-ref', { hasText: 'img' }).click({ modifiers: ['Meta'] });
await page.waitForTimeout(400);
check(await page.locator('#refs4 .path-ref.path-dir').count() === 1 && await page.locator('.modal').count() === 0 && await page.locator('#reslist .res', { hasText: 'img' }).count() === 0,
  'a folder reference does not open');
await page.locator('#refs .path-ref', { hasText: 'dot.png' }).click({ modifiers: ['Control'] });
await page.locator('#reslist .res.res-ready', { hasText: 'dot.png' }).waitFor({ timeout: 15000 }).catch(() => {});
check(await page.locator('#resources').isVisible() && await page.locator('#reslist .res.res-ready', { hasText: 'dot.png' }).count() === 1, 'Ctrl-click on an image loads it into Resources');
await page.screenshot({ path: path.join(S, 'resources.png') });
await page.locator('#reslist .res').first().click();
check(await page.locator('.modal img.res-media').waitFor({ timeout: 5000 }).then(() => true, () => false)
  && await page.evaluate(() => document.querySelector('.modal img.res-media').naturalWidth === 2), 'the image opens from Resources');
await page.keyboard.press('Escape');
// an SVG gets a data: URL (a blob: one has the page's origin: opened in a tab, its scripts would run there)
fs.writeFileSync(path.join(WORK, 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><script>parent.pwned=1</script><rect width="3" height="2"/></svg>');
await mdRefs('refs5', `Logo: [logo.svg](${WORK}/img/logo.svg)`);
await page.locator('#refs5 .path-ref', { hasText: 'logo.svg' }).click({ modifiers: ['Control'] });
await page.locator('#reslist .res.res-ready', { hasText: 'logo.svg' }).waitFor({ timeout: 15000 }).catch(() => {});
await page.locator('#reslist .res', { hasText: 'logo.svg' }).click();
await page.locator('.modal img.res-media').waitFor({ timeout: 5000 }).catch(() => {});
check(await page.evaluate(() => { const i = document.querySelector('.modal img.res-media'); return !!i && i.src.startsWith('data:image/svg+xml') && i.naturalWidth === 3; }),
  'an SVG opens from Resources from a data: URL');
await page.keyboard.press('Escape');
// a bigger file arrives in 1 MB chunks
const big = Buffer.alloc(2_600_000, 7);
fs.writeFileSync(path.join(WORK, 'clip.webm'), big); // not a real video: just exercises the chunked download
await mdRefs('refs2', `Video: [clip.webm](${WORK}/clip.webm)`);
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
  await mdRefs('refs3', `Result: [mocap.mp4](${WORK}/mocap.mp4)`);
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
// compact rows: the second line is symbols only (person / robot waits bottom left, ⚙n for background work bottom right), no status words
{
  const r = await page.locator('.sess').first().evaluate((row) => {
    const m = row.querySelector('.m'), w = row.querySelector('.waits').getBoundingClientRect(), t = row.querySelector('.t').getBoundingClientRect();
    return { text: m.textContent, icons: row.querySelectorAll('.waits svg').length, waitsInLine2: w.top >= t.bottom - 1, left: Math.abs(w.left - parseFloat(getComputedStyle(m).paddingLeft) - m.getBoundingClientRect().left) <= 1, height: row.getBoundingClientRect().height };
  });
  check(/^\S+?(⚙\uFE0E\d+)?$/.test(r.text) && r.icons === 2 && !/busy|idle|detached|background/.test(r.text) && r.waitsInLine2 && r.left,
    `a row's second line is "⚙n" and the person / robot waits at the bottom left (${JSON.stringify(r.text)}, ${r.icons} icons)`);
  check(r.height <= 46, `rows are compact (${r.height}px)`);
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

// folders: + opens a draft that starts nothing until its first message, and has no sidebar row until then
const FOLDER = `.folder[data-dir="${fs.realpathSync(WORK)}"]`;
const liveSid = await page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-new`);
check(await page.locator('.draft-intro').isVisible() && await page.locator('.sess.active').count() === 0 && await page.locator(`${FOLDER} .sess`).count() === 1,
  '+ opens a draft session in the folder, with no row of its own until it starts');
check(!(await page.locator('#input').isDisabled()) && await page.locator('#closeSess').isDisabled(), 'the draft takes input; nothing to detach');
await page.waitForFunction(() => !/^(Model|Default)?$/.test(document.querySelector('#modelBtn .mb-name')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
{
  const name = await page.locator('#modelBtn .mb-name').textContent();
  // Without a login (CI) the CLI knows the family but not the version ("Opus"), so there only "Model"/"Default" fail.
  const ok = process.env.CI ? /^[A-Z][a-z]+( \d|$)/.test(name) && !/^(Model|Default)$/.test(name) : /^[A-Z][a-z]+ \d/.test(name);
  check(ok, `a draft names the model it will run, not "Model" (${name})`);
}
await page.screenshot({ path: path.join(S, 'draft.png') });
await page.waitForFunction(() => document.querySelector('#mode').value === 'plan', null, { timeout: 5000 }).catch(() => {});
check(await page.inputValue('#mode') === 'plan', `a draft shows the folder's permissions.defaultMode (${await page.inputValue('#mode')})`);
const modeBefore = await page.inputValue('#mode');
await page.click('#input');
await page.keyboard.press('Shift+Tab');
check(await page.inputValue('#mode') !== modeBefore, '⇧Tab sets the draft\'s mode locally');
{ // a new session elsewhere does not inherit what another draft was changed to: it starts from its own defaults
  const REMF = `.folder[data-dir="${fs.realpathSync(REM)}"]`;
  await page.locator(`${REMF} .folder-head`).hover();
  await page.click(`${REMF} .folder-new`);
  await page.waitForFunction(() => document.querySelector('#mode').value === 'acceptEdits', null, { timeout: 5000 }).catch(() => {});
  check(await page.locator('.draft-intro').isVisible() && await page.inputValue('#mode') === 'acceptEdits',
    `a new draft starts in its folder's default mode, not the one picked in another draft (${await page.inputValue('#mode')}, want acceptEdits)`);
  await page.locator(`${FOLDER} .folder-head`).hover(); // (the empty draft left behind is gone: open it again)
  await page.click(`${FOLDER} .folder-new`);
}
await page.fill('#input', 'half-written');
await page.locator(`${FOLDER} .sess`).first().click();
check(await page.locator('.draft-intro').count() === 0 && await page.inputValue('#input') === '', 'leaving a draft for a session');
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-new`);
check(await page.inputValue('#input') === 'half-written', '+ on the folder again brings the draft back with its text');
// right-click → Archive: the row goes, the next remembered one moves up, and a restart keeps it out
await page.locator(`.folder[data-dir="${fs.realpathSync(REM)}"] .sess`, { hasText: 'remembered 9' }).click({ button: 'right' });
await page.locator('.ctx-item', { hasText: 'Archive' }).click();
await page.waitForTimeout(300);
const remAfter = await page.locator(`.folder[data-dir="${fs.realpathSync(REM)}"] .sess-title`).allTextContents();
const remIds = Object.values(JSON.parse(fs.readFileSync(path.join(IRO_DIR, 'recent.json'), 'utf8'))).flat().map((x) => x.id);
const ARCH = '00000000-0000-4000-8000-000000000009';
check(remAfter.length === 8 && !remAfter.includes('remembered 9') && remAfter.includes('remembered 1') && !remIds.includes(ARCH)
  && JSON.parse(fs.readFileSync(path.join(IRO_DIR, 'archived.json'), 'utf8')).includes(ARCH),
  `right-click archives a session: it leaves the sidebar and recent.json (${remAfter.map((t) => t.replace('remembered ', '')).join(' ')})`);
await page.fill('#input', '');
await page.locator(`${FOLDER} .sess`).first().click();
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-new`);
check(await page.locator('.draft-intro').isVisible() && await page.inputValue('#input') === '', 'an empty draft goes away when you leave it');
await page.locator(`${FOLDER} .sess`).first().click();
// ---- Settings: the defaults of a new session, and the usage sampling interval ----
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-new`);
await page.waitForFunction(() => document.querySelector('#mode').value === 'plan', null, { timeout: 5000 }).catch(() => {});
{ // the model panel starts on the model the button names (it used to start on the first one while a draft had not chosen)
  const name = await page.locator('#modelBtn .mb-name').textContent();
  await page.click('#input');
  await page.keyboard.press('Alt+KeyM');
  await page.locator('.model-pop').waitFor({ timeout: 8000 }).catch(() => {});
  const marked = await page.locator('.model-pop .dd-item.hover .dd-label').first().textContent().catch(() => null);
  check(marked === name, `the model panel opens on the model the button shows (${marked} / ${name})`);
  await page.keyboard.press('Escape');
}
await page.click('#settingsBtn');
await page.locator('.modal .set-select').nth(3).waitFor({ timeout: 8000 }).catch(() => {});
const pickers = page.locator('.modal .set-select');
check(await pickers.count() === 4 && (await page.locator('.modal-title').textContent()) === 'Settings', 'the Settings button below the usage card opens the panel: model, effort, mode, sampling interval');
check((await pickers.nth(2).locator('option').evaluateAll((os) => os.map((o) => o.value))).includes('bypassPermissions'), 'Bypass permissions can be the default mode');
const modelOpts = await pickers.nth(0).locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
const [wantModel, wantModelName] = modelOpts[modelOpts.length - 1];
await pickers.nth(0).selectOption(wantModel);
await pickers.nth(1).selectOption('max');
await pickers.nth(2).selectOption('default');
await pickers.nth(3).selectOption('60');
await page.screenshot({ path: path.join(S, 'settings.png') });
await page.waitForFunction(() => document.querySelector('#effort').value === 'max' && document.querySelector('#mode').value === 'default', null, { timeout: 5000 }).catch(() => {});
{
  const st = (await rpc({ type: 'getSettings' })).data || {};
  check(st.defaults?.model === wantModel && st.defaults?.effort === 'max' && st.defaults?.mode === 'default' && st.usageInterval === 60,
    `the defaults and the interval are kept on the server (${JSON.stringify(st.defaults)}, ${st.usageInterval})`);
  check((await rpc({ type: 'setSettings', usageInterval: 7 })).status !== 200 || (await rpc({ type: 'getSettings' })).data?.usageInterval === 60, 'an interval the clock cannot keep is refused');
  check(await page.inputValue('#effort') === 'max' && await page.inputValue('#mode') === 'default' && await page.locator('#modelBtn .mb-name').textContent() === wantModelName,
    `the open, untouched draft follows the new defaults (${await page.inputValue('#effort')}, ${await page.inputValue('#mode')}, ${await page.locator('#modelBtn .mb-name').textContent()})`);
}
await page.locator('.modal-head button').click();
{ // and so does a draft opened later, over its folder's own mode
  const REMF = `.folder[data-dir="${fs.realpathSync(REM)}"]`;
  await page.locator(`${REMF} .folder-head`).hover();
  await page.click(`${REMF} .folder-new`);
  await page.waitForTimeout(500);
  check(await page.inputValue('#mode') === 'default' && await page.inputValue('#effort') === 'max' && await page.locator('#modelBtn .mb-name').textContent() === wantModelName,
    `a new draft starts with the defaults from Settings (${await page.inputValue('#mode')}, ${await page.inputValue('#effort')}, ${await page.locator('#modelBtn .mb-name').textContent()})`);
}
{ // the usage charts follow the interval: one bar per hour of the week
  await page.click('#usageBtn');
  await page.locator('.usage-view .seg button', { hasText: 'Usage Delta' }).click();
  await page.locator('.usage-page path.bar').first().waitFor({ timeout: 3000 }).catch(() => {});
  const hits = await page.locator('.usage-page .chart-svg').nth(1).locator('rect.hit').count();
  check(hits === 168, `with hourly samples the weekly chart has 168 bars (${hits})`);
  await page.locator('.usage-view .seg button', { hasText: 'Usage Accumulated' }).click();
  await page.click('#usageBack');
}
await rpc({ type: 'setSettings', defaults: { model: null, effort: null, mode: null }, usageInterval: 30 });
await page.waitForTimeout(300);
await page.locator(`${FOLDER} .sess`).first().click();
// past sessions of this folder
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-btn[title^="Past"]`);
check((await page.locator('.modal-title').textContent()).startsWith('Past sessions · ') , 'the folder\'s history button opens its past sessions');
// its filter and checkbox wear the theme, not the browser's blue focus ring and stock checkbox
const hLook = await page.evaluate(() => {
  const f = document.querySelector('.hfilter'), c = document.querySelector('.hall input'), cs = getComputedStyle(f);
  const accent = getComputedStyle(document.body).getPropertyValue('--accent').trim();
  const probe = document.body.appendChild(Object.assign(document.createElement('i'), { style: `color:${accent}` }));
  const accentRgb = getComputedStyle(probe).color; probe.remove();
  return { focused: document.activeElement === f, outline: cs.outlineStyle, border: cs.borderTopColor, accentRgb, box: getComputedStyle(c).appearance };
});
check(hLook.focused && hLook.outline === 'none' && hLook.border === hLook.accentRgb && hLook.box === 'none', `the history filter and checkbox follow the theme (${JSON.stringify(hLook)})`);
await page.click('.hall');
await page.locator('.hbar').screenshot({ path: path.join(S, 'history-bar.png') });
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

// the usage card shows the server's latest level (here the synthetic history's last sample), pushed, not polled
check(/Weekly50%/.test(await page.locator('#sb-7d').textContent()), `the usage card shows the server's level (${await page.locator('#sb-7d').textContent()})`);
// under each bar a triangle marks how far the reset window has run (the synthetic week resets in 4 days: 3/7 in)
const tickAt = (id) => page.locator(`${id} .uc-tick`).evaluate((t) => parseFloat(t.style.left)).catch(() => NaN);
const weekTick = await tickAt('#sb-7d'), fiveTick = await tickAt('#sb-5h');
check(Math.abs(weekTick - 300 / 7) < 0.5 && fiveTick >= 0 && fiveTick <= 100, `the usage card marks the time into each window (5h ${fiveTick}%, week ${weekTick}%)`);
// Usage page
// opening it marks the card without moving anything in it (no size or position change, not even half a pixel)
const cardBoxes = () => page.locator('#usageBtn, #usageBtn .uc-top, #usageBtn .uc-bar, #usageBtn .uc-tick')
  .evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(','); }).join(' ')
    + ' ' + getComputedStyle(els[0]).borderWidth + ' ' + getComputedStyle(els[0]).boxShadow.replace(/.*inset[^,]*,\s*/, ''));
const cardShut = await cardBoxes();
await page.click('#usageBtn');
check(await cardBoxes() === cardShut, 'opening the usage page does not shift or lift the usage card');
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

// ---- the event log keeps only what a gone session's row needs; an archived one goes entirely ----
{
  const sse = () => new Promise((resolve) => {
    const got = [];
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/events?t=' + token }, (x) => {
      let b = '';
      x.on('data', (c) => { b += c; let i; while ((i = b.indexOf('\n\n')) >= 0) { const f = b.slice(0, i); b = b.slice(i + 2); if (f.startsWith('data: ')) got.push(JSON.parse(f.slice(6))); } });
    });
    setTimeout(() => { r.destroy(); resolve(got.filter((m) => m.type === 'event')); }, 800);
  });
  const kept = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  const gone = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  await rpc({ type: 'send', sid: kept, text: '/cost' }); // a local command: events, but no model call
  await until(async () => (await sse()).some((e) => e.sid === kept && e.kind === 'msg' && e.msg.type === 'result'), 30000);
  const before = (await sse()).filter((e) => e.sid === kept).length;
  await rpc({ type: 'close', sid: kept });
  await rpc({ type: 'archive', sid: gone });
  await wait(2000);
  const after = await sse();
  const k = after.filter((e) => e.sid === kept);
  check(k.length < before && k.every((e) => ['created', 'meta', 'closed', 'state'].includes(e.kind)) && k.find((e) => e.kind === 'created')?.dormant && k.some((e) => e.kind === 'closed'),
    `a closed session keeps only its row in the log (${before} → ${k.map((e) => e.kind)})`);
  check(!after.some((e) => e.sid === gone), 'an archived one leaves nothing');
  await rpc({ type: 'archive', sid: kept });
}

// ---- 3b. stopping: the ⏻ button, Start server, and client.mjs --stop ----
{
  const daemonUp = () => fs.existsSync(path.join(IRO_DIR, 'daemon.sock'));
  const stopCli = () => execFileSync(process.execPath, [CLIENT, '--local', '--stop'], { env: cleanEnv() }).toString();
  await page.click('#stopServer');
  await until(() => !daemonUp(), 15000, 'the daemon stops');
  await page.locator('#startServer').waitFor({ timeout: 5000 }).catch(() => {});
  check(await page.locator('#startServer').isVisible() && /server stopped/.test(await page.locator('#conn').textContent()), 'Stop server: the page says so and offers Start server');
  await wait(2500);
  check(!daemonUp(), 'the client does not restart a stopped server');
  await page.click('#startServer');
  check(await page.locator('#conn .dot.up').waitFor({ timeout: 15000 }).then(() => true, () => false) && daemonUp(), 'Start server starts it again');
  check(/stopped the IroWell server/.test(stopCli()), 'client.mjs --local --stop stops it');
  check(!daemonUp() && await page.locator('#startServer').waitFor({ timeout: 5000 }).then(() => true, () => false), 'the open page hears of it and does not restart it');
  check(/no IroWell server is running/.test(stopCli()), '--stop with no server running says so');
}

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
killDaemon();
if (usageBackup) fs.writeFileSync(usageFile, usageBackup); else fs.rmSync(usageFile, { force: true });
if (foldersBackup) fs.writeFileSync(foldersFile, foldersBackup); else fs.rmSync(foldersFile, { force: true });
{ const f = path.join(IRO_DIR, 'archived.json'), a = JSON.parse(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '[]').filter((x) => !x.startsWith('00000000-0000-4000-8000-')); if (a.length) fs.writeFileSync(f, JSON.stringify(a)); else fs.rmSync(f, { force: true }); }

// ---- 4a. two daemons started at once over a dead daemon's socket: one runs, the other leaves ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-race-'));
  const sock = path.join(dir, 'daemon.sock');
  fs.writeFileSync(sock, ''); // left behind (not listening)
  fs.writeFileSync(path.join(dir, 'daemon.lock'), '999999'); // and a dead daemon's lock
  const start = () => { const d = spawn(process.execPath, [path.join(REPO, 'server/daemon.mjs')], { cwd: dir, env: cleanEnv({ IRO_DIR: dir }), stdio: 'ignore' }); d.on('exit', () => (d.gone = true)); return d; };
  const ds = [start(), start()];
  await wait(3000);
  const net = await import('node:net');
  const reachable = await new Promise((r) => { const c = net.connect(sock); c.once('data', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
  const running = ds.filter((d) => !d.gone);
  check(running.length === 1 && reachable && Number(fs.readFileSync(path.join(dir, 'daemon.lock'), 'utf8')) === running[0]?.pid,
    `two daemons at once: one runs and owns the socket, the other exits (${running.length} running, reachable: ${reachable})`);
  for (const d of ds) d.kill();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
}

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
