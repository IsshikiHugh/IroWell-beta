// Rewind to a message sent through an older daemon (its event carries no uuid): the daemon finds the
// message in the transcript by its text. IRO_TEST_NO_UUID makes this suite's daemon play that part.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { CLIENT, outDir, browserPath, cleanEnv } from '../lib.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = outDir();
const PORT = 4779;
const WORK = path.join(S, 'work-rewind-old');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, '.claude'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'a.txt'), 'one\n');
fs.writeFileSync(path.join(WORK, '.claude', 'settings.local.json'), JSON.stringify({
  permissions: { allow: ['Edit', 'Write'] },
  hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hook-said-hi' }] }] },
}));

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

const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv({ IRO_TEST_NO_UUID: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
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


const userTexts = (sid) => of(sid).filter((e) => e.kind === 'user_text');
try {
  await until(() => T.up, 15000, 'transport up');
  const A = (await cmd({ type: 'new', cwd: WORK, text: 'Remember the codeword PELICAN. Reply with just: ok', mode: 'default' })).data.sid;
  await until(() => results(A).length >= 1, 120000, 'turn 1');
  await ask(A, 'Use the Edit tool to change "one" to "two" in a.txt. Also, the codeword is now HERON. Then reply with just: done');
  const u2 = userTexts(A)[1];
  check(u2 && !u2.uuid, 'the message event has no uuid (as from an older daemon)');
  const dry = await cmd({ type: 'rewind', sid: A, seq: u2.seq, dryRun: true });
  check(dry.data?.filesChanged?.some((f) => f.endsWith('a.txt')), `found in the transcript: the dry run names the file (${JSON.stringify(dry.data || dry.error)})`);
  const rw = await cmd({ type: 'rewind', sid: A, seq: u2.seq });
  check(rw.data?.text === u2.text && fs.readFileSync(path.join(WORK, 'a.txt'), 'utf8').trim() === 'one', 'rewound: file restored, message returned');
  const said = await ask(A, 'What is the codeword now? Reply with just the word.');
  check(/PELICAN/i.test(said) && !/HERON/i.test(said), `the conversation goes on from before it (${said})`);
} finally {
  client.kill('SIGTERM');
}
log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
