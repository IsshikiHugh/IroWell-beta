// Quick suite: no model calls. Syntax, protocol basics, and the UI around a blank session
// (a Claude process that has not been sent anything). Takes well under a minute.
import { chromium } from 'playwright-core';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, addFolder, killDaemon, check, until, wait, finish, answerDialogs, eventStream, hold, daemonAsk } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// run.mjs runs this suite as four parts at once, each with its own port, daemon and folders
// (IRO_QUICK_PART): A the blank session's UI, B Settings and the usage page, C the queue, streaming
// and the rail, D stopping and the daemon's own exits. With no part set, it runs them all in turn.
const PART = process.env.IRO_QUICK_PART || '';
const runs = (p) => !PART || PART === p;
const S = PART ? path.join(outDir(), `quick-${PART}`) : outDir();
fs.mkdirSync(S, { recursive: true });
const PORTS = { A: 4770, B: 4804, C: 4805, D: 4806 }; // (run.mjs reads this line)
const PORT = PORTS[PART || 'A'];
const WORK = path.join(S, 'quick-work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'src'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'calc.py'), 'def add(a, b):\n    return a + b\n');
fs.writeFileSync(path.join(WORK, 'src', 'notes.md'), '# notes\n');
fs.mkdirSync(path.join(WORK, '.claude'));
fs.writeFileSync(path.join(WORK, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'plan' } })); // a draft here shows Plan


// ---- 1. syntax of every source file ----
if (runs('A')) {
const sources = [
  'server/daemon.mjs', 'server/attach.mjs', 'server/shared.mjs', 'client/client.mjs', 'client/main.mjs', 'client/skills.mjs', 'skills/remote/port.mjs', 'skills/progress/progress.mjs', 'skills/workplace/workplace.mjs', 'skills/session-context/sessions.mjs', 'skills/daemon.mjs',
  ...fs.readdirSync(path.join(REPO, 'client/ui')).filter((f) => f.endsWith('.js')).map((f) => `client/ui/${f}`),
  ...fs.readdirSync(path.join(REPO, 'plugins')).filter((d) => fs.existsSync(path.join(REPO, 'plugins', d, 'ui.js'))).map((d) => `plugins/${d}/ui.js`),
];
let syntaxOk = true;
for (const f of sources) {
  try { execFileSync(process.execPath, ['--check', path.join(REPO, f)], { stdio: 'pipe' }); } catch (e) { syntaxOk = false; console.log(String(e.stderr)); }
}
check(syntaxOk, `syntax of ${sources.length} source files`);
}

