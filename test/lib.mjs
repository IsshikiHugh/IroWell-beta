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
// The suites' Claude sessions run on Sonnet, to spare plan quota (the daemon hands its environment to the
// CLI). IRO_TEST_MODEL picks another; "default" leaves the CLI's own. (Not Haiku: the effort checks in
// statusbar/dropdowns need a model that has effort levels.)
const testModel = process.env.IRO_TEST_MODEL || 'sonnet';
if (testModel !== 'default') process.env.ANTHROPIC_MODEL = testModel;

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

// The HTTP side of a client.mjs on `port`: its page's token, raw requests, and commands (`cmd`
// resolves to the parsed { data } / { error } reply).
export async function clientApi(port) {
  const req = (method, p, { headers = {}, body, host } = {}) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: host ? { ...headers, host } : headers }, (x) => {
      let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b }));
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
// client restarted while its daemon runs on). `env` and `stdio` go to the client's process.
export async function startClient(port, { env = cleanEnv(), stdio = 'inherit', fresh = true } = {}) {
  if (fresh) { killDaemon(); await wait(500); }
  const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(port)], { env, stdio });
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
