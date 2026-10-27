// What a reply's text becomes on the page, drawn straight by ui/render.js: Markdown (LaTeX, tables, code, raw
// HTML, images), tool cards, the :::log / :::reply / :::ask parts, mermaid diagrams and their viewer, and how a
// wide table sits in the conversation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, expectSoon, endSuite, showMarkdown, newDraft, addFolder } from '../lib.mjs';
import { start, work } from './_qa.mjs';

const WORK = work('render-work');
const S = await start({ clipboard: true });
const { page } = S;
// (a draft, so the conversation area is laid out as for a session)
await addFolder(page, WORK);
await newDraft(page, WORK);
await page.locator('.draft-intro').waitFor({ timeout: 5000 });

// ---- Markdown, LaTeX, tool cards ----
const SAMPLE = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '_sample.md'), 'utf8');
await showMarkdown(page, 'sample', SAMPLE);
await page.evaluate(async () => {
  const r = await import('/ui/render.js');
  const box = document.createElement('div'); box.id = 'cards';
  document.getElementById('feed').append(box);
  const add = (b, res) => { const api = r.toolCard(b, '/w'); box.append(api.card); if (res) api.setResult(res); };
  add({ id: 't1', name: 'Edit', input: { file_path: '/w/a.py', old_string: 'return a - b', new_string: 'return a + b' } }, { content: 'ok' });
  add({ id: 't2', name: 'Bash', input: { command: 'false', description: 'fails' } }, { content: 'boom', is_error: true });
  add({ id: 't3', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', activeForm: 'doing b' }] } }, { content: 'ok' });
});
const sample = page.locator('#sample');
check(await sample.locator('.katex').count() >= 6 && await sample.locator('.katex-error, .katex .errorColor').count() === 0, 'LaTeX renders without errors');
check((await sample.textContent()).includes('$5 and $6') && await sample.locator('code', { hasText: '$not_math$' }).count() === 1, 'money and code spans are not math');
check(await sample.locator('table th').count() >= 3 && await sample.locator('.codeblock .hljs-keyword').count() > 0, 'tables and highlighted code');
check(await sample.locator('script, img[onerror]').count() === 0 && (await sample.textContent()).includes('<script>'), 'raw HTML shown as text');
check(await page.locator('#cards table.diff tr.add').count() === 1 && await page.locator('#cards .tool.error').count() === 1 && await page.locator('#cards ul.todos li').count() === 2, 'tool cards: diff, error, checklist');
{
  const imgs = await page.evaluate(async () => {
    const el = (await import('/ui/render.js')).markdown('![leak](https://example.com/p.png?d=secret) ![x](//example.com/a.png) ![dot](data:image/png;base64,iVBORw0KGgo=)');
    return { imgs: [...el.querySelectorAll('img')].map((i) => i.getAttribute('src').slice(0, 10)), links: [...el.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]) };
  });
  check(JSON.stringify(imgs.imgs) === '["data:image"]' && imgs.links.length === 2 && imgs.links[0][1] === 'https://example.com/p.png?d=secret' && imgs.links[1][1] === null,
    `remote Markdown images become links, data: images stay (${JSON.stringify(imgs)})`);
}
await page.evaluate(() => { document.getElementById('sample').remove(); document.getElementById('cards').remove(); });

// ---- a reply's parts by what they are for: :::log / :::reply / :::ask blocks (skills/system-prompt.md, item 4) ----
{
  await showMarkdown(page, 'roles', [':::log', 'Ran the tests: `3 failed`, then fixed the import.', ':::', '', ':::reply', 'The parser now **splits** the reply.', ':::', '',
    '- a list just above', ':::ask', '1. Keep the old syntax too?', ':::', '', ':::reply', '```md', ':::', 'inside a fence', '```', ':::', 'outside again', '',
    ':::log', 'First line of a longer log.', '', '- and more below it', ':::'].join('\n'), { turn: true });
  const roles = await page.evaluate(async () => {
    const r = await import('/ui/render.js');
    const el = document.getElementById('roles');
    const kinds = (e) => [...e.children].map((c) => c.classList.contains('md-role') ? c.className.match(/md-(log|reply|ask)/)[1] : c.tagName.toLowerCase());
    const font = (s) => parseFloat(getComputedStyle(el.querySelector(s)).fontSize);
    const mark = (s) => getComputedStyle(el.querySelector(s), '::before').content;
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))); // the logs are measured
    const [short, long] = [...el.querySelectorAll('.md-log')];
    const bodyOf = (l) => l.querySelector('.md-role-body');
    const dot = (l) => getComputedStyle(l.querySelector('.md-log-dot')).backgroundColor;
    const folded = bodyOf(long).offsetHeight, dots = [dot(short), dot(long)];
    short.click(); bodyOf(long).click(); // the text itself opens nothing
    const still = [short.classList.contains('open'), bodyOf(long).offsetHeight === folded];
    long.querySelector('.md-log-dot').click();
    const opened = bodyOf(long).offsetHeight;
    dots.push(dot(long));
    const numbered = r.markdown(':::ask[1]\nFirst?\n:::\n\n:::ask[ 2 ]\n2.1 This?\n2.2 That?\n:::');
    el.parentElement.append(numbered);
    return { kinds: kinds(el), fence: el.querySelector('.md-reply pre')?.textContent, ul: el.querySelector('ul .md-role') === null,
      bare: kinds(r.markdown('Now the config.\n\n:::reply\nDone.\n:::\n\nAfter it.', 'log')), plain: kinds(r.markdown('No marks here', 'log')),
      log: font('.md-log'), res: font('.md-reply'), typing: kinds(r.markdown(':::log\nhalf typed')), half: r.markdown('text\n\n:::as').textContent.trim(), halfN: r.markdown('text\n\n:::ask[1').textContent.trim(),
      numbered: { n: [...numbered.querySelectorAll('.md-ask')].map((a) => a.dataset.n), marks: [...numbered.querySelectorAll('.md-ask')].map((a) => getComputedStyle(a, '::before').content), text: numbered.textContent.includes('[') },
      marks: [mark('.md-reply'), mark('.md-ask')], more: [short.classList.contains('more'), long.classList.contains('more')], folded, opened, line: bodyOf(short).offsetHeight, dots, still };
  });
  check(JSON.stringify(roles.kinds) === '["log","reply","ul","ask","reply","p","log"]' && roles.ul && /^:::\ninside a fence/.test(roles.fence || ''),
    `:::log / :::reply / :::ask become blocks; a list above keeps out of them; a fence inside keeps its ::: (${JSON.stringify(roles.kinds)})`);
  check(JSON.stringify(roles.bare) === '["log","reply","log"]' && JSON.stringify(roles.plain) === '["log"]',
    `text in a reply left without a marker shows as a log (${JSON.stringify(roles.bare)}, ${JSON.stringify(roles.plain)})`);
  check(roles.log < roles.res && JSON.stringify(roles.typing) === '["log"]' && roles.half === 'text',
    `a log reads smaller; a block still typing shows as one; a half-typed marker is hidden (${roles.log} vs ${roles.res}px, "${roles.half}")`);
  check(JSON.stringify(roles.numbered.n) === '["1","2"]' && JSON.stringify(roles.numbered.marks) === '["\\"1\\"","\\"2\\""]' && !roles.numbered.text && roles.halfN === 'text',
    `:::ask[n] is a question marked with its number; a half-typed :::ask[1 is hidden (${JSON.stringify(roles.numbered)}, "${roles.halfN}")`);
  check(JSON.stringify(roles.marks) === '["\\"!\\"","\\"?\\""]' && JSON.stringify(roles.more) === '[false,true]' && roles.folded === roles.line && roles.opened > roles.folded * 2
    && roles.dots[0] === 'rgba(0, 0, 0, 0)' && roles.dots[1] !== roles.dots[0] && roles.dots[2] === roles.dots[0] && JSON.stringify(roles.still) === '[false,true]',
    `a reply and a question are marked ! and ?; a longer log shows its first line, with a filled dot that opens it (a ring once open, or with nothing more); clicking the text does nothing (${JSON.stringify(roles)})`);
  await page.evaluate(() => document.getElementById('roles').closest('.turn').remove());
}