// synthetic plan-usage history for the Usage page: 3 days, a sample every 30 minutes
// (the daemon must not add real samples: a real weekly reset would start a cycle the synthetic days are not in)
process.env.IRO_NO_USAGE_RECORD = '1';
process.env.IRO_COMPACT_MS = '500'; // the event log is trimmed every half second (else every minute)
// the UI Skills page edits a copy of skills/, never the checkout's
const SKILLS = path.join(S, 'quick-skills');
fs.cpSync(path.join(REPO, 'skills'), SKILLS, { recursive: true });
process.env.IRO_SKILLS_DIR = SKILLS;
// the widgets: the checkout's clock, a plugin whose tile opens nothing, and one whose ui.js fails
const PLUGINS = path.join(S, 'quick-plugins');
fs.rmSync(PLUGINS, { recursive: true, force: true });
fs.cpSync(path.join(REPO, 'plugins', 'clock'), path.join(PLUGINS, 'clock'), { recursive: true });
for (const [name, ui] of [['still', "export default { tile(el) { el.textContent = 'ok'; } };"], ['broken', "throw new Error('boom');"]]) {
  fs.mkdirSync(path.join(PLUGINS, name));
  fs.writeFileSync(path.join(PLUGINS, name, 'plugin.json'), JSON.stringify({ title: name }));
  fs.writeFileSync(path.join(PLUGINS, name, 'ui.js'), ui);
}
process.env.IRO_PLUGINS_DIR = PLUGINS;
// the Output style page edits this folder in place of ~/.claude: a style of the user's, and their settings
const STYLES_HOME = path.join(S, 'quick-claude');
fs.rmSync(STYLES_HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(STYLES_HOME, 'output-styles'), { recursive: true });
fs.writeFileSync(path.join(STYLES_HOME, 'output-styles', 'mine.md'), '---\nname: Mine\ndescription: A style of my own\ncolor: blue\n---\n\nAnswer in haiku.\n');
fs.writeFileSync(path.join(STYLES_HOME, 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2));
process.env.IRO_STYLES_HOME = STYLES_HOME;
const IRO_DIR = process.env.IRO_DIR; // this suite's own state dir (test/lib.mjs)
fs.mkdirSync(IRO_DIR, { recursive: true });
const usageFile = path.join(IRO_DIR, 'usage.jsonl');
let fiveResets = 0; // when the synthetic history's last 5-hour window resets
{
  const lines = [];
  const now = Date.now();
  const slot0 = Math.ceil((now - 3 * 24 * 3600e3) / 1800e3) * 1800e3; // on the :00/:30 marks, as the daemon stamps them
  for (let t = slot0; t <= now; t += 1800e3) {
    const win = Math.floor(t / (5 * 3600e3));
    const into = (t % (5 * 3600e3)) / (5 * 3600e3);
    const five = Math.round(into * 60);
    const week = Math.min(99, Math.round(((t - (now - 3 * 24 * 3600e3)) / (3 * 24 * 3600e3)) * 40) + 10);
    fiveResets = (win + 1) * 5 * 3600e3;
    lines.push(JSON.stringify({ t, five: { pct: five, resets: new Date(fiveResets).toISOString() }, week: { pct: week, resets: new Date(now + 4 * 24 * 3600e3).toISOString() } }));
  }
  fs.writeFileSync(usageFile, lines.join('\n') + '\n');
}
// Transcripts for the cost of the work (the daemon reads these instead of ~/.claude/projects): an answer
// every half hour for 3 days at $2.004 each, every one written twice (once per content block, the first
// with the counts so far), the lot copied into a second transcript (a resumed session), and one more
// answer by a subagent.
const COST_DIR = path.join(S, 'quick-cost');
process.env.IRO_COST_DIR = COST_DIR;
let costAnswers = 0;
{
  const dir = path.join(COST_DIR, '-quick-project');
  fs.mkdirSync(path.join(dir, 'aaaa', 'subagents'), { recursive: true });
  const now = Date.now(), lines = [];
  const answer = (id, t, out) => JSON.stringify({ type: 'assistant', timestamp: new Date(t).toISOString(), message: { id, model: 'claude-opus-5-5', usage: {
    input_tokens: 1000, output_tokens: out, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e5, cache_creation: { ephemeral_1h_input_tokens: 1e5, ephemeral_5m_input_tokens: 0 }, speed: 'standard' } } });
  for (let t = now - 3 * 24 * 3600e3 + 60e3; t < now; t += 1800e3) { lines.push(answer(`msg_${t}`, t, 10), answer(`msg_${t}`, t, 50000)); costAnswers++; }
  fs.writeFileSync(path.join(dir, 'aaaa.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'bbbb.jsonl'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'aaaa', 'subagents', 'agent-1.jsonl'), answer('msg_sub', now - 3600e3, 50000) + '\n');
  costAnswers++;
  // Other models, at the prices of pricing.md: a Sonnet 5.5 cache read ($0.10 per million, not Sonnet 5's
  // $0.20), and Claude Haiku 5.5 under and over its 100,000-token prompt (input and cache read together).
  const other = (id, model, usage) => JSON.stringify({ type: 'assistant', timestamp: new Date(now - 7200e3).toISOString(), message: { id, model, usage } });
  fs.writeFileSync(path.join(dir, 'cccc.jsonl'), [
    other('msg_sonnet', 'claude-sonnet-5-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 }), // $0.10
    other('msg_haiku_short', 'claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1e6, cache_read_input_tokens: 40000 }), // $0.0050 + $0.5 + $0.0004
    other('msg_haiku_long', 'claude-haiku-5-5', { input_tokens: 50000, output_tokens: 1e6, cache_read_input_tokens: 60000 }), // $0.025 + $2.5 + $0.003
  ].join('\n') + '\n');
}
const COST_OTHER = 0.1 + 0.5054 + 2.528;

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
if (runs('A')) {
check((await req('POST', '/cmd', { body: '{}' })).status === 403, 'POST without token → 403');
check((await req('GET', '/', { host: 'evil.com:' + PORT })).status === 403, 'foreign Host header → 403');
check((await req('POST', '/cmd', { headers: { 'x-token': token }, body: '{"type":"sync"}' })).status === 400, 'internal commands are not exposed');
check((await Promise.all(['adopt', 'retire', 'toString'].map((type) => req('POST', '/cmd', { headers: { 'x-token': token }, body: JSON.stringify({ type }) })))).every((r) => r.status === 400),
  'nor the ones between daemons, nor names that are not commands');
check(/img-src 'self' data: blob:/.test((await req('GET', '/')).headers['content-security-policy']), 'the page may load images only from itself');
check(/empty/.test((await rpc({ type: 'new', cwd: WORK, text: '  ' })).error || ''), 'empty first message is rejected');
check(/Not a directory/.test((await rpc({ type: 'new', cwd: '/no/such/dir', text: 'x' })).error || ''), 'missing directory is rejected');
check(/doesn't know/.test((await rpc({ type: 'nonsense' })).error || '') || (await rpc({ type: 'nonsense' })).status === 400, 'unknown commands are refused');
const hist = await rpc({ type: 'history' });
check(Array.isArray(hist.data), `history lists sessions (${hist.data?.length ?? 'error'})`);
// This machine is no remote server (test/full/ports.mjs has one): a session is told nothing about ssh, the
// skill's script says there is nothing to forward, and the client forwards nothing.
// (asked of the daemon itself, on its socket: a command the client doesn't pass on)
const daemonSays = async (cmd) => (await daemonAsk(process.env.IRO_DIR, cmd))?.data ?? null;
{
  const prompt = await daemonSays({ type: 'uiPrompt' });
  check(prompt?.includes('# IroWell UI') && !/Remote machine|\{\{/.test(prompt), 'on this machine a session\'s system prompt has the UI part and nothing about a remote machine');
  let out = '';
  try { out = execFileSync(process.execPath, [path.join(REPO, 'skills', 'remote', 'port.mjs'), '5173'], { stdio: 'pipe' }).toString(); } catch (e) { out = String(e.stdout) + String(e.stderr); }
  check(/^5173 -> http:\/\/localhost:5173\/ +\(the user is on this machine/.test(out), `the remote skill's script says there is nothing to forward here (${out.trim()})`);
  check(/this machine/.test((await rpc({ type: 'openPort', port: 5173 })).error || ''), 'and the client forwards no port of this machine');
}

}

// ---- 3. UI around a blank session ----
const browser = await chromium.launch({ executablePath: browserPath() });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
// window.__iroFeed(msg): a message as if it came down the page's event stream (to stage what a remote server sends)
await ctx.addInitScript(() => {
  const E = window.EventSource, open = [];
  window.EventSource = class extends E { constructor(...a) { super(...a); open.push(this); } };
  window.__iroFeed = (d) => open.at(-1).onmessage({ data: JSON.stringify(d) });
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let nativeDialogs = 0;
page.on('dialog', (d) => { nativeDialogs++; console.log('NATIVE DIALOG:', d.message()); d.dismiss(); }); // the page draws its own (ui/dialog.js)
await answerDialogs(page);
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
const FOLDER = `.folder[data-dir="${fs.realpathSync(WORK)}"]`;
let liveSid; // the blank session's title (the work folder's row)
if (runs('A')) {
{
  // your avatar's letter: the first letter of the host's git user.name (else the login name)
  let name = '';
  try { name = execFileSync('git', ['config', '--global', 'user.name']).toString().trim(); } catch {}
  name ||= os.userInfo().username;
  const me = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--me').trim());
  check(me === JSON.stringify([...name][0].toUpperCase()), `the avatar shows your initial (${me}, from "${name}")`);
}

check(await page.title() === `IroWell at local`, `the browser tab names the server (${await page.title()})`);
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
// so does a rename, with no process to tell: the row and recent.json take the name (then back, for the checks below)
for (const name of ['renamed nine', 'remembered 9']) {
  await page.fill('#input', `/rename ${name}`);
  await page.press('#input', 'Escape');
  await page.press('#input', 'Enter');
  await page.waitForFunction((t) => document.querySelector('.sess.active .sess-title')?.textContent === t, name, { timeout: 5000 }).catch(() => {});
  const saved = JSON.parse(fs.readFileSync(path.join(IRO_DIR, 'recent.json'), 'utf8'))[fs.realpathSync(REM)];
  check(await page.locator('.sess.active .sess-title').textContent() === name && await page.textContent('#title') === name
    && saved.find((x) => x.id === '00000000-0000-4000-8000-000000000009')?.title === name && saved[0].id === '00000000-0000-4000-8000-000000000009'
    && (await page.locator('#closeSess').textContent()) === 'Reattach',
    `a session remembered from before a restart is renamed without reattaching it, and the name is saved (${name})`);
}
await page.fill('#input', '');
// once you leave it, the coloured detached row goes grey like any other detached row
await page.locator('.sess', { hasText: 'remembered 8' }).click();
{
  // (the list redraws after the click: wait for it rather than read a row mid-update)
  await page.waitForFunction(() => {
    const v = [...document.querySelectorAll('.sess')].filter((r) => /remembered [97]\b/.test(r.textContent)).map((r) => getComputedStyle(r).getPropertyValue('--sc').trim());
    return v.length === 2 && !!v[0] && v[0] === v[1];
  }, null, { timeout: 5000 }).catch(() => {});
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
{
  // a reply's parts by what they are for: :::log / :::reply / :::ask blocks (skills/system-prompt.md, item 4)
  const roles = await page.evaluate(async () => {
    const r = await import('/ui/render.js');
    const turn = document.createElement('div'); turn.className = 'turn'; turn.id = 'roles';
    const body = document.createElement('div'); body.className = 'turn-body'; turn.append(body);
    const el = r.markdown([':::log', 'Ran the tests: `3 failed`, then fixed the import.', ':::', '', ':::reply', 'The parser now **splits** the reply.', ':::', '',
      '- a list just above', ':::ask', '1. Keep the old syntax too?', ':::', '', ':::reply', '```md', ':::', 'inside a fence', '```', ':::', 'outside again', '',
      ':::log', 'First line of a longer log.', '', '- and more below it', ':::'].join('\n'));
    el.classList.add('assistant');
    body.append(el);
    document.getElementById('feed').append(turn);
    const kinds = (e) => [...e.children].map((c) => c.classList.contains('md-role') ? c.className.match(/md-(log|reply|ask)/)[1] : c.tagName.toLowerCase());
    const font = (s) => parseFloat(getComputedStyle(el.querySelector(s)).fontSize);
    const mark = (s) => getComputedStyle(el.querySelector(s), '::before').content;
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); // the logs are measured
    const [short, long] = [...el.querySelectorAll('.md-log')];
    const bodyOf = (l) => l.querySelector('.md-role-body');
    const dot = (l) => getComputedStyle(l.querySelector('.md-log-dot')).backgroundColor;
    const folded = bodyOf(long).offsetHeight, dots = [dot(short), dot(long)];
    short.click(); bodyOf(long).click(); // the text itself opens nothing
    const still = [short.classList.contains('open'), bodyOf(long).offsetHeight === folded];
    long.querySelector('.md-log-dot').click();
    const opened = bodyOf(long).offsetHeight;
    dots.push(dot(long));
    return { kinds: kinds(el), fence: el.querySelector('.md-reply pre')?.textContent, ul: el.querySelector('ul .md-role') === null,
      bare: kinds(r.markdown('Now the config.\n\n:::reply\nDone.\n:::\n\nAfter it.', 'log')), plain: kinds(r.markdown('No marks here', 'log')),
      log: font('.md-log'), res: font('.md-reply'), typing: kinds(r.markdown(':::log\nhalf typed')), half: r.markdown('text\n\n:::as').textContent.trim(), halfN: r.markdown('text\n\n:::ask[1').textContent.trim(),
      numbered: (() => { const m = r.markdown(':::ask[1]\nFirst?\n:::\n\n:::ask[ 2 ]\n2.1 This?\n2.2 That?\n:::'); turn.querySelector('.turn-body').append(m);
        return { n: [...m.querySelectorAll('.md-ask')].map((a) => a.dataset.n), marks: [...m.querySelectorAll('.md-ask')].map((a) => getComputedStyle(a, '::before').content), text: m.textContent.includes('[') }; })(),
      marks: [mark('.md-reply'), mark('.md-ask')], more: [short.classList.contains('more'), long.classList.contains('more')], folded, opened, line: bodyOf(short).offsetHeight, dots, still };
  });
  check(JSON.stringify(roles.kinds) === '["log","reply","ul","ask","reply","p","log"]' && roles.ul && /^:::\ninside a fence/.test(roles.fence || ''),
    `:::log / :::reply / :::ask become blocks; a list above keeps out of them; a fence inside keeps its ::: (${JSON.stringify(roles.kinds)})`);
  check(JSON.stringify(roles.bare) === '["log","reply","log"]' && JSON.stringify(roles.plain) === '["log"]',
    `text in a reply left without a marker shows as a log (${JSON.stringify(roles.bare)}, ${JSON.stringify(roles.plain)})`);
  check(roles.log < roles.res && JSON.stringify(roles.typing) === '["log"]' && roles.half === 'text',
    `a log reads smaller; a block still typing shows as one; a half-typed marker is hidden (${roles.log} vs ${roles.res}px, "${roles.half}")`);
  check(JSON.stringify(roles.numbered.n) === '["1","2"]' && JSON.stringify(roles.numbered.marks) === '["\\"1\\"","\\"2\\""]' && !roles.numbered.text && roles.halfN === 'text',
    `:::ask[n] is a question marked with its number; a half-typed :::ask[1 is hidden (${JSON.stringify(roles.numbered)}, "${roles.halfN}")`);
  check(JSON.stringify(roles.marks) === '["\\"!\\"","\\"?\\""]' && JSON.stringify(roles.more) === '[false,true]' && roles.folded === roles.line && roles.opened > roles.folded * 2
    && roles.dots[0] === 'rgba(0, 0, 0, 0)' && roles.dots[1] !== roles.dots[0] && roles.dots[2] === roles.dots[0] && JSON.stringify(roles.still) === '[false,true]',
    `a reply and a question are marked ! and ?; a longer log shows its first line, with a filled dot that opens it (a ring once open, or with nothing more); clicking the text does nothing (${JSON.stringify(roles)})`);
  await page.locator('#roles').screenshot({ path: path.join(S, 'roles.png') });
  await page.evaluate(() => document.getElementById('roles').remove());
}
{
  // ```mermaid: a closed block draws (once: drawing the reply again finds the SVG at once), one still
  // streaming in stays code, a broken one shows its source and why; Source/Copy give the source
  const SRC = 'flowchart LR\n  a["Start (x)"] --> b{ok?}\n  b -->|yes| c[Done]';
  await page.evaluate(async ([src]) => {
    const r = await import('/ui/render.js');
    const box = document.createElement('div'); box.id = 'diagrams';
    box.append(r.markdown(`Flow:\n\n\`\`\`mermaid\n${src}\n\`\`\`\n`), r.markdown(`Still typing:\n\n\`\`\`mermaid\n${src}\n`),
      r.markdown('```mermaid\nflowchart LR\n  a --> end\n  ((\n```'));
    document.getElementById('feed').append(box);
  }, [SRC]);
  const blocks = page.locator('#diagrams .diagram-block');
  await page.locator('#diagrams .diagram-block .diagram-view > svg').first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.locator('#diagrams .diagram-block.failed').waitFor({ timeout: 10000 }).catch(() => {});
  check(await blocks.count() === 2 && await page.locator('#diagrams .codeblock:not(.diagram-source)').count() === 1, 'a closed mermaid block is a diagram, an unclosed one stays code');
  const first = blocks.nth(0), frame = first.locator('.diagram');
  check(await frame.locator('.diagram-view > svg').count() === 1 && (await frame.textContent()).includes('Start (x)') && !await first.locator('.diagram-source').isVisible(), 'the diagram is drawn, its source hidden');
  const failed = blocks.nth(1);
  check(await failed.evaluate((e) => e.classList.contains('failed')) && await failed.locator('.diagram-source pre').isVisible() && /couldn't draw/.test(await failed.locator('.code-lang').textContent()),
    `a broken diagram shows its source and why (${await failed.locator('.code-lang').textContent()})`);
  check(await page.evaluate(() => document.querySelectorAll('body > [id^="ddiagram-"], body > svg[id^="diagram-"]').length) === 0, 'mermaid leaves nothing behind in the page');
  // GitHub-style viewer: buttons on hover, zoom/pan/reset, drag, ⌘/Ctrl-scroll
  const opacity = () => first.locator('.diagram-pad').evaluate((e) => getComputedStyle(e).opacity);
  const before = await opacity();
  await frame.hover();
  await page.waitForFunction((e) => getComputedStyle(e).opacity === '1', await first.locator('.diagram-pad').elementHandle(), { timeout: 3000 }).catch(() => {}); // (they fade in)
  check(before === '0' && await opacity() === '1', `the buttons show on hover (${before} → ${await opacity()})`);
  await page.screenshot({ path: path.join(S, 'mermaid-hover.png'), clip: await frame.boundingBox() });
  const tf = () => first.locator('.diagram-view').evaluate((e) => new DOMMatrix(getComputedStyle(e).transform));
  await first.locator('[data-act="zoom-in"]').click();
  const zin = await tf();
  await first.locator('[data-act="right"]').click();
  const panned = await tf();
  check(Math.abs(zin.a - 1.25) < 1e-6 && Math.abs(panned.e - zin.e - 60) < 1e-6, `zoom in and pan buttons (scale ${zin.a}, moved ${panned.e - zin.e})`);
  await first.locator('[data-act="reset"]').click();
  const reset = await tf();
  check(reset.a === 1 && reset.e === 0 && reset.f === 0, 'reset puts it back');
  await frame.scrollIntoViewIfNeeded();
  const fb = await frame.boundingBox();
  await page.mouse.move(fb.x + 30, fb.y + 30);
  await page.mouse.down();
  await page.mouse.move(fb.x + 70, fb.y + 50, { steps: 4 });
  await page.mouse.up();
  const dragged = await tf();
  check(dragged.e === 40 && dragged.f === 20, `dragging pans it (${dragged.e}, ${dragged.f})`);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  check((await tf()).a > 1.2 && (await tf()).a < 1.3, `Ctrl-scroll zooms, a notch at a time (${(await tf()).a})`);
  await first.locator('[data-act="source"]').click();
  check(await first.locator('.diagram-source pre').isVisible() && !await frame.isVisible(), 'the source button shows the mermaid source');
  await first.locator('.diagram-toggle').click();
  check(await frame.isVisible() && !await first.locator('.diagram-source').isVisible(), 'and Diagram goes back');
  await frame.hover();
  await first.locator('[data-act="copy"]').click();
  await until(async () => await page.evaluate(() => navigator.clipboard.readText()) === SRC, 3000);
  check(await page.evaluate(() => navigator.clipboard.readText()) === SRC, 'Copy copies the source');
  await first.locator('[data-act="expand"]').click();
  const big = page.locator('.modal.diagram-modal .diagram-block.expanded');
  check(await big.locator('.diagram-view > svg').count() === 1 && (await big.locator('.diagram').boundingBox()).height > fb.height, 'Open larger shows it in a big dialog');
  await page.screenshot({ path: path.join(S, 'mermaid-large.png') });
  await page.locator('.modal-head button').click();
  const again = await page.evaluate(async ([src]) => (await import('/ui/render.js')).markdown(`\`\`\`mermaid\n${src}\n\`\`\``).querySelectorAll('.diagram-view > svg').length, [SRC]);
  check(again === 1, 'drawing the same diagram again finds its SVG at once');
  await page.mouse.move(0, 0);
  await page.locator('#diagrams').screenshot({ path: path.join(S, 'mermaid.png') });
  await page.evaluate(() => document.getElementById('diagrams').remove());
}
check(await page.locator('table.diff tr.add').count() === 1 && await page.locator('.tool.error').count() === 1 && await page.locator('ul.todos li').count() === 2, 'tool cards: diff, error, checklist');
{
  // a reply's table: a narrow one starts at the text's edge; a wide one spreads into both gutters equally,
  // centred on the column (the text is indented 34px in it), up to 20px from the conversation area's edges
  // (less half a scrollbar), and scrolls beyond that
  const g = await page.evaluate(async () => {
    const r = await import('/ui/render.js');
    const row = (n, w) => `| ${Array.from({ length: n }, (_, i) => `${w}${i}`).join(' | ')} |`;
    const tbl = (n, w) => `${row(n, 'h')}\n|${' --- |'.repeat(n)}\n${row(n, w)}`;
    const turn = document.createElement('div'); turn.className = 'turn';
    const body = document.createElement('div'); body.className = 'turn-body'; turn.append(body);
    const el = r.markdown(`${tbl(2, 'x')}\n\ntext\n\n${tbl(3, 'cell')}\n\ntext\n\n${tbl(3, 'cell')}\n\ntext\n\n${tbl(40, 'verywidecell')}`);
    el.classList.add('assistant');
    body.append(el);
    const feed = document.getElementById('feed');
    feed.append(turn);
    turn.scrollIntoView();
    const box = (e) => e.getBoundingClientRect().toJSON();
    const [n, s, w, vw] = [...el.querySelectorAll('table')];
    s.style.width = `${box(el).width + 20}px`; // wider than the text, narrower than the column
    w.style.width = `${box(el).width + 34 + 40}px`; // 20px past the column on each side
    return { md: box(el), area: box(document.getElementById('content')), sb: feed.offsetWidth - feed.clientWidth,
             n: box(n), s: box(s), w: box(w), vw: box(vw), scrolls: vw.scrollWidth > vw.clientWidth };
  });
  const near = (a, b) => Math.abs(a - b) < 1.5;
  const col = { left: g.md.left - 34, right: g.md.right };
  check(near(g.n.left, g.md.left) && g.n.width < g.md.width, `a narrow table stays at the text's left edge (${g.n.left} vs ${g.md.left})`);
  check(near(g.s.right, g.md.right) && near(g.s.left, g.md.left - 20), `a table a little wider than the text grows left into the indent (${Math.round(g.md.left - g.s.left)}px)`);
  check(near(col.left - g.w.left, 20) && near(g.w.right - col.right, 20),
    `a wider one spreads into both gutters equally, centred on the column (${Math.round(col.left - g.w.left)} / ${Math.round(g.w.right - col.right)}px)`);
  const [l, rt] = [g.vw.left - g.area.left, g.area.right - g.sb - g.vw.right];
  check(near(l, rt) && near(l, 20 - g.sb / 2) && g.scrolls, `a very wide table stops the same distance from both edges and scrolls (${Math.round(l)} / ${Math.round(rt)}px, scrollbar ${g.sb}px)`);
  await page.screenshot({ path: path.join(S, 'wide-table.png') });
}

// blank session: a live Claude process with nothing sent
await page.evaluate(() => localStorage.setItem('iro-rail-tab', 'resources')); // (a tab of an earlier version)
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
  await until(async () => await page.inputValue('#input') === 'typed meanwhile', 5000);
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
const rows = await page.evaluate(() => [...document.querySelectorAll('#statusbar .sb-row')].map((r) => [...r.children].filter((c) => !c.classList.contains('dd-native')).map((c) => c.id || (c.classList.contains('sess-slot') && c.firstElementChild.id) || c.className.split(' ')[0])));
check(rows.length === 1 && rows[0][0] === 'modelBtn' && rows[0][1] === 'dd-btn' && rows[0].includes('sb-ctx') && rows[0].at(-1) === 'closeSess' && rows[0].at(-2) === 'stop', `settings line: model, mode, context … Stop, Detach (${rows})`);
check(await page.locator('header .head-sub #sb-sid').count() === 1 && await page.locator('#statusbar #sb-sid').count() === 0 && await page.locator('header #sb-dir').isVisible(), 'the folder and session id sit under the title');
check((await page.locator('#railtabs button').allTextContents()).join('|') === 'Anchors|Tasks|btw', 'rail tabs: Anchors / Tasks / btw');
check(await page.locator('#railtabs button.active').textContent() === 'Anchors' && await page.locator('#outline').isVisible(), 'a remembered tab that is no more falls back to Anchors');
await page.click('#railtabs button[data-tab="tasks"]');
check((await page.locator('#runlist .run-item').first().textContent()).startsWith('main'), 'Tasks lists main');
check(await page.locator('#taskCount').isHidden(), 'the Tasks tab has no badge while only main is listed');
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
  await page.waitForFunction(() => document.getElementById('shell').contains(document.activeElement), null, { timeout: 5000 }).catch(() => {}); // (the keys go back to the shell)
  const mode0 = await page.inputValue('#mode');
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(300);
  check(await page.inputValue('#mode') === mode0, 'keys typed in the shell stay there (⇧Tab does not cycle the mode)');
  await page.click('#shell .sh-add');
  const newOn = async () => (await page.locator('#shell .sh-tab').count()) === 2
    && await page.locator('#shell .sh-tab.on').getAttribute('data-tid') === await page.locator('#shell .sh-tab').nth(1).getAttribute('data-tid');
  await until(newOn, 10000);
  check(await newOn(), '+ opens a second shell in its own tab');
  await page.locator('#shell .sh-tab').first().dblclick();
  await page.locator('#shell .sh-tab input').fill('build');
  await page.keyboard.press('Enter');
  await until(async () => ((await rpc({ type: 'shellList', sid })).data || []).some((t) => t.name === 'build'), 5000);
  check(await page.locator('#shell .sh-tab').first().textContent() === 'build', 'double-clicking a tab renames the shell');
  // (the animation is short: caught as it starts, not read once after the press)
  const lifted = await page.locator('#shell').evaluateHandle((el) => ({ started: new Promise((ok) => {
    el.addEventListener('animationstart', (ev) => { if (ev.animationName === 'sh-lift') ok(true); });
    setTimeout(() => ok(false), 5000);
  }) }));
  await page.keyboard.press('Control+Backquote');
  check(await lifted.evaluate((l) => l.started), '⌃` folds the panel away, animated');
  await page.locator('#shell').waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
  check(await page.locator('#shell').isHidden(), '… and then it is hidden');
  // a reload shows the shells again, with their recent output
  await page.reload();
  await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  await workRow.click();
  await page.keyboard.press('Control+Backquote');
  await page.locator('#shell .sh-tab').first().waitFor({ timeout: 10000 });
  await until(async () => /IRO_42/.test(await screen()), 15000);
  check((await page.locator('#shell .sh-tab').allTextContents()).join('|') === 'build|zsh 2'.replace('zsh', path.basename(process.env.SHELL || 'sh')) && /IRO_42/.test(await screen()), 'after a reload the shells and their output are still there');
  const before = ((await rpc({ type: 'shellList', sid })).data || []).map((t) => t.tid);
  await page.locator('#shell .sh-tab .sh-x').first().click();
  await until(async () => ((await rpc({ type: 'shellList', sid })).data || []).length === 1, 5000);
  check(((await rpc({ type: 'shellList', sid })).data || []).map((t) => t.tid).join() === before[1], '× closes a shell');
  await page.locator('#shell .sh-tab .sh-x').first().click();
  await until(async () => { const l = (await rpc({ type: 'shellList', sid })).data || []; return l.length === 1 && l[0].tid !== before[1]
    && (await page.locator('#shell .sh-tab').evaluateAll((ts) => ts.map((t) => t.dataset.tid))).join() === l[0].tid; }, 5000); // (the page shows it too)
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

// pasting: text wins over the picture of it an app adds (Excel, Feishu, Typeless); images attach when there
// is no text, or the text is only their file names (Finder); a type Claude can't take says so
{
  const thumbs = () => page.locator('#attach .thumb').count();
  const pastePng = (text, name) => page.evaluate(async ([text, name]) => {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    if (text) dt.setData('text/plain', text);
    dt.items.add(new File([png], name, { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById('input').dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [text, name]);
  await page.click('#input');
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['cells as text'], { type: 'text/plain' }), 'image/png': png })]);
  });
  await page.keyboard.press('ControlOrMeta+V');
  await until(async () => await page.inputValue('#input') === 'cells as text', 3000);
  check(await page.inputValue('#input') === 'cells as text' && await thumbs() === 0, `a paste of text with a picture of it pastes the text (${JSON.stringify(await page.inputValue('#input'))}, ${await thumbs()} images)`);
  await page.fill('#input', '');
  check(await pastePng('shot.png', 'shot.png') && await until(async () => await thumbs() === 1, 3000), 'an image file copied in Finder (its name as the text) attaches');
  await page.locator('#attach .thumb button').click();
  check(await pastePng('', 'image.png') && await until(async () => await thumbs() === 1, 3000), 'an image alone attaches');
  await page.locator('#attach .thumb button').click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(8)], 'a.tiff', { type: 'image/tiff' }));
    document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check(await page.locator('.toast.note', { hasText: "can't be attached" }).waitFor({ timeout: 3000 }).then(() => true, () => false) && await thumbs() === 0, 'an image of a type Claude can\'t take says so');
  await page.fill('#input', '');
}

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
  // (the system composes it with the key press; the page's clock stands still meanwhile, so a slow
  // machine doesn't push it past the 100 ms the guard allows)
  await page.evaluate(() => { const now = Date.now, t = now(); window.__now = now; Date.now = () => t; });
  await page.keyboard.press('Alt+KeyM');
  await cdp.send('Input.imeSetComposition', { text: '¯', selectionStart: 1, selectionEnd: 1 });
  await page.locator('.model-pop').waitFor({ timeout: 8000 }).catch(() => {});
  await until(async () => await page.inputValue('#input') === 'hi', 5000);
  await page.evaluate(() => { Date.now = window.__now; delete window.__now; });
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
await until(() => page.evaluate(() => document.querySelector('#popup:not([hidden]) .pop-item.sel .pop-main')?.textContent === '../quick-work/src/'), 8000);
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
const clipText = () => page.evaluate(() => navigator.clipboard.readText());
await page.locator('#refs code.code-copy', { hasText: 'src/notes.md:3' }).click();
const toasted = page.locator('.toast', { hasText: /^Copied/ }).first().waitFor({ timeout: 5000 }).then(() => true, () => false); // (it goes by itself)
await until(async () => await clipText() === 'src/notes.md:3', 3000);
check(await clipText() === 'src/notes.md:3', 'a click on path-like code copies its text as written');
check(await toasted, 'a toast confirms the copy');
await page.locator('#refs code.code-copy', { hasText: 'img/dot.png' }).click({ modifiers: ['Meta'] });
await page.waitForTimeout(400);
check(await page.locator('.modal').count() === 0, '⌘-click on path-like code opens nothing');
const realWork = fs.realpathSync(WORK);
await page.locator('#refs .path-ref', { hasText: 'notes' }).click();
const notesPath = (c) => c === path.join(WORK, 'src/notes.md') + ':2' || c === path.join(realWork, 'src/notes.md') + ':2';
await until(async () => notesPath(await clipText()), 3000);
const clip = await clipText();
check(notesPath(clip), `a link click copies the absolute path, keeping #L line numbers (${clip})`);
await page.locator('#refs .path-ref', { hasText: 'missing' }).click({ modifiers: ['Shift'] });
check(await page.locator('.toast', { hasText: 'Not found' }).waitFor({ timeout: 5000 }).then(() => true, () => false), 'Shift-click on a link to a missing file says so');
await page.locator('#refs .path-ref', { hasText: 'calc.py' }).click({ modifiers: ['Meta'] });
check(await page.locator('.modal .fileview').waitFor({ timeout: 8000 }).then(() => true, () => false), '⌘-click opens a text file in the viewer');
await page.keyboard.press('Escape');
fs.appendFileSync(path.join(WORK, 'calc.py'), '\n# edited after the first open\n');
await page.locator('#refs .path-ref', { hasText: 'calc.py' }).click({ modifiers: ['Meta'] });
await page.locator('.modal .fileview').waitFor({ timeout: 8000 }).catch(() => {});
check((await page.locator('.modal .fileview .src').textContent()).includes('edited after the first open'), 'a small text file is read again on each open: it shows the file as it is now');
await page.keyboard.press('Escape');
// a link that names lines (a.py:12-40) opens the file there, with those line numbers marked
fs.writeFileSync(path.join(WORK, 'long.py'), Array.from({ length: 400 }, (_, i) => `x${i + 1} = ${i + 1}`).join('\n') + '\n');
await mdRefs('refs6', `[range](${realWork}/long.py:123-234), [one](./long.py:300), [col](./long.py:7:5), [frag](long.py#L20-L25), [past](./long.py:390-999), [plain](long.py).`);
const lineRefs = await page.evaluate(() => [...document.querySelectorAll('#refs6 .path-ref')].map((a) => [a.dataset.path.split('/').pop(), a.dataset.line || '', a.dataset.lineEnd || ''].join(' ')));
check(JSON.stringify(lineRefs) === JSON.stringify(['long.py 123 234', 'long.py 300 ', 'long.py 7 ', 'long.py 20 25', 'long.py 390 999', 'long.py  ']), `a link's lines are read off its target (${JSON.stringify(lineRefs)})`);
await page.locator('#refs6 .path-ref', { hasText: 'range' }).click();
await until(async () => (await clipText()).endsWith('/long.py:123-234'), 3000);
check((await clipText()).endsWith('/long.py:123-234'), 'a click copies the path with its lines');
// what the viewer shows: the marked line numbers, and the first and last line number in view
const marked = async () => {
  await page.locator('.modal .fileview').waitFor({ timeout: 8000 }).catch(() => {});
  return page.evaluate(() => {
    const body = document.querySelector('.modal-body'), gutter = body.querySelector('.gutter'), mark = gutter.querySelector('.lines');
    const total = body.querySelector('.src').textContent.split('\n').length;
    const b = body.getBoundingClientRect(), g = gutter.getBoundingClientRect(), lh = parseFloat(getComputedStyle(gutter).lineHeight);
    const nums = mark ? mark.textContent.split('\n') : [];
    return { first: nums[0], last: nums.at(-1), scroll: body.scrollTop, top: Math.floor((b.top - g.top) / lh) + 1, bottom: Math.ceil((b.bottom - g.top) / lh), total, at: mark ? (mark.getBoundingClientRect().top - b.top) / b.height : null, even: Math.abs(g.height - total * lh) < 1,
      aligned: mark ? Math.abs(mark.getBoundingClientRect().top - g.top - (Number(nums[0]) - 1) * lh) < 1 : null, bg: mark ? getComputedStyle(mark).backgroundColor : '' };
  });
};
const openRef = async (name) => { await page.locator('#refs6 .path-ref', { hasText: name }).click({ modifiers: ['Meta'] }); const m = await marked(); await page.keyboard.press('Escape'); return m; };
let mk = await openRef('range');
check(mk.first === '123' && mk.last === '234' && mk.total === 401 && mk.even && mk.aligned && !/rgba\(0, 0, 0, 0\)|transparent/.test(mk.bg), `the lines a link names are marked in the gutter, each number still beside its line (${JSON.stringify(mk)})`);
check(Math.abs(mk.at - 0.4) < 0.02, `and the viewer opens with the first of them two fifths of the way down (${mk.at.toFixed(3)}; lines ${mk.top}–${mk.bottom} in view)`);
mk = await openRef('one');
check(mk.first === '300' && mk.last === '300' && Math.abs(mk.at - 0.4) < 0.02, `a single line works the same (${JSON.stringify(mk)})`);
mk = await openRef('past');
check(mk.first === '390' && mk.last === '401', `a range past the end stops at the last line (${JSON.stringify(mk)})`);
mk = await openRef('plain');
check(mk.first === undefined && mk.scroll === 0, `a link without lines opens at the top, nothing marked (${JSON.stringify(mk)})`);
// a big text file is fetched in chunks, its dialog showing how far along it is, and kept in memory:
// opening it again asks the server nothing more
let chunks = 0, converts = 0;
page.on('request', (r) => {
  if (r.url().endsWith('/cmd') && JSON.parse(r.postData() || '{}').type === 'readChunk') chunks++;
  if (r.url().includes('/convert?')) converts++;
});
const openFile = async (box, name, sel) => {
  await page.locator(`${box} .path-ref`, { hasText: name }).click({ modifiers: ['Meta'] });
  return page.locator(`.modal ${sel}`).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
};
fs.writeFileSync(path.join(WORK, 'big.log'), 'line of a big log\n'.repeat(20000));
// a folder never opens: ⌘-click does nothing, a plain click still copies its path
await mdRefs('refs4', `Log: [big.log](${WORK}/big.log:19990-19995), folder: [img](${WORK}/img), small: [calc.py](${WORK}/calc.py)`);
check(await openFile('#refs4', 'big.log', '.fileview') && (await page.locator('.modal .fileview .src').textContent()).startsWith('line of a big log') && chunks === 1,
  `a big text file is fetched, then shows in the viewer (${chunks} chunk)`);
check(await page.locator('.modal .gutter .lines').textContent() === Array.from({ length: 6 }, (_, i) => 19990 + i).join('\n'), 'at the lines its link names');
await page.keyboard.press('Escape');
await openFile('#refs4', 'calc.py', '.fileview');
await page.keyboard.press('Escape');
check(await openFile('#refs4', 'big.log', '.fileview') && chunks === 1, `opened again, it comes from memory (${chunks} chunk in all)`);
await page.keyboard.press('Escape');
// changed on the server: fetched again
fs.appendFileSync(path.join(WORK, 'big.log'), 'the line added later\n');
check(await openFile('#refs4', 'big.log', '.fileview') && chunks === 2 && (await page.locator('.modal .fileview .src').textContent()).includes('the line added later'),
  `a file that changed on the server is fetched again (${chunks} chunks in all)`);
await page.keyboard.press('Escape');
{ // … also when only its modification time says so (same size)
  const f = path.join(WORK, 'big.log'), text = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, text.replace('the line added later', 'THE LINE ADDED LATER'));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  check(await openFile('#refs4', 'big.log', '.fileview') && chunks === 3 && (await page.locator('.modal .fileview .src').textContent()).includes('THE LINE ADDED LATER'),
    `one of the same size but a newer modification time too (${chunks} chunks in all)`);
  await page.keyboard.press('Escape');
}
// not opened for an hour: dropped the next time a file is opened (no timer), so the open after that fetches it again
await page.evaluate(() => { const now = Date.now; window.__now = now; Date.now = () => now() + 59 * 60e3; });
await openFile('#refs4', 'calc.py', '.fileview');
await page.keyboard.press('Escape');
await page.evaluate(() => { Date.now = window.__now; });
check(await openFile('#refs4', 'big.log', '.fileview') && chunks === 3, `a file opened 59 minutes ago is still kept (${chunks} chunks in all)`);
await page.keyboard.press('Escape');
await page.evaluate(() => { const now = window.__now; Date.now = () => now() + 61 * 60e3; });
await openFile('#refs4', 'calc.py', '.fileview');
await page.keyboard.press('Escape');
await page.evaluate(() => { Date.now = window.__now; delete window.__now; });
check(await openFile('#refs4', 'big.log', '.fileview') && chunks === 4, `one not opened for an hour was dropped: it is fetched again (${chunks} chunks in all)`);
await page.keyboard.press('Escape');
await page.locator('#refs4 .path-ref', { hasText: 'img' }).hover();
await page.waitForTimeout(400);
await page.locator('#refs4 .path-ref', { hasText: 'img' }).click({ modifiers: ['Meta'] });
await page.waitForTimeout(400);
await until(async () => await page.locator('#refs4 .path-ref.path-dir').count() === 1, 5000); // (known as a folder once the server says so)
check(await page.locator('#refs4 .path-ref.path-dir').count() === 1 && await page.locator('.modal').count() === 0, 'a folder reference does not open');
await page.locator('#refs .path-ref', { hasText: 'dot.png' }).click({ modifiers: ['Control'] });
check(await page.locator('.modal img.res-media').waitFor({ timeout: 15000 }).then(() => true, () => false)
  && await page.waitForFunction(() => document.querySelector('.modal img.res-media')?.naturalWidth === 2, null, { timeout: 5000 }).then(() => true, () => false), 'Ctrl-click on an image shows it in a dialog');
{ // the image can be zoomed and panned, in the frame the diagrams have
  const view = () => page.evaluate(() => {
    const img = document.querySelector('.modal .res-image img'), m = new DOMMatrix(getComputedStyle(document.querySelector('.modal .res-image .diagram-view')).transform);
    return { s: Math.round(m.a * 1000) / 1000, x: Math.round(m.e), y: Math.round(m.f), pixels: img.classList.contains('pixels'), w: Math.round(img.getBoundingClientRect().width) };
  });
  const frame = page.locator('.modal .res-image .diagram');
  const box = await frame.boundingBox();
  const v0 = await view();
  const card = await frame.evaluate((f) => { const c = getComputedStyle(f); return [c.backgroundColor, c.borderTopWidth, c.paddingTop].join(' '); });
  check(card === 'rgba(0, 0, 0, 0) 0px 0px', `the image lies on the dialog itself: no card behind it (${card})`);
  const dlg = await page.evaluate(() => { const r = document.querySelector('.modal.media-modal')?.getBoundingClientRect(); return r && [r.width / innerWidth, r.height / innerHeight].map((f) => Math.round(f * 100)); });
  check(v0.s === 1 && !v0.pixels && dlg?.join() === '90,90' && box.height > 400, `an image opens whole, in a dialog of 90% of the page with room to zoom (${JSON.stringify(v0)}, ${Math.round(box.width)}×${Math.round(box.height)}, dialog ${dlg}%)`);
  await frame.hover();
  const acts = await page.locator('.modal .res-image .diagram button').evaluateAll((bs) => bs.map((b) => b.dataset.act).join());
  check(acts === 'zoom-in,zoom-out,reset', `its buttons: zoom in, zoom out, reset (${acts})`);
  await page.locator('.modal .res-image [data-act="zoom-in"]').click();
  await page.locator('.modal .res-image [data-act="zoom-out"]').click();
  check((await view()).s === 1, 'Zoom out undoes a Zoom in');
  await page.locator('.modal .res-image [data-act="zoom-in"]').click();
  const v1 = await view();
  check(v1.s === 1.25 && v1.w === Math.round(v0.w * 1.25), `Zoom in enlarges it (${JSON.stringify(v1)})`);
  for (let i = 0; i < 4; i++) await page.locator('.modal .res-image [data-act="zoom-in"]').click();
  const v2 = await view();
  check(v2.s > 3 && v2.pixels && await page.evaluate(() => getComputedStyle(document.querySelector('.modal .res-image img')).imageRendering) === 'pixelated', `zoomed far in, its pixels are drawn as squares (${JSON.stringify(v2)})`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < 80; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  const v3 = await view();
  check(v3.s === 40, `Ctrl-scroll zooms too, up to 40 times (${JSON.stringify(v3)})`);
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 130, { steps: 4 });
  await page.mouse.up();
  const v4 = await view();
  check(v4.x - v3.x === 60 && v4.y - v3.y === 30, `dragging pans it (${v4.x - v3.x}, ${v4.y - v3.y})`);
  await page.screenshot({ path: path.join(S, 'image-zoom.png') });
  await page.locator('.modal .res-image [data-act="reset"]').click();
  const v5 = await view();
  check(v5.s === 1 && v5.x === 0 && v5.y === 0 && !v5.pixels, `Reset shows it whole again (${JSON.stringify(v5)})`);
}
await page.keyboard.press('Escape');
// an SVG gets a data: URL (a blob: one has the page's origin: opened in a tab, its scripts would run there)
fs.writeFileSync(path.join(WORK, 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><script>parent.pwned=1</script><rect width="3" height="2"/></svg>');
await mdRefs('refs5', `Logo: [logo.svg](${WORK}/img/logo.svg)`);
await openFile('#refs5', 'logo.svg', 'img.res-media');
check(await page.waitForFunction(() => { const i = document.querySelector('.modal img.res-media'); return !!i && i.src.startsWith('data:image/svg+xml') && i.naturalWidth === 3; }, null, { timeout: 5000 }).then(() => true, () => false),
  'an SVG is shown from a data: URL');
await page.keyboard.press('Escape');
// a bigger file arrives in 1 MB chunks, the dialog showing how far along it is; closing the dialog doesn't stop it
fs.writeFileSync(path.join(WORK, 'clip.bin'), Buffer.alloc(2_600_000, 0)); // not a video (that would be checked and converted): just exercises the chunked download
await mdRefs('refs2', `Data: [clip.bin](${WORK}/clip.bin)`);
{
  const slow = async (route) => { if (JSON.parse(route.request().postData() || '{}').type === 'readChunk') await wait(400); await route.continue().catch(() => {}); };
  await page.route('**/cmd', slow);
  const before = chunks;
  check(await openFile('#refs2', 'clip.bin', '.res-wait .res-bar') && /^loading \d+% · 2\.5 MB$/.test(await page.locator('.modal .res-wait .meta').textContent()), 'while a file loads, its dialog shows how far along it is');
  await page.screenshot({ path: path.join(S, 'file-loading.png') });
  await page.keyboard.press('Escape');
  await until(() => chunks - before === 3, 10000, 'the download goes on after its dialog is closed');
  await page.unroute('**/cmd', slow);
  check(chunks - before === 3, `a 2.6 MB file loads in chunks, also once its dialog is closed (${chunks - before})`);
  check(await openFile('#refs2', 'clip.bin', '.modal-body > .meta') && (await page.locator('.modal-body').textContent()).startsWith('Binary file') && chunks - before === 3, 'opened again, it is there');
  await page.keyboard.press('Escape');
}
// a file over the limit for its kind is not fetched
{
  const f = path.join(WORK, 'huge.log');
  fs.closeSync(fs.openSync(f, 'w'));
  fs.truncateSync(f, 17 * 1024 * 1024);
  await mdRefs('refs7', `Huge: [huge.log](${f})`);
  const before = chunks;
  await page.locator('#refs7 .path-ref').click({ modifiers: ['Meta'] });
  check(await page.locator('.toast', { hasText: 'too big to preview' }).waitFor({ timeout: 5000 }).then(() => true, () => false) && await page.locator('.modal').count() === 0 && chunks === before, 'a file over the limit is not fetched: a note says so');
}
// an OpenCV-style MPEG-4 Part 2 video (no browser plays it) is converted on this computer (the local client), not the server
let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2', '-c:v', 'mpeg4', path.join(WORK, 'mocap.mp4')]); } catch { hasFfmpeg = false; }
if (hasFfmpeg) {
  await mdRefs('refs3', `Result: [mocap.mp4](${WORK}/mocap.mp4)`);
  await page.locator('#refs3 .path-ref').click({ modifiers: ['Meta'] });
  const w = await page.waitForFunction(() => document.querySelector('.modal video')?.videoWidth, null, { timeout: 60000 }).then((h) => h.jsonValue(), () => 0);
  check(converts === 1, 'an MPEG-4 Part 2 video is converted by the local client');
  check(w === 320, 'the converted video plays in its dialog'); // H.264, or VP9 in a browser without H.264
  // frame by frame (an MP4 lists its frames; the test video has 30, 15 a second)
  if (await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '')) {
    const bar = page.locator('.modal .res-frames');
    await bar.waitFor({ timeout: 5000 }).catch(() => {});
    const state = async () => {
      await page.waitForFunction(() => !document.querySelector('.modal video').seeking, null, { timeout: 5000 }).catch(() => {});
      return page.evaluate(() => {
        const v = document.querySelector('.modal video'), b = document.querySelector('.modal .res-frames');
        return { n: b.querySelector('input').value, of: b.querySelector('.res-frame-of').textContent, shown: Math.floor(v.currentTime * 15 + 1e-6), paused: v.paused, back: !b.querySelectorAll('button')[0].disabled, on: !b.querySelectorAll('button')[1].disabled };
      });
    };
    const to = async (n) => { await bar.locator('input').fill(String(n)); await bar.locator('input').press('Enter'); return state(); };
    let f = await to(20);
    check(f.of === '/ 29' && f.n === '20' && f.shown === 20 && f.paused, `a frame number typed in goes to that frame, paused (${JSON.stringify(f)})`);
    await bar.locator('button[title="Next frame"]').click();
    f = await state();
    check(f.n === '21' && f.shown === 21, `Next frame steps one frame on (${JSON.stringify(f)})`);
    await bar.locator('button[title="Previous frame"]').click();
    await bar.locator('button[title="Previous frame"]').click();
    f = await state();
    check(f.n === '19' && f.shown === 19, `Previous frame steps back, one frame a click (${JSON.stringify(f)})`);
    f = await to(999);
    check(f.n === '29' && f.shown === 29 && !f.on && f.back, `past the end is the last frame, with no step on from it (${JSON.stringify(f)})`);
    f = await to(0);
    check(f.n === '0' && f.shown === 0 && !f.back && f.on, `0 is the first frame (${JSON.stringify(f)})`);
    await page.screenshot({ path: path.join(S, 'video-frames.png') });
    await page.evaluate(() => document.querySelector('.modal video').play());
    await page.waitForFunction(() => Number(document.querySelector('.modal .res-frames input').value) >= 5, null, { timeout: 5000 }).catch(() => {});
    f = await page.evaluate(() => { const v = document.querySelector('.modal video'); v.pause(); return { n: Number(document.querySelector('.modal .res-frames input').value), paused: v.paused }; });
    check(f.n >= 5, `while it plays, the number follows the frame on screen (${JSON.stringify(f)})`);
  } else console.log('INFO no H.264 in this browser; the frame bar not tested');
  await page.keyboard.press('Escape');
  // the frames are where the file says, also with reordered (B) frames and an edit list, and the browser shows them there
  let bfile = null;
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '2', '-c:v', 'libx264', '-bf', '2', '-pix_fmt', 'yuv420p', path.join(WORK, 'bframes.mp4')]); bfile = fs.readFileSync(path.join(WORK, 'bframes.mp4')).toString('base64'); } catch {}
  if (bfile) {
    const r = await page.evaluate(async (b64) => {
      const { frameTimes } = await import('/ui/frames.js');
      const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'video/mp4' });
      const times = await frameTimes(blob);
      const out = { n: times?.length, off: times ? Math.max(...Array.from(times, (t, i) => Math.abs(t - i / 15))) : null, none: await frameTimes(new Blob(['not a video at all, just some text'])), seen: [] };
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(blob);
      if (!v.requestVideoFrameCallback || !times) return out;
      await new Promise((ok) => { v.onloadeddata = ok; v.onerror = ok; });
      await new Promise((ok) => { v.requestVideoFrameCallback(ok); setTimeout(ok, 1000); }); // (the first frame's callback, out of the way)
      for (const i of [1, 0, 14, 28, 29]) { // the frame on screen in the middle of frame i's time
        const got = new Promise((ok) => { v.requestVideoFrameCallback((now, meta) => ok(meta.mediaTime)); setTimeout(() => ok(null), 10000); });
        v.currentTime = i < 29 ? (times[i] + times[i + 1]) / 2 : times[i] + 1 / 30;
        const t = await got;
        out.seen.push(t == null ? null : Math.round((t - times[i]) * 1e4) / 1e4);
      }
      URL.revokeObjectURL(v.src);
      return out;
    }, bfile);
    check(r.n === 30 && r.off < 1e-6 && r.none === null, `an MP4's frame times are read from the file, B-frames and all; a file that is no MP4 has none (${JSON.stringify({ n: r.n, off: r.off, none: r.none })})`);
    check(r.seen.length === 0 || r.seen.every((d) => d === 0), `and the browser shows each frame at the time read for it (${JSON.stringify(r.seen)})`);
  } else console.log('INFO no libx264 in this ffmpeg; B-frame times not tested');
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
liveSid = await page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);
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
{ // every session has its own input: another session's starts empty, and coming back finds yours again
  const remRow = page.locator(`.folder[data-dir="${fs.realpathSync(REM)}"] .sess`, { hasText: 'remembered 8' });
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
await page.locator(`${FOLDER} .folder-head`).hover();
await page.click(`${FOLDER} .folder-new`);
check(await page.inputValue('#input') === 'half-written', '+ on the folder again brings the draft back with its text');
// right-click → Archive: the row goes, the next remembered one moves up, and a restart keeps it out
await page.locator(`.folder[data-dir="${fs.realpathSync(REM)}"] .sess`, { hasText: 'remembered 9' }).click({ button: 'right' });
await hold(page, page.locator('.ctx-item', { hasText: 'Archive' }));
const remTitles = () => page.locator(`.folder[data-dir="${fs.realpathSync(REM)}"] .sess-title`).allTextContents();
await until(async () => { const t = await remTitles(); return t.length === 8 && !t.includes('remembered 9') && t.includes('remembered 1'); }, 10000);
const remAfter = await remTitles();
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
}
if (PART === 'B' || PART === 'C') { // what A leaves behind for them: the remembered folder listed, and a blank session in the work folder, open
  await addFolder(page, REM);
  await rpc({ type: 'new', cwd: WORK, blank: true });
  await page.locator(`${FOLDER} .sess`).first().click({ timeout: 10000 });
  await page.waitForFunction(() => !document.getElementById('input').disabled, null, { timeout: 15000 }).catch(() => {});
  liveSid = await page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);
  // (the page has the model list, as A's draft waits for: a draft names the model it will run)
  await page.waitForFunction(() => !/^(Model|Default)?$/.test(document.querySelector('#modelBtn .mb-name')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
}
if (runs('B')) {
// The page's answer to its next command of `type` (to wait for what the page draws from it).
const answered = (type) => page.waitForResponse((r) => r.url().endsWith('/cmd') && !!r.request().postData()?.startsWith(`{"type":"${type}"`), { timeout: 5000 }).catch(() => {});
// ---- widgets: the plugins' tiles above the usage card, a row of up to four; a click opens a plugin's page ----
{
  await page.locator('#widgets .widget.plugin-clock').waitFor({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => /^\d\d:\d\d$/.test(document.querySelector('#widgets .plugin-clock')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const w = await page.evaluate(() => {
    const box = document.getElementById('widgets'), tiles = [...box.children];
    const r = (el) => el.getBoundingClientRect();
    return { cols: getComputedStyle(box).gridTemplateColumns.split(' ').length, tiles: tiles.map((t) => [t.tagName, t.className, t.textContent, t.title]),
      row: new Set(tiles.map((t) => Math.round(r(t).top))).size, above: r(box).bottom < r(document.getElementById('usageBtn')).top,
      even: Math.abs(r(tiles[0]).width - r(tiles[2]).width) < 1 };
  });
  check(w.cols === 3 && w.row === 1 && w.even && w.above && JSON.stringify(w.tiles.map((t) => t[0])) === '["DIV","BUTTON","DIV"]'
    && /bad/.test(w.tiles[0][1]) && /boom/.test(w.tiles[0][3]) && /^\d\d:\d\d$/.test(w.tiles[1][2]) && w.tiles[1][3] === 'Clock' && w.tiles[2][2] === 'ok',
    `three plugins: three widgets sharing one row above the usage card; the clock's opens a page, a failed one says why (${JSON.stringify(w)})`);
  await page.click('#widgets .plugin-clock');
  await page.locator('.modal-body.widget-page.plugin-clock .time').waitFor({ timeout: 3000 }).catch(() => {});
  const open = await page.evaluate(() => {
    const t = document.querySelector('.modal-body.plugin-clock .time');
    window.__clockTime = t;
    return { title: document.querySelector('#modal .modal-title')?.textContent, time: t?.textContent, size: t && getComputedStyle(t).fontSize,
      on: document.querySelector('#widgets .plugin-clock').classList.contains('on') };
  });
  let ticked = open.time; // (polled: a tick may come late under load)
  await until(async () => (ticked = await page.evaluate(() => window.__clockTime.textContent)) !== open.time, 3000);
  check(open.title === 'Clock' && /^\d\d:\d\d:\d\d$/.test(open.time || '') && open.size === '44px' && open.on && ticked !== open.time,
    `the clock's page opens in a dialog, styled by its ui.css, and ticks (${JSON.stringify(open)} → ${ticked})`);
  await page.click('#modal .modal-head button');
  const closed = await page.evaluate(() => window.__clockTime.textContent);
  await wait(1200);
  const after = await page.evaluate(() => ({ time: window.__clockTime.textContent, modal: !!document.getElementById('modal'), on: document.querySelector('#widgets .plugin-clock').classList.contains('on') }));
  check(!after.modal && !after.on && after.time === closed, `closing the dialog stops the plugin's page (${JSON.stringify(after)}, ${closed})`);

  // Settings → Plugins: where each widget shows, kept in plugins.json by the client, the widgets drawn again at once
  const pl = (sel) => page.locator(`#pluginsView ${sel}`);
  // (a plugins.json of the first version, the where map alone, is read as it was)
  fs.writeFileSync(path.join(IRO_DIR, 'plugins.json'), JSON.stringify({ still: 'off' }));
  const config = () => { try { return JSON.parse(fs.readFileSync(path.join(IRO_DIR, 'plugins.json'), 'utf8')); } catch { return {}; } };
  const kept = () => config().where?.clock;
  const clockShown = (on) => page.waitForFunction((on) => !!document.querySelector('#widgets .plugin-clock') === on, on, { timeout: 5000 }).then(() => true, () => false);
  await page.click('#settingsBtn');
  await page.locator('.modal .set-row:has-text("Plugins") .set-open').click();
  await pl('.sk-item').first().waitFor({ timeout: 5000 }).catch(() => {});
  const listed = await pl('.sk-item').evaluateAll((els) => els.map((e) => `${e.querySelector('.sk-name').textContent}:${e.querySelector('.sk-tag').textContent}`));
  check(JSON.stringify(listed) === '["broken:every server","clock:every server","still:off"]' && await page.locator('#content').isHidden(),
    `Settings → Plugins lists every plugin and where it shows (${JSON.stringify(listed)})`);
  await pl('.sk-item:has-text("still")').click();
  await pl('.sk-mode:has-text("Every server")').click();
  await page.locator('#widgets .plugin-still').waitFor({ timeout: 5000 }).catch(() => {});
  await pl('.sk-item:has-text("clock")').click();
  await pl('.sk-mode:has-text("Off")').click();
  const off = await clockShown(false);
  check(off && kept() === 'off' && await page.locator('#widgets .widget').count() === 2 && (await pl('.sk-item.on .sk-tag').textContent()) === 'off',
    `Off: the clock's widget goes at once, and the client keeps it (${kept()})`);
  await pl('.sk-mode:has-text("Some servers")').click();
  await pl('.pl-servers input').first().waitFor({ timeout: 3000 }).catch(() => {});
  const some = { shown: await clockShown(true), kept: kept(), ticked: await pl('.pl-servers .hall:has(input:checked)').allTextContents() };
  await pl('.pl-servers .hall:has(input:checked) input').click();
  const none = { shown: !(await clockShown(false)), kept: kept() };
  await pl('.sk-mode:has-text("Every server")').click();
  const all = { shown: await clockShown(true), kept: kept() };
  check(some.shown && JSON.stringify(some.kept) === '["local"]' && JSON.stringify(some.ticked) === '["This machine"]' && !none.shown && JSON.stringify(none.kept) === '[]' && all.shown && all.kept === undefined,
    `Some servers starts with the tab's own; unticked it shows nowhere; Every server again (${JSON.stringify({ some, none, all })})`);
  // dragged in the list: the widgets follow its order
  await pl('.sk-item:has-text("still")').dragTo(pl('.sk-item:has-text("broken")'), { targetPosition: { x: 40, y: 3 } });
  await page.waitForFunction(() => [...document.querySelectorAll('#widgets .widget')].map((w) => w.className.match(/plugin-(\w+)/)[1]).join() === 'still,broken,clock', null, { timeout: 5000 }).catch(() => {});
  const order = { list: await pl('.sk-item .sk-name').allTextContents(), widgets: await page.locator('#widgets .widget').evaluateAll((ws) => ws.map((w) => w.className.match(/plugin-(\w+)/)[1])), kept: config().order };
  check(JSON.stringify(order.list) === '["still","broken","clock"]' && JSON.stringify(order.widgets) === JSON.stringify(order.list) && JSON.stringify(order.kept) === JSON.stringify(order.list),
    `a plugin dragged to the top of the list: its widget goes first, and the client keeps the order (${JSON.stringify(order)})`);
  // a plugin's files, to look at
  await pl('.sk-item:has-text("clock")').click();
  const files = await pl('.sk-files button').allTextContents();
  await pl('.sk-files button:has-text("ui.js")').click();
  await page.locator('.modal .sk-file').waitFor({ timeout: 3000 }).catch(() => {});
  check(JSON.stringify(files) === '["plugin.json","ui.css","ui.js"]' && (await page.locator('.modal-title').textContent()) === 'plugins/clock/ui.js' && await page.locator('.modal .sk-file .hljs-keyword').count() > 0,
    `a plugin's files are listed, and open to look at (${JSON.stringify(files)})`);
  await page.locator('.modal-head button').click();

  // ---- the bookmarks plugin: what it keeps stays with the local client (plugin-data/bookmarks.json) ----
  // (added while the page is open: it shows once the widgets are drawn again, here by turning still off)
  fs.cpSync(path.join(REPO, 'plugins', 'bookmarks'), path.join(PLUGINS, 'bookmarks'), { recursive: true });
  await pl('.sk-item:has-text("still")').click();
  await pl('.sk-mode:has-text("Off")').click();
  await page.locator('#widgets button.plugin-bookmarks').waitFor({ timeout: 5000 }).catch(() => {});
  await pl('.usage-bar > button').click();
  const kept2 = () => { try { return JSON.parse(fs.readFileSync(path.join(IRO_DIR, 'plugin-data', 'bookmarks.json'), 'utf8')); } catch { return null; } };
  const bm = (sel) => page.locator(`.modal-body.plugin-bookmarks ${sel}`);
  const sec = (name) => bm(`.bm-sec:has(.bm-name:text-is("${name}"))`);
  const addTo = async (name, title, url) => {
    await sec(name).locator('.bm-head').hover();
    await sec(name).locator('.bm-act[title="Add a bookmark"]').click();
    await bm('.bm-form input').first().fill(title);
    await bm('.bm-form input').nth(1).fill(url);
    await page.keyboard.press('Enter');
    await bm('.bm-form').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  };
  // (its page reads them again as it opens: added only once that read is in)
  const read = answered('pluginData');
  await page.click('#widgets .plugin-bookmarks');
  await bm('.bm-sec').first().waitFor({ timeout: 3000 }).catch(() => {});
  await read;
  const fresh = await bm('.bm-name').allTextContents();
  await addTo('Bookmarks', '', 'openreview.net');
  await addTo('Bookmarks', 'Overleaf', 'https://www.overleaf.com/');
  await bm('.bm-newsec').click();
  await bm('.bm-rename').waitFor({ timeout: 3000 }).catch(() => {});
  await page.keyboard.type('Tools');
  await page.keyboard.press('Enter');
  await addTo('Tools', 'TensorBoard', 'localhost:6006');
  // (each save reaches the client after the form has gone)
  const keptShape = () => JSON.stringify(kept2()?.sections.map((s) => [s.name, s.items.length]));
  await until(() => keptShape() === '[["Bookmarks",2],["Tools",1]]', 3000);
  const added = { fresh, chips: await bm('.bm-chip').evaluateAll((as) => as.map((a) => `${a.textContent.replace(/[✎✕]/g, '')}=${a.getAttribute('href')}`)), kept: kept2() };
  check(JSON.stringify(added.fresh) === '["Bookmarks"]'
    && JSON.stringify(added.chips) === '["Oopenreview.net=https://openreview.net/","OOverleaf=https://www.overleaf.com/","TTensorBoard=http://localhost:6006/"]'
    && JSON.stringify(added.kept?.sections.map((s) => [s.name, s.items.length])) === '[["Bookmarks",2],["Tools",1]]',
    `bookmarks: a section to start with; added ones get an address and a title, and the client keeps them (${JSON.stringify(added)})`);
  // dragged: a bookmark before another, a bookmark onto another section (its end), a section above another
  await bm('.bm-chip:has-text("Overleaf")').dragTo(bm('.bm-chip:has-text("openreview.net")'), { targetPosition: { x: 4, y: 8 } });
  await bm('.bm-chip:has-text("TensorBoard")').dragTo(sec('Bookmarks').locator('.bm-head'), { targetPosition: { x: 40, y: 20 } });
  await sec('Tools').locator('.bm-head').dragTo(sec('Bookmarks').locator('.bm-head'), { targetPosition: { x: 40, y: 2 } });
  const want = '[["Tools",[]],["Bookmarks",["Overleaf","openreview.net","TensorBoard"]]]';
  await until(() => JSON.stringify(kept2()?.sections.map((s) => [s.name, s.items.map((i) => i.title)])) === want, 3000);
  const moved = { shown: await bm('.bm-sec').evaluateAll((ss) => ss.map((s) => [s.querySelector('.bm-name').textContent, [...s.querySelectorAll('.bm-t')].map((t) => t.textContent)])),
    kept: kept2()?.sections.map((s) => [s.name, s.items.map((i) => i.title)]), tile: await page.locator('#widgets .plugin-bookmarks .bm-mono').allTextContents() };
  check(JSON.stringify(moved.shown) === want && JSON.stringify(moved.kept) === want && JSON.stringify(moved.tile) === '["O","O","T"]',
    `bookmarks and sections are dragged into place, kept so, and the tile shows the first three (${JSON.stringify(moved)})`);
  await bm('.bm-q').fill('tensor');
  const filtered = { chips: await bm('.bm-t').allTextContents(), secs: await bm('.bm-name').allTextContents(), n: await bm('.bm-n').allTextContents() };
  check(JSON.stringify(filtered) === '{"chips":["TensorBoard"],"secs":["Bookmarks"],"n":["1"]}', `the filter leaves what matches (${JSON.stringify(filtered)})`);
  await page.locator('.modal-head button').click();
}
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
await page.locator('.modal .set-select').nth(4).waitFor({ timeout: 8000 }).catch(() => {});
const pickers = page.locator('.modal .set-select');
check(await pickers.count() === 5 && (await page.locator('.modal-title').textContent()) === 'Settings', 'the Settings button below the usage card opens the panel: model, effort, mode, theme colour, sampling interval');
check((await pickers.nth(2).locator('option').evaluateAll((os) => os.map((o) => o.value))).includes('bypassPermissions'), 'Bypass permissions can be the default mode');
const modelOpts = await pickers.nth(0).locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
const [wantModel, wantModelName] = modelOpts[modelOpts.length - 1];
await pickers.nth(0).selectOption(wantModel);
await pickers.nth(1).selectOption('max');
await pickers.nth(2).selectOption('default');
await pickers.nth(4).selectOption('60');
await page.screenshot({ path: path.join(S, 'settings.png') });
{ // the theme colour: the page's where a session has none of its own, kept on the server (each machine its own)
  const base = () => page.evaluate(() => ({ base: getComputedStyle(document.documentElement).getPropertyValue('--base-accent').trim(), side: getComputedStyle(document.querySelector('aside')).getPropertyValue('--accent').trim() }));
  const before = await base();
  await pickers.nth(3).selectOption('blue');
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--base-accent').trim() === '#3d78c2', null, { timeout: 5000 }).catch(() => {});
  const blue = await base(), kept = (await rpc({ type: 'getSettings' })).data?.color;
  check(blue.base === '#3d78c2' && blue.side === '#3d78c2' && kept === 'blue' && before.base !== blue.base, `a theme colour picked in Settings colours the page and the sidebar, and is kept on the server (${JSON.stringify({ before, blue, kept })})`);
  await rpc({ type: 'setSettings', color: 'url(x)' });
  check((await rpc({ type: 'getSettings' })).data?.color === 'blue', 'a theme colour that is not one is refused');
  await pickers.nth(3).selectOption('');
  await page.waitForFunction((b) => getComputedStyle(document.documentElement).getPropertyValue('--base-accent').trim() === b, before.base, { timeout: 5000 }).catch(() => {});
  const back = await base();
  check(back.base === before.base && (await rpc({ type: 'getSettings' })).data?.color === null, `the built-in colour comes back (${JSON.stringify(back)})`);
  const groups = await page.locator('.settings h4').allTextContents();
  check(groups.join() === 'Local(local),Global' && await page.locator('.settings .set-note').count() === 0, `the settings are grouped by where they hold: this machine (named), or every server (${groups})`);
}
await page.waitForFunction(() => document.querySelector('#effort').value === 'max' && document.querySelector('#mode').value === 'default', null, { timeout: 5000 }).catch(() => {});
{
  const st = (await rpc({ type: 'getSettings' })).data || {};
  check(st.defaults?.model === wantModel && st.defaults?.effort === 'max' && st.defaults?.mode === 'default' && st.usageInterval === 60,
    `the defaults and the interval are kept on the server (${JSON.stringify(st.defaults)}, ${st.usageInterval})`);
  const bad = await rpc({ type: 'setSettings', usageInterval: 7 });
  check(/must be one of/.test(bad.error || '') && (await rpc({ type: 'getSettings' })).data?.usageInterval === 60, `an interval the clock cannot keep is refused (${bad.error})`);
  check(await page.inputValue('#effort') === 'max' && await page.inputValue('#mode') === 'default' && await page.locator('#modelBtn .mb-name').textContent() === wantModelName,
    `the open, untouched draft follows the new defaults (${await page.inputValue('#effort')}, ${await page.inputValue('#mode')}, ${await page.locator('#modelBtn .mb-name').textContent()})`);
}
await page.locator('.modal-head button').click();
{ // Settings → UI skills: a page over the session that edits skills/ (here a copy)
  const sk = (sel) => page.locator(`#skillsView ${sel}`);
  const mermaidFile = path.join(SKILLS, 'mermaid', 'SKILL.md');
  await page.click('#settingsBtn');
  await page.locator('.modal .set-row:has-text("UI skills") .set-open').click();
  await sk('.sk-item').first().waitFor({ timeout: 5000 }).catch(() => {});
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
  await page.screenshot({ path: path.join(S, 'ui-skills.png') });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await page.waitForFunction(() => !document.querySelector('#skillsView .sk-item.dirty'), null, { timeout: 5000 }).catch(() => {});
  let file = fs.readFileSync(mermaidFile, 'utf8');
  check(file.includes('description: "Use when: testing # the page."') && file.includes('disable-model-invocation: true') && !file.includes('user-invocable') && file.includes('# Mermaid diagrams in IroWell'),
    'Save (⌘S) writes the description and the mode into the frontmatter, and keeps the text');
  check((await sk('.sk-item:has-text("mermaid") .sk-tag').textContent()) === '/ only' && await sk('.sk-server.ok').count() === 1, 'the list follows, and this machine already runs the new file');
  await sk('.sk-tabs button:has-text("Preview")').click();
  check(await sk('.sk-preview h1').count() === 1, 'Preview renders the text');
  await sk('.sk-tabs button:has-text("Edit")').click();
  await sk('.sk-area').fill('changed in the page');
  fs.appendFileSync(mermaidFile, 'changed on disk\n');
  const reread = answered('uiSkills'); // (refused, the page reads the files again and draws them)
  await sk('.sk-foot .primary').click(); // refused: the notice says so (answered by answerDialogs, it shows in the log)
  await reread;
  file = fs.readFileSync(mermaidFile, 'utf8');
  check(file.includes('changed on disk') && !file.includes('changed in the page'), 'a file changed on disk since is not overwritten');
  check(await sk('.sk-item.dirty').count() === 1 && (await sk('.sk-area').inputValue()) === 'changed in the page', 'and the edit stays as a draft');
  await hold(page, sk('.sk-foot button:has-text("Revert")'));
  await page.waitForTimeout(300);
  check(await sk('.sk-item.dirty').count() === 0 && (await sk('.sk-area').inputValue()).includes('changed on disk'), 'Revert goes back to the file as it is now');
  await sk('.sk-add').click();
  await sk('.sk-new input').fill('show-files');
  await sk('.sk-new input').press('Enter');
  await sk('.sk-item.on:has-text("show-files")').waitFor({ timeout: 5000 }).catch(() => {});
  check(fs.existsSync(path.join(SKILLS, 'show-files', 'SKILL.md')) && (await sk('.sk-item.on .sk-tag').textContent()) === 'off', 'New skill creates skills/<name>/SKILL.md, off until it is ready');
  await sk('.sk-item:has-text("session-context")').click();
  await sk('.sk-files button:has-text("sessions.mjs")').click();
  check((await page.locator('.modal-title').textContent()) === 'skills/session-context/sessions.mjs' && await page.locator('.modal .sk-file .hljs-keyword').count() > 0, 'a file beside the skill opens to look at');
  await page.locator('.modal-head button').click();
  await sk('.usage-bar > button').click();
  check(await page.locator('#skillsView').isHidden() && await page.locator('#content').isVisible(), 'Back returns to the session');
  // a client started before the page existed answers 400: the page says to restart it
  const old = (route) => (JSON.parse(route.request().postData() || '{}').type === 'uiSkills' ? route.fulfill({ status: 400, body: '' }) : route.fallback());
  await page.route('**/cmd', old);
  await page.click('#settingsBtn');
  await page.locator('.modal .set-row:has-text("UI skills") .set-open').click();
  await sk('.sk-error').waitFor({ timeout: 5000 }).catch(() => {});
  check(/restart it \(client\.mjs\)/.test(await sk('.sk-error').textContent().catch(() => '')) && await page.locator('.dlg, .toast.note', { hasText: /\b400\b|Command failed/ }).count() === 0, 'an older client: the page says to restart it, no bare 400');
  await page.unroute('**/cmd', old);
  // (the browser logs the faked 400 as a failed load: expected here, not an error of the page)
  for (let i = errors.length - 1; i >= 0; i--) if (/status of 400/.test(errors[i])) errors.splice(i, 1);
  await sk('.usage-bar > button').click();
}
{ // Settings → Output style: Claude Code's output styles (here STYLES_HOME stands for ~/.claude), to pick, and the user's own to make, edit and delete
  const st = (sel) => page.locator(`#stylesView ${sel}`);
  const dir = path.join(STYLES_HOME, 'output-styles');
  const settingsNow = () => JSON.parse(fs.readFileSync(path.join(STYLES_HOME, 'settings.json'), 'utf8'));
  const state = () => st('.sk-state').textContent();
  await page.click('#settingsBtn');
  await page.locator('.modal .set-open:has-text("Open")').click();
  await st('.sk-item').first().waitFor({ timeout: 5000 }).catch(() => {});
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
  await st('.sk-item.on:has-text("Quick Style")').waitFor({ timeout: 5000 }).catch(() => {});
  const made = path.join(dir, 'Quick Style.md');
  check(fs.existsSync(made) && /^name: "Quick Style"$/m.test(fs.readFileSync(made, 'utf8')) && await st('.hall input').isChecked(), 'New style makes a file of that name, empty, keeping the coding instructions');
  await st('.sk-desc').fill('For the quick suite');
  await st('.sk-area').fill('QUICK-STYLE-TEXT: answer in one line.');
  await st('.hall input').uncheck();
  check((await state()) === 'Not saved' && await st('.sk-item.dirty').count() === 1 && !fs.readFileSync(made, 'utf8').includes('QUICK-STYLE-TEXT'), 'an edit is a draft until it is saved');
  await st('.usage-bar > button').click();
  check(await page.locator('#stylesView').isHidden() && await page.locator('#content').isVisible(), 'Back returns to the session');
  await page.click('#settingsBtn');
  await page.locator('.modal .set-open:has-text("Open")').click();
  await st('.sk-area').waitFor({ timeout: 5000 }).catch(() => {});
  check((await st('.sk-area').inputValue()) === 'QUICK-STYLE-TEXT: answer in one line.' && (await state()) === 'Not saved', 'and the draft is still there when the page is opened again');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await page.waitForFunction(() => /^Saved/.test(document.querySelector('#stylesView .sk-state')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  let text = fs.readFileSync(made, 'utf8');
  check(text.includes('description: "For the quick suite"') && text.includes('keep-coding-instructions: false') && text.endsWith('---\n\nQUICK-STYLE-TEXT: answer in one line.\n'), 'Save (⌘S) writes the front matter and the text');
  await page.screenshot({ path: path.join(S, 'output-style.png') });
  await st('.sk-foot button:has-text("Use this style")').click();
  await st('.sk-item.on .sk-tag').waitFor({ timeout: 5000 }).catch(() => {});
  check(settingsNow().outputStyle === 'Quick Style' && settingsNow().model === 'opus' && (await st('.sk-tag').allTextContents()).length === 1 && await st('.sk-foot button:has-text("In use")').isDisabled(),
    'Use this style sets outputStyle in settings.json (the rest of it kept), and the list follows');
  // (the file changed on disk meanwhile, by the terminal or an editor: not written over)
  await st('.sk-area').fill('changed in the page');
  fs.appendFileSync(made, 'changed on disk\n');
  const reread = answered('outputStyles'); // (refused, the page reads the styles again and draws them)
  await st('.sk-foot .primary').click(); // refused: the notice says so (answered by answerDialogs)
  await reread;
  text = fs.readFileSync(made, 'utf8');
  check(text.includes('changed on disk') && !text.includes('changed in the page') && (await st('.sk-area').inputValue()) === 'changed in the page', 'a style changed on disk since is not written over, and the edit stays as a draft');
  await hold(page, st('.sk-foot button:has-text("Revert")'));
  await page.waitForTimeout(300);
  check(await st('.sk-item.dirty').count() === 0 && (await st('.sk-area').inputValue()).includes('changed on disk'), 'Revert goes back to the file as it is now');
  await hold(page, st('.sk-foot button:has-text("Delete")'));
  await st('.sk-item.on:has-text("Default")').waitFor({ timeout: 5000 }).catch(() => {});
  check(!fs.existsSync(made) && !('outputStyle' in settingsNow()) && (await st('.sk-item.on .sk-tag').textContent()) === 'in use', 'Delete (held) removes the file; it was in use, so Default is again');
  await st('.sk-item:has-text("Mine")').click();
  await st('.sk-foot button:has-text("Use this style")').click();
  await until(() => settingsNow().outputStyle === 'Mine', 5000);
  check(settingsNow().outputStyle === 'Mine' && fs.readFileSync(path.join(dir, 'mine.md'), 'utf8').includes('color: blue'), 'a style of the user\'s, untouched, is picked as it is');
  await st('.sk-item:has-text("Default")').click();
  await st('.sk-foot button:has-text("Use this style")').click();
  await until(() => !('outputStyle' in settingsNow()), 5000);
  check(!('outputStyle' in settingsNow()), 'Default again: outputStyle is taken out of settings.json');
  await st('.usage-bar > button').click();
  // a server from before the page answers 400 through the client: the page says to update it
  const old = (route) => (JSON.parse(route.request().postData() || '{}').type === 'outputStyles' ? route.fulfill({ status: 400, body: '' }) : route.fallback());
  await page.route('**/cmd', old);
  await page.click('#settingsBtn');
  await page.locator('.modal .set-open:has-text("Open")').click();
  await st('.sk-error').waitFor({ timeout: 5000 }).catch(() => {});
  check(/update it \(Update server\)/.test(await st('.sk-error').textContent().catch(() => '')) && await page.locator('.dlg, .toast.note', { hasText: /\b400\b|Command failed/ }).count() === 0, 'an older server: the page says to update it, no bare 400');
  await page.unroute('**/cmd', old);
  for (let i = errors.length - 1; i >= 0; i--) if (/status of 400/.test(errors[i])) errors.splice(i, 1); // (the faked 400, as above)
  await st('.usage-bar > button').click();
}
{ // and so does a draft opened later, over its folder's own mode
  const REMF = `.folder[data-dir="${fs.realpathSync(REM)}"]`;
  await page.locator(`${REMF} .folder-head`).hover();
  await page.click(`${REMF} .folder-new`);
  await page.waitForTimeout(500);
  check(await page.inputValue('#mode') === 'default' && await page.inputValue('#effort') === 'max' && await page.locator('#modelBtn .mb-name').textContent() === wantModelName,
    `a new draft starts with the defaults from Settings (${await page.inputValue('#mode')}, ${await page.inputValue('#effort')}, ${await page.locator('#modelBtn .mb-name').textContent()})`);
}
{ // the usage page follows the interval: Daily peek has one band per hour of the week
  await page.click('#usageBtn');
  await page.locator('.usage-page .week-cell').first().waitFor({ timeout: 3000 }).catch(() => {});
  const hits = await page.locator('.usage-page .week-cell').count();
  check(hits === 168, `with hourly samples Daily peek has 168 bands (${hits})`);
  await page.click('#usageBack');
  // a fresh page may draw the usage page before the settings arrive (a server over ssh answers in the
  // order asked, the settings last): it must not stay on half hours
  const p2 = await page.context().newPage();
  await p2.route('**/cmd', async (route) => {
    if (route.request().postData()?.includes('"getSettings"')) await wait(1200);
    await route.continue();
  });
  await p2.goto(page.url());
  await p2.waitForSelector('.usage-page', { timeout: 5000 }).catch(() => {});
  if (await p2.locator('#usageView').isHidden()) await p2.click('#usageBtn');
  await p2.waitForFunction(() => document.querySelectorAll('.usage-page .week-cell').length === 168, null, { timeout: 6000 }).catch(() => {});
  const hits2 = await p2.locator('.usage-page .week-cell').count();
  check(hits2 === 168, `a page opened afresh shows the hourly interval too (${hits2} bands)`);
  await p2.close();
}
{ // the logo turns: once when the sidebar's is clicked; and while the usage page has nothing to draw, large in its
  // middle and in the sidebar. Data that comes mid-turn waits for the turn to end: it never stops half way.
  const brand = () => page.evaluate(() => [...document.querySelectorAll('.brand-logo svg > path')].map((p) => p.getAttribute('d')).join());
  // At rest: the same for 0.8 s (a turn never holds a shape longer than 0.5 s). It may still be ending a turn begun
  // by what came before.
  const rest = async () => { const a = await brand(); await page.waitForTimeout(400); const b = await brand(); await page.waitForTimeout(400); return a === b && b === await brand() ? a : null; };
  let still = null;
  for (let i = 0; i < 25 && !still; i++) still = await rest();
  const name = page.locator('.brand-name');
  const box = await name.boundingBox();
  await name.click({ position: { x: box.width - 12, y: box.height / 2 } }); // (on the name, past the logo)
  const turned = await until(async () => await brand() !== still, 2000);
  check(still && turned && await name.evaluate((el) => getComputedStyle(el).userSelect) === 'none',
    'a click on the name in the sidebar turns the logo, and the name is not text to select');
  await page.evaluate(() => localStorage.removeItem('iro-usage-page')); // (nothing this browser drew before)
  let release;
  const held = new Promise((r) => (release = r));
  const slow = async (route) => {
    if (['usageHistory', 'usageForecast'].includes(JSON.parse(route.request().postData() || '{}').type)) await held;
    await route.fallback();
  };
  await page.route('**/cmd', slow);
  // (timed in the page, from the logo turning in its middle to the page drawn: not the test's round trips)
  await page.evaluate(() => {
    const t = window.turnTimes = {};
    const ob = new MutationObserver(() => {
      if (!t.wait && document.querySelector('#usageBody .usage-wait svg')) t.wait = performance.now();
      if (t.wait && document.querySelector('#usageBody .usage-page')) { t.drawn = performance.now(); ob.disconnect(); }
    });
    ob.observe(document.getElementById('usageBody'), { childList: true, subtree: true });
  });
  await page.click('#usageBtn');
  await page.waitForTimeout(1200);
  release();
  await page.waitForTimeout(1200);
  const mid = await page.evaluate(() => ({ wait: !!document.querySelector('#usageBody .usage-wait svg'), drawn: !!document.querySelector('.usage-page') }));
  await page.waitForSelector('.usage-page', { timeout: 8000 }).catch(() => {});
  const ms = await page.evaluate(() => Math.round(window.turnTimes.drawn - window.turnTimes.wait));
  // (the sidebar's turns on while the page's sync bar runs, a round that may start a little later: it stands still on
  // itself once that is over too)
  let stopped = false;
  for (let i = 0; i < 25 && !stopped; i++) stopped = (await rest()) === still;
  check(mid.wait && !mid.drawn && ms > 3500 && ms < 6000 && stopped,
    `the usage page with nothing to draw: the logo turns in its middle, the data in mid-turn is drawn when the turn ends (${ms} ms, ${JSON.stringify(mid)}), and the sidebar's logo then stops on itself`);
  await page.unroute('**/cmd', slow);
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
await hold(page, page.locator('.ctx-item', { hasText: 'Remove from sidebar' }));
await page.locator(`.folder[data-dir="${OTHER}"]`).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
check(await page.locator(`.folder[data-dir="${OTHER}"]`).count() === 0, 'right-click removes a folder');
// removing a folder detaches its live sessions (nothing runs where the sidebar can't show it); adding it back lists them, detached
{
  const OTHERF = `.folder[data-dir="${OTHER}"]`;
  const hid = (await rpc({ type: 'new', cwd: OTHER, blank: true })).data?.sid;
  await page.locator(`${OTHERF} .sess`).waitFor({ timeout: 10000 }).catch(() => {});
  check(await page.locator(`${OTHERF} .sess`).count() === 1, 'a session started in a removed folder lists the folder again');
  await page.locator(`${OTHERF} .sess`).click();
  await page.waitForFunction(() => !document.getElementById('input').disabled, null, { timeout: 15000 }).catch(() => {});
  check(/st-idle/.test(await page.locator('.sess.active .dot').getAttribute('class')), 'it runs there');
  await page.locator(`${OTHERF} .folder-head`).click({ button: 'right' });
  await hold(page, page.locator('.ctx-item', { hasText: 'Remove from sidebar' }));
  await page.locator(OTHERF).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  check(await page.locator(OTHERF).count() === 0 && await page.locator('.sess.active').count() === 0, 'its sessions are hidden with it');
  const closed = await until(async () => /not running/.test((await rpc({ type: 'context', sid: hid })).error || ''), 10000);
  check(closed, 'and detached: its Claude process is not left running out of sight');
  await addFolder(page, OTHER);
  check(/st-detached/.test(await page.locator(`${OTHERF} .sess .dot`).getAttribute('class').catch(() => '')), 'adding the folder back shows them again, detached');
  // (leave the sidebar as it was)
  await page.locator(`${OTHERF} .sess`).click({ button: 'right' });
  await hold(page, page.locator('.ctx-item', { hasText: 'Archive' }));
  await page.locator(`${OTHERF} .folder-empty`).waitFor({ timeout: 5000 }).catch(() => {});
  await page.locator(`${OTHERF} .folder-head`).click({ button: 'right' });
  await hold(page, page.locator('.ctx-item', { hasText: 'Remove from sidebar' }));
  await page.locator(OTHERF).waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}
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
// (the synthetic 5-hour window may have reset since the suite began: then it is empty, and has no triangle)
check(Math.abs(weekTick - 300 / 7) < 0.5 && ((fiveTick >= 0 && fiveTick <= 100) || (Number.isNaN(fiveTick) && Date.now() >= fiveResets)),
  `the usage card marks the time into each window (5h ${fiveTick}%, week ${weekTick}%)`);
// Usage page
// opening it marks the card without moving anything in it (no size or position change, not even half a pixel)
// (found and measured in one look: the card is drawn anew now and then, and a row found a moment before is
// no longer on the page, all zeros)
const cardBoxes = () => page.evaluate(() => {
  const els = [...document.querySelectorAll('#usageBtn, #usageBtn .uc-top, #usageBtn .uc-bar, #usageBtn .uc-tick')];
  return els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(','); }).join(' ')
    + ' ' + getComputedStyle(els[0]).borderWidth + ' ' + getComputedStyle(els[0]).boxShadow.replace(/.*inset[^,]*,\s*/, '');
});
// (no round of questions to the machines under way or about to start: a daemon's hello or a login starts
// one in the background 3 s later, and its sync bar would mix with the page's own round; so: 3.5 s quiet)
{ let quiet = Date.now(); const until = Date.now() + 30000;
  while (Date.now() - quiet < 3500 && Date.now() < until) {
    if (await page.evaluate(() => document.getElementById('usageSync').classList.contains('on'))) quiet = Date.now();
    await page.waitForTimeout(250);
  } }
// (the triangles move on the page's minute clock: both looks are taken within one minute)
{ const ms = Date.now() % 60000; if (ms > 50000) await page.waitForTimeout(60000 - ms + 500); }
const cardShut = await cardBoxes();
// (the sync bar beside the page's title, as it changes from here on)
await page.evaluate(() => {
  const el = document.getElementById('usageSync');
  window.syncSeen = [];
  new MutationObserver(() => window.syncSeen.push(`${el.classList.contains('on') ? 'on' : 'off'} ${el.textContent}`)).observe(el, { attributes: true, childList: true, subtree: true });
});
await page.click('#usageBtn');
{ const open = await cardBoxes(); check(open === cardShut, `opening the usage page does not shift or lift the usage card${open === cardShut ? '' : ` (${cardShut} | ${open})`}`); }
// (the page is drawn anew as each answer comes, and a chart draws its curve a frame after it is put in: the
// curves are counted in the same look that finds them, as a later one can land between a redraw and that frame)
const curves = () => [...document.querySelectorAll('.usage-page .chart-svg')].map((x) => x.querySelectorAll('path.line').length);
const lines = await page.waitForFunction(`(() => { const c = (${curves})(); return c.length === 2 && c.every((n) => n >= 1) && c; })()`, null, { timeout: 8000 })
  .then((r) => r.jsonValue(), () => page.evaluate(curves));
check(lines.length === 2 && lines[0] >= 1 && lines[1] >= 1, `the usage page is the level curves (${lines})`);
check(await page.locator('#feed').isHidden(), 'it replaces the conversation view');
{ // the sync bar: the round of questions the client puts to the machines for the page (here one, this machine), then gone
  // (as it was when the round ended: the next round can start right after)
  const seen = await page.waitForFunction(() => window.syncSeen.some((s) => s.startsWith('on ')) && window.syncSeen.at(-1).startsWith('off ') && [...window.syncSeen], null, { timeout: 8000 })
    .then((r) => r.jsonValue(), () => page.evaluate(() => window.syncSeen));
  const at = (s) => seen.indexOf(s);
  // (how far: by how much of the answers has arrived, so the level only ever rises within a round: the page's
  // round, from its 0% for as long as the bar shows it; a later round of the same kind starts again from 0)
  const first = at('on Reading the usage samples…0%');
  let last = first;
  while (first >= 0 && seen[last + 1]?.startsWith('on Reading the usage samples…')) last++;
  const levels = first < 0 ? [] : seen.slice(first, last + 1).map((s) => parseInt(s.split('…')[1], 10));
  check(levels.length && levels.at(-1) === 100 && levels.every((v, i) => !i || v >= levels[i - 1]) && seen.at(-1).startsWith('off '),
    `the usage page shows the client reading the machines' samples, as far as they have arrived, and then no more (${seen.join(' | ')})`);
  const bar = page.locator('#usageSync');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('usageSync')).opacity === '0', null, { timeout: 5000 }).catch(() => {});
  check(await bar.evaluate((el) => getComputedStyle(el).opacity === '0' && !el.title) && await bar.locator('.uc-fill').evaluate((f) => f.style.width === '100%'),
    'a finished round fades, with its bar full');
}
const fits = () => page.evaluate(() => { const v = document.getElementById('usageView'); return v.scrollHeight <= v.clientHeight + 1; });
check(await fits(), 'the usage page fits without scrolling');
{ // beside the charts: Daily peek, the week by half hour, a strip per day (each from 04:00), tinted by what it cost at API rates; under a day, what it added to the weekly limit and what it cost
  const wk = () => page.locator('.week-sec').evaluate((s) => {
    const r = s.getBoundingClientRect(), c = document.querySelector('.usage-charts').getBoundingClientRect();
    return { cols: s.querySelectorAll('.week-col').length, cells: s.querySelectorAll('.week-cell').length, used: s.querySelectorAll('.week-cell:not(.none):not(.b0)').length,
      days: s.querySelectorAll('.week-day').length, today: s.querySelectorAll('.week-day.today').length, now: s.querySelectorAll('.week-now').length,
      hour: s.querySelector('.week-hour span').textContent, beside: r.left >= c.right && Math.abs(r.top - c.top) < 1 && Math.abs(r.height - c.height) < 1 };
  });
  const priced = (await rpc({ type: 'usageCost' })).data || [];
  const sum = priced.reduce((n, x) => n + x[1], 0);
  check(Math.abs(sum - costAnswers * 2.004 - COST_OTHER) < 1e-6, `the cost is each answer's tokens at its model's prices (Sonnet 5.5's cache reads, Haiku 5.5's long prompts), an answer counted once (${sum} for ${costAnswers} answers and ${COST_OTHER})`);
  const toks = priced.reduce((n, x) => n.map((v, i) => v + (x[i + 2] || 0)), [0, 0, 0]);
  check(toks[0] === costAnswers * 1000 + 1e5 && toks[1] === costAnswers * 1.1e6 + 1.1e6 && toks[2] === costAnswers * 5e4 + 2e6,
    `and its tokens: the input not cached, the cache read and written, the output, an answer counted once (${toks})`);
  await page.locator('.week-cell:not(.none)').first().waitFor({ timeout: 5000 }).catch(() => {}); // (the cost comes after the charts)
  const cur = await wk();
  check(cur.cols === 7 && cur.days === 7 && cur.cells === 336 && cur.hour === '04:00', `the week grid has 7 days of 48 half hours, from 04:00 (${JSON.stringify(cur)})`);
  check(cur.beside, 'it stands beside the two charts, as tall as both');
  // a day is one strip: its bands touch (no grid of separate cells), and only the strip has corners
  const strip = await page.locator('.week-strip').first().evaluate((x) => {
    const c = [...x.children].map((e) => e.getBoundingClientRect());
    return { n: c.length, gaps: c.slice(1).filter((r, i) => Math.abs(r.top - c[i].bottom) > 0.01).length, corners: getComputedStyle(x.children[5]).borderRadius, round: getComputedStyle(x).borderRadius, shadows: [...x.children].filter((e) => getComputedStyle(e).boxShadow !== 'none').length };
  });
  check(strip.n === 48 && strip.gaps === 0 && strip.corners === '0px' && strip.round === '5px' && strip.shadows === 0, `each day is one unbroken strip (${JSON.stringify(strip)})`);
  const blank = await page.locator('.week-sec').evaluate((s) => {
    const bg = (e) => getComputedStyle(e).backgroundColor;
    const none = s.querySelector('.week-cell.none'); // (none in the week's last half hour: nothing is still to come)
    return { strip: bg(s.querySelector('.week-strip')), none: none ? bg(none) : null, zero: bg(s.querySelector('.week-ramp .b0')) };
  });
  check(blank.strip === blank.zero && (blank.none === null || blank.none === 'rgba(0, 0, 0, 0)'), `a half hour without a sample looks the same as one that used nothing (${JSON.stringify(blank)})`);
  check((await page.locator('.week-sec h3').textContent()) === 'Daily peek' && (await page.locator('.week-read').textContent()) === '', 'titled Daily peek, with nothing read out until a half hour is pointed at');
  check(cur.today === 1 && cur.now === 1, 'this week marks today and the time now');
  check(!(await page.locator('.week-sec .chart-nav button').nth(1).isEnabled()), 'there is no week after this one');
  // the synthetic 3 days may reach into the week before (always, early in a week)
  const before = page.locator('.week-sec .chart-nav button').first();
  let used = cur.used, back = false;
  if (await before.isEnabled()) {
    const range = await page.locator('.week-sec .chart-range').textContent();
    await before.click();
    back = true;
    const prev = await wk();
    check((await page.locator('.week-sec .chart-range').textContent()) !== range && prev.cells === 336 && prev.today === 0 && prev.now === 0, 'the arrow shows the week before, with no "now" in it');
    used += prev.used;
    if (!prev.used || cur.used > prev.used) { await page.locator('.week-sec .chart-nav button').nth(1).click(); back = false; }
  }
  check(used > 100, `the half hours the samples rose in are tinted (${used})`);
  const sums = await page.locator('.week-sum b').allTextContents();
  const pts = sums.filter((x) => x !== '—').map(Number);
  check(pts.length >= 1 && pts.every((n) => n > 0 && n <= 40) && sums.some((x) => /^\+\d/.test(x)), `under a day: the points it added to the weekly limit, not to the 5-hour window (${sums})`);
  const costs = await page.locator('.week-sum span:first-of-type').allTextContents();
  check(costs.some((x) => /^\$\d/.test(x)) && costs.every((x) => x === '—' || /^\$\d/.test(x)), `and what it cost (${costs})`);
  await page.locator('.week-cell:not(.none):not(.b0)').first().hover();
  const read = await page.locator('.week-read').textContent();
  check(/\d\d:\d\d–\d\d:\d\d · \$\d+\.\d\d$/.test(read), `hovering a half hour reads its time and what it cost (${read})`);
  const lifted = await page.locator('.week-sec').evaluate((s) => { const l = s.querySelector('.week-lift'), c = s.querySelector('.week-cell.on'); return l && { shadow: getComputedStyle(l).boxShadow, same: getComputedStyle(l).backgroundColor === getComputedStyle(c).backgroundColor, inCol: l.parentElement === c.closest('.week-col') }; });
  check(lifted && lifted.same && lifted.inCol && /rgba\(60, 40, 25/.test(lifted.shadow), `the half hour pointed at is lifted out of its strip, a shadow all round (${JSON.stringify(lifted)})`);
  // right of the days, the week as a whole: a smooth curve of each half hour's cost over the week, and the week's totals
  const tot = await page.locator('.week-sec').evaluate((s) => ({ rows: s.querySelectorAll('.week-tot .week-bar').length, curve: s.querySelector('.week-curve path.line')?.getAttribute('d') || '',
    lines: [...s.querySelector('.week-tot-sum').children].map((c) => c.textContent), legend: [...s.querySelector('.week-legend').children].filter((c) => !c.matches('.seg')).map((c) => c.textContent).join('') }));
  const dayPts = pts.reduce((n, x) => n + x, 0);
  check(tot.rows === 48 && / C/.test(tot.curve) && tot.lines.length === 3 && Math.abs(Number(tot.lines[0]) - dayPts) < 0.5 && /^\$\d/.test(tot.lines[1]) && /h$/.test(tot.lines[2]) && tot.legend === 'LessMore',
    `the week column: a curve over 48 half hours, and the week's totals (points, cost, hours) only (${JSON.stringify({ ...tot, curve: tot.curve.slice(0, 40) })})`);
  await page.locator('.week-bar').nth(40).hover();
  const readTot = await page.locator('.week-read').textContent();
  const dotOn = await page.locator('.week-dot').isVisible();
  check(dotOn && /^The week · \d\d:\d\d–\d\d:\d\d · \$\d+(\.\d+)? · on \d days?$/.test(readTot), `pointing at the curve marks it with a dot and reads that half hour over the week (${readTot})`);
  if (back) await page.locator('.week-sec .chart-nav button').nth(1).click();
  await page.mouse.move(5, 5);
  // Week / Month at its foot: the month, a strip a day on the same scale, paged by month; a day's totals read out with its half hours
  const views = page.locator('.week-sec .seg button');
  check(JSON.stringify(await views.allTextContents()) === '["Week","Month"]' && await page.locator('.week-sec .seg button.active').textContent() === 'Week', 'Daily peek opens on the week, with Week / Month at its foot');
  await views.nth(1).click();
  const mon = await wk(), nDays = await page.evaluate(() => { const d = new Date(Date.now() - 4 * 3600e3); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); });
  const mRange = await page.locator('.week-sec .chart-range').textContent();
  const mFoot = await page.locator('.week-sec').evaluate((s) => ({ sums: s.querySelectorAll('.week-sum').length, tot: s.querySelector('.week-tot-sum').children.length, month: s.classList.contains('month'), labels: s.querySelectorAll('.week-day b').length }));
  check(mon.cols === nDays && mon.cells === nDays * 48 && mon.today === 1 && mon.now === 1 && new RegExp(`^\\w+ 1 – ${nDays}$`).test(mRange) && mFoot.month && !mFoot.sums && mFoot.tot === 3 && mFoot.labels >= 1 && mFoot.labels <= 7,
    `Month shows this month, a strip a day, the dates over a few of them, and the month's totals only (${JSON.stringify({ ...mon, range: mRange, ...mFoot })})`);
  let mUsed = mon.used, mBack = false;
  if (mon.used < used) { await page.locator('.week-sec .chart-nav button').first().click(); mBack = true; mUsed += (await wk()).used; } // (early in a month: the synthetic days reach into the one before)
  check(mUsed === used, `the month tints the same half hours as the weeks (${mUsed} vs ${used})`);
  await page.locator('.week-cell:not(.none):not(.b0)').first().hover();
  const mRead = await page.locator('.week-read').textContent();
  check(/\d\d:\d\d–\d\d:\d\d · \$\d+\.\d\d · day (\+\S+ )?\$\S+ \S+h$/.test(mRead), `pointing at a half hour in a month reads its day's totals too (${mRead})`);
  if (mBack) await page.locator('.week-sec .chart-nav button').nth(1).click();
  await page.mouse.move(5, 5);
  await views.first().click();
  check((await wk()).cols === 7 && await page.locator('.week-sec .seg button.active').textContent() === 'Week', 'and Week brings the week back');
}
{ // under the two charts: Weekly tokens, a pair of bars a day (the input with its cache at the foot, and the output beside it)
  const tk = () => page.locator('.tok-sec').evaluate((s) => ({ title: s.querySelector('h3').textContent, keys: s.querySelector('.tok-keys').textContent, names: s.querySelectorAll('.tok-name').length,
    days: s.querySelectorAll('.tok-day').length, ins: s.querySelectorAll('.tok-day .k-in').length, caches: s.querySelectorAll('.tok-day .k-cache').length, outs: s.querySelectorAll('.tok-day .k-out').length,
    scales: [s.querySelectorAll('.tick.k-in-t').length, s.querySelectorAll('.tick.k-out-t').length] }));
  let t = await tk(), back = false;
  if (!t.days) { // (early on a Sunday: the work is all in the week before)
    await page.locator('.tok-sec .chart-nav button').first().click();
    back = true;
    await page.waitForFunction(() => document.querySelectorAll('.tok-sec .tok-name').length === 7, null, { timeout: 3000 }).catch(() => {});
    t = await tk();
  }
  check(t.title === 'Weekly tokens' && t.keys === 'inputcacheoutput' && t.names === 7 && t.days >= 1 && t.ins === t.days && t.caches === t.days && t.outs === t.days && t.scales.join() === '3,3', `Weekly tokens: a pair of bars for each day with work, the input's scale on the left and the output's on the right (${JSON.stringify(t)})`);
  await page.locator('.tok-day .hit').first().hover();
  const on = await page.locator('.tok-sec').evaluate((s) => ({ on: s.querySelectorAll('.tok-day.on').length, tip: s.querySelector('.tok-tip').hidden ? '' : s.querySelector('.tok-tip').textContent }));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.tok-day.on .tok-shadow')).opacity === '1', null, { timeout: 3000 }).catch(() => {}); // (the shadow fades in)
  const shadow = await page.locator('.tok-day.on .tok-shadow').evaluate((x) => {
    const cut = document.querySelector(x.getAttribute('clip-path').slice(4, -1) + ' rect'), axis = x.closest('svg').querySelector('.axis');
    return { opacity: getComputedStyle(x).opacity, blurred: !!document.querySelector(x.getAttribute('filter').slice(4, -1) + ' feGaussianBlur'), cutAt: +cut.getAttribute('height'), axis: +axis.getAttribute('y1') };
  });
  check(on.on === 1 && shadow.opacity === '1' && shadow.blurred && shadow.cutAt === shadow.axis && /tokens/.test(on.tip) && /input.*cache.*%.*output/.test(on.tip),
    `pointing at a day shadows its pair (none under it: cut off at the axis) and reads its tokens (${JSON.stringify({ ...on, shadow })})`);
  await page.mouse.move(5, 5);
  check(await page.locator('.tok-tip').isHidden() && await page.locator('.tok-day.on').count() === 0, 'and both go when the pointer leaves');
  if (back) await page.locator('.tok-sec .chart-nav button').nth(1).click();
}
{ // opened, the page draws at once from what the client has on file, then the fresh samples and cost over it as they come
  const onFile = await rpc({ type: 'usageHistory', days: 35, cached: true }), fresh = await rpc({ type: 'usageHistory', days: 35 });
  const costOnFile = await rpc({ type: 'usageCost', days: 35, cached: true });
  check(onFile.data?.length > 100 && onFile.data.length === fresh.data?.length && costOnFile.data?.length > 100,
    `the client answers from what it has on file when asked to (${onFile.data?.length} samples of ${fresh.data?.length}, ${costOnFile.data?.length} half hours of cost)`);
  // every answer held back, the client's on file too: the page draws what this browser drew last, at once
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/cmd', async (route) => {
    const b = JSON.parse(route.request().postData() || '{}');
    if (['usageHistory', 'usageForecast', 'usageCost'].includes(b.type)) await held;
    await route.continue().catch(() => {}); // (one let go as the route is taken away is sent on anyway)
  });
  await page.click('#usageBack');
  // (the week's token bars may be none yet: early on a Sunday the work is all in the week before)
  const drawn = () => document.querySelectorAll('.usage-page .chart-svg path.line').length >= 2 && document.querySelectorAll('.tok-sec .tok-name').length === 7 && !!document.querySelector('.week-sec .week-curve');
  // (timed in the page, from the click to the first frame it is drawn in: not the test's round trips; the page
  // left behind is still in the DOM, so the first look is a frame after the click has drawn the new one)
  await page.evaluate(`(() => {
    const drawn = ${drawn};
    window.drawnIn = null;
    document.getElementById('usageBtn').addEventListener('click', () => {
      const t0 = performance.now();
      const look = () => { if (drawn()) window.drawnIn = Math.round(performance.now() - t0); else requestAnimationFrame(look); };
      requestAnimationFrame(look);
    }, { capture: true, once: true });
  })()`);
  await page.click('#usageBtn');
  const ms = await page.waitForFunction(() => window.drawnIn != null && [window.drawnIn], null, { timeout: 3000 }).then(async (r) => (await r.jsonValue())[0], () => NaN);
  check(ms < 1500, `it is drawn from what this browser drew last while the answers are still out (${ms} ms)`);
  release();
  await page.waitForTimeout(500);
  await page.unroute('**/cmd');
  check(await page.waitForFunction(drawn, null, { timeout: 3000 }).then(() => true, () => false), 'and the fresh ones drawn over it keep the charts');
  // a fresh page opens the usage page by itself, before it is connected: it is drawn once it is
  const p3 = await page.context().newPage();
  await p3.goto(page.url());
  // (a redraw with fresher data can land at any moment, and its curves come a frame later: they are counted in
  // the same look that finds them)
  const p3Lines = await p3.waitForFunction(() => { const n = document.querySelectorAll('.usage-page .chart-svg path.line').length; return n >= 2 && n; }, null, { timeout: 8000 })
    .then((r) => r.jsonValue(), () => 0);
  const p3State = await p3.evaluate(() => ({ view: !document.getElementById('usageView').hidden, body: document.getElementById('usageBody').textContent.slice(0, 60), conn: document.querySelector('#conn .dot.up') != null }));
  check(p3Lines >= 2, `a fresh page opens the usage page by itself, drawn once connected (${JSON.stringify(p3State)})`);
  await p3.close();
}
{ // a line joins samples one sampling step apart, and the step is the samples' own: the history is the account's,
  // and another of its machines may sample every hour while this server's setting says every 30 minutes
  const runs = await page.evaluate(async () => {
    const { usagePage } = await import('/ui/usage.js');
    const H = 3600e3, end = Math.floor(Date.now() / H) * H, resets = new Date(end + 30 * H).toISOString();
    // The weekly chart's lines (one per run of samples) for samples taken these many hours ago, on a page of a 30-minute server.
    const lines = async (hoursAgo) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px;display:flex;flex-direction:column;visibility:hidden';
      box.append(usagePage(hoursAgo.map((h) => ({ t: end - h * H, five: null, week: { pct: 60 - h, resets } })), { interval: 30 }));
      document.body.append(box);
      for (let i = 0; i < 40 && box.querySelectorAll('.chart-svg').length < 2; i++) await new Promise((r) => setTimeout(r, 50)); // (drawn once its box is measured)
      const n = box.querySelectorAll('.chart-sec')[1].querySelectorAll('path.line').length;
      box.remove();
      return n;
    };
    return {
      hourly: await lines([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]),
      asleep: await lines([10, 9, 8, 7, 3, 2, 1, 0]), // (nothing for 4 hours)
      missed: await lines([5, 4.5, 4, 3.5, 2.5, 2, 1.5, 1]), // (every half hour, but for the slot 3 hours ago)
      slower: await lines([5, 4.5, 4, 3.5, 3, 2, 1, 0]), // (every half hour, then every hour)
    };
  });
  check(runs.hourly === 1 && runs.slower === 1, `samples an hour apart make one line on the page of a server that samples every 30 minutes (${JSON.stringify(runs)})`);
  check(runs.asleep === 2 && runs.missed === 2, `and a line still breaks where samples are missing (${JSON.stringify(runs)})`);
}
{ // the half hour still running is drawn with what it has cost so far, not left bare until it ends; before the cost is known the week is bare
  const running = await page.evaluate(async () => {
    const { usagePage } = await import('/ui/usage.js');
    const now = Date.now(), tinted = (cost) => usagePage([], { cost }).querySelectorAll('.week-cell:not(.none):not(.b0)').length;
    return { unknown: usagePage([], {}).querySelectorAll('.week-cell:not(.none)').length, none: tinted([]), now: tinted([[Math.floor(now / 300e3) * 300e3, 3]]) };
  });
  check(running.unknown === 0 && running.none === 0 && running.now === 1, `the running half hour shows what it has cost so far (${JSON.stringify(running)})`);
}
{ // each chart pages back too: the 5-hour one 48 hours at a time, the weekly one a reset cycle at a time, the tokens a week at a time
  const navs = page.locator('.usage-charts .chart-nav');
  check(await navs.count() === 3 && !(await navs.nth(0).locator('button').nth(1).isEnabled()) && !(await navs.nth(1).locator('button').nth(1).isEnabled()) && !(await navs.nth(2).locator('button').nth(1).isEnabled()), 'each chart has ‹ range ›, with nothing after the latest');
  const range = await navs.nth(0).locator('.chart-range').textContent();
  await navs.nth(0).locator('button').first().click();
  const older = await navs.nth(0).locator('.chart-range').textContent();
  const fiveLines = page.locator('.usage-charts .chart-sec').first().locator('.chart-svg path.line');
  await fiveLines.first().waitFor({ timeout: 3000 }).catch(() => {}); // (a chart is drawn once its box is measured)
  check(older !== range && await fiveLines.count() >= 1 && await page.locator('.usage-page .chart-svg').count() === 2,
    `‹ on the 5-hour chart shows the 48 hours before (${range} → ${older})`);
  await navs.nth(0).locator('button').nth(1).click();
  check((await navs.nth(0).locator('.chart-range').textContent()) === range, '› comes back to the latest');
  await fiveLines.first().waitFor({ timeout: 3000 }).catch(() => {});
  // (the synthetic history has one weekly cycle: nothing before it)
  check(!(await navs.nth(1).locator('button').first().isEnabled()), 'the weekly chart has no cycle before the only one on file');
  await page.mouse.move(5, 5);
}
// (polled, the pointer moved there again each time, a pixel apart: a redraw with fresher data can land in between)
let tries = 0;
const levelShown = await until(async () => {
  const box = await page.locator('.usage-page .chart-svg').nth(1).boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width * 0.35 + (tries++ % 2), box.y + box.height * 0.5); // the cycle's past (the right part is still to come)
  return /\d+%/.test(await page.locator('.chart-tip').nth(1).textContent().catch(() => '')) && await page.locator('.chart-tip').nth(1).isVisible();
}, 3000);
check(levelShown, 'hovering the curve shows the level');
{ // no dashed bridges over gaps (the area still spans them); the estimate is the dashed line and runs on backwards
  const d = await page.locator('.usage-page .chart-svg').nth(1).evaluate((x) => {
    const p = x.querySelector('path.proj');
    const pts = p ? p.getAttribute('d').match(/-?[\d.]+,-?[\d.]+/g).map((q) => q.split(',').map(Number)) : [];
    const last = [...x.querySelectorAll('path.line')].at(-1).getAttribute('d').match(/-?[\d.]+,-?[\d.]+/g).at(-1).split(',').map(Number);
    const axis = parseFloat(x.querySelector('line.axis').getAttribute('y1')), left = parseFloat(x.querySelector('line.axis').getAttribute('x1'));
    return { bridges: x.querySelectorAll('path.bridge').length, n: pts.length, first: pts[0], last, axis, left };
  });
  check(d.bridges === 0, 'the curve has no dashed bridges');
  check(d.n >= 2 && d.first[0] < d.last[0] && (Math.abs(d.first[0] - d.left) < 1.5 || Math.abs(d.first[1] - d.axis) < 1.5), `the estimate extends backwards to the start of the cycle or to zero (${JSON.stringify(d)})`);
}
{ // the estimate runs through the level now and the level 24 hours before
  const xs = fs.readFileSync(usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = xs.at(-1), prior = xs.find((x) => x.t === last.t - 24 * 3600e3);
  const f = (await rpc({ type: 'usageForecast' })).data?.week;
  const want = prior ? (last.week.pct - prior.week.pct) / 24 : NaN;
  check(f && Math.abs(f.slopePerHour - want) < 1e-6, `the estimate's slope is the last 24 hours' rise (${f?.slopePerHour} vs ${want} per hour)`);
  check(await page.locator('.usage-page .chart-svg').nth(1).locator('line.now').count() === 0, 'no vertical "now" line on the weekly chart');
}
await page.screenshot({ path: path.join(S, 'usage-level.png'), fullPage: true });
await page.click('#usageBack');
check(await page.locator('#feed').isVisible(), 'Back returns to the session');

// Detach
await hold(page, '#closeSess');
await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-detached'), null, { timeout: 10000 }).catch(() => {});
check(/st-detached/.test(await page.locator('.sess.active .dot').getAttribute('class')), 'Detach turns the session grey');

}
if (runs('C')) {
// ---- the event log keeps only what a gone session's row needs; an archived one goes entirely ----
{
  const sse = async () => { // the log's events, as a page that opens now gets them (in 800 ms)
    const st = eventStream(PORT, token);
    await wait(800);
    st.req.destroy();
    return st.events;
  };
  const kept = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  const gone = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  await rpc({ type: 'send', sid: kept, text: '/cost' }); // a local command: events, but no model call
  await until(async () => (await sse()).some((e) => e.sid === kept && e.kind === 'msg' && e.msg.type === 'result'), 30000);
  const before = (await sse()).filter((e) => e.sid === kept).length;
  await rpc({ type: 'close', sid: kept });
  await rpc({ type: 'archive', sid: gone });
  const rowOnly = (k) => k.every((e) => ['created', 'meta', 'closed', 'state'].includes(e.kind)) && k.find((e) => e.kind === 'created')?.dormant && k.some((e) => e.kind === 'closed');
  let after = [];
  await until(async () => { after = await sse(); return rowOnly(after.filter((e) => e.sid === kept)) && !after.some((e) => e.sid === gone); }, 10000); // (trimmed every half second)
  const k = after.filter((e) => e.sid === kept);
  check(k.length < before && rowOnly(k),
    `a closed session keeps only its row in the log (${before} → ${k.map((e) => e.kind)})`);
  check(!after.some((e) => e.sid === gone), 'an archived one leaves nothing');
  await rpc({ type: 'archive', sid: kept });
}

// ---- /clear, /detach and /branch wait their turn in the session's queue; the server runs them then ----
// (a command of the CLI's own, /cost, keeps a blank session in a turn for a moment: no model call)
{
  const T = eventStream(PORT, token);
  await until(() => T.up, 10000);
  const of = (sid) => T.events.filter((e) => e.sid === sid);
  const at = (sid, test) => of(sid).find(test)?.seq ?? 0;
  const result = (e) => e.kind === 'msg' && e.msg.type === 'result';
  const blank = async (title) => {
    const sid = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
    await rpc({ type: 'rename', sid, title });
    return sid;
  };
  const open = async (title) => { await page.locator('.sess-title', { hasText: title }).first().click(); await wait(300); };
  const active = () => page.evaluate(() => document.querySelector('.sess.active .sess-title')?.textContent);

  const A = await blank('queue-detach');
  check(/can't be queued/.test((await rpc({ type: 'queue', sid: A, op: 'add', text: '/help' })).error || ''), 'a command that only opens a panel is not one for the queue');
  await rpc({ type: 'send', sid: A, text: '/cost' });
  await rpc({ type: 'queue', sid: A, op: 'add', text: '/detach' });
  check(await until(() => of(A).some((e) => e.kind === 'queue' && e.items.length === 1 && e.items[0].text === '/detach'), 5000) && !of(A).some((e) => e.kind === 'closed'),
    'a /detach sent during a turn is listed in the queue, and the session runs on');
  await until(() => of(A).some((e) => e.kind === 'closed'), 30000);
  check(at(A, result) > 0 && at(A, (e) => e.kind === 'closed') > at(A, result), 'it detaches the session once the turn is over');

  // /clear with a message behind it: the session is archived, and the message starts the fresh one
  const B = await blank('queue-clear');
  await open('queue-clear');
  await page.fill('#input', 'half typed');
  await rpc({ type: 'send', sid: B, text: '/cost' });
  await rpc({ type: 'queue', sid: B, op: 'add', text: '/clear' });
  await rpc({ type: 'send', sid: B, text: '/cost' });
  check(await until(() => of(B).some((e) => e.kind === 'queue' && e.items.map((i) => i.text).join() === '/clear,/cost'), 5000), 'a /clear and the message after it wait in the queue, in order');
  await until(() => of(B).some((e) => e.kind === 'archived'), 30000);
  const next = T.events.find((e) => e.kind === 'created' && e.seq > at(B, result) && e.title === '/cost');
  check(at(B, result) > 0 && at(B, (e) => e.kind === 'archived') > at(B, result) && of(B).filter((e) => e.kind === 'user_text').length === 1,
    'the /clear archives the session once the turn is over; the message behind it was not sent there');
  check(next?.cwd === fs.realpathSync(WORK) && of(next.sid).filter((e) => e.kind === 'user_text').map((e) => e.text).join() === '/cost',
    `that message starts a fresh session in the folder (${JSON.stringify(next && { cwd: next.cwd, title: next.title })})`);
  // (the page hears it on its own stream, which can be behind the test's)
  await page.waitForFunction(() => document.querySelector('.sess.active .sess-title')?.textContent === '/cost' && document.getElementById('input').value === 'half typed'
    && ![...document.querySelectorAll('.sess-title')].some((t) => t.textContent.includes('queue-clear')), null, { timeout: 5000 }).catch(() => {});
  check(await active() === '/cost' && await page.inputValue('#input') === 'half typed' && await page.locator('.sess-title', { hasText: 'queue-clear' }).count() === 0,
    `the page that had it open shows the fresh session, with what was typed (${await active()}, ${JSON.stringify(await page.inputValue('#input'))})`);
  await page.fill('#input', '');
  await until(() => of(next.sid).some(result), 30000);

  // /clear with nothing behind it: a draft in the folder, as an unqueued /clear gives
  const C = await blank('queue-clear2');
  await open('queue-clear2');
  await rpc({ type: 'send', sid: C, text: '/cost' });
  await rpc({ type: 'queue', sid: C, op: 'add', text: '/clear' });
  await until(() => of(C).some((e) => e.kind === 'archived'), 30000);
  await page.waitForFunction(() => document.querySelector('.draft-intro') && ![...document.querySelectorAll('.sess-title')].some((t) => t.textContent.includes('queue-clear2')), null, { timeout: 5000 }).catch(() => {});
  check(await page.locator('.draft-intro').count() === 1 && await page.locator('.sess-title', { hasText: 'queue-clear2' }).count() === 0, 'a queued /clear with nothing behind it leaves a new draft open');

  // typed with nothing going on: at once, and /detach asks nothing
  const D = await blank('queue-idle');
  await open('queue-idle');
  const asked = await page.locator('.dlg-back').count();
  await page.fill('#input', '/detach');
  await page.press('#input', 'Enter');
  await until(() => of(D).some((e) => e.kind === 'closed'), 10000);
  check(of(D).some((e) => e.kind === 'closed') && !of(D).some((e) => e.kind === 'queue') && await page.locator('.dlg-back').count() === asked, 'typed in an idle session, /detach detaches it at once, without asking');
  await page.waitForFunction(() => document.querySelector('.sess.active .dot')?.classList.contains('st-detached'), null, { timeout: 5000 }).catch(() => {});
  check(/st-detached/.test(await page.locator('.sess.active .dot').getAttribute('class')), 'its row goes grey');
  T.req.destroy();
  for (const sid of [A, D, next.sid]) await rpc({ type: 'archive', sid });
}

// ---- a confirmation opens at the mouse pointer (or beside the field just typed in); a notice floats there ----
{
  await page.mouse.move(420, 300);
  const at = await page.evaluate(async () => {
    const d = await import('/ui/dialog.js');
    d.ask(null, { ok: 'Test' });
    await new Promise((r) => setTimeout(r, 0)); // (answerDialogs answers it a moment later)
    const b = document.querySelector('.dlg'); // (where it is put: the box itself is still growing)
    return b && { x: parseFloat(b.style.left), y: parseFloat(b.style.top), text: !!document.querySelector('.dlg-text') };
  });
  check(at && Math.abs(at.x - 404) <= 2 && Math.abs(at.y - 312) <= 2 && !at.text, `a confirmation is just its button, opened at the pointer (${JSON.stringify(at)})`);
  await page.locator('.dlg-back').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  // (a field of its own: no session is open here, so the composer's input is disabled)
  await page.evaluate(() => { const f = document.createElement('input'); f.id = 'dlgField'; f.style.cssText = 'position:fixed;left:300px;bottom:40px;width:300px'; document.body.append(f); });
  await page.focus('#dlgField');
  await page.keyboard.press('Shift');
  const typed = await page.evaluate(async () => {
    const d = await import('/ui/dialog.js');
    d.ask(null, { ok: 'Test' });
    await new Promise((r) => setTimeout(r, 0));
    const b = document.querySelector('.dlg'), i = document.getElementById('dlgField').getBoundingClientRect();
    const bottom = b && parseFloat(b.style.top) + b.offsetHeight;
    return b && { above: bottom <= i.top, gap: Math.round(i.top - bottom) };
  });
  check(typed?.above && typed.gap < 20, `after typing it opens just above the field typed in (${JSON.stringify(typed)})`);
  await page.locator('.dlg-back').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('dlgField').remove());
  await page.mouse.move(500, 250);
  const note = await page.evaluate(async () => {
    (await import('/ui/dialog.js')).tell('Something went wrong');
    const t = document.querySelector('.toast.note');
    return t && { x: parseFloat(t.style.left), y: parseFloat(t.style.top), dlg: !!document.querySelector('.dlg-back') };
  });
  check(note && Math.abs(note.x - 484) <= 2 && Math.abs(note.y - 262) <= 2 && !note.dlg, `a notice floats at the pointer, nothing to click (${JSON.stringify(note)})`);
}

// ---- press and hold (ui/hold.js): a click does nothing, half a second's hold runs it once, sliding off drops it ----
{
  await page.evaluate(async () => {
    const { holdToRun } = await import('/ui/hold.js');
    const b = document.createElement('button');
    b.id = 'holdTest'; b.textContent = 'Stop'; b.style.cssText = 'position:fixed;left:300px;top:300px;z-index:99';
    window.__held = 0; window.__clicked = 0;
    b.onclick = () => window.__clicked++;
    holdToRun(b, () => window.__held++);
    document.body.append(b);
  });
  const n = () => page.evaluate(() => [window.__held, window.__clicked]);
  await page.click('#holdTest');
  await wait(1200);
  check((await n())[0] === 0, 'a plain click on a held control does nothing');
  await page.hover('#holdTest');
  await page.mouse.down();
  // (the fill read at its middle, its transition paused there: read by the clock, a slow machine reads it
  // before it has started or once it is over)
  const mid = await page.locator('#holdTest').evaluate((b) => {
    const a = b.getAnimations({ subtree: true }).find((x) => x.transitionProperty === 'transform');
    if (!b.classList.contains('holding') || !a) return null;
    a.pause();
    a.currentTime = 250;
    const fill = new DOMMatrix(getComputedStyle(b, '::after').transform).a;
    a.play();
    return { fill, ms: a.effect.getTiming().duration };
  });
  await until(async () => (await n())[0] === 1, 5000); // (let go once it ran: the half second is the page's)
  await page.mouse.up();
  check(Math.abs(mid?.fill - 0.5) < 0.05 && mid.ms === 500 && (await n()).join() === '1,1', `held for half a second it runs once, the fill growing across it meanwhile (${JSON.stringify(mid)}, ${await n()})`);
  // (the click that ends the hold reached only the swallowing listener: __clicked counts the plain click above)
  await page.hover('#holdTest');
  await page.mouse.down();
  await page.locator('#holdTest.holding').waitFor({ timeout: 5000 }).catch(() => {}); // (and off at once: a fixed wait can outlast the half second)
  await page.mouse.move(600, 600);
  await wait(600);
  await page.mouse.up();
  check((await n())[0] === 1, 'sliding off before the half second is up drops it');
  await page.evaluate(() => document.getElementById('holdTest').remove());
}

// ---- a new session and a branch show at once, before a slow server answers (here 1.5 s) ----
{
  const dir = fs.realpathSync(WORK);
  // `as`: what the server is sent instead (the UI's own /cost never reaches it)
  const slow = (type, refuse, as) => page.route('**/cmd', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.type !== type) return route.continue();
    await wait(1500);
    if (refuse) route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: 'refused for the test' }) });
    else route.continue(as ? { postData: JSON.stringify({ ...body, ...as }) } : undefined);
  });
  const look = () => page.evaluate(() => ({
    q: document.querySelector('#feed .turn-q-text')?.textContent, note: document.querySelector('#feed .pending-note')?.textContent,
    intro: !!document.querySelector('.draft-intro'), input: document.getElementById('input').value,
    row: document.querySelector('.sess.active .sess-title')?.textContent, dot: document.querySelector('.sess.active .dot')?.className,
    branched: /branched/.test(document.getElementById('feed').textContent),
  }));
  const settled = () => page.waitForFunction(() => !document.querySelector('.pending-note'), null, { timeout: 15000 }).catch(() => {});

  await slow('new', true);
  await page.click(`.folder[data-dir="${dir}"] .folder-new`);
  await page.locator('.draft-intro').waitFor({ timeout: 5000 });
  await page.fill('#input', 'shown at once');
  await page.press('#input', 'Enter');
  await wait(150);
  const early = await look();
  check(early.q === 'shown at once' && /starting/.test(early.note || '') && early.input === '' && early.row === 'shown at once' && early.dot === 'dot st-busy',
    `a new session shows at once: its message, its row, an empty input (${JSON.stringify(early)})`);
  await settled();
  const refused = await look();
  check(refused.intro && refused.input === 'shown at once' && !refused.row, `refused: back to the draft, the message in the input again (${JSON.stringify(refused)})`);
  await page.unroute('**/cmd');

  await slow('new', false, { text: '/cost' }); // the server runs a CLI command: a real session, no model call
  await page.fill('#input', 'shown then real');
  await page.press('#input', 'Enter');
  await wait(150);
  const ok = await look();
  check(ok.row === 'shown then real' && ok.q === 'shown then real' && /starting/.test(ok.note || ''), `again, shown at once (${JSON.stringify(ok)})`);
  await settled();
  // (the row is redrawn on the next frame)
  await page.waitForFunction(() => document.querySelector('.sess.active .sess-title')?.textContent === '/cost'
    && ![...document.querySelectorAll('.sess-title')].some((t) => t.textContent.includes('shown then real')), null, { timeout: 5000 }).catch(() => {});
  const real = await look();
  check(real.row === '/cost' && !real.intro && !real.note && await page.locator('.sess-title', { hasText: /^\/cost$/ }).count() === 1
    && await page.locator('.sess-title', { hasText: 'shown then real' }).count() === 0,
  `then the server's session takes its place: one row, open (${JSON.stringify(real)})`);
  await page.unroute('**/cmd');

  // (typed during a turn it would wait in the queue: the /cost is over first)
  await page.waitForFunction(() => !document.querySelector('.sess.active .dot.st-busy'), null, { timeout: 15000 }).catch(() => {});
  await slow('branch', true);
  await page.fill('#input', '/branch');
  await page.click('#send');
  await wait(150);
  const br = await look();
  check(br.row === '/cost (branch)' && br.branched && /starting the branch/.test(br.note || ''), `a branch shows at once, with the conversation copied (${JSON.stringify(br)})`);
  await settled();
  const brBack = await look();
  check(brBack.row === '/cost' && !brBack.branched && await page.locator('.sess-title', { hasText: '(branch)' }).count() === 0,
    `refused: the branch goes and the original opens again (${JSON.stringify(brBack)})`);
  await page.unroute('**/cmd');
}

