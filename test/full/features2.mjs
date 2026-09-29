// Follow-up: slash command output, file viewer from an Edit card, subagent streaming.
import { chromium } from 'playwright-core';
import { REPO, CLIENT, outDir, browserPath, cleanEnv, startSession, openFolderHistory, addFolder, killDaemon } from '../lib.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4792;
const WORK = path.join(S, 'work7');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
fs.writeFileSync(path.join(WORK, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\nprint(add(2, 3))\n');
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT'].includes(k)) delete env[k];
killDaemon();
await new Promise((r) => setTimeout(r, 500));
let failures = 0;
const check = (ok, what) => { console.log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };
const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 1000));
const browser = await chromium.launch({ executablePath: browserPath() });
const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => { console.log('ALERT:', d.message()); d.dismiss(); });
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });

async function turn(text, timeout = 180000) {
  const before = await page.locator('.meta.result').count();
  await page.fill('#input', text);
  await page.press('#input', 'Enter');
  const t0 = Date.now();
  let sawChildLive = false;
  while (Date.now() - t0 < timeout) {
    if (await page.locator('.children .live').count()) sawChildLive = true;
    const allow = page.locator('.approval .btns button.primary');
    if (await allow.count()) { await allow.first().click(); await page.waitForTimeout(300); }
    if ((await page.locator('.meta.result').count()) > before) return { ok: true, sawChildLive };
    await page.waitForTimeout(100);
  }
  return { ok: false, sawChildLive };
}

await startSession(page, WORK, 'Reply with just: ready');
await page.locator('.meta.result').first().waitFor({ timeout: 120000 });

// slash command
await page.fill('#input', '/context');
await page.press('#input', 'Escape');
await page.press('#input', 'Enter');
const r1 = { ok: true };
const outs = await page.locator('.local-out').count();
console.log('  feed:', (await page.evaluate(() => [...document.getElementById('feed').children].map((c) => c.className + ' :: ' + c.textContent.slice(0, 60).replace(/\n/g, ' ')).join('\n    '))));
console.log('  /context produced:', outs ? 'local output' : 'no local output', '| last text:', JSON.stringify(((await page.locator('#feed').textContent()) || '').slice(-120)));
await page.locator('.modal .ctx-bar').waitFor({ timeout: 30000 }).catch(() => {});
check(await page.locator('.modal .modal-title', { hasText: 'Context window' }).count() === 1, '/context opens the context panel');
check(await page.locator('.modal .ctx-seg').count() >= 2, '/context panel has the usage bar');
await page.keyboard.press('Escape');

// file viewer from an Edit card
check((await turn('Use the Edit tool to change print(add(2, 3)) to print(add(7, 8)) in calc.py. Reply with just: done')).ok, 'edit turn');
await page.locator('.turn-foot .file-link', { hasText: 'calc.py' }).last().click({ modifiers: ['Meta'] });
await page.locator('.modal .fileview').waitFor({ timeout: 10000 });
check((await page.locator('.modal .fileview .src').textContent()).includes('add(7, 8)'), 'file viewer shows the current file');
await page.keyboard.press('Escape');

// subagent streaming
const r3 = await turn('Use the Agent tool (general-purpose) and ask it to write a 12-line poem about the sea in its final answer, without using tools. Then reply with just: ok');
check(r3.ok, 'agent turn');
console.log('  subagent live streaming seen:', r3.sawChildLive);

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
