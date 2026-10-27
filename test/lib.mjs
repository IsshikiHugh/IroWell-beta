// Shared bits for the test suites.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLIENT = path.join(REPO, 'client', 'client.mjs');

// Every suite gets its own daemon state dir (sessions, folders, remembered sessions, usage), so
// suites don't see each other's sessions and never touch the real ~/.iro-coding. Child processes
// (client → attach → daemon) inherit it. test/run.mjs makes and removes one per suite; one made here
// (a suite run by itself) goes when the suite does, with its daemon.
if (!process.env.IRO_DIR) {
  const dir = process.env.IRO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iro-dir-'));
  process.on('exit', () => { killDaemon(dir); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
}
// The daemon's "is there a newer Agent SDK on npm" check is answered locally: "no" (no network, and
// a new release can't make a suite fail).
process.env.IRO_TEST_SDK_LATEST ||= JSON.parse(fs.readFileSync(path.join(REPO, 'server/node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version;
// Claude: the suites in test/real/ (and test/remote.mjs) talk to the real one (on Sonnet, to spare plan quota: IRO_TEST_MODEL picks
// another, "default" leaves the CLI's own). Every other suite gets the stand-in (test/fakeclaude): no model, no
// login, and its transcripts in the suite's own Claude config folder, never in ~/.claude. A suite's own replies
// for it go in <suite>.fake.mjs beside it (see test/fakeclaude/claude.mjs).
// (test/run.mjs itself is neither: it hands each suite a clean environment.)
const SUITE = process.argv[1] || '';
export const REAL = /[/\\]test[/\\](real[/\\]|remote\.mjs$)/.test(SUITE) || process.env.IRO_REAL_CLAUDE === '1';
if (/[/\\]test[/\\]run\.mjs$/.test(SUITE)) {
  // nothing: the runner starts no client
} else if (REAL) {
  delete process.env.IRO_FAKE_CLAUDE;
  delete process.env.IRO_FAKE_SCRIPT;
  const testModel = process.env.IRO_TEST_MODEL || 'sonnet';
  if (testModel !== 'default') process.env.ANTHROPIC_MODEL = testModel;
} else {
  process.env.IRO_FAKE_CLAUDE = path.join(REPO, 'test', 'fakeclaude', 'claude.mjs');
  process.env.CLAUDE_CONFIG_DIR = path.join(process.env.IRO_DIR, 'claude');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const own = SUITE.replace(/\.mjs$/, '.fake.mjs');
  if (!process.env.IRO_FAKE_SCRIPT && own !== SUITE && fs.existsSync(own)) process.env.IRO_FAKE_SCRIPT = own;
}

// The port this suite's client listens on: the runner's pick (IRO_TEST_PORT), else a free one. (Never a fixed
// one: two runs at once, or a run beside the user's own client, would take each other's.)
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
export const PORT = Number(process.env.IRO_TEST_PORT) || await freePort();

// ---- PASS / FAIL bookkeeping (test/run.mjs collects the lines that start with FAIL or say TIMEOUT) ----
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
let failures = 0;
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(`[${secs()}s]`, ...a);
// `fn(n, what)` runs on each failure (the n-th), e.g. to save what the page shows. It runs beside the
// suite, which goes on meanwhile; one that throws is logged, one that hangs is given up on after 3 s.
const failHooks = [], pending = [];
export const onFail = (fn) => failHooks.push(fn);
function failed(what) {
  const n = ++failures;
  for (const fn of failHooks) {
    const timeout = new Promise((r) => setTimeout(r, 3000));
    pending.push(Promise.race([Promise.resolve().then(() => fn(n, what)), timeout]).catch((e) => log('fail hook:', String(e?.message || e).split('\n')[0])));
  }
}
export function check(ok, what) {
  console.log(ok ? 'PASS' : 'FAIL', `[${secs()}s]`, what);
  if (!ok) failed(what);
  return ok;
}
// Polls `pred` (may be async) until it holds or `ms` pass. With `what`, running out of time is a failure.
export async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await wait(200); }
  if (what) { console.log('TIMEOUT', `[${secs()}s]`, 'waiting for', what); failed(`waiting for ${what}`); }
  return false;
}
// (once the failure hooks are done)
export function finish() {
  return Promise.allSettled(pending).then(() => {
    console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
    process.exit(failures ? 1 : 0);
  });
}
// A crash (an error nothing caught) says what and where on a FAIL line, which run.mjs shows: else the
// log ends in a stack, and its last line is only "Node.js v22…".
let crashed = false;
const crash = (e) => {
  if (crashed) return;
  crashed = true;
  process.exitCode = 1;
  const at = /\btest\/(full\/)?[^/\s]+\.mjs:\d+(:\d+)?/.exec(String(e?.stack || ''))?.[0];
  console.log(`FAIL crash: ${String(e?.message ?? e).split('\n')[0]}${at ? ` (at ${at})` : ''}`);
  console.log(e?.stack || e);
  Promise.allSettled(pending).then(() => process.stdout.write('', () => process.exit(1)));
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

// The HTTP side of a client.mjs on `port`: its page's token, raw requests ({ status, body, headers }), and
// commands (`cmd` resolves to the parsed { data } / { error } reply).
export async function clientApi(port) {
  const req = (method, p, { headers = {}, body, host } = {}) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: host ? { ...headers, host } : headers }, (x) => {
      let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b, headers: x.headers }));
    });
    r.on('error', rej);
    r.end(body);
  });
  let token;
  for (let i = 0; i < 100 && !token; i++) { try { token = (await req('GET', '/')).body.match(/name="token" content="([0-9a-f]+)"/)[1]; } catch { await wait(200); } }
  const cmd = (body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body) }).then((r) => JSON.parse(r.body));
  return { token, req, cmd };
}

