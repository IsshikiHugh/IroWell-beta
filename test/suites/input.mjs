// The composer and what sits around it, on a blank session: the rail, menus, the input's growth, pasting,
// /color, ⌥M's dead key, /keybindings, and @ completion.
import { check, wait, seen, expectSoon, endSuite, command, reloadPage } from '../lib.mjs';
import { start, work, openBlank } from './_qa.mjs';

const WORK = work('input-work');
const S = await start({ clipboard: true });
const { page, cmd } = S;
await page.evaluate(() => localStorage.setItem('iro-rail-tab', 'resources')); // (a tab of an earlier version)
await reloadPage(page);
await openBlank(page, cmd, WORK);
check(/st-idle/.test(await page.locator('.sess.active .dot').getAttribute('class')), 'idle session is yellow');

// a send that takes a while (a reattach first) clears only what it sent: text typed meanwhile stays
{
  await page.route('**/cmd', async (route) => {
    if (JSON.parse(route.request().postData() || '{}').type !== 'send') return route.continue();
    await wait(600);
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: null }) });
  });
  await page.fill('#input', 'sent message');
  await page.press('#input', 'Enter');
  await wait(100);
  await page.evaluate(() => { const i = document.getElementById('input'); i.value += '\n\ntyped meanwhile'; });
  await expectSoon(async () => await page.inputValue('#input') === 'typed meanwhile', 'text typed during a send stays in the input', 5000);
  await page.unroute('**/cmd');
  await page.fill('#input', '');
}

// menus and popovers: one at a time, and a click elsewhere closes them
{
  const n = (sel) => page.locator(sel).count();
  await page.click('#statusbar .dd-btn.dd-modepick');
  const dd = await n('.dd-menu');
  await page.locator('.folder-head').first().click({ button: 'right' });
  const swapped = (await n('.dd-menu')) === 0 && (await n('.ctx-menu')) === 1;
  await page.keyboard.press('Escape');
  const escaped = (await n('.ctx-menu')) === 0;
  await page.click('#input');
  await page.keyboard.press('Alt+KeyM');
  const pop = await seen(page.locator('.model-pop'), 8000);
  await page.click('#statusbar .dd-btn.dd-modepick');
  const popToDd = (await n('.model-pop')) === 0 && (await n('.dd-menu')) === 1;
  await page.mouse.click(700, 300);
  check(dd === 1 && swapped && escaped && pop && popToDd && (await n('.dd-menu')) === 0,
    `one menu at a time: a dropdown, a right-click menu and the model panel close one another (${[dd, swapped, escaped, pop, popToDd]})`);
}

// the rail
check((await page.locator('#railtabs button').allTextContents()).join('|') === 'Anchors|Tasks|btw|Todo', 'rail tabs: Anchors / Tasks / btw / Todo');
check(await page.locator('#railtabs button.active').textContent() === 'Anchors' && await page.locator('#outline').isVisible(), 'a remembered tab that is no more falls back to Anchors');
await page.click('#railtabs button[data-tab="tasks"]');
check((await page.locator('#runlist .run-item').first().textContent()).startsWith('main'), 'Tasks lists main');
check(await page.locator('#taskCount').isHidden(), 'the Tasks tab has no badge while only main is listed');
check(await page.evaluate(() => { const w = document.querySelector('.input-wrap').getBoundingClientRect(), b = document.getElementById('send').getBoundingClientRect();
  return b.right <= w.right && b.left >= w.left && b.bottom <= w.bottom && b.top >= w.top; }), 'the send button sits inside the pill');

// the input grows with its text, up to a cap; three lines bring the expand bar
{
  const height = () => page.evaluate(() => document.getElementById('input').offsetHeight);
  await page.fill('#input', '');
  const small = await height();
  check(await page.locator('#expandInput').isHidden(), 'one line: no expand button');
  await page.fill('#input', 'a\nb');
  check(await page.locator('#expandInput').isHidden(), 'two lines: still no expand button');
  await page.fill('#input', 'a\nb\nc');
  check(await page.locator('#expandInput').isVisible(), 'three lines show the expand button');
  const three = await height();
  check(three > small, `the pill grows with its text (${small} → ${three}px)`);
  await page.fill('#input', 'x\n'.repeat(40));
  const capped = await height();
  check(capped < 260 && await page.evaluate(() => getComputedStyle(document.getElementById('input')).overflowY) === 'auto', `long text: capped (${capped}px) and scrolls inside`);
  await page.fill('#input', '');
  check(Math.abs((await height()) - small) <= 1, 'clearing returns to one line');
  check(await page.evaluate(() => { const i = document.getElementById('input'); i.focus(); return getComputedStyle(i).outlineStyle; }) === 'none', 'no focus ring on the input');
  await page.fill('#input', 'x\n'.repeat(40));
  await page.click('#expandInput');
  check((await page.evaluate(() => document.getElementById('input').offsetHeight / innerHeight)) > 0.45, 'expand bar opens a half-screen editor');
  await page.fill('#input', '');
}