// ---- ```mermaid: a closed block draws (once: drawing the reply again finds the SVG at once), one still streaming
// in stays code, a broken one shows its source and why; the viewer: buttons on hover, zoom / pan / reset, drag,
// Ctrl-scroll, Source, Copy, Open larger ----
{
  const SRC = 'flowchart LR\n  a["Start (x)"] --> b{ok?}\n  b -->|yes| c[Done]';
  await showMarkdown(page, 'diagrams', `Flow:\n\n\`\`\`mermaid\n${SRC}\n\`\`\`\n\nStill typing:\n\n\`\`\`mermaid\n${SRC}\n`);
  await showMarkdown(page, 'broken', '```mermaid\nflowchart LR\n  a --> end\n  ((\n```');
  const first = page.locator('#diagrams .diagram-block'), frame = first.locator('.diagram'), failed = page.locator('#broken .diagram-block');
  await expectSoon(async () => await frame.locator('.diagram-view > svg').count() === 1 && await failed.evaluate((e) => e.classList.contains('failed')), 'mermaid draws the diagram, and gives up on the broken one', 20000);
  check(await first.count() === 1 && await page.locator('#diagrams .codeblock:not(.diagram-source)').count() === 1, 'a closed mermaid block is a diagram, an unclosed one stays code');
  check((await frame.textContent()).includes('Start (x)') && !await first.locator('.diagram-source').isVisible(), 'the diagram is drawn, its source hidden');
  check(await failed.locator('.diagram-source pre').isVisible() && /couldn't draw/.test(await failed.locator('.code-lang').textContent()),
    `a broken diagram shows its source and why (${await failed.locator('.code-lang').textContent()})`);
  check(await page.evaluate(() => document.querySelectorAll('body > [id^="ddiagram-"], body > svg[id^="diagram-"]').length) === 0, 'mermaid leaves nothing behind in the page');
  const pad = first.locator('.diagram-pad');
  const opacity = () => pad.evaluate((e) => getComputedStyle(e).opacity);
  const before = await opacity();
  await frame.hover();
  check(before === '0' && await expectSoon(async () => await opacity() === '1', 'the buttons show on hover (they fade in)', 3000), `no buttons before the hover (${before})`);
  const tf = () => first.locator('.diagram-view').evaluate((e) => new DOMMatrix(getComputedStyle(e).transform));
  await first.locator('[data-act="zoom-in"]').click();
  const zin = await tf();
  await first.locator('[data-act="right"]').click();
  const panned = await tf();
  check(zin.a > 1 && panned.e > zin.e, `zoom in and pan buttons (scale ${zin.a}, moved ${panned.e - zin.e})`);
  await first.locator('[data-act="reset"]').click();
  const reset = await tf();
  check(reset.a === 1 && reset.e === 0 && reset.f === 0, 'reset puts it back');
  await frame.scrollIntoViewIfNeeded();
  const fb = await frame.boundingBox();
  await page.mouse.move(fb.x + 30, fb.y + 30);
  await page.mouse.down();
  await page.mouse.move(fb.x + 70, fb.y + 50, { steps: 4 });
  await page.mouse.up();
  const dragged = await tf();
  check(dragged.e === 40 && dragged.f === 20, `dragging pans it as far as the mouse moved (${dragged.e}, ${dragged.f})`);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  const zoomed = await expectSoon(async () => { const a = (await tf()).a; return a > 1 && a; }, 'Ctrl-scroll zooms', 2000);
  check(zoomed < 1.3, `… a notch at a time (${zoomed})`);
  await first.locator('[data-act="source"]').click();
  check(await first.locator('.diagram-source pre').isVisible() && !await frame.isVisible(), 'the source button shows the mermaid source');
  await first.locator('.diagram-toggle').click();
  check(await frame.isVisible() && !await first.locator('.diagram-source').isVisible(), 'and Diagram goes back');
  await frame.hover();
  await first.locator('[data-act="copy"]').click();
  await expectSoon(async () => await page.evaluate(() => navigator.clipboard.readText()) === SRC, 'Copy copies the source', 3000);
  await first.locator('[data-act="expand"]').click();
  const big = page.locator('.modal.diagram-modal .diagram-block.expanded');
  check(await big.locator('.diagram-view > svg').count() === 1 && (await big.locator('.diagram').boundingBox()).height > fb.height, 'Open larger shows it in a big dialog');
  await page.locator('.modal-head button').click();
  const again = await page.evaluate(async ([src]) => (await import('/ui/render.js')).markdown(`\`\`\`mermaid\n${src}\n\`\`\``).querySelectorAll('.diagram-view > svg').length, [SRC]);
  check(again === 1, 'drawing the same diagram again finds its SVG at once');
  await page.evaluate(() => { document.getElementById('diagrams').remove(); document.getElementById('broken').remove(); });
}