// ---- streamed text is typed out evenly, however it arrives: in bursts from a remote server ----
{
  const p2 = await ctx.newPage(); // its own page: the staged events stay out of the main one's log
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(page.url());
  await p2.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  const sid = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  await rpc({ type: 'rename', sid, title: 'typewriter' });
  await p2.locator('.sess', { hasText: 'typewriter' }).click();
  await p2.waitForFunction(() => document.getElementById('title').textContent === 'typewriter', null, { timeout: 5000 }).catch(() => {});
  // The page's frames and clock are the test's from here, a frame every FRAME ms: on a slow machine real
  // frames come late and few, and the pace read would be the machine's. (Its waits here poll on a timer.)
  const FRAME = 20;
  await p2.evaluate((FRAME) => {
    let now = performance.now(), id = 0;
    const q = new Map();
    performance.now = () => now;
    window.requestAnimationFrame = (cb) => (q.set(++id, cb), id);
    window.cancelAnimationFrame = (i) => q.delete(i);
    // `n` frames, and what `sample()` reads after each
    window.__frames = (n, sample = () => 0) => Array.from({ length: n }, () => {
      now += FRAME;
      const cbs = [...q.values()];
      q.clear();
      cbs.forEach((f) => f(now));
      return sample();
    });
  }, FRAME);
  // one burst: 20 deltas in one packet; the shown length after each frame, for a second
  const burst = (n, k) => p2.evaluate(({ sid, n, k, frames }) => {
    for (let i = 0; i < 20; i++) window.__iroFeed({ type: 'partial', sid, op: 'delta', block: 'text', text: `w${k}-${i} `.padEnd(n / 20, '.') });
    return window.__frames(frames, () => document.querySelector('#feed .assistant.live')?.textContent.length ?? -1);
  }, { sid, n, k, frames: 1000 / FRAME });
  await p2.evaluate((sid) => window.__iroFeed({ type: 'partial', sid, op: 'start', block: 'text' }), sid);
  const a = await burst(400, 1);
  const allAfter = (xs) => xs.findIndex((x) => x >= xs.at(-1)) + 1; // the frames until all of it shows
  // (the first burst is spread over 200 ms, the page's TYPE_FIRST_MS)
  check(a[0] < 200 && a.at(-1) >= 390 && Math.abs(allAfter(a) - 200 / FRAME) <= 1, `a burst of 400 characters is typed out over several frames, not at once (all shown after ${allAfter(a)} frames: ${a.slice(0, 8)}… ${a.at(-1)})`);
  // leaving the session mid-reply stops the typing; back in it, the text so far is there and typing goes on from it
  await p2.locator('.sess:not(.active)').first().click();
  await p2.waitForFunction(() => document.getElementById('title').textContent !== 'typewriter', null, { timeout: 5000, polling: 100 }).catch(() => {});
  await p2.evaluate((sid) => window.__iroFeed({ type: 'partial', sid, op: 'delta', block: 'text', text: ' and more while away.' }), sid);
  await p2.locator('.sess', { hasText: 'typewriter' }).click();
  const backAt = await p2.evaluate(() => document.querySelector('#feed .assistant.live')?.textContent ?? '');
  check(backAt.length >= a.at(-1) && backAt.includes('while away'), `back in the session mid-reply, the text so far shows at once (${backAt.length} chars, ends ${JSON.stringify(backAt.slice(-24))})`);
  const b = await burst(400, 2); // a second burst a second later: spread over about that second, up to 600 ms (TYPE_MAX_MS)
  check(b[0] < backAt.length + 200 && Math.abs(allAfter(b) - 600 / FRAME) <= 1, `the next one is typed on from there, spread over the gap between bursts (all shown after ${allAfter(b)} frames)`);
  // the finished message arrives while text is still being typed: it waits for the typing, then takes its place
  const full = await p2.evaluate(() => document.querySelector('#feed .assistant.live').textContent);
  const more = ' and then the rest of the reply, which arrived together with the finished message.';
  const fin = await p2.evaluate(({ sid, text, more, FRAME }) => {
    window.__iroFeed({ type: 'partial', sid, op: 'delta', block: 'text', text: more });
    window.__iroFeed({ type: 'event', seq: 1e12, sid, ts: Date.now(), kind: 'msg',
      msg: { type: 'assistant', uuid: 'u-final', parent_tool_use_id: null, message: { model: 'claude-test', content: [{ type: 'text', text }] } } });
    const at = () => ({ live: !!document.querySelector('#feed .assistant.live'), shown: [...document.querySelectorAll('#feed .assistant')].filter((x) => x.offsetParent).map((x) => x.textContent) });
    const now = at();
    window.__frames(900 / FRAME);
    return { now, later: at() };
  }, { sid, text: full + more, more, FRAME });
  check(fin.now.live && fin.now.shown.length === 1 && !fin.now.shown[0].includes('arrived together'), `the finished message waits while the text is typed out (${JSON.stringify(fin.now).slice(0, 120)})`);
  check(!fin.later.live && fin.later.shown.length === 1 && fin.later.shown[0].trim().endsWith('finished message.'), `then it takes the live text's place (${JSON.stringify(fin.later).slice(-120)})`);
  await p2.close();
  await rpc({ type: 'archive', sid });
}

