// Quoting the conversation and naming attachments in the text: the conversation's right-click menu, > on a
// selection, the row above the input (q1, p1), their chips in the box (<q1>, <p1>: typed, or dragged in), and what
// goes to Claude (a quote and an image where the text names them, the others first).
import fs from 'node:fs';
import path from 'node:path';
import { check, seen, expectSoon, endSuite, startSession, outDir } from '../lib.mjs';
import { start, work } from './_qa.mjs';

const WORK = work('quote-work');
const S = await start({ clipboard: true });
const { page } = S;
const REPLY = 'The page keeps the clock skew. Every replayed event carries the server time'; // (the fake Claude drops a last full stop)
await startSession(page, WORK, `Reply with just: ${REPLY}`);
// (typed out first: the reply's own block shows once that is done)
await expectSoon(() => seen(page.locator('.md.assistant:not(.live) p', { hasText: 'Every replayed event' }), 1000), 'the reply comes', 15000);
const value = () => page.$eval('#input', (e) => e.value);
const menu = () => page.locator('.ctx-menu .ctx-item').allTextContents();

// Select `what` in the reply; returns the middle of the selection (for a right-click on it).
const select = (what) => page.evaluate((what) => {
  const blocks = [...document.querySelectorAll('.md.assistant:not(.live)')];
  let node = null;
  for (const b of blocks) {
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    while (!node && w.nextNode()) if (w.currentNode.data.includes(what)) node = w.currentNode;
  }
  if (!node) throw new Error(`no ${JSON.stringify(what)} in the replies: ${JSON.stringify(blocks.map((b) => b.innerHTML))}`);
  document.activeElement?.blur(); // (as a press in the conversation does)
  node.parentElement.scrollIntoView({ block: 'center' });
  const r = document.createRange();
  const at = node.data.indexOf(what);
  r.setStart(node, at); r.setEnd(node, at + what.length);
  getSelection().removeAllRanges(); getSelection().addRange(r);
  const b = r.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}, what);

// right-click on a selection: Quote puts it in the row above the input, as q1
{
  const at = await select('Every replayed event carries the server time');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const items = await menu();
  await page.screenshot({ path: path.join(outDir(), 'quote-menu.png') });
  check(items.length === 3 && /^Quote/.test(items[0]) && /^Ask aside/.test(items[1]) && /^Copy/.test(items[2]), `the menu on a selection: Quote, Ask aside, Copy (${items})`);
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Quote' }).click();
  await expectSoon(async () => await page.locator('#attach .thumb.quote').count() === 1 && /q1\s*Every replayed/.test(await page.locator('#attach .thumb.quote').textContent()), 'Quote: the quote is in the row above the input, as q1', 3000);
}

// <q1> typed in the box becomes its chip; a picture pasted is p1, and <p1> its chip too
{
  await page.click('#input');
  await page.keyboard.type('<q1>');
  await expectSoon(async () => await page.locator('#input .ref-q').count() === 1 && await value() === '<q1>', '<q1> typed becomes a chip (the value keeps <q1>)', 3000);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('What does this mean, next to ');
  const took = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'image.png', { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById('input').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  await expectSoon(async () => took && await page.locator('#attach .thumb:not(.quote)').count() === 1 && (await page.locator('#attach .thumb:not(.quote) .ref-label').textContent()) === 'p1', 'a pasted picture is p1 in the row', 3000);
  await page.keyboard.type('<p1>?');
  await expectSoon(async () => await page.locator('#input .ref-p img').count() === 1 && await value() === '<q1>\nWhat does this mean, next to <p1>?', `<p1> becomes a chip with the picture (${JSON.stringify(await value())})`, 3000);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  check(await value() === '<q1>\nWhat does this mean, next to ' && await page.locator('#input .ref-p').count() === 0, `Backspace takes the chip away whole (${JSON.stringify(await value())})`);
  await page.keyboard.type('<p1>?');
  await page.screenshot({ path: path.join(outDir(), 'quote-composer.png') });
  await page.keyboard.press('Enter');
  await expectSoon(() => seen(page.locator('.turn-q-quote', { hasText: 'Every replayed event' }), 1000), 'the request shows the quote as a quote', 10000);
  check(await page.locator('.turn-q-text .ref-p img').count() === 1 && await page.locator('#attach .thumb').count() === 0 && await value() === '', 'the picture sits in the request where it was named; the row and the box are empty again');
  await page.screenshot({ path: path.join(outDir(), 'quote-sent.png') });
}

// what Claude got: the quote where it was named, the picture between the words around it
{
  // (the transcripts the fake Claude keeps: what it got, as it got it)
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects');
  const lines = () => fs.readdirSync(dir).flatMap((d) => fs.readdirSync(path.join(dir, d)).filter((f) => f.endsWith('.jsonl')).map((f) => fs.readFileSync(path.join(dir, d, f), 'utf8'))).join('\n');
  let content = null;
  await expectSoon(async () => {
    const users = lines().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.type === 'user' && Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === 'image'));
    content = users.at(-1)?.message.content;
    return !!content;
  }, 'the message with the picture reaches Claude', 10000);
  const kinds = content.map((b) => b.type).join(',');
  check(kinds === 'text,image,text' && content[0].text === '> Every replayed event carries the server time\nWhat does this mean, next to ' && content[2].text === '?',
    `Claude gets the quote as a quote block, and the picture where it was named (${JSON.stringify(content.map((b) => b.type === 'text' ? b.text : b.type))})`);
}

