// The progress list with a real session: Claude starts one through the irowell:progress skill, it shows at
// the rail's foot, and what the user changes there reaches Claude with their next message.
import { outDir, startSession, check, finish, startSuite, until, turn } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const S = outDir();
const PORT = 4766;
const WORK = path.join(S, 'work-progress');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
const { client, browser, page, errors } = await startSuite(PORT, { viewport: { width: 1400, height: 900 } });

const items = () => page.evaluate(() => [...document.querySelectorAll('#progress .pg-item')].map((r) => `${r.className.replace('pg-item ', '')}:${r.querySelector('.pg-text').textContent}`).join(' | '));
const item = (text) => page.locator('#progress .pg-item', { hasText: text });
const lastAnswer = () => page.evaluate(() => document.querySelector('#feed .turn:last-child')?.textContent || '');

await startSession(page, WORK, 'Reply with just: ready');
await page.locator('.meta.result').first().waitFor({ timeout: 120000 });
check(await page.locator('#progress').isHidden(), 'a session shows no progress list before it starts one');

check(await turn(page, 'Load the irowell:progress skill and use it to start a progress list with exactly these three items, in this order: "Alpha step", "Beta step", "Gamma step". Then mark "Alpha step" done. Reply with just: ok', { results: '.meta.result', timeout: 240000 }), 'the turn that starts the list');
await until(async () => (await items()) === 'done:Alpha step | todo:Beta step | todo:Gamma step', 10000);
check(await items() === 'done:Alpha step | todo:Beta step | todo:Gamma step' && await page.locator('#progress .pg-count').textContent() === '1/3',
  `Claude starts the list through the skill, and it shows at the rail's foot (${await items()})`);
await page.screenshot({ path: path.join(S, 'progress-1-started.png') });

// the user's changes go with their next message: Claude knows them without reading the list
await page.fill('#progress .pg-add', 'Delta step');
await page.press('#progress .pg-add', 'Enter');
await item('Delta step').waitFor({ timeout: 5000 }).catch(() => {});
await item('Beta step').locator('.pg-state').click();
await page.locator('#progress .pg-item.doing', { hasText: 'Beta step' }).waitFor({ timeout: 5000 }).catch(() => {});
await item('Gamma step').hover();
await item('Gamma step').locator('.pg-x').click();
await until(async () => (await items()) === 'done:Alpha step | doing:Beta step | todo:Delta step', 5000);
const tools = await page.locator('#feed .tool').count();
check(await turn(page, 'Run no command and use no tool for this one. I just edited the progress list: which item did I add, which did I remove, and which did I mark as being done now (doing)? Answer in one line as: added=<text>; removed=<text>; doing=<text>', { results: '.meta.result', timeout: 240000 }), 'the turn after the user\'s edits');
const answer = await lastAnswer();
check(/added=\W*Delta step/i.test(answer) && /removed=\W*Gamma step/i.test(answer) && /doing=\W*Beta step/i.test(answer) && await page.locator('#feed .tool').count() === tools,
  `the user's changes came with their message: Claude names them without a tool call (${JSON.stringify(answer.slice(-200))})`);
await page.screenshot({ path: path.join(S, 'progress-2-told.png') });
check(await page.locator('#feed .turn:last-child .hook-note').count() === 0, 'and the turn shows no note about how they came');

// told once: the next message carries nothing, and Claude's own reading has nothing new either
check(await turn(page, 'Now run the progress script with no command and paste its exact output in a code block.', { results: '.meta.result', timeout: 240000 }), 'the turn that reads the list');
const read = await lastAnswer();
check(/Progress list \(1 of 3 done\)/.test(read) && /\[~\] Beta step/.test(read) && !/The user changed/.test(read), `each change is told once: reading the list afterwards shows it without them (${JSON.stringify(read.slice(-300))})`);

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
finish();
