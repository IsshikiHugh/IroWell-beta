// Plugins: their widgets above the usage card and the pages they open, Settings → Plugins (where each widget
// shows, their order, their files), and the bookmarks and mindfulness plugins. No model.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { PORT, check, startSuite, endSuite } from '../lib.mjs';
import { pluginsDir, openSettings, answered, soon } from './_qb.mjs';

const plugins = pluginsDir();
process.env.IRO_SITE_ICONS_LOCAL = '1'; // the bookmarks ask only pages on this machine for their icons
const IRO_DIR = process.env.IRO_DIR;
const { browser, client, page, errors } = await startSuite(PORT);
// (the page's clock flows as usual; a step that waits for a second to pass jumps it instead)
await page.clock.install();

// ---- widgets: the plugins' tiles above the usage card, a row of up to four; a click opens a plugin's page ----
await soon(() => page.evaluate(() => {
  const box = document.getElementById('widgets'), tiles = [...box.children];
  const r = (el) => el.getBoundingClientRect();
  return { cols: getComputedStyle(box).gridTemplateColumns.split(' ').length, tiles: tiles.map((t) => [t.tagName, t.className, t.textContent, t.title]),
    row: new Set(tiles.map((t) => Math.round(r(t).top))).size, above: r(box).bottom < r(document.getElementById('usageBtn')).top,
    even: tiles.length === 3 && Math.abs(r(tiles[0]).width - r(tiles[2]).width) < 1 };
}), (w) => w.cols === 3 && w.row === 1 && w.even && w.above && JSON.stringify(w.tiles.map((t) => t[0])) === '["DIV","BUTTON","DIV"]'
  && /bad/.test(w.tiles[0][1]) && /boom/.test(w.tiles[0][3]) && /^\d\d:\d\d$/.test(w.tiles[1][2]) && w.tiles[1][3] === 'Clock' && w.tiles[2][2] === 'ok',
'three plugins: three widgets sharing one row above the usage card; the clock\'s opens a page, a failed one says why');

await page.click('#widgets .plugin-clock');
const clockTime = page.locator('.modal-body.widget-page.plugin-clock .time');
await clockTime.waitFor({ timeout: 3000 });
const open = await page.evaluate(() => {
  const t = document.querySelector('.modal-body.plugin-clock .time');
  window.__clockTime = t;
  return { title: document.querySelector('#modal .modal-title')?.textContent, time: t.textContent, size: parseFloat(getComputedStyle(t).fontSize),
    on: document.querySelector('#widgets .plugin-clock').classList.contains('on') };
});
await page.clock.fastForward(1100);
const ticked = await page.evaluate(() => window.__clockTime.textContent);
check(open.title === 'Clock' && /^\d\d:\d\d:\d\d$/.test(open.time) && open.size > 30 && open.on && ticked !== open.time,
  `the clock's page opens in a dialog, styled by its ui.css, and ticks (${JSON.stringify(open)} → ${ticked})`);
await page.click('#modal .modal-head button');
const closed = await page.evaluate(() => window.__clockTime.textContent);
await page.clock.fastForward(1100);
const after = await page.evaluate(() => ({ time: window.__clockTime.textContent, modal: !!document.getElementById('modal'), on: document.querySelector('#widgets .plugin-clock').classList.contains('on') }));
check(!after.modal && !after.on && after.time === closed, `closing the dialog stops the plugin's page (${JSON.stringify(after)}, ${closed})`);

// ---- Settings → Plugins: where each widget shows, kept in plugins.json by the client, the widgets drawn again at once ----
const pl = (sel) => page.locator(`#pluginsView ${sel}`);
const configFile = path.join(IRO_DIR, 'plugins.json');
// (a plugins.json of the first version, the where map alone, is read as it was)
fs.writeFileSync(configFile, JSON.stringify({ still: 'off' }));
const config = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };
const kept = () => config().where?.clock;
const widgets = () => page.locator('#widgets .widget').evaluateAll((ws) => ws.map((w) => w.className.match(/plugin-(\w+)/)[1]).join());
const pluginRows = () => pl('.sk-item').evaluateAll((els) => els.map((e) => `${e.querySelector('.sk-name').textContent}:${e.querySelector('.sk-tag').textContent}`).join());
await openSettings(page, 'Plugins');
await soon(async () => ({ rows: await pluginRows(), content: await page.locator('#content').isHidden() }),
  (v) => v.rows === 'broken:every server,clock:every server,still:off' && v.content, 'Settings → Plugins lists every plugin and where it shows, over the session');
await pl('.sk-item:has-text("still")').click();
await pl('.sk-mode:has-text("Every server")').click();
await page.locator('#widgets .plugin-still').waitFor({ timeout: 5000 });
await pl('.sk-item:has-text("clock")').click();
await pl('.sk-mode:has-text("Off")').click();
await soon(async () => ({ widgets: await widgets(), kept: kept(), tag: await pl('.sk-item.on .sk-tag').textContent() }),
  (v) => v.widgets === 'broken,still' && v.kept === 'off' && v.tag === 'off', 'Off: the clock\'s widget goes at once, and the client keeps it');