// > on a selection quotes it too; a quote the text doesn't name goes first
{
  await select('The page keeps the clock skew.');
  await page.keyboard.press('Shift+Period');
  await expectSoon(async () => await page.locator('#attach .thumb.quote').count() === 1, '> on a selection quotes it', 3000);
  await page.fill('#input', 'Why?');
  await page.keyboard.press('Enter');
  await expectSoon(() => seen(page.locator('.turn-q', { hasText: 'Why?' }).locator('.turn-q-quote', { hasText: 'clock skew' }), 1000), 'a quote not named in the text goes before it', 10000);
}

// a quote dragged from the row into the text is named where it lands; × takes it out of the row and the text
{
  await select('Every replayed event');
  await page.keyboard.press('Shift+Period');
  await page.fill('#input', 'About this: ');
  await page.locator('#attach .thumb.quote').dragTo(page.locator('#input'));
  await expectSoon(async () => /<q1>/.test(await value()) && await page.locator('#input .ref-q').count() === 1, `dragged into the box, the quote is named there (${JSON.stringify(await value())})`, 3000);
  await page.locator('#attach .thumb.quote button').click();
  check(await page.locator('#attach .thumb').count() === 0 && !/<q1>/.test(await value()) && await page.locator('#input .ref').count() === 0, `× takes it out of the row and out of the text (${JSON.stringify(await value())})`);
  await page.fill('#input', '');
}

// Ask aside: a side question (btw) with the selection quoted in its box
{
  const at = await select('The page keeps the clock skew');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.locator('.ctx-menu .ctx-item', { hasText: 'Ask aside' }).click();
  await expectSoon(async () => await page.locator('#btw .btw-input').evaluate((e) => e.value) === '> The page keeps the clock skew\n\n'
    && await page.locator('#btw .btw-input').evaluate((e) => e === document.activeElement), 'Ask aside opens a side question with the selection quoted, for the question', 3000);
  await page.locator('#btw .btw-close').click();
}

// copied from the box, a chip is its <q1>
{
  await select('Every replayed event');
  await page.keyboard.press('Shift+Period');
  await page.fill('#input', 'See <q1> now');
  await expectSoon(async () => await page.locator('#input .ref-q').count() === 1, 'the chip is in the box', 3000);
  await page.click('#input');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  check(await page.evaluate(() => navigator.clipboard.readText()) === 'See <q1> now', 'copied, the box\'s text names the quote as <q1>');
  await page.locator('#attach .thumb.quote button').click();
  await page.fill('#input', '');
}

// the other menus: a reply's paragraph, your message, and Shift for the browser's own
{
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.locator('.md.assistant p', { hasText: 'Every replayed' }).first().click({ button: 'right' });
  let items = await menu();
  check(items.join('|') === 'Quote paragraph|Copy reply as Markdown', `on a reply: Quote paragraph, Copy reply as Markdown (${items})`);
  await page.keyboard.press('Escape');
  await page.locator('.turn-q-text').first().click({ button: 'right' });
  items = await menu();
  check(items[0] === 'Copy message' && items.includes('Branch from here') && items.some((t) => t.startsWith('Rewind to here')), `on your message: Copy message, Branch, Rewind (${items})`);
  await page.keyboard.press('Escape');
  await page.locator('.md.assistant p').first().click({ button: 'right', modifiers: ['Shift'] });
  check(await page.locator('.ctx-menu').count() === 0, 'Shift+right-click leaves the browser its own menu');
}

await endSuite(S);
