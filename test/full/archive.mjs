// Archiving sidebar sessions (right-click → Archive): an archived row stays gone across a page reload
// and a daemon restart, the rows left keep their own conversations, and using a session again
// (Past sessions → reopen) brings it back.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT, outDir, browserPath, cleanEnv, log, check, until, finish, clientApi, addFolder, killDaemon, openFolderHistory } from '../lib.mjs';

const S = outDir();
const PORT = 4797;
const WORK = path.join(S, 'work-archive');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const DIR = fs.realpathSync(WORK);

const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const { cmd } = await clientApi(PORT);

const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator('#conn .dot.up').waitFor({ timeout: 15000 });
await addFolder(page, DIR);

// Three sessions, each told its own word, so a row showing another one's conversation is caught.
const WORDS = ['ALPHA', 'BRAVO', 'CHARLIE'];
for (const w of WORDS) {
  const r = await cmd({ type: 'new', cwd: DIR, text: `Reply with just the word ${w}.`, model: 'haiku' });
  check(!r.error, `session ${w} started${r.error ? `: ${r.error}` : ''}`);
  await page.waitForTimeout(300);
}
const rows = () => page.locator(`.folder[data-dir="${DIR}"] .sess`);
await until(async () => (await page.locator(`.folder[data-dir="${DIR}"] .sess.idle`).count()) === 3, 120000, 'all three answered');

// Each row opens its own conversation: the question in its feed carries its word.
async function bindings() {
  const out = [];
  for (let i = 0; i < await rows().count(); i++) {
    await rows().nth(i).click();
    await page.locator('#feed .turn-q-text').first().waitFor({ timeout: 8000 }).catch(() => {}); // a detached one reads its transcript first
    const q = (await page.locator('#feed .turn-q-text').first().textContent().catch(() => '')) || (await page.locator('#feed').textContent()).slice(0, 80);
    out.push(WORDS.find((w) => q.includes(w)) || `?${q.slice(0, 30)}`);
  }
  return out;
}
const before = await bindings();
check(before.length === 3 && new Set(before).size === 3, `three rows, each with its own conversation (${before})`);

async function archive(word) {
  const i = (await bindings()).indexOf(word);
  await rows().nth(i).click({ button: 'right' });
  await page.locator('.ctx-item', { hasText: 'Archive' }).click();
  await until(async () => !(await bindings()).includes(word), 15000, `${word} leaves the sidebar`);
}

// Archive one that is not open, then the open one.
await rows().first().click();
const openWord = (await bindings())[0];
await rows().first().click();
const other = WORDS.find((w) => w !== openWord && w !== 'BRAVO') || 'ALPHA';
await archive(other);
await archive('BRAVO');
const left = WORDS.filter((w) => w !== other && w !== 'BRAVO');
let now = await bindings();
check(JSON.stringify(now) === JSON.stringify(left), `after archiving ${other} and BRAVO: ${now}`);

// A reload replays the event log: the archived rows must stay gone, the rest keep their conversations.
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
now = await bindings();
check(JSON.stringify(now) === JSON.stringify(left), `after a reload: ${now}`);
await page.screenshot({ path: path.join(S, 'archive-reload.png') });

// A daemon restart lists the remembered sessions again: not the archived ones. The open one is a
// detached row whose transcript is read once the connection is up (the replay comes first).
killDaemon();
await page.waitForTimeout(1500);
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 30000 });
await page.waitForTimeout(2000);
now = await bindings();
check(JSON.stringify([...now].sort()) === JSON.stringify([...left].sort()), `after a daemon restart: ${now}`);

// Reopening an archived one from Past sessions brings it back, with its own conversation.
await openFolderHistory(page, DIR);
await page.locator('.modal .hrow', { hasText: 'BRAVO' }).first().click();
await until(async () => (await bindings()).includes('BRAVO'), 30000, 'BRAVO reopened');
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 15000 });
await page.waitForTimeout(1500);
now = await bindings();
check(now.includes('BRAVO') && !now.includes(other) && new Set(now).size === now.length, `reopened from Past sessions, and still there after a reload: ${now}`);

check(!errors.length, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
client.kill();
killDaemon();
finish();