// ---- text Claude leaves without a marker: the reply while it is the last thing written, a log once more follows in the turn ----
{
  const p2 = await ctx.newPage(); // its own page: the staged events stay out of the main one's log
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(page.url());
  await p2.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  const sid = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  await rpc({ type: 'rename', sid, title: 'unmarked' });
  await p2.locator('.sess', { hasText: 'unmarked' }).click();
  await p2.waitForFunction(() => document.getElementById('title').textContent === 'unmarked', null, { timeout: 5000 }).catch(() => {});
  const seen = await p2.evaluate(async (sid) => {
    let seq = 1e12;
    const feed = (e) => window.__iroFeed({ type: 'event', seq: seq++, sid, ts: Date.now(), ...e });
    const say = (content) => feed({ kind: 'msg', msg: { type: 'assistant', uuid: `u${seq}`, parent_tool_use_id: null, message: { model: 'claude-test', content } } });
    const kinds = () => [...document.querySelectorAll('#feed .assistant')].map((a) => (a.querySelector('.md-log') ? 'log' : a.querySelector('.md-role') ? 'marked' : 'reply'));
    const tick = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = [];
    feed({ kind: 'user_text', text: 'first' });
    say([{ type: 'text', text: 'Now the config dataclasses.' }]); await tick(); out.push(kinds());
    say([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]); await tick(); out.push(kinds());
    say([{ type: 'text', text: ':::reply\nMarked.\n:::\n\nAnd the answer, unmarked.' }]); await tick(); out.push(kinds());
    feed({ kind: 'user_text', text: 'second' });
    say([{ type: 'text', text: 'Next turn.' }]); await tick(); out.push(kinds());
    return out;
  }, sid);
  check(JSON.stringify(seen) === '[["reply"],["log"],["log","marked"],["log","marked","reply"]]',
    `unmarked text reads as the reply until more of the turn follows, then as a log; the last answer of a turn stays one (${JSON.stringify(seen)})`);
  await p2.close();
  await rpc({ type: 'archive', sid });
}