// pasting: text wins over the picture of it an app adds (Excel, Feishu, Typeless); images attach when there
// is no text, or the text is only their file names (Finder); a type Claude can't take says so
{
  const thumbs = () => page.locator('#attach .thumb').count();
  const pastePng = (text, name) => page.evaluate(async ([text, name]) => {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    if (text) dt.setData('text/plain', text);
    dt.items.add(new File([png], name, { type: 'image/png' }));
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById('input').dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [text, name]);
  await page.click('#input');
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const png = await new Promise((r) => c.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob(['cells as text'], { type: 'text/plain' }), 'image/png': png })]);
  });
  await page.keyboard.press('ControlOrMeta+V');
  await expectSoon(async () => await page.inputValue('#input') === 'cells as text', 'a paste of text with a picture of it pastes the text', 3000);
  check(await thumbs() === 0, `… and attaches no picture (${await thumbs()} images)`);
  await page.fill('#input', '');
  let took = await pastePng('shot.png', 'shot.png');
  await expectSoon(async () => took && await thumbs() === 1, 'an image file copied in Finder (its name as the text) attaches', 3000);
  await page.locator('#attach .thumb button').click();
  took = await pastePng('', 'image.png');
  await expectSoon(async () => took && await thumbs() === 1, 'an image alone attaches', 3000);
  await page.locator('#attach .thumb button').click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(8)], 'a.tiff', { type: 'image/tiff' }));
    document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check(await seen(page.locator('.toast.note', { hasText: "can't be attached" }), 3000) && await thumbs() === 0, 'an image of a type Claude can\'t take says so');
  await page.fill('#input', '');
}

// /color, handled in the page
{
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  const was = await accent();
  await command(page, '/color green');
  const now = await expectSoon(async () => { const a = await accent(); return a !== was && a; }, '/color changes the accent', 8000);
  const [r, g, b] = (now || '#000000').match(/\w\w/g).map((x) => parseInt(x, 16));
  check(g > r && g > b, `… to a green (${was} → ${now})`);
}

// ⌥M is a dead key on US Extended: the system composes an accent into the input anyway
{
  const cdp = await page.context().newCDPSession(page);
  await page.fill('#input', 'hi');
  await page.click('#input');
  // (the system composes it with the key press; the page's clock stands still meanwhile, so a slow
  // machine doesn't push it past the 100 ms the guard allows)
  await page.evaluate(() => { const now = Date.now, t = now(); window.__now = now; Date.now = () => t; });
  await page.keyboard.press('Alt+KeyM');
  await cdp.send('Input.imeSetComposition', { text: '¯', selectionStart: 1, selectionEnd: 1 });
  await expectSoon(() => page.locator('.model-pop').count(), '⌥M opens the model panel', 8000);
  await expectSoon(async () => await page.inputValue('#input') === 'hi', '⌥M\'s dead-key accent doesn\'t stay in the input', 5000);
  await page.evaluate(() => { Date.now = window.__now; delete window.__now; });
  // a pending composition can deliver one ← → press twice; it moves effort one level
  const level = () => page.evaluate(() => Number(document.querySelector('.model-pop input[type=range]').value));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); // off the low end, so two steps would show
  const l0 = await level();
  const arrow = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...arrow });
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...arrow });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...arrow });
  const l1 = await level();
  await page.keyboard.press('ArrowRight');
  const l2 = await level();
  check(l1 === Math.max(0, l0 - 1) && l2 === l1 + 1, `one ← → press is one effort level (${l0} → ${l1} → ${l2})`);
  await page.keyboard.press('Escape');
  await page.fill('#input', '');
  await cdp.detach();
}

