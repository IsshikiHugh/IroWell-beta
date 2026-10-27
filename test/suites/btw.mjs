// The composer's memory (↑/↓ history, the grey completion, the predicted next prompt) and /btw: a side thread on
// a fork of the session, with follow-ups, listed in the rail's btw tab, asked while the main turn runs, and still
// there (and able to go on) after a daemon restart.
import { PORT, startSuite, startSession, openFolderHistory, killDaemon, check, expectSoon, seen, waitResults, turn, command, workDir, endSuite } from '../lib.mjs';

const WORK = workDir('btw');
const suite = await startSuite(PORT);
const { page } = suite;
const ghost = () => page.locator('#ghost .g').textContent();
const answers = () => page.locator('#btw .btw-answer:not(.live)');
const lastAnswer = async () => (await answers().last().textContent()).trim();
const turns = () => page.locator('.turn').count();

await startSession(page, WORK, 'Remember the codeword PELICAN. Reply with just: ok');
check(await waitResults(page, 1, { timeout: 30000 }), 'first turn');
check(await turn(page, 'What is 2+2? Reply with just the number.', { timeout: 30000 }), 'second turn');
check(await turn(page, 'What is 3+3? Reply with just the number.', { timeout: 30000 }), 'third turn');

// ---- history with ↑/↓ ----
await page.click('#input');
await page.keyboard.type('draft text');
await page.keyboard.press('ArrowUp');
check(await page.inputValue('#input') === 'draft text', '↑ with text in the box does not recall history');
await page.fill('#input', '');
await page.keyboard.press('ArrowUp');
check(await page.inputValue('#input') === 'What is 3+3? Reply with just the number.', '↑ in an empty box recalls the last message');
await page.keyboard.press('ArrowUp');
check(await page.inputValue('#input') === 'What is 2+2? Reply with just the number.', '↑ again goes further back');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
check(await page.inputValue('#input') === '', '↓ past the newest empties the box again');

// ---- the grey completion from history; → accepts it ----
await page.keyboard.type('What is 2');
check((await ghost()) === '+2? Reply with just the number.', `a grey completion from history (${JSON.stringify(await ghost())})`);
await page.keyboard.press('ArrowRight');
check(await page.inputValue('#input') === 'What is 2+2? Reply with just the number.', '→ accepts it');
await page.fill('#input', '');

// ---- the predicted next prompt in the empty box; Tab accepts it ----
check(await turn(page, 'Write a Python function is_prime(n) in a code block, nothing else. Do not create files.', { timeout: 30000 }), 'fourth turn');
await page.click('#input');
await expectSoon(async () => (await ghost()) === 'Now add unit tests for is_prime', 'the guessed next prompt shows grey in the empty box');
await page.keyboard.press('Tab');
check(await page.inputValue('#input') === 'Now add unit tests for is_prime', 'Tab accepts the guessed prompt');
await page.fill('#input', '');

// ---- a side thread: answered from the conversation, follow-ups keep the thread, the conversation stays as it was ----
await command(page, '/btw what codeword did I give you?');
await expectSoon(async () => await answers().count() === 1 && await lastAnswer() === 'PELICAN', '/btw answers from the conversation');
await page.fill('#btw .btw-input', 'Spell it backwards, letters only.');
await page.press('#btw .btw-input', 'Enter');
await expectSoon(async () => await answers().count() === 2 && await lastAnswer() === 'NACILEP', 'a follow-up keeps the thread');
check(await turns() === 4, 'the side thread stays out of the conversation');
await page.locator('#btw .btw-close').click();
check(await page.locator('#btw').count() === 0, 'the btw card closes');

// the rail's btw tab lists the thread; a click reopens all of it; opening the Usage page closes it
await page.click('#railtabs button[data-tab="btw"]');
await expectSoon(async () => await page.locator('#rail #btwlist .btw-item').count() === 1 && /2 exchanges/.test(await page.locator('#btwlist .btw-item .m').textContent()),
  'the btw tab in the right rail lists the thread with its 2 exchanges');
await page.locator('#btwlist .btw-item').first().click();
check(await page.locator('#btw .btw-user').count() === 2 && await answers().count() === 2, 'clicking it reopens the whole thread');
await page.locator('#usageBtn').click();
check(await page.locator('#btw').count() === 0, 'the btw card closes when the Usage page opens');
await page.locator('#usageBack').click();

// ---- /btw while the main turn runs (it waits for the side question: see btw.fake.mjs) ----
await page.fill('#input', 'Write 40 numbered one-sentence facts about rivers.');
await page.press('#input', 'Enter');
check(await seen(page.locator('.turn').nth(4).locator('.md.assistant').first(), 10000), 'the main turn is under way');
await command(page, '/btw what codeword did I ask you to remember?');
await expectSoon(async () => /PELICAN/.test(await page.locator('#btw .btw-body').textContent()), '/btw answers while the main turn runs');
check(!(await page.locator('#busy').isHidden()), '… and the main turn is still running then');
check(await waitResults(page, 5, { timeout: 30000, approve: false }), 'the main turn finished normally');
check(await turns() === 5 && !/codeword/i.test(await page.locator('.turn').last().textContent()), 'the side question did not get into the conversation');
await page.locator('#btw .btw-close').click();

// ---- after a daemon restart the thread is still there and goes on ----
killDaemon();
await page.getByText('reconnecting to local').waitFor({ timeout: 20000 });
await page.locator('#conn .dot.up').waitFor({ timeout: 20000 });
await openFolderHistory(page, WORK);
await page.locator('.hrow', { hasText: 'codeword' }).first().click();
await page.getByText('earlier conversation above').waitFor({ timeout: 20000 });
const thread = page.locator('#btwlist .btw-item', { hasText: '2 exchanges' });
check(await seen(thread, 10000), 'the thread survives a daemon restart');
await thread.click();
await page.fill('#btw .btw-input', 'What did you answer to my previous side question? Quote it.');
await page.click('#btw .btw-send'); // (the pill's send button)
await expectSoon(async () => await answers().count() === 3 && await lastAnswer() === 'NACILEP', 'going on after the restart, it still knows the thread', 20000);

await endSuite(suite);