await pl('.sk-mode:has-text("Some servers")').click();
await soon(async () => ({ widgets: await widgets(), kept: kept(), ticked: await pl('.pl-servers .hall:has(input:checked)').allTextContents() }),
  (v) => v.widgets.includes('clock') && JSON.stringify(v.kept) === '["local"]' && JSON.stringify(v.ticked) === '["This machine"]', 'Some servers starts with the tab\'s own server ticked');
await pl('.pl-servers .hall:has(input:checked) input').click();
await soon(async () => ({ widgets: await widgets(), kept: kept() }), (v) => !v.widgets.includes('clock') && JSON.stringify(v.kept) === '[]', 'unticked, it shows nowhere');
await pl('.sk-mode:has-text("Every server")').click();
await soon(async () => ({ widgets: await widgets(), kept: kept() }), (v) => v.widgets.includes('clock') && v.kept === undefined, 'Every server again');
// dragged in the list: the widgets follow its order
await pl('.sk-item:has-text("still")').dragTo(pl('.sk-item:has-text("broken")'), { targetPosition: { x: 40, y: 3 } });
await soon(async () => ({ list: (await pl('.sk-item .sk-name').allTextContents()).join(), widgets: await widgets(), kept: config().order?.join() }),
  (v) => v.list === 'still,broken,clock' && v.widgets === v.list && v.kept === v.list,
  'a plugin dragged to the top of the list: its widget goes first, and the client keeps the order');
// a plugin's files, to look at
await pl('.sk-item:has-text("clock")').click();
const files = await pl('.sk-files button').allTextContents();
await pl('.sk-files button:has-text("ui.js")').click();
await soon(async () => ({ files: files.join(), title: await page.locator('.modal-title').textContent(), code: await page.locator('.modal .sk-file .hljs-keyword').count() }),
  (v) => v.files === 'plugin.json,ui.css,ui.js' && v.title === 'plugins/clock/ui.js' && v.code > 0, 'a plugin\'s files are listed, and open to look at');
await page.locator('.modal-head button').click();

// ---- the bookmarks plugin: what it keeps stays with the local client (plugin-data/bookmarks.json) ----
// (added while the page is open: it shows once the widgets are drawn again, here by turning still off)
plugins.add('bookmarks');
await pl('.sk-item:has-text("still")').click();
await pl('.sk-mode:has-text("Off")').click();
await page.locator('#widgets button.plugin-bookmarks').waitFor({ timeout: 5000 });
await pl('.usage-bar > button').click();
const keptMarks = () => { try { return JSON.parse(fs.readFileSync(path.join(IRO_DIR, 'plugin-data', 'bookmarks.json'), 'utf8')); } catch { return null; } };
const bm = (sel) => page.locator(`.modal-body.plugin-bookmarks ${sel}`);
const sec = (name) => bm(`.bm-sec:has(.bm-name:text-is("${name}"))`);
const addTo = async (name, title, url) => {
  await sec(name).hover();
  await sec(name).locator('.bm-add').click();
  await bm('.bm-form input').first().fill(title);
  await bm('.bm-form input').nth(1).fill(url);
  await page.keyboard.press('Enter');
  await bm('.bm-form').waitFor({ state: 'detached', timeout: 3000 });
};
// (its page reads them again as it opens: added only once that read is in)
const read = answered(page, 'pluginData');
await page.click('#widgets .plugin-bookmarks');
await bm('.bm-sec').first().waitFor({ timeout: 3000 });
await read;
const fresh = await bm('.bm-name').allTextContents();
await addTo('Bookmarks', '', 'openreview.net');
await addTo('Bookmarks', 'Overleaf', 'https://www.overleaf.com/');
await bm('.bm-newsec').click();
await bm('.bm-rename').waitFor({ timeout: 3000 });
await page.keyboard.type('Tools');
await page.keyboard.press('Enter');
await addTo('Tools', 'TensorBoard', 'localhost:6006');
// (each save reaches the client after the form has gone)
await soon(async () => ({ fresh, chips: await bm('.bm-chip').evaluateAll((as) => as.map((a) => `${a.textContent.replace(/[✎✕]/g, '')}=${a.getAttribute('href')}`)), kept: keptMarks()?.sections.map((s) => [s.name, s.items.length]) }),
  (v) => JSON.stringify(v.fresh) === '["Bookmarks"]'
    && JSON.stringify(v.chips) === '["Oopenreview.net=https://openreview.net/","OOverleaf=https://www.overleaf.com/","TTensorBoard=http://localhost:6006/"]'
    && JSON.stringify(v.kept) === '[["Bookmarks",2],["Tools",1]]',
  'bookmarks: a section to start with; added ones get an address and a title, and the client keeps them');
