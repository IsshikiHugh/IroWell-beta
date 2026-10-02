// Branching a session (/branch and a turn's "Branch from here"), bypass permissions, and the tools a
// headless CLI leaves out but the terminal has (Artifact, forked subagents).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { CLIENT, outDir, browserPath, cleanEnv } from '../lib.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = outDir();
const PORT = 4780;
const WORK = path.join(S, 'work-branch');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let failures = 0;
const check = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures++; };
async function until(pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await wait(200); }
  log('TIMEOUT waiting for', what); failures++; return false;
}

const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const req = (method, p, { headers = {}, body } = {}) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (x) => {
    let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b }));
  });
  r.on('error', rej);
  r.end(body);
});
let token;
for (let i = 0; i < 50 && !token; i++) { try { token = (await req('GET', '/')).body.match(/name="token" content="([0-9a-f]+)"/)[1]; } catch { await wait(200); } }
const cmd = (body) => req('POST', '/cmd', { headers: { 'content-type': 'application/json', 'x-token': token }, body: JSON.stringify(body) }).then((r) => JSON.parse(r.body));

const T = { events: [], up: false };
http.get({ host: '127.0.0.1', port: PORT, path: '/events?t=' + token }, (r) => {
  let b = '';
  r.on('data', (c) => {
    b += c; let i;
    while ((i = b.indexOf('\n\n')) >= 0) {
      const f = b.slice(0, i); b = b.slice(i + 2);
      if (!f.startsWith('data: ')) continue;
      const m = JSON.parse(f.slice(6));
      if (m.type === 'reset') T.events = [];
      if (m.type === 'transport') T.up = m.up;
      if (m.type === 'event') T.events.push(m);
    }
  });
});
const of = (sid) => T.events.filter((e) => e.sid === sid);
const results = (sid) => of(sid).filter((e) => e.kind === 'msg' && e.msg.type === 'result');
const assistants = (sid) => of(sid).filter((e) => e.kind === 'msg' && e.msg.type === 'assistant' && !e.msg.parent_tool_use_id);
const lastText = (sid) => assistants(sid).flatMap((e) => e.msg.message.content.filter((x) => x.type === 'text').map((x) => x.text)).pop() || '';
async function ask(sid, text) {
  const n = results(sid).length;
  await cmd({ type: 'send', sid, text });
  await until(() => results(sid).length > n, 120000, `answer to "${text.slice(0, 30)}"`);
  return lastText(sid);
}
const transcript = (id) => {
  const dir = path.join(os.homedir(), '.claude', 'projects');
  for (const d of fs.readdirSync(dir)) { const f = path.join(dir, d, `${id}.jsonl`); if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); }
  return '';
};
const claudeId = (sid) => of(sid).find((e) => e.kind === 'init')?.claudeSessionId;

try {
  await until(() => T.up, 15000, 'transport up');
  const A = (await cmd({ type: 'new', cwd: WORK, text: 'Remember the codeword PELICAN. Reply with just: ok', mode: 'default' })).data.sid;
  await until(() => results(A).length >= 1, 120000, 'turn 1');
  const at = assistants(A).pop().msg.uuid;
  check(!!at, 'assistant messages carry their uuid');
  await ask(A, 'The codeword is now HERON instead. Reply with just: ok');

  // ---- the terminal's tools ----
  const snap = transcript(claudeId(A)).split('\n').filter((l) => l.includes('"prompt_snapshot"') && l.includes('"tools"')).pop() || '';
  check(/"name":"Artifact"/.test(snap), 'the Artifact tool is available (as in the terminal)');
  check(/subagent_type: \\?"fork/.test(snap), 'forked subagents are offered (as in the terminal)');

  // ---- bypass permissions ----
  const by = await cmd({ type: 'setMode', sid: A, mode: 'bypassPermissions' });
  check(by.error == null, `bypass permissions can be switched on${by.error ? ': ' + by.error : ''}`);
  await cmd({ type: 'setMode', sid: A, mode: 'default' });

  // ---- branch from the first turn ----
  const b = await cmd({ type: 'branch', sid: A, at, nonce: 'b1' });
  check(!!b.data?.sid, `branch from a turn${b.error ? ': ' + b.error : ''}`);
  const B = b.data.sid;
  check(of(B).filter((e) => e.kind === 'user_text').length === 1, 'the branch shows the conversation up to that turn');
  const fromB = await ask(B, 'What is the codeword now? Reply with just the word.');
  check(/PELICAN/i.test(fromB) && !/HERON/i.test(fromB), `the branch continues from that point (${fromB})`);
  check(claudeId(B) && claudeId(B) !== claudeId(A), 'the branch is a session of its own');

  // ---- /branch: the whole conversation ----
  const c = await cmd({ type: 'branch', sid: A, title: 'whole', nonce: 'c1' });
  const C = c.data.sid;
  check(of(C)[0]?.title === 'whole', 'a /branch name becomes its title');
  const fromC = await ask(C, 'What is the codeword now? Reply with just the word.');
  check(/HERON/i.test(fromC), `/branch copies the whole conversation (${fromC})`);

  // ---- the original is untouched ----
  check(!/What is the codeword now/.test(transcript(claudeId(A))), 'nothing asked in a branch reaches the original');
  const fromA = await ask(A, 'What is the codeword now? Reply with just the word.');
  check(/HERON/i.test(fromA), `the original carries on (${fromA})`);

  // ---- the UI ----
  const browser = await chromium.launch({ executablePath: browserPath() });
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  await page.locator('.sess-title', { hasText: /^Remember the codeword PELICAN\. Reply with just: ok$/ }).click();
  await page.locator('.turn').first().waitFor({ timeout: 10000 });
  check(await page.locator('.turn-q .turn-more').count() === await page.locator('.turn').count(), 'each question has a ⋯ menu');
  check(await page.locator('.turn-foot .branch-here').count() === 0, 'no Branch button under the turns');
  const n = await page.locator('.sess').count();
  await page.locator('.turn-q').first().hover();
  await page.locator('.turn-q .turn-more').first().click();
  check(await page.locator('.ctx-menu .ctx-item', { hasText: 'Rewind to here' }).count() === 1, 'the menu offers Rewind to here');
  await page.screenshot({ path: path.join(S, 'turn-menu.png') });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Branch from here' }).click();
  await page.waitForFunction((k) => document.querySelectorAll('.sess').length > k, n, { timeout: 10000 }).catch(() => {});
  check(await page.locator('.sess').count() > n && /branched/.test(await page.locator('#feed').textContent()), 'clicking it opens the branch');
  await page.screenshot({ path: path.join(S, 'branch.png') });
  await browser.close();
} finally {
  client.kill('SIGTERM');
}
log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
