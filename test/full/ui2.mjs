// Message rendering test: Markdown/LaTeX sample + a real session exercising tool cards.
import { outDir, startSession, log, check, finish, startSuite } from '../lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const S = outDir();
const PORT = 4795;
const WORK = path.join(S, 'work4');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK);
fs.writeFileSync(path.join(WORK, 'calc.py'), 'def add(a, b):\n    return a - b\n\n\nif __name__ == "__main__":\n    print("add(2, 3) =", add(2, 3))\n');
fs.writeFileSync(path.join(WORK, 'secret.txt'), 'The secret number is 4817.\n');
const { client, browser, page, errors } = await startSuite(PORT, { viewport: { width: 1300, height: 1000 }, dialog: 'dismiss' });

// ---- 1. Markdown + LaTeX sample ----
const SAMPLE = fs.readFileSync(path.join(HERE, 'sample.md'), 'utf8');
await page.evaluate(async (src) => {
  const r = await import('/ui/render.js');
  const f = document.getElementById('feed');
  f.innerHTML = '';
  const el = r.markdown(src);
  el.id = 'sample';
  f.append(el);
}, SAMPLE);
const sample = page.locator('#sample');
check(await sample.locator('h1, h2, h3').count() >= 3, 'headings');
check(await sample.locator('table th').count() >= 3, 'GFM table');
check(await sample.locator('input[type=checkbox]').count() === 2, 'task list');
check(await sample.locator('.katex').count() >= 6, `KaTeX rendered (${await sample.locator('.katex').count()} formulas)`);
check(await sample.locator('.math-block .katex-display').count() >= 3, 'display math ($$, \\[ \\], ```math)');
check(await sample.locator('.katex-error, .katex .errorColor').count() === 0, 'no KaTeX errors');
check((await sample.textContent()).includes('$5 and $6'), 'currency is not math');
check(await sample.locator('code', { hasText: '$not_math$' }).count() === 1, 'math inside inline code stays code');
check(await sample.locator('.codeblock .hljs .hljs-keyword').count() > 0, 'code highlighted');
check(await sample.locator('.codeblock .copy').count() >= 2, 'copy buttons');
check(await sample.locator('script, img[onerror], iframe').count() === 0 && (await sample.textContent()).includes('<script>'), 'raw HTML shown as text, not executed');
check(await sample.locator('a[target=_blank][rel*=noopener]').count() >= 1, 'links open in a new tab');
// Synthetic tool cards for tools the model may not use in a short test.
await page.evaluate(async () => {
  const r = await import('/ui/render.js');
  const f = document.getElementById('feed');
  const add = (b, res, patch, agent) => { const api = r.toolCard(b, '/w'); api.card.classList.add('synthetic'); f.append(api.card); if (res) api.setResult(res, patch, agent); return api; };
  add({ id: 't1', name: 'TodoWrite', input: { todos: [
    { content: 'Fix add()', status: 'completed', activeForm: 'Fixing add()' },
    { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
    { content: 'Write summary', status: 'pending', activeForm: 'Writing summary' }] } }, { content: 'ok' });
  add({ id: 't2', name: 'TaskUpdate', input: { taskId: '2', status: 'completed', subject: 'Run tests' } }, { content: 'ok' });
  add({ id: 't3', name: 'Bash', input: { command: 'false && echo x', description: 'Failing command' } }, { content: 'Exit code 1\nboom', is_error: true });
  add({ id: 't4', name: 'Write', input: { file_path: '/w/new.py', content: 'print(1)\n' } }, { content: 'File created' });
  add({ id: 't5', name: 'Grep', input: { pattern: 'TODO', path: '/w/src', glob: '*.py' } }, { content: 'src/a.py:3: # TODO' });
  add({ id: 't6', name: 'mcp__github__get_issue', input: { owner: 'o', repo: 'r', issue_number: 1 } }, { content: '{"title":"x"}' });
  add({ id: 't7', name: 'WebFetch', input: { url: 'https://example.com', prompt: 'summarize' } }, { content: '# Example\nSome **markdown** result' });
});
const syn = page.locator('.tool.synthetic');
check(await syn.locator('ul.todos li').count() === 3 && await syn.locator('li.todo.in_progress', { hasText: 'Running tests' }).count() === 1, 'TodoWrite checklist (activeForm for in-progress)');
check(await syn.locator('.tool-extra', { hasText: 'done' }).count() >= 1, 'TaskUpdate status');
check(await page.locator('.tool.synthetic.error pre.out.err', { hasText: 'boom' }).count() === 1, 'failed Bash shows error output');
check(await syn.locator('.tool-sum', { hasText: 'new.py' }).count() === 1, 'paths shown relative to cwd');
check(await syn.locator('.tool-name', { hasText: 'github · get_issue' }).count() === 1, 'MCP tool name');
await page.screenshot({ path: path.join(S, 'md-light.png'), fullPage: false });
await page.emulateMedia({ colorScheme: 'dark' });
await page.screenshot({ path: path.join(S, 'md-dark.png') });
await page.emulateMedia({ colorScheme: 'light' });

// ---- 2. real session ----
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
await startSession(page, WORK, [
  'Do these steps in order:',
  '1. Track the work as 3 tasks using your task/todo tool (TaskCreate or TodoWrite, whichever you have).',
  '2. Read calc.py.',
  '3. Fix the bug in add() with the Edit tool.',
  '4. Run `python3 calc.py` with Bash.',
  '5. Use the Agent tool (general-purpose subagent) to find the secret number in secret.txt.',
  '6. Finish with a short explanation that includes the formula $f(a,b)=a+b$ in LaTeX, a display equation $$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$, and a 2-row markdown table of inputs and outputs, and the secret number.',
].join('\n'));

let sawLive = false;
const t0 = Date.now();
while (Date.now() - t0 < 300000) {
  if (!sawLive && await page.locator('.live').count()) sawLive = true;
  const allow = page.locator('.approval .btns button.primary');
  if (await allow.count()) {
    const box = page.locator('.approval:has(.btns)').first();
    console.log('  approving:', (await box.locator('.ask').textContent().catch(() => '?'))?.slice(0, 80));
    if (!(await page.locator('.approval .btns button', { hasText: 'Always allow' }).count())) console.log('  (no Always allow offered)');
    await allow.first().click();
    await page.waitForTimeout(400);
  }
  if (await page.locator('.meta.result').count()) break;
  await page.waitForTimeout(150);
}
check(await page.locator('.meta.result').count() >= 1, 'turn finished');
check(sawLive, 'streaming text/thinking was shown live');
check(await page.locator('.live').count() === 0, 'no leftover live block');
// The subagent may run in the background (forked subagents do): the turn then ends first, and the summary
// (step 6) comes in the turn its completion starts.
await page.waitForFunction(() => document.querySelectorAll('.md.assistant .katex').length >= 2 && !document.querySelector('.live'), null, { timeout: 120000 }).catch(() => {});
const report = page.locator('.tool .report'), inBackground = page.locator('.tool:has(.tool-name:text-is("Agent")) .tool-extra', { hasText: 'running in background' });
check(await report.count() ? !(await report.first().textContent()).includes('Subagent hand-back') : await inBackground.count() >= 1,
  `subagent report shown without harness framing (${await report.count() ? 'foreground' : 'in the background: no report'})`);
check(await page.locator('.approval.settled .ask').count() === 0, 'settled approvals collapse to one line');
check(await page.locator('.tool:has(.tool-name:text-is("Read"))').count() >= 1, 'Read card');
check(await page.locator('table.diff tr.add').count() >= 1 && await page.locator('table.diff tr.del').count() >= 1, 'Edit shows a diff');
check(await page.locator('.tool-extra .plus').count() >= 1, 'diff replaced by real patch (+/- counts)');
check(await page.locator('.tool:has(.tool-name:text-is("Bash")) pre.out', { hasText: 'add(2, 3) = 5' }).count() >= 1, 'Bash output shown');
check(await page.locator('.tool:has(.tool-name:text-is("Agent")) .children > *').count() >= 1, 'subagent messages nested in Agent card');
check(await page.locator('.md.assistant .katex').count() >= 2, 'LaTeX in the reply rendered');
check(await page.locator('.md.assistant table').count() >= 1, 'table in the reply rendered');
check(fs.readFileSync(path.join(WORK, 'calc.py'), 'utf8').includes('a + b'), 'file actually fixed');
check(await page.locator('.tool.running').count() === 0, 'no tool card stuck in running state');
console.log('  thinking blocks:', await page.locator('details.thinking').count());
await page.screenshot({ path: path.join(S, 'session-top.png') });
await page.evaluate(() => { const f = document.getElementById('feed'); f.scrollTop = f.scrollHeight; });
await page.screenshot({ path: path.join(S, 'session-bottom.png') });
await page.setViewportSize({ width: 1300, height: 3000 });
await page.screenshot({ path: path.join(S, 'session-full.png') });

// reload: history renders the same way (from the event log, no streaming)
await page.reload();
await page.locator('#conn .dot.up').waitFor({ timeout: 10000 });
await page.locator('.sess').first().click();
await page.waitForTimeout(800);
check(await page.locator('table.diff tr.add').count() >= 1 && await page.locator('.md.assistant .katex').count() >= 2, 'history re-renders after reload');

check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
client.kill('SIGTERM');
finish();
