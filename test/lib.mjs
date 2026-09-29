// Shared bits for the test suites.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CLIENT = path.join(REPO, 'client', 'client.mjs');

// Every suite gets its own daemon state dir (sessions, folders, remembered sessions, usage), so
// suites don't see each other's sessions and never touch the real ~/.iro-coding. Child processes
// (client → attach → daemon) inherit it.
process.env.IRO_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'iro-dir-'));
// The daemon's "is there a newer Agent SDK on npm" check is answered locally: "no" (no network, and
// a new release can't make a suite fail).
process.env.IRO_TEST_SDK_LATEST ||= JSON.parse(fs.readFileSync(path.join(REPO, 'server/node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version;

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
  await page.waitForFunction(() => !document.querySelector('.sess.draft.active'), null, { timeout: 15000 }).catch(() => {});
}

// The past-sessions dialog of a folder.
export async function openFolderHistory(page, dir) {
  dir = fs.realpathSync(dir);
  await page.locator(`.folder[data-dir="${dir}"] .folder-head`).hover();
  await page.click(`.folder[data-dir="${dir}"] .folder-btn[title^="Past"]`);
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