// Where screenshots and scratch project folders go (the runner sets one per run).
export function outDir() {
  if (process.env.IRO_TEST_OUT) { fs.mkdirSync(process.env.IRO_TEST_OUT, { recursive: true }); return process.env.IRO_TEST_OUT; }
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iro-test-'));
}

// A Chromium for Playwright: $IRO_CHROMIUM, else the newest headless shell Playwright has downloaded.
export function browserPath() {
  if (process.env.IRO_CHROMIUM) return process.env.IRO_CHROMIUM;
  const cache = process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright');
  const dirs = fs.existsSync(cache) ? fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell-')).sort().reverse() : [];
  for (const d of dirs) {
    for (const sub of fs.readdirSync(path.join(cache, d))) {
      const exe = path.join(cache, d, sub, 'chrome-headless-shell');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined; // let Playwright look for its own
}

// Environment for a Claude session started from a test (drop the variables of an outer Claude Code session).
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k)) delete env[k];
  return env;
}

// Add a folder to the sidebar through the folder picker (if it isn't listed yet).
export async function addFolder(page, dir) {
  dir = fs.realpathSync(dir); // the server lists folders by their real path
  // Ask the server, not the page: before the page has loaded the folder list it shows every folder
  // that has sessions, registered or not.
  const registered = await page.evaluate(async () => {
    const r = await fetch('/cmd', { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': document.querySelector('meta[name=token]').content }, body: JSON.stringify({ type: 'folders' }) });
    return (await r.json()).data || [];
  });
  if (registered.includes(dir)) { await page.locator(`.folder[data-dir="${dir}"]`).waitFor({ timeout: 10000 }); return; }
  await page.click('#addFolder');
  await page.fill('.fp-input', dir.replace(/\/?$/, '/'));
  // (the picker opens on ~ and lists it, Add row and all: wait until it lists `dir`, or that row adds ~)
  await page.waitForFunction((dir) => document.querySelector('.fp-where')?.textContent === dir, dir, { timeout: 10000 });
  await page.locator('.fp-row.fp-add:not(.disabled)').waitFor({ timeout: 10000 });
  await page.click('.fp-row.fp-add');
  await page.locator(`.folder[data-dir="${dir}"]`).waitFor({ timeout: 10000 });
}

// Start a session the way a user does: + on the folder opens a draft, the first message creates it.
export async function startSession(page, dir, text, { mode } = {}) {
  dir = fs.realpathSync(dir);
  await addFolder(page, dir);
  await page.click(`.folder[data-dir="${dir}"] .folder-new`);
  await page.locator('.draft-intro').waitFor({ timeout: 5000 });
  if (mode) await page.selectOption('#mode', mode);
  await page.fill('#input', text);
  await page.click('#send');
  // the draft shows as started at once (a stand-in), and turns into the real session once the server has it
  await page.waitForFunction(() => !document.querySelector('.draft-intro') && !document.querySelector('.pending-note'), null, { timeout: 15000 }).catch(() => {});
}

// The past-sessions dialog of a folder.
export async function openFolderHistory(page, dir) {
  dir = fs.realpathSync(dir);
  await page.locator(`.folder[data-dir="${dir}"] .folder-head`).hover();
  await page.click(`.folder[data-dir="${dir}"] .folder-btn[title^="Past"]`);
}

// Answers the page's dialogs (ui/dialog.js draws them in the page: no native confirm/alert) as they
// open: `how` is 'accept', 'dismiss', or ({ text, confirm }) => true / false (a notice is only logged).
// Each one is logged.
export async function answerDialogs(page, how = 'accept') {
  await page.exposeFunction('__iroAnswer', async (text, confirm) => {
    const yes = typeof how === 'function' ? await how({ text, confirm }) : how === 'accept';
    console.log(confirm ? 'DIALOG:' : 'NOTICE:', text.slice(0, 120), confirm ? (yes ? '-> OK' : '-> Cancel') : '');
    return yes;
  });
  // A confirmation: its button (the action) and any text; no is Esc. A notice floats and fades by itself.
  const watch = () => {
    const start = () => new MutationObserver(() => {
      for (const b of document.querySelectorAll('body > .dlg-back:not([data-seen])')) {
        b.dataset.seen = '1';
        const ok = b.querySelector('.dlg-ok'), text = b.querySelector('.dlg-text')?.textContent;
        window.__iroAnswer(text ? `${ok.textContent}: ${text}` : ok.textContent, true)
          .then((yes) => yes ? ok.click() : window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
      }
      for (const t of document.querySelectorAll('body > .toast.note:not([data-seen])')) {
        t.dataset.seen = '1';
        window.__iroAnswer(t.textContent, false);
      }
    }).observe(document.body, { childList: true });
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  };
  await page.addInitScript(watch);
  await page.evaluate(watch).catch(() => {});
}

// Presses and holds a control past its half second (ui/hold.js): how Stop, Detach, Archive… are taken.
// A press that missed (the control moved or was redrawn between the hover and the press, so it shows
// no `holding`) is let go at once, well before the half second, its click swallowed, and tried again.
// The last try is held through, as is a control that is not held (no `hold` class: a plain click).
export async function hold(page, target) {
  const l = typeof target === 'string' ? page.locator(target) : target;
  for (let i = 1; ; i++) {
    await l.hover();
    const retry = i < 3 && await l.evaluate((el) => el.classList.contains('hold'));
    // (a release where the press missed would click whatever is under it)
    const swallow = (on) => page.evaluate((on) => {
      window.__iroNoClick ||= (ev) => { ev.stopImmediatePropagation(); ev.preventDefault(); };
      if (on) addEventListener('click', window.__iroNoClick, true); else removeEventListener('click', window.__iroNoClick, true);
    }, on).catch(() => {});
    if (retry) await swallow(true);
    await page.mouse.down();
    const t = Date.now();
    if (retry) {
      const landed = await l.evaluate((el) => el.classList.contains('holding'), null, { timeout: 2000 }).catch(() => false);
      // (a check slower than that may have missed a hold that already ran: held through)
      if (!landed && Date.now() - t < 400) {
        await page.mouse.up();
        await swallow(false);
        log('hold: the press missed', String(target), '- again');
        continue;
      }
      await swallow(false);
    }
    await wait(1200 - (Date.now() - t));
    await page.mouse.up();
    return;
  }
}

// This checkout's client on `port` (--local), once it answers: { client, token, req, cmd } (clientApi).
// The suite's daemon is stopped first, so the client starts a fresh one; `fresh: false` keeps it (a
// client restarted while its daemon runs on). `env` and `stdio` go to the client's process. `host`: a server
// over ssh instead (--host <host>; see fakeHost); null: neither, the page asks which (the server picker).
export async function startClient(port, { env = cleanEnv(), stdio = 'inherit', fresh = true, host } = {}) {
  if (fresh) { killDaemon(); await wait(500); }
  const where = host === undefined ? ['--local'] : host === null ? [] : ['--host', host];
  const client = spawn(process.execPath, [CLIENT, ...where, '--port', String(port)], { env, stdio });
  return { client, ...(await clientApi(port)) };
}

// A browser with a page open on the client on `port`, once its connection is up (`connTimeout`). Errors
// on the page go into `pageErrors`; those and the console's errors into `errors`. `dialog`: how its
// dialogs are answered (answerDialogs).
export async function openPage(port, { viewport = { width: 1400, height: 900 }, dialog = 'accept', clipboard = false, connTimeout = 10000 } = {}) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: browserPath() });
  const ctx = await browser.newContext({ viewport, ...(clipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
  const page = await ctx.newPage();
  const errors = [], pageErrors = [];
  page.on('pageerror', (e) => { errors.push(e.message); pageErrors.push(e.message); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await answerDialogs(page, dialog);
  // What the page showed when a check failed (no screenshots otherwise).
  onFail((n) => page.screenshot({ path: path.join(outDir(), `fail-${path.basename(SUITE, '.mjs')}-${n}.png`) }).catch(() => {}));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#conn .dot.up').waitFor({ timeout: connTimeout });
  return { browser, page, errors, pageErrors };
}

// The usual start of a browser suite: a fresh daemon, this checkout's client on `port`, and a page open
// on it (the options of startClient and openPage; what both return).
export async function startSuite(port, opts = {}) {
  const api = await startClient(port, opts);
  return { ...api, ...(await openPage(port, opts)) };
}

// ---- turns on a page ----
// A finished turn shows its result line in its foot.
const TURN_RESULTS = '.turn-foot .meta.result';

// until(), clicking Allow on each tool call that asks for approval meanwhile.
export function untilAllowing(page, pred, ms, what) {
  return until(async () => {
    const allow = page.locator('.approval .btns button.primary');
    if (await allow.count()) { await allow.first().click().catch(() => {}); await page.waitForTimeout(300); }
    return pred();
  }, ms, what);
}

// Waits until the page shows `n` result lines (`results`: which ones count), allowing the tool calls
// that ask meanwhile unless `approve` is false. `each` runs on every poll, to watch the page meanwhile.
// With `what`, running out of time is a failure (as in until).
export function waitResults(page, n, { timeout = 180000, approve = true, results = TURN_RESULTS, each, what } = {}) {
  const done = async () => { if (each) await each(); return (await page.locator(results).count()) >= n; };
  return approve ? untilAllowing(page, done, timeout, what) : until(done, timeout, what);
}

// Sends `text` from the input and waits for its turn's result: one result line more than before
// (the options of waitResults).
export async function turn(page, text, opts = {}) {
  const before = await page.locator(opts.results || TURN_RESULTS).count();
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
  return waitResults(page, before + 1, opts);
}

// The page's event stream from the client on `port`, collected as the page does: a reset starts over,
// an event already seen (seq not past the last) is counted in `dupes` and dropped. `msgs` has every
// message; `downs` counts the times the transport went down. Its methods read one session's events
// (`sid`); with `cmd` (clientApi's), ask() sends that session a message and resolves to the answer's text.
export function eventStream(port, token, cmd) {
  const st = { msgs: [], events: [], up: false, resets: 0, downs: 0, dupes: 0, lastSeq: 0 };
  st.of = (sid) => st.events.filter((e) => e.sid === sid);
  st.state = (sid) => st.of(sid).filter((e) => e.kind === 'state').pop()?.state;
  st.closed = (sid) => st.of(sid).some((e) => e.kind === 'closed');
  st.results = (sid) => st.of(sid).filter((e) => e.kind === 'msg' && e.msg.type === 'result');
  st.assistants = (sid) => st.of(sid).filter((e) => e.kind === 'msg' && e.msg.type === 'assistant' && !e.msg.parent_tool_use_id); // (not a subagent's)
  st.lastText = (sid) => st.assistants(sid).flatMap((e) => e.msg.message.content.filter((x) => x.type === 'text').map((x) => x.text)).pop() || '';
  st.claudeId = (sid) => st.of(sid).find((e) => e.kind === 'init')?.claudeSessionId;
  st.ask = async (sid, text) => {
    const n = st.results(sid).length;
    await cmd({ type: 'send', sid, text });
    await until(() => st.results(sid).length > n, 120000, `answer to "${text.slice(0, 30)}"`);
    return st.lastText(sid);
  };
  st.req = http.get({ host: '127.0.0.1', port, path: '/events?t=' + token }, (r) => {
    let b = '';
    r.on('data', (c) => {
      b += c; let i;
      while ((i = b.indexOf('\n\n')) >= 0) {
        const f = b.slice(0, i); b = b.slice(i + 2);
        if (!f.startsWith('data: ')) continue;
        const m = JSON.parse(f.slice(6));
        st.msgs.push(m);
        if (m.type === 'reset') { st.events = []; st.lastSeq = 0; st.resets++; }
        if (m.type === 'transport') { if (st.up && !m.up) st.downs++; st.up = m.up; }
        if (m.type === 'event') { if (m.seq <= st.lastSeq) st.dupes++; else { st.lastSeq = m.seq; st.events.push(m); } }
      }
    });
  });
  st.req.on('error', () => {});
  return st;
}

// The transcript Claude Code keeps of a session (`id`: its claudeSessionId), '' while there is none.
export function transcript(id) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  for (const d of fs.readdirSync(dir)) { const f = path.join(dir, d, `${id}.jsonl`); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); }
  return '';
}

// One command straight to the daemon of state dir `dir`, on its socket (as client.mjs sends its own):
// its reply with the daemon's `hello`, or null if none comes within `ms`.
export function daemonAsk(dir, cmd, ms = 8000) {
  return new Promise((resolve) => {
    const sock = net.connect(path.join(dir, 'daemon.sock'));
    let buf = '', hello = null;
    const end = (v) => { clearTimeout(timer); sock.destroy(); resolve(v); };
    const timer = setTimeout(() => end(null), ms);
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        let m;
        try { m = JSON.parse(buf.slice(0, i)); } catch {}
        buf = buf.slice(i + 1);
        if (m?.type === 'hello') { hello = m; sock.write(JSON.stringify({ ...cmd, id: 1 }) + '\n'); }
        else if (m?.type === 'reply' && m.id === 1) end({ hello, ...m });
      }
    });
    sock.on('error', () => end(null));
  });
}

