// Rewind (the terminal's Esc Esc): files restored, the conversation goes on from before the message,
// also across a detach before anything new is sent; and hooks show up in the turn.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { CLIENT, outDir, browserPath, cleanEnv, log, check, until, finish, clientApi, eventStream } from '../lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = outDir();
const PORT = 4778;
const WORK = path.join(S, 'work-rewind');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, '.claude'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'a.txt'), 'one\n');
fs.writeFileSync(path.join(WORK, '.claude', 'settings.local.json'), JSON.stringify({
  permissions: { allow: ['Edit', 'Write'] },
  hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hook-said-hi' }] }] },
}));


const client = spawn(process.execPath, [CLIENT, '--local', '--port', String(PORT)], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
client.stderr.on('data', (d) => log('client err:', d.toString().trim()));
const { token, cmd } = await clientApi(PORT);

const T = eventStream(PORT, token);
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
const shown = (sid) => { const ev = []; for (const e of of(sid)) { if (e.kind === 'rewound') { const k = ev.findIndex((x) => x.seq >= e.from); if (k >= 0) ev.length = k; } ev.push(e); } return ev; };
const DIR = process.env.IRO_DIR;
try {
  await until(() => T.up, 15000, 'transport up');
  const A = (await cmd({ type: 'new', cwd: WORK, text: 'Remember the codeword PELICAN. Reply with just: ok', mode: 'default' })).data.sid;
  await until(() => results(A).length >= 1, 120000, 'turn 1');
  await ask(A, 'Use the Edit tool to change "one" to "two" in a.txt. Also, the codeword is now HERON. Then reply with just: done');
  check(fs.readFileSync(path.join(WORK, 'a.txt'), 'utf8').trim() === 'two', 'the edit happened');
  check(of(A).some((e) => e.kind === 'sys' && e.subtype === 'hook' && /hook-said-hi/.test(e.text)), 'the PostToolUse hook\'s output shows in the turn');
  const u2 = userTexts(A)[1];
  check(!!u2?.uuid, 'user messages carry a uuid');

  const dry = await cmd({ type: 'rewind', sid: A, uuid: u2.uuid, dryRun: true });
  check(dry.data?.filesChanged?.some((f) => f.endsWith('a.txt')), `a dry run names the file to restore (${JSON.stringify(dry.data || dry.error)})`);
  check(fs.readFileSync(path.join(WORK, 'a.txt'), 'utf8').trim() === 'two', 'a dry run changes nothing');
  const rw = await cmd({ type: 'rewind', sid: A, uuid: u2.uuid });
  check(rw.data?.text === u2.text, 'the rewound message comes back (for the input)');
  check(fs.readFileSync(path.join(WORK, 'a.txt'), 'utf8').trim() === 'one', 'the file is restored');
  check(userTexts(A).length === 2 && shown(A).filter((e) => e.kind === 'user_text').length === 1, 'the page drops the rewound turn');
  const said = await ask(A, 'What is the codeword now? Reply with just the word.');
  check(/PELICAN/i.test(said) && !/HERON/i.test(said), `the conversation goes on from before it (${said})`);

  // rewound, then detached before anything new is sent: a reattach must still start at the rewind point
  await ask(A, 'The codeword is now OSPREY. Reply with just: ok');
  const u4 = userTexts(A).pop();
  // two rewinds at once (a double click, a second tab): one goes through, the other is turned away
  // instead of restarting the CLI a second time and leaving the first new one running unseen
  const both = await Promise.all([cmd({ type: 'rewind', sid: A, uuid: u4.uuid }), cmd({ type: 'rewind', sid: A, uuid: u4.uuid })]);
  check(both.filter((r) => r.data).length === 1 && both.some((r) => /rewinding|can't be rewound|not running/.test(r.error || '')), `two rewinds at once: one goes through (${JSON.stringify(both.map((r) => r.error || 'ok'))})`);
  const cid = of(A).filter((e) => e.kind === 'init').pop()?.claudeSessionId;
  check(!!JSON.parse(fs.readFileSync(path.join(DIR, 'rewinds.json'), 'utf8'))[cid], 'the rewind point is remembered until the next message');
  await cmd({ type: 'close', sid: A });
  await until(() => of(A).some((e) => e.kind === 'closed'), 10000, 'detached');
  const B = (await cmd({ type: 'resume', claudeSessionId: cid, cwd: WORK, title: 'A' })).data.sid;
  check(!of(B).some((e) => e.kind === 'user_text' && /OSPREY/.test(e.text)), 'the reattached conversation does not show the rewound turn');
  const after = await ask(B, 'What is the codeword now? Reply with just the word.');
  check(/PELICAN/i.test(after) && !/OSPREY/i.test(after), `a reattach starts at the rewind point (${after})`);
  check(!JSON.parse(fs.readFileSync(path.join(DIR, 'rewinds.json'), 'utf8'))[cid], 'forgotten once the conversation goes on');

  // ---- the UI ----
  const browser = await chromium.launch({ executablePath: browserPath() });
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  await page.locator('.sess').first().click();
  await page.locator('.turn').first().waitFor({ timeout: 10000 });
  const nq = await page.locator('.turn').count();
  check(await page.locator('.turn-q .turn-more').count() === nq, 'every question has a ⋯ menu');
  await page.locator('.turn-q').last().hover();
  check(await page.locator('.turn-q .turn-more').last().isVisible(), 'it shows on hover');
  const lastQ = (await page.locator('.turn-q-text').last().textContent()).trim();
  await page.locator('.turn-q .turn-more').last().click();
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Rewind to here' }).click();
  await page.waitForFunction((k) => document.querySelectorAll('.turn').length < k, nq, { timeout: 15000 }).catch(() => {});
  check(await page.locator('.turn').count() === nq - 1 && (await page.inputValue('#input')).trim() === lastQ, 'after the confirm: the turn is gone, its message is back in the input');
  check(/rewound/.test(await page.locator('#feed').textContent()), 'a divider marks the rewind');
  await page.screenshot({ path: path.join(S, 'rewind.png') });
  await browser.close();
} finally {
  client.kill('SIGTERM');
}
finish();