// keyboard shortcuts: /keybindings rebinds them, the new key works and the old one doesn't
{
  await command(page, '/keybindings');
  const btn = page.locator('.key-btn[data-action="model.panel"]');
  check(await seen(btn, 8000), '/keybindings opens the shortcuts dialog');
  await btn.click();
  await page.keyboard.press('KeyK');
  const msg = page.locator('.key-msg').filter({ hasText: /\S/ });
  check(await msg.count() === 1, 'a key that types on its own is refused');
  await page.keyboard.press('Shift+Tab');
  check(/Already used/.test(await msg.textContent()), 'a key another action has is refused');
  await page.keyboard.press('Alt+KeyK');
  await expectSoon(async () => /K/.test(await btn.textContent()), 'the button shows the new key', 3000);
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('iro-keybindings'))['model.panel']) === 'Alt+KeyK', 'the new key is saved');
  check(await page.locator('.modal').count() === 1 && await page.locator('.model-pop').count() === 0, 'the key being recorded does nothing else');
  await page.keyboard.press('Escape');
  check(/K\)$/.test(await page.getAttribute('#modelBtn', 'title')), `the button's tooltip shows the new key (${await page.getAttribute('#modelBtn', 'title')})`);
  await page.click('#input');
  await page.keyboard.press('Alt+KeyM');
  await wait(200);
  check(await page.locator('.model-pop').count() === 0, 'the old key no longer opens the model panel');
  await page.keyboard.press('Alt+KeyK');
  check(await seen(page.locator('.model-pop'), 8000), 'the new key opens it');
  await page.keyboard.press('Escape');
  await command(page, '/keybindings');
  await page.locator('.keys-foot button').click();
  check(await page.evaluate(() => localStorage.getItem('iro-keybindings')) === null && !(await page.locator('.key-btn.changed').count()), 'Restore all defaults clears them');
  await page.keyboard.press('Escape');
  await page.fill('#input', '');
  await wait(200); // the click blurred the input, and a blur closes the completion popup 150ms later
  // (a second copy of the module, which reads the stored keys as a fresh page would)
  const k = await page.evaluate(async () => {
    localStorage.setItem('iro-keybindings', JSON.stringify({ 'model.panel': 5, 'mode.cycle': 'Alt+KeyK', 'gone.action': 'Alt+KeyX' }));
    const m = await import('/ui/keys.js?fresh');
    const out = { loaded: [m.keyOf('model.panel'), m.keyOf('mode.cycle')], label: m.label('model.panel') };
    m.setKey('model.panel', 'Alt+KeyJ');
    m.setKey('mode.cycle', 'Alt+KeyM');
    out.reset = m.resetKey('model.panel');
    out.after = m.keyOf('model.panel');
    out.refused = [m.problem('shell.toggle', 'Ctrl+KeyR'), m.problem('model.next', 'Enter')];
    localStorage.removeItem('iro-keybindings');
    return out;
  });
  check(k.loaded[0] === 'Alt+KeyM' && k.loaded[1] === 'Alt+KeyK' && !!k.label, `a stored key of the wrong shape is ignored (${JSON.stringify(k.loaded)})`);
  check(/Already used/.test(k.reset) && k.after === 'Alt+KeyJ', `Default is refused when another action has taken that key (${k.reset})`);
  check(k.refused.every(Boolean), `keys the shell or the model panel need are refused (${JSON.stringify(k.refused)})`);
}

// @ completion (the daemon lists the files): names, ./ and ../ paths, and a picked folder lists its entries
{
  const item = (text) => page.locator('#popup .pop-main', { hasText: text }).first();
  const at = async (typed, text) => { await page.fill('#input', ''); await page.type('#input', typed); return seen(item(text), 8000); };
  check(await at('@cal', 'calc.py'), '@ completes files');
  await page.press('#input', 'Escape');
  check(await at('@./sr', './src/'), '@./ lists the folder');
  await page.press('#input', 'Escape');
  await page.fill('#input', '');
  await page.type('#input', '@../input-work/s');
  await expectSoon(() => page.evaluate(() => document.querySelector('#popup:not([hidden]) .pop-item.sel .pop-main')?.textContent === '../input-work/src/'), '@../ lists the folder above', 8000);
  await page.press('#input', 'Tab');
  check(await seen(item('../input-work/src/notes.md'), 8000) && await page.inputValue('#input') === '@../input-work/src/', `picking a folder lists its entries (${await page.inputValue('#input')})`);
  await page.press('#input', 'Escape');
  await page.fill('#input', '');
}

await endSuite(S);
