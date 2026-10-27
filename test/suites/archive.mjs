// Archiving live sidebar sessions (right-click → Archive): an archived row stays gone across a page reload
// and a daemon restart, the rows left keep their own conversations, and reopening one from Past sessions
// brings it back. (Archiving a remembered, detached row: test/suites/sidebar.mjs.) The three conversations are
// transcripts written here, reopened: no turns.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PORT, check, until, wait, startSuite, addFolder, killDaemon, openFolderHistory, hold, workDir, reloadPage, endSuite } from '../lib.mjs';

const DIR = workDir('work-archive');
const WORDS = ['ALPHA', 'BRAVO', 'CHARLIE'];
// A transcript as Claude Code writes it (test/fakeclaude/claude.mjs writes the same): one question, its answer.
function transcript(word, i) {
  const id = randomUUID(), q = randomUUID(), a = randomUUID(), t = Date.now() - (10 - i) * 60e3;
  const base = { isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd: DIR, sessionId: id, version: '2.1.310' };
  const lines = [
    { ...base, parentUuid: null, type: 'user', message: { role: 'user', content: `Reply with just the word ${word}.` }, uuid: q, timestamp: new Date(t).toISOString(), promptId: randomUUID() },
    { ...base, parentUuid: q, type: 'assistant', uuid: a, timestamp: new Date(t + 1000).toISOString(), message: { id: `msg_${a.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text: word }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', DIR.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return id;
}
const ids = WORDS.map(transcript);

const { client, cmd, browser, page, pageErrors: errors } = await startSuite(PORT);
await addFolder(page, DIR);
const opened = [];
for (const id of ids) opened.push(await cmd({ type: 'resume', claudeSessionId: id, cwd: DIR }));
check(opened.every((r) => r.data?.sid), `the three sessions reopen from their transcripts (${opened.map((r) => r.error || 'ok')})`);
const rows = () => page.locator(`.folder[data-dir="${DIR}"] .sess`);
await until(async () => (await page.locator(`.folder[data-dir="${DIR}"] .sess.idle`).count()) === 3, 15000, 'all three live');

// Each row opens its own conversation: the question in its feed carries its word.
async function bindings() {
  const out = [];
  for (let i = 0; i < await rows().count(); i++) {
    await rows().nth(i).click();
    await page.locator('#feed .turn-q-text').first().waitFor({ timeout: 8000 }).catch(() => {}); // (a detached one reads its transcript first)
    const q = (await page.locator('#feed .turn-q-text').first().textContent().catch(() => '')) || (await page.locator('#feed').textContent()).slice(0, 80);
    out.push(WORDS.find((w) => q.includes(w)) || `?${q.slice(0, 30)}`);
  }
  return out;
}
const before = await bindings();
check(before.length === 3 && new Set(before).size === 3, `three rows, each with its own conversation (${before})`);

// (bindings() leaves the last row open)
async function archive(word, { open = false } = {}) {
  const order = await bindings(), i = order.indexOf(word);
  if (open) await rows().nth(i).click();
  check(open === (await rows().nth(i).evaluate((r) => r.classList.contains('active'))), `${word}'s row is ${open ? '' : 'not '}the open one`);
  await rows().nth(i).click({ button: 'right' });
  await hold(page, page.locator('.ctx-item', { hasText: 'Archive' }));
  await until(async () => !(await bindings()).includes(word), 10000, `${word} leaves the sidebar`);
}

// Archive one that is not open, then the open one.
const other = WORDS.find((w) => w !== before.at(-1) && w !== 'BRAVO');
await archive(other);
await archive('BRAVO', { open: true });
const left = WORDS.filter((w) => w !== other && w !== 'BRAVO');
let now = await bindings();
check(JSON.stringify(now) === JSON.stringify(left), `after archiving ${other} and BRAVO: ${now}`);

// A reload replays the event log: the archived rows must stay gone, the rest keep their conversations.
await reloadPage(page);
await rows().first().waitFor({ timeout: 10000 });
await wait(300);
now = await bindings();
check(JSON.stringify(now) === JSON.stringify(left), `after a reload: ${now}`);

// A daemon restart lists the remembered sessions again: not the archived ones. The open one is a
// detached row whose transcript is read once the connection is up (the replay comes first).
killDaemon();
await page.waitForFunction(() => !document.querySelector('#conn .dot.up'), null, { timeout: 10000 }).catch(() => {});
await reloadPage(page);
await rows().first().waitFor({ timeout: 10000 });
await wait(300);
now = await bindings();
check(JSON.stringify([...now].sort()) === JSON.stringify([...left].sort()), `after a daemon restart: ${now}`);

// Reopening an archived one from Past sessions brings it back, with its own conversation.
await openFolderHistory(page, DIR);
await page.locator('.modal .hrow', { hasText: 'BRAVO' }).first().click();
await until(async () => (await bindings()).includes('BRAVO'), 15000, 'BRAVO reopened');
await reloadPage(page);
await rows().first().waitFor({ timeout: 10000 });
await wait(300);
now = await bindings();
check(now.includes('BRAVO') && !now.includes(other) && new Set(now).size === now.length, `reopened from Past sessions, and still there after a reload: ${now}`);

await endSuite({ browser, client, errors });
