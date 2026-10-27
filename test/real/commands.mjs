// What the real Claude Code answers to the page's commands, which the fake only copies: the /usage and /context
// data the panels draw (plan limits and plan, the square grid), a CLI-native command's output (/agents), and /btw
// on a forked, unsaved, tool-less copy of the session still knowing the conversation. One model turn and one btw.
import { PORT, startSuite, startSession, check, expectSoon, waitResults, command, workDir, endSuite } from '../lib.mjs';

const WORK = workDir('real-commands');
const suite = await startSuite(PORT);
const { page } = suite;

await startSession(page, WORK, 'Remember the codeword PELICAN. Reply with just: ok', { mode: 'default' });
check(await waitResults(page, 1, { timeout: 120000, approve: false }), 'first turn');

const count = (sel, text) => page.locator(`.modal ${sel}`, text ? { hasText: text } : {}).count();
async function dialog(name, title, shows, what) {
  await command(page, name);
  await expectSoon(async () => await page.locator('.modal .modal-title', { hasText: title }).count() === 1 && await shows(), `${name} opens its dialog: ${what}`, 60000);
  await page.keyboard.press('Escape');
}
await dialog('/usage', 'Usage', async () => await count('.meter-row') >= 2 && await count('.plan-badge') === 1, 'the plan limits and the plan');
await dialog('/context', 'Context window', async () => await count('.ctx-seg') >= 2 && await count('.ctx-grid .sq') >= 50, 'a stacked bar and the square grid');
await dialog('/agents', '/agents', async () => (await page.locator('.modal .modal-body').textContent()).trim().length > 0, 'what the CLI answered');
check(await page.locator('.turn').count() === 1, 'none of these commands added a turn');

await command(page, '/btw what codeword did I give you? Reply with just the word.');
await expectSoon(async () => /PELICAN/i.test(await page.locator('#btw .btw-answer:not(.live)').last().textContent()), '/btw answers from the conversation', 120000);
check(await page.locator('.turn').count() === 1, 'the side question stays out of the conversation');

await endSuite(suite);
