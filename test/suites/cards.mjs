// How a turn's parts show in the page. First rendered straight from the modules (what test/suites/render.mjs
// doesn't cover: task lists, copy buttons, links, a few tool cards); then a turn on the fake Claude that streams
// thinking and text and uses Read, Edit, Bash and a subagent, its history after a reload, and the file viewer
// opened from its Edit card.
import { PORT, startSuite, startSession, workDir, check, expectSoon, waitResults, reloadPage, endSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const WORK = workDir('cards-work', {
  'calc.py': 'def add(a, b):\n    return a - b\n\n\nif __name__ == "__main__":\n    print("add(2, 3) =", add(2, 3))\n',
  'secret.txt': 'The secret number is 4817.\n',
});
const { client, browser, page, errors } = await startSuite(PORT, { viewport: { width: 1300, height: 1000 }, dialog: 'dismiss' });

// ---- rendered from the modules ----
await page.evaluate(async () => {
  const r = await import('/ui/render.js');
  const f = document.getElementById('feed');
  f.innerHTML = '';
  const el = r.markdown(['- [x] done', '- [ ] to do', '', '```js', 'let a = 1;', '```', '', '```py', 'b = 2', '```', '', 'See [the docs](https://example.com).'].join('\n'));
  el.id = 'sample';
  f.append(el);
  const add = (b, res) => { const api = r.toolCard(b, '/w'); api.card.classList.add('synthetic'); f.append(api.card); api.setResult(res); };
  add({ id: 't1', name: 'TodoWrite', input: { todos: [
    { content: 'Fix add()', status: 'completed', activeForm: 'Fixing add()' },
    { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
    { content: 'Write summary', status: 'pending', activeForm: 'Writing summary' }] } }, { content: 'ok' });
  add({ id: 't2', name: 'TaskUpdate', input: { taskId: '2', status: 'completed', subject: 'Run tests' } }, { content: 'ok' });
  add({ id: 't4', name: 'Write', input: { file_path: '/w/new.py', content: 'print(1)\n' } }, { content: 'File created' });
  add({ id: 't6', name: 'mcp__github__get_issue', input: { owner: 'o', repo: 'r', issue_number: 1 } }, { content: '{"title":"x"}' });
});
const sample = page.locator('#sample'), syn = page.locator('.tool.synthetic');
check(await sample.locator('input[type=checkbox]').count() === 2, 'a task list shows its checkboxes');
check(await sample.locator('.codeblock .copy').count() === 2, 'each code block has a copy button');
check(await sample.locator('a[target=_blank][rel*=noopener]').count() === 1, 'links open in a new tab');
check(await syn.locator('li.todo.in_progress', { hasText: 'Running tests' }).count() === 1, 'TodoWrite shows the in-progress task by its activeForm');
check(await syn.locator('.tool-extra', { hasText: 'done' }).count() >= 1, 'TaskUpdate shows its status');
check(await syn.locator('.tool-sum', { hasText: 'new.py' }).count() === 1 && await syn.locator('.tool-sum', { hasText: '/w/new.py' }).count() === 0, 'paths show relative to the session folder');
check(await syn.locator('.tool-name', { hasText: 'github · get_issue' }).count() === 1, 'an MCP tool shows as server · tool');

// ---- a turn with each kind of card ----
await reloadPage(page);
// What was shown live while it streamed (typing out is over within a second: a poll could miss it).
await page.evaluate(() => {
  window.__live = { main: false, child: false };
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('#feed .live')) { if (el.closest('.children')) window.__live.child = true; else window.__live.main = true; }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
});
await startSession(page, WORK, 'Fix calc.py, run it, and find the secret number.');
check(await waitResults(page, 1, { timeout: 30000 }), 'the turn finishes (Edit and Bash allowed)');
const live = await page.evaluate(() => window.__live);
check(live.main, 'thinking and text stream in live');
check(live.child, 'the subagent\'s text streams in live inside its Agent card');
// (text still being typed out when the turn ends finishes within 600 ms)
await expectSoon(() => page.evaluate(() => !document.querySelector('.live')), 'no live block is left over', 1500);
check(await page.locator('.approval.settled .ask').count() === 0, 'settled approvals collapse to one line');
check(await page.locator('.tool:has(.tool-name:text-is("Read"))').count() >= 1, 'a Read card');
check(await page.locator('table.diff tr.add').count() >= 1 && await page.locator('table.diff tr.del').count() >= 1, 'Edit shows a diff');
check(await page.locator('.tool-extra .plus').count() >= 1, 'the diff is replaced by the real patch (+/- counts)');
check(await page.locator('.tool:has(.tool-name:text-is("Bash")) pre.out', { hasText: 'add(2, 3) = 5' }).count() === 1, 'Bash shows its output');
check(await page.locator('.tool:has(.tool-name:text-is("Agent")) .children .tool:has(.tool-name:text-is("Read"))').count() === 1
  && await page.locator('.tool:has(.tool-name:text-is("Agent")) .report', { hasText: '4817' }).count() === 1, 'the subagent\'s tool calls nest in its Agent card, its report below');
check(await page.locator('.md.assistant .katex').count() >= 2, 'LaTeX in the reply renders');
check(await page.locator('.md.assistant table').count() === 1, 'a table in the reply renders');
check(fs.readFileSync(path.join(WORK, 'calc.py'), 'utf8').includes('a + b'), 'the file was fixed');
check(await page.locator('.tool.running').count() === 0, 'no tool card is left running');

// ---- the file viewer from the Edit card shows the file as it is now ----
await page.locator('.turn-foot .file-link', { hasText: 'calc.py' }).last().click({ modifiers: ['Meta'] });
await page.locator('.modal .fileview').waitFor({ timeout: 10000 });
check((await page.locator('.modal .fileview .src').textContent()).includes('a + b'), 'the file viewer opened from an Edit card shows the current file');
await page.keyboard.press('Escape');

// ---- reload: the history renders the same way (from the event log, no streaming) ----
await reloadPage(page, 'Fix calc.py');
await expectSoon(async () => await page.locator('table.diff tr.add').count() >= 1 && await page.locator('.md.assistant .katex').count() >= 2
  && await page.locator('.tool:has(.tool-name:text-is("Agent")) .children .tool').count() === 1, 'the history renders again after a reload');

await endSuite({ browser, client, errors });