// dragged: a bookmark before another, a bookmark onto another section (its end), a section above another
await bm('.bm-chip:has-text("Overleaf")').dragTo(bm('.bm-chip:has-text("openreview.net")'), { targetPosition: { x: 4, y: 8 } });
await bm('.bm-chip:has-text("TensorBoard")').dragTo(sec('Bookmarks').locator('.bm-head'), { targetPosition: { x: 40, y: 20 } });
await sec('Tools').locator('.bm-head').dragTo(sec('Bookmarks').locator('.bm-head'), { targetPosition: { x: 40, y: 2 } });
const want = '[["Tools",[]],["Bookmarks",["Overleaf","openreview.net","TensorBoard"]]]';
await soon(async () => ({
  shown: JSON.stringify(await bm('.bm-sec').evaluateAll((ss) => ss.map((s) => [s.querySelector('.bm-name').textContent, [...s.querySelectorAll('.bm-t')].map((t) => t.textContent)]))),
  kept: JSON.stringify(keptMarks()?.sections.map((s) => [s.name, s.items.map((i) => i.title)])),
  tile: JSON.stringify(await page.locator('#widgets .plugin-bookmarks').evaluate((t) => [t.textContent, t.querySelectorAll('svg').length])),
}), (v) => v.shown === want && v.kept === want && v.tile === '["",1]',
'bookmarks and sections are dragged into place, kept so, and the tile is the bookmark sign alone');
await bm('.bm-q').fill('tensor');
const filtered = { chips: await bm('.bm-t').allTextContents(), secs: await bm('.bm-name').allTextContents(), n: await bm('.bm-n').allTextContents() };
check(JSON.stringify(filtered) === '{"chips":["TensorBoard"],"secs":["Bookmarks"],"n":["1"]}', `the filter leaves what matches (${JSON.stringify(filtered)})`);
// a page's own icon (its HTML names it; the client fetches it) in place of its letter; none there: the letter
let PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const site = http.createServer((req, res) => (req.url === '/i.png'
  ? res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PNG)
  : res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><link rel="shortcut icon" href="i.png"></head></html>')));
await new Promise((r) => site.listen(0, '127.0.0.1', r));
await bm('.bm-q').fill('');
await addTo('Bookmarks', 'Site', `http://127.0.0.1:${site.address().port}/page`);
await soon(() => bm('.bm-chip').evaluateAll((as) => as.map((a) => [a.querySelector('.bm-t').textContent, a.querySelector('.bm-mono img')?.src.slice(0, 22) || a.querySelector('.bm-mono').textContent])),
  (icons) => JSON.stringify(icons) === '[["Overleaf","O"],["openreview.net","O"],["TensorBoard","T"],["Site","data:image/png;base64,"]]',
  'a bookmark shows its page\'s own icon, and the site\'s letter when it has none');
// saved again (the same address): its icon is fetched again
const siteImg = () => bm('.bm-chip:has-text("Site") .bm-mono img').getAttribute('src', { timeout: 500 }).catch(() => null);
const iconBefore = await siteImg();
PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGM4YWPzHwAFUAJA1CVDXgAAAABJRU5ErkJggg==', 'base64');
await bm('.bm-chip:has-text("Site")').hover();
await bm('.bm-chip:has-text("Site") .bm-act[title="Edit"]').click();
await bm('.bm-form input').first().press('Enter');
await soon(siteImg, (v) => iconBefore && v === `data:image/png;base64,${PNG.toString('base64')}`, 'a bookmark saved again fetches its icon again');
site.close();
await page.locator('.modal-head button').click();

// ---- the mindfulness plugin: closed, it leaves as it came (the circle fades, then the dark page), then the dialog goes ----
// (shown once the widgets are drawn again: here by turning still back on, in Settings → Plugins)
plugins.add('mindfulness');
await openSettings(page, 'Plugins');
await pl('.sk-item:has-text("still")').click();
await pl('.sk-mode:has-text("Every server")').click();
await page.locator('#widgets button.plugin-mindfulness').waitFor({ timeout: 5000 });
await pl('.usage-bar > button').click();
await page.click('#widgets .plugin-mindfulness');
await page.locator('.modal-body.plugin-mindfulness .mf-circle').waitFor({ timeout: 3000 });
// (the dark page has come in)
await page.waitForFunction(() => getComputedStyle(document.getElementById('modal')).opacity === '1', null, { timeout: 3000 });
// the dialog's and the dark page's opacity, every frame until it is gone
await page.evaluate(() => {
  const back = document.getElementById('modal'), m = back.querySelector('.modal');
  window.__mf = [];
  const tick = () => { if (!back.isConnected) return; window.__mf.push([+getComputedStyle(m).opacity, +getComputedStyle(back).opacity]); requestAnimationFrame(tick); };
  tick();
});
await page.locator('#modal .modal-head button').click();
const stillThere = await page.evaluate(() => !!document.getElementById('modal'));
await soon(() => page.evaluate(() => ({ gone: !document.getElementById('modal'), on: document.querySelector('#widgets .plugin-mindfulness').classList.contains('on'),
  circleFading: window.__mf.some(([m, b]) => m > 0.05 && m < 0.95 && b === 1), pageFading: window.__mf.some(([m, b]) => m < 0.05 && b > 0.05 && b < 0.95) })),
(mf) => stillThere && mf.gone && !mf.on && mf.circleFading && mf.pageFading, 'mindfulness closed with ✕: the circle fades out, then the dark page, then the dialog goes');

await endSuite({ browser, client, errors });
