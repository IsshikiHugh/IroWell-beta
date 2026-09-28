// Shared bits for the test suites.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const CLIENT = path.join(REPO, 'client', 'client.mjs');

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
  if (await page.locator(`.folder[data-dir="${dir}"]`).count()) return;
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