// The daemons whose working directory is `dir` (attach starts a suite's daemon in its $IRO_DIR): their pids.
export function daemonPids(dir = process.env.IRO_DIR) {
  let real, pids;
  try { real = fs.realpathSync(dir); } catch { return []; }
  try { pids = execFileSync('pgrep', ['-f', 'server/daemon[.]mjs']).toString().split(/\s+/).filter(Boolean); } catch { return []; }
  return pids.filter((pid) => {
    let cwd = '';
    try { cwd = /^n(.*)$/m.exec(execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())?.[1] || ''; } catch {}
    try { return !!cwd && fs.realpathSync(cwd) === real; } catch { return false; }
  });
}

// Stop a suite's daemon: the one whose working directory is its $IRO_DIR.
// Never `pkill` every daemon.mjs: that would also kill the daemon you are using, and its sessions.
export function killDaemon(iroDir = process.env.IRO_DIR) {
  for (const pid of daemonPids(iroDir)) try { process.kill(Number(pid)); } catch {}
}

// ---- small helpers the suites share ----

// A fresh scratch folder under the run's output (`files`: { 'rel/path': text } written into it): its real path.
export function workDir(name, files = {}) {
  const dir = path.join(outDir(), name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  return fs.realpathSync(dir);
}

// Whether `locator` shows up within `ms` (no failure if not: the check that follows says what was wanted).
export const seen = (locator, ms = 5000) => locator.waitFor({ timeout: ms }).then(() => true, () => false);

// Polls `fn` until it returns something truthy (then that), failing with `what` and the last value seen once
// `ms` pass. In place of a waitFor(…).catch(() => {}) followed by a check of the same thing: a stall then
// says what it was waiting for instead of costing its timeout in silence.
export async function expectSoon(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  let v;
  for (;;) {
    try { v = await fn(); } catch (e) { v = undefined; }
    if (v) { check(true, what); return v; }
    if (Date.now() > end) { check(false, `${what} (got ${JSON.stringify(v)?.slice(0, 200)})`); return v; }
    await wait(100);
  }
}

// A slash command (or any line) sent from the input the way it is typed: the completion menu closed first.
export async function command(page, text) {
  await page.fill('#input', text);
  await page.press('#input', 'Escape');
  await page.press('#input', 'Enter');
}

// The page reloaded and connected again; with `title`, that session opened.
export async function reloadPage(page, title) {
  await page.reload();
  await page.locator('#conn .dot.up').waitFor({ timeout: 15000 });
  if (title) await page.locator('.sess', { hasText: title }).first().click();
}

// A draft opened from the + on folder `dir`'s head (shown on hover), as a user starts a new session.
export async function newDraft(page, dir) {
  const head = page.locator(`.folder[data-dir="${dir}"] .folder-head`);
  await head.hover();
  await head.locator('.folder-new').click();
}

// Markdown drawn by the page's own renderer (ui/render.js) into the feed, as element #`id`; `turn`: inside a
// reply's turn, laid out as the feed lays out an answer. (Then `#id` is the rendered Markdown.)
export function showMarkdown(page, id, text, { turn = false } = {}) {
  return page.evaluate(async ([id, text, turn]) => {
    const el = (await import('/ui/render.js')).markdown(text);
    el.id = id;
    if (!turn) return void document.getElementById('feed').append(el);
    const t = document.createElement('div'); t.className = 'turn';
    const body = document.createElement('div'); body.className = 'turn-body'; t.append(body);
    el.classList.add('assistant');
    body.append(el);
    document.getElementById('feed').append(t);
  }, [id, text, turn]);
}

// The page's commands of `types` (a name or a list) handed to `fn(route, body)`, the others sent on as usual;
// resolves to what takes the route away again. (In place of a page.route('**/cmd', …) that parses each body.)
export async function routeCmd(page, types, fn) {
  const want = [types].flat();
  const handler = (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
    return want.includes(body.type) ? fn(route, body) : route.fallback();
  };
  await page.route('**/cmd', handler);
  return () => page.unroute('**/cmd', handler);
}

// The event log as a page that opens now gets it from the client on `port`: the events it sends before its status.
export async function logNow(port, token) {
  const st = eventStream(port, token);
  await until(() => st.msgs.some((m) => m.type === 'transport'), 10000, 'the event log of a fresh stream');
  st.req.destroy();
  return st.events;
}

// A daemon of its own in a fresh temp state dir (`env` added to the test's; no idle exit unless set), talked to on
// its socket once that is up: { dir, proc, evs (its events), ask(cmd) → its reply, close() (stops it, removes dir) }.
export async function tempDaemon(env = {}, prefix = 'iro-d-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sock = path.join(dir, 'daemon.sock');
  const proc = spawn(process.execPath, [path.join(REPO, 'server', 'daemon.mjs')], { cwd: dir, stdio: 'ignore', env: cleanEnv({ IRO_DIR: dir, IRO_IDLE_HOURS: '0', ...env }) });
  const exited = new Promise((r) => proc.once('exit', r));
  await until(() => fs.existsSync(sock), 10000, `the socket of the daemon in ${dir}`);
  const conn = net.connect(sock);
  conn.setEncoding('utf8');
  conn.on('error', () => {});
  const evs = [], waits = new Map();
  let next = 1, buf = '';
  conn.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      let m;
      try { m = JSON.parse(buf.slice(0, i)); } catch {}
      buf = buf.slice(i + 1);
      if (m?.type === 'event') evs.push(m);
      else if (m?.type === 'reply') { waits.get(m.id)?.(m); waits.delete(m.id); }
    }
  });
  const ask = (cmd) => new Promise((resolve) => { const id = next++; waits.set(id, resolve); conn.write(JSON.stringify({ ...cmd, id }) + '\n'); });
  await ask({ type: 'sync', since: 0 });
  const close = async () => {
    conn.end();
    proc.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  return { dir, proc, evs, ask, close };
}