// ---- a request is shown like the input: four lines at most, then a corner button that opens the whole of it ----
{
  const p2 = await ctx.newPage(); // its own page: the staged events stay out of the main one's log
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(page.url());
  await p2.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  const sid = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  await rpc({ type: 'rename', sid, title: 'requests' });
  await p2.locator('.sess', { hasText: 'requests' }).click();
  await p2.waitForFunction(() => document.getElementById('title').textContent === 'requests', null, { timeout: 5000 }).catch(() => {});
  const long = 'A long request that goes on well past the fourth line of its card. '.repeat(40);
  await p2.evaluate(({ sid, texts }) => texts.forEach((text, i) => window.__iroFeed({ type: 'event', seq: 1e12 + i, sid, ts: Date.now(), kind: 'user_text', text })),
    { sid, texts: ['One line.', 'Two lines:\nthe second.', long] });
  await p2.locator('.turn-q.long').waitFor({ timeout: 5000 }).catch(() => {});
  const cards = () => p2.evaluate(() => ({
    pill: document.querySelector('.input-wrap').getBoundingClientRect().height,
    win: window.innerHeight, feed: document.getElementById('feed').clientHeight,
    cards: [...document.querySelectorAll('.turn-q')].map((q) => {
      const t = q.querySelector('.turn-q-text'), b = q.querySelector('.turn-expand');
      return { h: q.getBoundingClientRect().height, lines: Math.round(t.clientHeight / parseFloat(getComputedStyle(t).lineHeight)), button: !!b.offsetParent, open: q.classList.contains('open'),
        arrows: ['out', 'in'].filter((d) => getComputedStyle(b.querySelector(`.ic-${d}`)).display !== 'none').join(),
        inside: q.querySelector('.turn-q-scroll').scrollHeight > q.querySelector('.turn-q-scroll').clientHeight + 1 };
    }),
  }));
  const shut = await cards();
  const [one, two, more] = shut.cards;
  check(Math.abs(one.h - shut.pill) <= 1 && one.lines === 1 && !one.button, `a one-line request is as tall as the empty input (${one.h} vs ${shut.pill})`);
  check(two.lines === 2 && !two.button, `a few lines are shown whole, with no button (${JSON.stringify(two)})`);
  check(more.lines === 4 && more.button && more.arrows === 'out' && more.h === two.h + 2 * (two.h - one.h) && !more.inside, `a longer one is cut at four lines and gets the corner button (${JSON.stringify(more)})`);
  await p2.locator('.turn-q.long .turn-expand').click();
  const open = (await cards()).cards[2];
  check(open.open && open.lines > 4 && open.inside && open.h <= shut.win / 2 + 32, `the button opens it: up to half the window, the rest scrolls inside (${JSON.stringify(open)}, window ${shut.win})`);
  check(open.arrows === 'in', `opened, the button's arrows point inwards: it closes the card (${open.arrows})`);
  await p2.locator('.turn-q.long .turn-expand').click();
  const again = (await cards()).cards[2];
  check(!again.open && again.arrows === 'out' && again.lines === 4 && again.h === more.h, `and closes it again (${JSON.stringify(again)})`);
  // a short window: fewer lines, so the card leaves the conversation its room; opened, it still shows its text
  await p2.setViewportSize({ width: 1400, height: 440 });
  // (the feed shrinks in steps, the input's height easing in last; on a slow machine a step can be read as the
  // end: wait until its height holds, and the lines shown are those that height gives)
  let lastH = -1;
  await until(() => p2.evaluate(() => {
    const f = document.getElementById('feed');
    return [f.clientHeight, getComputedStyle(f).getPropertyValue('--q-lines') === String(Math.max(1, Math.min(4, Math.floor((f.clientHeight / 3 - 30) / 24))))];
  }).then(([h, fits]) => { const held = h === lastH; lastH = h; return held && fits; }), 5000, 'the short window\'s feed settles');
  const low = await cards();
  check(low.cards[2].lines < 4 && low.cards[2].button && low.cards[2].h <= low.feed / 3 + 1, `in a short window it shows fewer lines: a third of the conversation at most (${low.cards[2].lines} lines, ${low.cards[2].h} of ${low.feed})`);
  await p2.locator('.turn-q.long .turn-expand').last().click();
  const lowOpen = (await cards()).cards[2];
  check(lowOpen.open && lowOpen.h >= low.cards[2].h && lowOpen.h < low.feed, `opened there, it is no smaller than it was and fits the conversation (${lowOpen.h} of ${low.feed})`);
  await p2.close();
  await rpc({ type: 'archive', sid });
}

