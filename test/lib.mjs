// Shared bits for the test suites.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CLIENT = path.join(REPO, 'client', 'client.mjs');

// Every suite gets its own daemon state dir (sessions, folders, remembered sessions, usage), so
// suites don't see each other's sessions and never touch the real ~/.iro-coding. Child processes
// (client → attach → daemon) inherit it.
process.env.IRO_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'iro-dir-'));
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
export function check(ok, what) {
  console.log(ok ? 'PASS' : 'FAIL', `[${secs()}s]`, what);
  if (!ok) failures++;
  return ok;
}
// Polls `pred` (may be async) until it holds or `ms` pass. With `what`, running out of time is a failure.
export async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await wait(200); }
  if (what) { console.log('TIMEOUT', `[${secs()}s]`, 'waiting for', what); failures++; }
  return false;
}
export function finish() {
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}

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
  // the draft turns into the real session once the server has created it
  await page.waitForFunction(() => !document.querySelector('.draft-intro'), null, { timeout: 15000 }).catch(() => {});
}

// The past-sessions dialog of a folder.
export async function openFolderHistory(page, dir) {
  dir = fs.realpathSync(dir);
  await page.locator(`.folder[data-dir="${dir}"] .folder-head`).hover();
  await page.click(`.folder[data-dir="${dir}"] .folder-btn[title^="Past"]`);
}

// Answers the page's dialogs (ui/dialog.js draws them in the page: no native confirm/alert) as they
// open: `how` is 'accept', 'dismiss' (a notice is just closed), or ({ text, confirm }) => true / false.
// Each one is logged.
export async function answerDialogs(page, how = 'accept') {
  await page.exposeFunction('__iroAnswer', async (text, confirm) => {
    const yes = typeof how === 'function' ? await how({ text, confirm }) : how === 'accept';
    console.log(confirm ? 'DIALOG:' : 'NOTICE:', text.slice(0, 120), confirm ? (yes ? '-> OK' : '-> Cancel') : '');
    return yes;
  });
  const watch = () => {
    const start = () => new MutationObserver(() => {
      for (const b of document.querySelectorAll('body > .dlg-back:not([data-seen])')) {
        b.dataset.seen = '1';
        const cancel = b.querySelector('.dlg-cancel');
        window.__iroAnswer(b.querySelector('.dlg-text').textContent, !!cancel).then((yes) => (yes || !cancel ? b.querySelector('.dlg-ok') : cancel).click());
      }
    }).observe(document.body, { childList: true });
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  };
  await page.addInitScript(watch);
  await page.evaluate(watch).catch(() => {});
}

// The usual start of a browser suite: a fresh daemon, this checkout's client on `port` (--local), and a
// page open on it once the connection is up. Errors on the page and in its console go into `errors`.
// `dialog`: how its dialogs are answered (answerDialogs).
export async function startSuite(port, { viewport = { width: 1400, height: 900 }, dialog = 'accept', clipboard = false } = {}) {
  killDaemon();
  await wait(500);
  const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(port)], { env: cleanEnv(), stdio: 'inherit' });
  await wait(1000);
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: browserPath() });
  const ctx = await browser.newContext({ viewport, ...(clipboard ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await answerDialogs(page, dialog);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  return { client, browser, page, errors };
}

// The page's event stream from the client on `port`, collected as the page does: a reset starts over,
// an event already seen (seq not past the last) is counted in `dupes` and dropped. `msgs` has every
// message; `downs` counts the times the transport went down.
export function eventStream(port, token) {
  const st = { msgs: [], events: [], up: false, resets: 0, downs: 0, dupes: 0, lastSeq: 0 };
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

// Stop a suite's daemon: the one whose working directory is its $IRO_DIR (attach starts it there).
// Never `pkill` every daemon.mjs: that would also kill the daemon you are using, and its sessions.
export function killDaemon(iroDir = process.env.IRO_DIR) {
  let dir, pids;
  try { dir = fs.realpathSync(iroDir); } catch { return; }
  try { pids = execFileSync('pgrep', ['-f', 'server/daemon[.]mjs']).toString().split(/\s+/).filter(Boolean); } catch { return; }
  for (const pid of pids) {
    let cwd = '';
    try { cwd = /^n(.*)$/m.exec(execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString())?.[1] || ''; } catch {}
    try { if (cwd && fs.realpathSync(cwd) === dir) process.kill(Number(pid)); } catch {}
  }
}
