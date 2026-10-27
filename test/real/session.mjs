// What only the real Claude Code can show (test/suites/session.mjs, cards.mjs and modes.mjs test the page on the
// fake): an image and an @file reach the model; Accept edits really skips the CLI's ask; Always allow is honoured
// by the CLI's own rule matching; a subagent's report shows without the CLI's hand-back framing. Five short turns.
import { PORT, startSuite, startSession, workDir, check, turn, endSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const WORK = workDir('real-session', {
  'calc.py': 'def add(a, b):\n    return a + b\n\n\nprint(add(2, 3))\n',
  'secret.txt': 'The secret number is 4817.\n',
});
const { client, browser, page, errors } = await startSuite(PORT, { viewport: { width: 1300, height: 1000 }, dialog: 'dismiss' });
const lastReply = async () => (await page.locator('.md.assistant:not(.live)').last().textContent()) || '';

// ---- Always allow: the CLI does not ask again for the second Write ----
await startSession(page, WORK, 'Use the Write tool to create a.txt containing "a". Then reply with just: ok', { mode: 'default' });
const always = page.locator('.approval button', { hasText: 'Always allow' });
if (check(await always.waitFor({ timeout: 120000 }).then(() => true, () => false), 'the first Write asks, with Always allow offered')) {
  await always.click();
  await page.locator('.meta.result').first().waitFor({ timeout: 120000 });
  check(await turn(page, 'Now use the Write tool to create b.txt containing "b". Then reply with just: ok2', { approve: false, timeout: 120000 })
    && await page.locator('.approval').count() === 1 && fs.existsSync(path.join(WORK, 'b.txt')), 'the second Write is not asked again');
}

// ---- an image and an @file reach the model; Accept edits; a subagent's report ----
await startSession(page, WORK, 'Reply with just: ready', { mode: 'acceptEdits' });
await page.locator('.meta.result').first().waitFor({ timeout: 120000 });
await page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ff0000'; g.fillRect(0, 0, 64, 64);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'red.png', { type: 'image/png' }));
  document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.locator('#attach .thumb img').waitFor({ timeout: 5000 });
check(await turn(page, 'Without using any tools: what is the name of the function in @calc.py, and what single color fills this image? Answer with just those two words.', { timeout: 120000 }), 'the turn with an image and an @file finishes');
const both = await lastReply();
check(/add/i.test(both) && /red/i.test(both), `the model saw the @file and the image (${JSON.stringify(both.slice(0, 40))})`);

const asked = await page.locator('.approval').count();
check(await turn(page, 'Use the Edit tool to change print(add(2, 3)) to print(add(4, 5)) in calc.py. Reply with just: edited', { approve: false, timeout: 120000 })
  && await page.locator('.approval').count() === asked && fs.readFileSync(path.join(WORK, 'calc.py'), 'utf8').includes('add(4, 5)'), 'in Accept edits mode the CLI edits without asking');

check(await turn(page, 'Use the Agent tool (general-purpose subagent) to find the secret number in secret.txt. Then reply with just the number.', { timeout: 180000 }), 'the subagent turn finishes');
// (a forked subagent runs in the background: its report then comes in a turn of its own)
await page.waitForFunction(() => /4817/.test([...document.querySelectorAll('.md.assistant')].pop()?.textContent || ''), null, { timeout: 120000 }).catch(() => {});
const report = page.locator('.tool .report'), inBackground = page.locator('.tool:has(.tool-name:text-is("Agent")) .tool-extra', { hasText: 'running in background' });
check(await report.count() ? !(await report.first().textContent()).includes('Subagent hand-back') : await inBackground.count() >= 1,
  `the subagent's report shows without the CLI's framing (${await report.count() ? 'foreground' : 'in the background: no report'})`);
check(await page.locator('.tool:has(.tool-name:text-is("Agent")) .children > *').count() >= 1, 'the subagent\'s messages nest in its Agent card');

await endSuite({ browser, client, errors });
