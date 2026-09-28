// "Always allow" test: allow the first Write with Always allow; the second Write must not ask.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, startSession, openFolderHistory, addFolder } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4794;
const WORK = path.join(S, 'work5');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k)) delete env[k];
try { execSync('pkill -f "IroWell/server/daemon.mjs"'); } catch {}
await new Promise((r) => setTimeout(r, 500));
let failures = 0;
const check = (ok, what) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };
const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
page.on('dialog', (d) => d.dismiss());
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.getByText('connected · local').waitFor({ timeout: 10000 });
await startSession(page, WORK, 'Use the Write tool to create a.txt containing "a". Then reply with just: ok');
const always = page.locator('.approval button', { hasText: 'Always allow' });
await Promise.race([always.waitFor({ timeout: 120000 }), page.locator('.meta.result').waitFor({ timeout: 120000 })]);
if (!(await always.count())) {
  console.log('no approval asked at all (settings already allow Write here); nothing to test');
} else {
  await always.click();
  await page.getByText('✓ always allowed').waitFor({ state: 'attached', timeout: 10000 });
  await page.locator('.meta.result').waitFor({ timeout: 120000 });
  await page.fill('#input', 'Now use the Write tool to create b.txt containing "b". Then reply with just: ok2');
  await page.press('#input', 'Enter');
  await page.locator('.meta.result').nth(1).waitFor({ timeout: 120000 });
  check(await page.locator('.approval').count() === 1, 'second Write was not asked again');
  check(fs.existsSync(path.join(WORK, 'a.txt')) && fs.existsSync(path.join(WORK, 'b.txt')), 'both files written');
  const local = path.join(WORK, '.claude', 'settings.local.json');
  console.log('  rule written to:', fs.existsSync(local) ? fs.readFileSync(local, 'utf8').replace(/\s+/g, ' ') : '(session only)');
}
await browser.close();
client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