// A stand-in ssh host for `--host <name>` (test/fakebin/ssh runs its commands on this machine, as sshd would):
// { home, dir, env }. Its home is a fresh folder of the run (keep `name` short: the sockets in <home>/.iro-coding,
// its daemon's state `dir`, allow ~100 bytes of path); `installed`: IroWell is there (the checkout's attach.mjs).
// Its login shell ignores -l (a login profile would rebuild PATH without the stubs) and sets `shellEnv` there only
// ('' unsets; IRO_DIR is always unset). `env`: the client's environment for it (`bin` first on PATH, then `extra`).
export function fakeHost(name, { installed = true, bin = [], shellEnv = {}, extra = {} } = {}) {
  const home = path.join(outDir(), name), dir = path.join(home, '.iro-coding'), sh = path.join(outDir(), `${name}-sh`);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (installed) fs.symlinkSync(path.join(REPO, 'server', 'attach.mjs'), path.join(dir, 'attach.mjs'));
  const sets = Object.entries({ IRO_DIR: '', ...shellEnv }).map(([k, v]) => (v ? `export ${k}='${String(v).replace(/'/g, `'\\''`)}'` : `unset ${k}`));
  fs.writeFileSync(sh, `#!/bin/sh\n${sets.join('\n')}\nif [ "$1" = "-lc" ]; then shift; exec /bin/sh -c "$@"; fi\nexec /bin/sh "$@"\n`, { mode: 0o755 });
  const env = cleanEnv({ HOME: home, SHELL: sh, PATH: [...bin, path.join(REPO, 'test', 'fakebin'), process.env.PATH].join(path.delimiter), ...extra });
  return { home, dir, env };
}

// The end of a browser suite: no errors on the page, everything closed, the verdict.
export async function endSuite({ browser, client, errors }) {
  if (errors) check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser?.close();
  client?.kill('SIGTERM');
  return finish();
}