// ---- a reply's table: a narrow one starts at the text's edge; a wide one spreads into both gutters equally,
// centred on the column, up to the same distance from the conversation area's edges, and scrolls beyond that ----
{
  const row = (n, w) => `| ${Array.from({ length: n }, (_, i) => `${w}${i}`).join(' | ')} |`;
  const tbl = (n, w) => `${row(n, 'h')}\n|${' --- |'.repeat(n)}\n${row(n, w)}`;
  await showMarkdown(page, 'tables', `${tbl(2, 'x')}\n\ntext\n\n${tbl(3, 'cell')}\n\ntext\n\n${tbl(3, 'cell')}\n\ntext\n\n${tbl(40, 'verywidecell')}`, { turn: true });
  const g = await page.evaluate(() => {
    const el = document.getElementById('tables'), feed = document.getElementById('feed');
    el.scrollIntoView();
    const box = (e) => e.getBoundingClientRect().toJSON();
    const [n, s, w, vw] = [...el.querySelectorAll('table')];
    const indent = box(el).left - box(el.closest('.turn')).left; // (the text's indent in the column)
    s.style.width = `${box(el).width + indent / 2}px`; // wider than the text, narrower than the column
    w.style.width = `${box(el).width + indent + 40}px`; // past the column on each side
    return { md: box(el), indent, area: box(document.getElementById('content')), sb: feed.offsetWidth - feed.clientWidth,
      n: box(n), s: box(s), w: box(w), vw: box(vw), scrolls: vw.scrollWidth > vw.clientWidth };
  });
  const near = (a, b) => Math.abs(a - b) < 1.5;
  const col = { left: g.md.left - g.indent, right: g.md.right };
  check(near(g.n.left, g.md.left) && g.n.width < g.md.width, `a narrow table stays at the text's left edge (${g.n.left} vs ${g.md.left})`);
  check(near(g.s.right, g.md.right) && g.s.left < g.md.left - 1, `a table a little wider than the text grows left into the indent (${Math.round(g.md.left - g.s.left)}px)`);
  const [wl, wr] = [col.left - g.w.left, g.w.right - col.right];
  check(wl > 1 && near(wl, wr), `a wider one spreads into both gutters equally, centred on the column (${Math.round(wl)} / ${Math.round(wr)}px)`);
  const [l, rt] = [g.vw.left - g.area.left, g.area.right - g.sb - g.vw.right];
  check(near(l, rt) && l > 0 && g.scrolls, `a very wide table stops the same distance from both edges and scrolls (${Math.round(l)} / ${Math.round(rt)}px)`);
}

await endSuite(S);