// ---- progress list: a session starts one with the irowell:progress skill's script; from then on it sits at the
// rail's foot, the user edits it there, and the script reports what they changed ----
{
  const p2 = await ctx.newPage(); // its own page: the staged events stay out of the main one's log
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(page.url());
  await p2.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  const sid = (await rpc({ type: 'new', cwd: WORK, blank: true })).data.sid;
  await rpc({ type: 'rename', sid, title: 'long task' });
  await p2.locator('.sess', { hasText: 'long task' }).click();
  await p2.waitForFunction(() => document.getElementById('title').textContent === 'long task', null, { timeout: 5000 }).catch(() => {});
  const ID = '00000000-0000-4000-8000-0000000000aa'; // the session's Claude session id, as Claude Code names it to the script
  // (CLAUDE_PID: a CLI that runs, as a live session's Bash tool has it; without one every daemon here lists the script as left running)
  const cli = (...args) => {
    try { return execFileSync(process.execPath, [path.join(REPO, 'skills', 'progress', 'progress.mjs'), ...args], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: ID, CLAUDE_PID: String(process.pid) }, stdio: 'pipe' }).toString(); }
    catch (e) { return String(e.stdout) + String(e.stderr); }
  };
  const items = () => p2.evaluate(() => [...document.querySelectorAll('#progress .pg-item')].map((r) => `${r.className.replace('pg-item ', '')}:${r.querySelector('.pg-text').textContent}`).join(' | '));
  const item = (text) => p2.locator('#progress .pg-item', { hasText: text });
  check(/no progress list yet/.test(cli()), 'progress: a session has no list until it starts one');
  check((await rpc({ type: 'progressCli', session: ID, op: 'add', texts: ['x'] })).status === 400, 'the page can\'t write to a list as the session');
  check(/no progress list/.test((await rpc({ type: 'progressEdit', claudeSessionId: ID, op: 'add', texts: ['x'] })).error || '') && (await rpc({ type: 'progress', claudeSessionId: ID })).data === null,
    'nor start one: only the session does (the skill)');
  check(/No such session/.test((await rpc({ type: 'progress', claudeSessionId: '../folders' })).error || ''), 'a list is named by a session id, never a path');
  // the page learns the session's Claude session id, as the session's first turn tells it
  // (and asks for its list: the answer, none, must not land after the first add's)
  const asked = p2.waitForResponse((r) => r.url().endsWith('/cmd') && JSON.parse(r.request().postData() || '{}').type === 'progress', { timeout: 5000 }).catch(() => {});
  await p2.evaluate(({ sid, ID }) => window.__iroFeed({ type: 'event', seq: 1e12, sid, ts: Date.now(), kind: 'init', claudeSessionId: ID }), { sid, ID });
  await asked;
  check(await p2.locator('#progress').isHidden(), 'the rail shows no progress list before there is one');
  const started = cli('add', 'Load the data', 'Train the baseline', 'Write it up');
  check(started === 'Progress list (0 of 3 done)\n  1 [ ] Load the data\n  2 [ ] Train the baseline\n  3 [ ] Write it up\n', `the script's first add starts the list and prints it (${JSON.stringify(started)})`);
  await item('Write it up').waitFor({ timeout: 5000 }).catch(() => {});
  cli('done', '1'); cli('doing', '2');
  await until(async () => await items() === 'done:Load the data | doing:Train the baseline | todo:Write it up', 5000); // (two changes: two lists sent)
  check(await items() === 'done:Load the data | doing:Train the baseline | todo:Write it up', `it shows in the rail as Claude changes it (${await items()})`);
  check(await page.locator('#progress').isHidden(), 'only for the session it belongs to');
  const place = () => p2.evaluate(() => {
    const r = document.getElementById('rail').getBoundingClientRect(), b = document.getElementById('progress').getBoundingClientRect();
    return { foot: Math.round(r.bottom - b.bottom), left: Math.round(b.left - r.left), right: Math.round(r.right - b.right), h: Math.round(b.height), list: Math.round(document.querySelector('#progress .pg-fold').getBoundingClientRect().height) };
  });
  const open = await place();
  check(open.foot === 0 && open.left <= 1 && open.right === 0, `it is docked at the rail's foot, edge to edge (${JSON.stringify(open)})`);
  for (const tab of ['tasks', 'btw', 'anchors']) { await p2.click(`#railtabs button[data-tab="${tab}"]`); if (!await p2.locator('#progress').isVisible()) check(false, `the list stays under the ${tab} tab`); }
  // the user's side: mark, reword, add, reorder, remove
  const marked = p2.waitForResponse((r) => r.url().endsWith('/cmd') && JSON.parse(r.request().postData() || '{}').type === 'progressEdit', { timeout: 5000 }).catch(() => {});
  await item('Write it up').locator('.pg-state').click();
  await p2.waitForFunction(() => document.querySelectorAll('#progress .pg-item.doing').length === 2, null, { timeout: 5000 }).catch(() => {});
  await marked; // (and its answer: a redraw between the next click's press and release would lose the click)
  await item('Train the baseline').locator('.pg-text').click();
  const field = await item('Train the baseline').locator('.pg-text').evaluate((t) => { const c = getComputedStyle(t); return { on: document.activeElement === t, outline: c.outlineStyle, edge: c.boxShadow }; });
  const accent = await p2.evaluate(() => { const d = document.createElement('i'); d.style.color = 'var(--accent)'; document.body.append(d); const c = getComputedStyle(d).color; d.remove(); return c; });
  check(field.on && field.outline === 'none' && field.edge.includes(accent), `a click on an item's text makes it a field with the accent on its edge, not the browser's ring (${JSON.stringify(field)})`);
  await p2.keyboard.press('End');
  await p2.keyboard.type(' twice');
  const meanwhile = cli('add', 'Check the numbers'); // Claude adds one meanwhile: the field keeps its text and its focus
  check(/\n\nThe user changed the list since you last read it:\n +\d\d-\d\d \d\d:\d\d  marked 3 doing \(was todo\): "Write it up"\n$/.test(meanwhile), `whatever the script is run for, its output ends with what the user changed since (${JSON.stringify(meanwhile)})`);
  await wait(400);
  check(await item('Train the baseline twice').locator('.pg-text').evaluate((t) => document.activeElement === t) && await item('Check the numbers').count() === 0, 'a change from Claude meanwhile waits for the field');
  await p2.keyboard.press('Enter');
  await item('Check the numbers').waitFor({ timeout: 5000 }).catch(() => {});
  await p2.fill('#progress .pg-add', 'Report GPU hours');
  await p2.press('#progress .pg-add', 'Enter');
  await item('Report GPU hours').waitFor({ timeout: 5000 }).catch(() => {});
  check(await p2.inputValue('#progress .pg-add') === '', 'Enter in the box adds an item and empties the box');
  await until(async () => Number(await item('Report GPU hours').getAttribute('data-id')) > 0, 5000); // (it is moved by the id the server gives it)
  await item('Report GPU hours').dragTo(item('Train the baseline twice'), { targetPosition: { x: 60, y: 3 } });
  await p2.waitForFunction(() => document.querySelectorAll('#progress .pg-item')[1]?.textContent.includes('Report GPU hours'), null, { timeout: 5000 }).catch(() => {});
  await item('Load the data').hover();
  await item('Load the data').locator('.pg-x').click();
  await p2.waitForFunction(() => document.querySelectorAll('#progress .pg-item').length === 4, null, { timeout: 5000 }).catch(() => {});
  check(await items() === 'todo:Report GPU hours | doing:Train the baseline twice | doing:Write it up | todo:Check the numbers' && await p2.locator('#progress .pg-count').textContent() === '0/4',
    `marked, reworded, added, dragged above another, removed (${await items()})`);
  await until(async () => (await rpc({ type: 'progress', claudeSessionId: ID })).data?.items.map((i) => i.text).join() === 'Report GPU hours,Train the baseline twice,Write it up,Check the numbers', 5000); // (the server has them all)
  const told = cli();
  check(told.startsWith('Progress list (0 of 4 done)\n  5 [ ] Report GPU hours\n  2 [~] Train the baseline twice\n  3 [~] Write it up\n  4 [ ] Check the numbers\n\nThe user changed the list since you last read it:\n')
    && ['reworded 2: "Train the baseline" -> "Train the baseline twice"', 'added 5 "Report GPU hours" below 4', 'moved 5 below 1: "Report GPU hours"', 'removed 1 (was done): "Load the data"']
      .every((l, i, all) => told.includes(l) && (!i || told.indexOf(all[i - 1]) < told.indexOf(l))) && !/Check the numbers"|Write it up"/.test(told),
    `the next time, the changes after that, in order: not Claude's own, nor one it was told already (${JSON.stringify(told)})`);
  check(!/The user changed/.test(cli()), 'each change is told once');
  const all = cli('log');
  check(/you +added 1 "Load the data" at the top/.test(all) && /user +removed 1 \(was done\): "Load the data"/.test(all), 'the log keeps every change with who made it');
  check(/The list has no item 1\n/.test(cli('done', '1')) && /^Unknown command: finish\nusage:/.test(cli('finish')), 'an item that is gone, or a command the script doesn\'t have, is said so');
  // the anchors keep clear of it, and it never takes more than half the rail
  await p2.evaluate(({ sid }) => { for (let i = 1; i <= 40; i++) window.__iroFeed({ type: 'event', seq: 1e12 + i, sid, ts: Date.now(), kind: 'user_text', text: `request ${i}` }); }, { sid });
  await p2.locator('#outline .ol-item').nth(39).waitFor({ timeout: 5000 }).catch(() => {});
  const clear = () => p2.evaluate(() => {
    const last = document.querySelector('#outline').lastElementChild.getBoundingClientRect(), b = document.getElementById('progress').getBoundingClientRect(), tabs = document.getElementById('railtabs').getBoundingClientRect().bottom;
    return { last: Math.round(last.top), spot: Math.round(tabs + (b.top - tabs) / 3), above: last.bottom <= b.top };
  });
  const placed = (c) => c.above && Math.abs(c.last - c.spot) <= 2;
  let c1, c2;
  await until(async () => placed(c1 = await clear()), 5000); // (placed on a later frame)
  check(placed(c1), `the newest anchor rests a third of the way down the room above the list (${JSON.stringify(c1)})`);
  cli('add', ...Array.from({ length: 40 }, (_, i) => `Experiment ${i + 1}`));
  await item('Experiment 40').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
  await until(async () => placed(c2 = await clear()), 5000);
  const full = await place();
  check(full.h <= 451 && full.h > open.h && await p2.evaluate(() => { const l = document.querySelector('#progress .pg-list'); return l.scrollHeight > l.clientHeight + 100; }) && await p2.locator('#progress .pg-add').isVisible(),
    `a long list takes half the rail at most and scrolls inside, the box still below it (${full.h} of 900)`);
  check(placed(c2), `and the anchors move up to the room that is left (${JSON.stringify(c2)})`);
  // folded: the body closes downwards, the bar stays at the foot
  await p2.click('#progress .pg-bar');
  let shut;
  await until(async () => (shut = await place()).list === 0, 5000); // (it folds over .18 s)
  check(shut.list === 0 && shut.foot === 0 && shut.h < 50 && await p2.locator('#progress .pg-count').textContent() === '0/44' && await p2.locator('#progress .pg-bar').getAttribute('aria-expanded') === 'false',
    `its bar folds it down to one line at the rail's foot (${JSON.stringify(shut)})`);
  const p3 = await ctx.newPage(); // (folded is remembered in this browser)
  await p3.goto(page.url());
  await p3.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  check(await p3.evaluate(() => document.getElementById('progress').classList.contains('folded')), 'folded stays folded in a page opened later');
  await p3.close();
  await p2.click('#progress .pg-bar');
  check(await until(async () => (await place()).h === full.h, 5000), 'and opens again');
  // ended: by the user's End (held, as Detach is), or by the session once the user said yes
  const endBtn = p2.locator('#progress .pg-end');
  await endBtn.click();
  await wait(400);
  check(await p2.locator('#progress').isVisible(), 'a click on End does nothing: it is held');
  await endBtn.hover();
  await p2.mouse.down();
  await p2.locator('#progress').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {}); // (let go once it ran)
  await p2.mouse.up();
  await until(async () => (await rpc({ type: 'progress', claudeSessionId: ID })).data === null, 5000); // (it is hidden before the server has it)
  check(await p2.locator('#progress').isHidden() && (await rpc({ type: 'progress', claudeSessionId: ID })).data === null, 'held, End ends the list: it leaves the rail');
  check(/no progress list/.test((await rpc({ type: 'progressEdit', claudeSessionId: ID, op: 'add', texts: ['x'] })).error || ''), 'and the page can\'t write to it any more');
  const ended = cli();
  check(/^Progress list: ended\. `add` starts a new one\.\n\nThe user changed the list since you last read it:\n +\d\d-\d\d \d\d:\d\d  ended the list \(0 of 44 done\)\n$/.test(ended), `the session is told the user ended it (${JSON.stringify(ended)})`);
  check(/user +ended the list \(0 of 44 done\)/.test(cli('log')), 'the log keeps it');
  const again = cli('add', 'Next task');
  check(/^Progress list \(0 of 1 done\)\n  46 \[ \] Next task\n$/.test(again), `the session's next add starts a new list (${JSON.stringify(again)})`);
  await item('Next task').waitFor({ timeout: 5000 }).catch(() => {});
  check(await items() === 'todo:Next task' && await p2.locator('#progress .pg-count').textContent() === '0/1', `a new list shows again, with only its own items (${await items()})`);
  const allDone = cli('done', '46');
  check(/\n\nEvery item is done\. Once the user has nothing more to add or change, ask them whether to end the list; run `end` only after they say yes\.\n$/.test(allDone), `with every item done, the session is told to ask the user before ending it (${JSON.stringify(allDone)})`);
  check(/^Progress list: ended\. `add` starts a new one\.\n$/.test(cli('end')), 'the session\'s `end` ends it');
  await p2.locator('#progress').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  check(await p2.locator('#progress').isHidden() && /The list has no item 46|no progress list/.test(cli('done', '46')), 'and it leaves the rail too');
  await p2.close();
  await rpc({ type: 'archive', sid });
}

// ---- workplace: beside the title, the git worktree and branch the session works in (irowell:workplace) ----
{
  const GIT = path.join(S, 'quick-git');
  fs.rmSync(GIT, { recursive: true, force: true });
  fs.rmSync(GIT + '-feat', { recursive: true, force: true });
  fs.mkdirSync(GIT);
  const git = (...args) => execFileSync('git', args, { cwd: GIT, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(GIT, 'a.txt'), 'a\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
  git('worktree', 'add', '-q', '-b', 'feat', GIT + '-feat');
  await addFolder(page, GIT);
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(page.url());
  await p2.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  const work = () => p2.evaluate(() => { const el = document.getElementById('sb-work'); return el.hidden ? null : { text: el.textContent, wt: el.querySelector('.wt')?.textContent ?? null, title: el.title }; });
  const sid = (await rpc({ type: 'new', cwd: GIT, blank: true })).data.sid;
  await rpc({ type: 'rename', sid, title: 'in git' });
  await p2.locator('.sess', { hasText: 'in git' }).click();
  await p2.waitForFunction(() => !document.getElementById('sb-work').hidden, null, { timeout: 5000 }).catch(() => {});
  const home = await work();
  check(home?.text === 'main' && home.wt === null && home.title.includes(fs.realpathSync(GIT)), `workplace: in a git folder the title shows its branch (${JSON.stringify(home)})`);
  // another worktree, as the daemon reports it once the session said so
  await p2.evaluate(({ sid, root }) => window.__iroFeed({ type: 'event', seq: 1e12, sid, ts: Date.now(), kind: 'stats', work: { root, branch: 'feat', other: true, set: true } }), { sid, root: fs.realpathSync(GIT + '-feat') });
  await p2.waitForFunction(() => !!document.querySelector('#sb-work .wt'), null, { timeout: 5000 }).catch(() => {});
  const other = await work();
  check(other?.wt === 'quick-git-feat' && other.text === 'quick-git-featfeat' && /^Worktree: .*quick-git-feat\nBranch: feat$/.test(other.title), `another worktree: its name, then its branch (${JSON.stringify(other)})`);
  const box = await p2.evaluate(() => { const t = document.getElementById('title').getBoundingClientRect(), w = document.getElementById('sb-work').getBoundingClientRect(); return { right: w.left >= t.right, mid: Math.abs((t.top + t.bottom) / 2 - (w.top + w.bottom) / 2) }; });
  check(box.right && box.mid <= 3, `it sits right of the title, on its line (${JSON.stringify(box)})`);
  await p2.screenshot({ path: path.join(S, 'workplace-chip.png'), clip: { x: 0, y: 0, width: 1100, height: 110 } });
  // the session's script: only the session uses it, and only on a git working tree
  check((await rpc({ type: 'workplaceCli', session: 'x', op: 'reset' })).status === 400, 'the page can\'t set it as the session');
  // (CLAUDE_PID: as for the progress script)
  const cli = (...args) => {
    try { return execFileSync(process.execPath, [path.join(REPO, 'skills', 'workplace', 'workplace.mjs'), ...args], { env: { ...process.env, CLAUDE_CODE_SESSION_ID: '00000000-0000-4000-8000-0000000000bb', CLAUDE_PID: String(process.pid) }, stdio: 'pipe' }).toString(); }
    catch (e) { return String(e.stdout) + String(e.stderr); }
  };
  check(/^Not in a git working tree: /.test(cli('set', S)) && /^No such directory: /.test(cli('set', path.join(S, 'nowhere'))) && /^Unknown command: go\nusage:/.test(cli('go')),
    'a directory outside git, one that isn\'t there, a command it doesn\'t have: said so');
  // not in git: nothing beside the title
  const PLAIN = path.join(S, 'quick-plain');
  fs.mkdirSync(PLAIN, { recursive: true });
  const plain = await rpc({ type: 'new', cwd: PLAIN, blank: true });
  const st = await rpc({ type: 'stats', sid: plain.data?.sid });
  check(st.data && st.data.work === null, `a folder outside git shows none (${JSON.stringify(plain)} ${JSON.stringify(st.data?.work)})`);
  await p2.close();
  await rpc({ type: 'archive', sid });
  await rpc({ type: 'archive', sid: plain.data?.sid });
}

}
if (runs('D')) {
// ---- Left running: what sessions that have ended left behind shows by the server's name, by session, and
// stops there (a job whole; one that ignores SIGTERM gets SIGKILL after 5 s) ----
{
  // (as a session's Bash tool leaves them: its id in the environment, and the pid of a CLI that has exited: one
  // that just did. A made-up pid can be a process that runs: Linux's go well past 99999)
  const gone = String(spawnSync('true').pid);
  const leave = (cid, code) => {
    const p = spawn(process.execPath, ['-e', code], { env: { ...cleanEnv(), CLAUDE_CODE_SESSION_ID: cid, CLAUDE_PID: gone }, detached: true, stdio: 'ignore' });
    p.unref();
    return p.pid;
  };
  const runsStill = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const kidOf = (pid) => { try { return Number(execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n')[0]); } catch { return 0; } };
  const [c1, c2] = [crypto.randomUUID(), crypto.randomUUID()];
  // (the count is the whole machine's: this one's own leftovers, and what other suites running meanwhile leave,
  // come and go. So the button is held to the list the server gives at the same moment, and only ours are looked at)
  const sketch = (l) => JSON.stringify(l.map((g) => [g.cid.slice(0, 8), g.procs.map((p) => `${p.pid} ${(p.cmd || '').slice(0, 60)}`)]));
  const leftNow = async () => (await rpc({ type: 'leftRunning' })).data || [];
  const jobs = (l) => l.reduce((n, g) => n + g.procs.length, 0);
  const ours = (l) => l.filter((g) => g.cid === c1 || g.cid === c2).reduce((n, g) => n + g.procs.length, 0);
  // the button shows the server's count (none: no button), and ours in it are `n` (the server tells the page of
  // each list it is asked for)
  const countIs = async (n) => { const l = await leftNow(); return ours(l) === n && (jobs(l) ? (await btn.isVisible()) && (await btn.textContent()).trim() === String(jobs(l)) : !(await btn.isVisible())); };
  const quiet = leave(c1, 'setInterval(() => {}, 1000)');
  const stubborn = leave(c2, "process.on('SIGTERM', () => {}); require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)");
  // (each its own process group: the suite ends them, passed or not. One that ignores SIGTERM would run on for
  // good, in this machine's Left running)
  process.on('exit', () => { for (const pid of [quiet, stubborn]) try { process.kill(-pid, 'SIGKILL'); } catch {} });
  await until(() => kidOf(stubborn), 5000, 'the stubborn job has its child');
  const kid = kidOf(stubborn);
  await rpc({ type: 'overview' }); // (scans now: else within 10 s)
  const btn = page.locator('#leftRunningBtn');
  check(await until(() => countIs(2), 10000), `the ghost by the server's name counts our 2 jobs (${await btn.textContent().catch(() => '?')} ${sketch(await leftNow())})`);
  const list = (await rpc({ type: 'leftRunning' })).data || [];
  const g2 = list.find((g) => g.cid === c2);
  check(list.some((g) => g.cid === c1 && g.procs.length === 1 && g.procs[0].pid === quiet) && g2?.procs.length === 1 && g2.procs[0].pid === stubborn && g2.procs[0].children === 1,
    `listed by session, each job once by its top process (${JSON.stringify(list.map((g) => [g.cid.slice(0, 4), g.procs.map((p) => [p.pid, p.children])]))})`);
  await btn.click();
  await page.locator('.modal .lr-row').first().waitFor({ timeout: 5000 });
  check(await page.locator(`.modal .lr-head[data-cid="${c1}"], .modal .lr-head[data-cid="${c2}"]`).count() === 2
    && await page.locator(`.modal .lr-row[data-pid="${quiet}"], .modal .lr-row[data-pid="${stubborn}"]`).count() === 2
    && await page.locator(`.modal .lr-row[data-pid="${kid}"]`).count() === 0, 'the dialog: a heading per session, a row per job (not one for the process under it)');
  await page.screenshot({ path: path.join(S, 'left-running.png') });
  await hold(page, `.modal .lr-row[data-pid="${quiet}"] .run-stop`);
  check(await until(() => !runsStill(quiet), 4000), 'Stop (held) stops a job');
  // (its row goes once the server says so, and the rows below move up: a hold begun before then lands beside Stop)
  await until(async () => (await page.locator(`.modal .lr-row[data-pid="${quiet}"]`).count()) === 0, 5000, 'the stopped job leaves the dialog');
  await hold(page, `.modal .lr-row[data-pid="${stubborn}"] .run-stop`);
  check(await until(() => !runsStill(kid), 3000) && runsStill(stubborn), 'its processes all get SIGTERM: one that ignores it is still there');
  check(await until(() => !runsStill(stubborn), 12000), '…until SIGKILL, 5 s later');
  check(await until(async () => (await page.locator(`.modal .lr-head[data-cid="${c1}"], .modal .lr-head[data-cid="${c2}"]`).count()) === 0, 15000)
    && await until(() => countIs(0), 5000),
    `then they are gone from the dialog, and from the count (${await btn.textContent().catch(() => '?')} ${sketch(await leftNow())})`);
  await page.locator('.modal-head button').click();
  // (this machine's own leftovers can keep the count above 0: whether a hidden ghost really goes is checked here)
  check(await btn.evaluate((b) => { const was = b.hidden; b.hidden = true; const d = getComputedStyle(b).display; b.hidden = was; return d === 'none'; }),
    'with nothing left running the ghost is gone (hidden takes it off the line)');
}

// ---- 3b. stopping: the ⏻ button, Start server, and client.mjs --stop ----
{
  const daemonUp = () => fs.existsSync(path.join(IRO_DIR, 'daemon.sock'));
  const stopCli = () => execFileSync(process.execPath, [CLIENT, '--local', '--stop'], { env: cleanEnv() }).toString();
  await hold(page, '#stopServer');
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

}

check(nativeDialogs === 0, `no native confirm/alert (${nativeDialogs})`);
check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
killDaemon();

if (runs('D')) {
// ---- 4a. two daemons started at once over a dead daemon's socket: one runs, the other leaves ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-race-'));
  const sock = path.join(dir, 'daemon.sock');
  fs.writeFileSync(sock, ''); // left behind (not listening)
  fs.writeFileSync(path.join(dir, 'daemon.lock'), '999999'); // and a dead daemon's lock
  const start = () => { const d = spawn(process.execPath, [path.join(REPO, 'server/daemon.mjs')], { cwd: dir, env: cleanEnv({ IRO_DIR: dir }), stdio: 'ignore' }); d.on('exit', () => (d.gone = true)); return d; };
  const ds = [start(), start()];
  const net = await import('node:net');
  const lockPid = () => { try { return Number(fs.readFileSync(path.join(dir, 'daemon.lock'), 'utf8')); } catch { return 0; } }; // (moved aside for a moment while taken)
  let running = [], reachable = false;
  const settled = async () => {
    running = ds.filter((d) => !d.gone);
    reachable = await new Promise((r) => { const c = net.connect(sock); c.once('data', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
    return running.length === 1 && reachable && lockPid() === running[0].pid;
  };
  check(await until(settled, 15000),
    `two daemons at once: one runs and owns the socket, the other exits (${running.length} running, reachable: ${reachable})`);
  for (const d of ds) d.kill();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 4b. a release whose Claude Code doesn't run (it answers like a bare Bun): --check-cli says so, and a
// daemon of it started to take over from a retiring one leaves; with no daemon to take over from it runs ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-cli-'));
  const rel = path.join(dir, 'rel'), mods = path.join(REPO, 'server', 'node_modules'), at = path.join(rel, 'node_modules', '@anthropic-ai');
  fs.mkdirSync(at, { recursive: true });
  for (const f of ['daemon.mjs', 'shared.mjs']) fs.copyFileSync(path.join(REPO, 'server', f), path.join(rel, f));
  for (const f of fs.readdirSync(mods)) if (f !== '@anthropic-ai') fs.symlinkSync(path.join(mods, f), path.join(rel, 'node_modules', f));
  for (const f of fs.readdirSync(path.join(mods, '@anthropic-ai'))) { // (the SDK a copy: it looks for Claude Code in the release too)
    const from = path.join(mods, '@anthropic-ai', f);
    if (f === 'claude-agent-sdk') fs.cpSync(from, path.join(at, f), { recursive: true });
    else if (!f.startsWith('claude-agent-sdk-')) fs.symlinkSync(from, path.join(at, f));
    else {
      fs.mkdirSync(path.join(at, f));
      fs.copyFileSync(path.join(from, 'package.json'), path.join(at, f, 'package.json'));
      fs.writeFileSync(path.join(at, f, 'claude'), '#!/bin/sh\necho 1.4.3\n', { mode: 0o755 });
    }
  }
  const env = cleanEnv({ IRO_DIR: dir });
  const cliCheck = (file) => spawnSync(process.execPath, [file, '--check-cli'], { cwd: dir, env, encoding: 'utf8' });
  const good = cliCheck(path.join(REPO, 'server', 'daemon.mjs')), bad = cliCheck(path.join(rel, 'daemon.mjs'));
  check(good.status === 0 && !good.stderr && bad.status === 1 && /^Claude Code at .*does not run \(--version: 1\.4\.3\)$/.test(bad.stderr.trim()) && fs.readdirSync(dir).join() === 'rel',
    `--check-cli: 0 for this checkout, 1 for a damaged Claude Code, and nothing of a daemon runs (${bad.stderr.trim()})`);
  const run = () => {
    const d = spawn(process.execPath, [path.join(rel, 'daemon.mjs')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    d.out = '';
    d.stdout.on('data', (b) => (d.out += b));
    d.on('exit', (code) => (d.code = code));
    return d;
  };
  const net = await import('node:net');
  const retiring = net.createServer((s) => s.end()); // a retiring daemon, still listening
  await new Promise((r) => retiring.listen(path.join(dir, 'old-12345678.sock'), r));
  const d = run();
  await until(() => d.code != null, 15000, 'the daemon that cannot take over exits');
  check(d.code === 1 && /not taking over the sessions: Claude Code at .*does not run/.test(d.out) && !fs.existsSync(path.join(dir, 'daemon.sock')),
    `a damaged Claude Code: it leaves the sessions to the retiring daemon, and takes no socket (exit ${d.code}; ${d.out.trim().split('\n').pop()})`);
  await new Promise((r) => retiring.close(r));
  fs.rmSync(path.join(dir, 'old-12345678.sock'), { force: true });
  fs.writeFileSync(path.join(dir, 'old-87654321.sock'), ''); // left by a daemon that died: no one to take over from
  const d2 = run();
  check(await until(() => fs.existsSync(path.join(dir, 'daemon.sock')), 10000) && d2.code == null, 'with no live daemon to take over from, it runs anyway');
  d2.kill();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 4c. one folder, one machine: while the daemon of another machine sharing the folder (a home on NFS)
// says it serves it, one started here leaves and attach says where IroWell runs; once that is stale (the
// other machine went away without a word), one starts here, says so itself, and lets go when it stops ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-host-'));
  const hostFile = path.join(dir, 'daemon.host'), sock = path.join(dir, 'daemon.sock');
  fs.writeFileSync(hostFile, JSON.stringify({ host: 'otherbox', pid: 4242 }) + '\n');
  const env = cleanEnv({ IRO_DIR: dir });
  const d = spawnSync(process.execPath, [path.join(REPO, 'server/daemon.mjs')], { cwd: dir, env, encoding: 'utf8', timeout: 15000 });
  check(d.status === 1 && /IroWell runs on otherbox, which shares /.test(d.stdout) && !fs.existsSync(sock), `another machine serves the folder: a daemon started here leaves (exit ${d.status}; ${d.stdout.trim()})`);
  const a = spawnSync(process.execPath, [path.join(REPO, 'server/attach.mjs')], { cwd: dir, env, encoding: 'utf8', timeout: 15000, input: '' });
  check(a.status === 1 && /^IroWell already runs on otherbox, which shares .*: connect to otherbox, or stop it there first$/.test(a.stderr.trim()) && !fs.existsSync(sock),
    `…and attach says where IroWell runs, and starts nothing (${a.stderr.trim()})`);
  const old = new Date(Date.now() - 10 * 60e3);
  fs.utimesSync(hostFile, old, old);
  const d2 = spawn(process.execPath, [path.join(REPO, 'server/daemon.mjs')], { cwd: dir, env, stdio: 'ignore' });
  let gone = false;
  d2.on('exit', () => (gone = true));
  check(await until(() => fs.existsSync(sock) && JSON.parse(fs.readFileSync(hostFile, 'utf8')).host === os.hostname(), 10000) && JSON.parse(fs.readFileSync(hostFile, 'utf8')).pid === d2.pid,
    'once that is stale, a daemon starts here and says it serves the folder');
  { // this machine under another name (a laptop's changes with its network): its own daemon is no other machine
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-host-'));
    fs.writeFileSync(path.join(dir2, 'daemon.host'), JSON.stringify({ host: 'thismac-before', pid: d2.pid }) + '\n');
    const d3 = spawn(process.execPath, [path.join(REPO, 'server/daemon.mjs')], { cwd: dir2, env: cleanEnv({ IRO_DIR: dir2 }), stdio: 'ignore' });
    check(await until(() => fs.existsSync(path.join(dir2, 'daemon.sock')), 10000), 'a fresh record under another name whose daemon runs on this machine: it is this machine, and a daemon starts');
    d3.kill();
    await wait(300);
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  const net = await import('node:net');
  const c = net.connect(sock);
  c.on('error', () => {});
  c.write(JSON.stringify({ type: 'shutdown', id: 1 }) + '\n');
  check(await until(() => gone, 15000) && !fs.existsSync(hostFile), 'stopped, it lets the folder go (another machine may start one at once)');
  c.destroy();
  if (!gone) d2.kill();
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
  await until(() => fs.existsSync(sock), 10000, 'the idle daemon\'s socket');
  const net = await import('node:net');
  const c = net.connect(sock);
  c.on('error', () => {}); // (no socket: the checks below say so)
  await new Promise((r) => { c.once('data', r); c.once('error', r); }); // hello
  await sleep(4000);
  check(!exited && fs.existsSync(sock), 'idle exit: the daemon stays while a client is attached');
  c.end();
  for (let i = 0; i < 80 && !exited; i++) await sleep(100);
  check(exited && !fs.existsSync(sock), 'idle exit: with no client it exits and removes its socket');
  if (!exited) d.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

}

finish();
