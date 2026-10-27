// Files a reply points at: which links are file references, what a click / ⌘-click does, the viewer (lines a
// link names), big files fetched in chunks and kept in memory, images (zoom and pan), SVG, and videos (converted
// on this computer, stepped frame by frame).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, wait, seen, expectSoon, endSuite, showMarkdown } from '../lib.mjs';
import { start, work, openBlank } from './_qa.mjs';

const WORK = work('files-work');
fs.mkdirSync(path.join(WORK, 'img'));
fs.writeFileSync(path.join(WORK, 'img', 'dot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64'));
const S = await start({ clipboard: true });
const { page, cmd } = S;
await openBlank(page, cmd, WORK); // (relative links are read against the open session's folder)
const clipText = () => page.evaluate(() => navigator.clipboard.readText());
const clipped = (want, what) => expectSoon(async () => { const c = await clipText(); return (typeof want === 'function' ? want(c) : c === want) && c; }, what, 3000);
const toast = (text) => seen(page.locator('.toast', { hasText: text }).first());

// ---- file references: only Markdown links to files (a click copies the target, ⌘/Ctrl/Shift-click opens it);
// a path in `code` is plain code that a click copies as written ----
await showMarkdown(page, 'refs', `Prose mentions calc.py and a/b/c.txt but those stay text. Code: \`src/notes.md:3\`, \`img/dot.png\`. Links: [notes](src/notes.md#L2), [missing](./missing/file.txt), [dot.png](${WORK}/img/dot.png), [calc.py](${WORK}/calc.py).`);
{
  const refs = await page.locator('#refs .path-ref').allTextContents();
  const codes = await page.locator('#refs code.code-copy').allTextContents();
  check(JSON.stringify(refs) === JSON.stringify(['notes', 'missing', 'dot.png', 'calc.py']) && JSON.stringify(codes) === JSON.stringify(['src/notes.md:3', 'img/dot.png']),
    `only file links are references; path-like code is copyable code (${JSON.stringify({ refs, codes })})`);
  const codeLook = await page.evaluate(() => getComputedStyle(document.querySelector('#refs code.code-copy')).textDecorationLine);
  check(codeLook === 'none', `path-like code is not underlined (${codeLook})`);
  await page.locator('#refs code.code-copy', { hasText: 'src/notes.md:3' }).click();
  const toasted = toast(/^Copied/); // (it goes by itself)
  await clipped('src/notes.md:3', 'a click on path-like code copies its text as written');
  check(await toasted, 'a toast confirms the copy');
  await page.locator('#refs code.code-copy', { hasText: 'img/dot.png' }).click({ modifiers: ['Meta'] });
  await wait(300);
  check(await page.locator('.modal').count() === 0, '⌘-click on path-like code opens nothing');
  await page.locator('#refs .path-ref', { hasText: 'notes' }).click();
  await clipped(path.join(WORK, 'src/notes.md') + ':2', 'a link click copies the absolute path, keeping #L line numbers');
  await page.locator('#refs .path-ref', { hasText: 'missing' }).click({ modifiers: ['Shift'] });
  check(await toast('Not found'), 'Shift-click on a link to a missing file says so');
  await page.locator('#refs .path-ref', { hasText: 'calc.py' }).click({ modifiers: ['Meta'] });
  check(await seen(page.locator('.modal .fileview'), 8000), '⌘-click opens a text file in the viewer');
  await page.keyboard.press('Escape');
  fs.appendFileSync(path.join(WORK, 'calc.py'), '\n# edited after the first open\n');
  await page.locator('#refs .path-ref', { hasText: 'calc.py' }).click({ modifiers: ['Meta'] });
  await expectSoon(async () => (await page.locator('.modal .fileview .src').textContent({ timeout: 1000 })).includes('edited after the first open'),
    'a small text file is read again on each open: it shows the file as it is now', 8000);
  await page.keyboard.press('Escape');
}

// ---- a link that names lines (a.py:12-40) opens the file there, with those line numbers marked ----
fs.writeFileSync(path.join(WORK, 'long.py'), Array.from({ length: 400 }, (_, i) => `x${i + 1} = ${i + 1}`).join('\n') + '\n');
await showMarkdown(page, 'lines', `[range](${WORK}/long.py:123-234), [one](./long.py:300), [col](./long.py:7:5), [frag](long.py#L20-L25), [past](./long.py:390-999), [plain](long.py).`);
{
  const lineRefs = await page.evaluate(() => [...document.querySelectorAll('#lines .path-ref')].map((a) => [a.dataset.path.split('/').pop(), a.dataset.line || '', a.dataset.lineEnd || ''].join(' ')));
  check(JSON.stringify(lineRefs) === JSON.stringify(['long.py 123 234', 'long.py 300 ', 'long.py 7 ', 'long.py 20 25', 'long.py 390 999', 'long.py  ']), `a link's lines are read off its target (${JSON.stringify(lineRefs)})`);
  await page.locator('#lines .path-ref', { hasText: 'range' }).click();
  await clipped((c) => c.endsWith('/long.py:123-234'), 'a click copies the path with its lines');
  // what the viewer shows: the marked line numbers, and the first and last line number in view
  const openRef = async (name) => {
    await page.locator('#lines .path-ref', { hasText: name }).click({ modifiers: ['Meta'] });
    await page.locator('.modal .fileview').waitFor({ timeout: 8000 });
    const m = await page.evaluate(() => {
      const body = document.querySelector('.modal-body'), gutter = body.querySelector('.gutter'), mark = gutter.querySelector('.lines');
      const total = body.querySelector('.src').textContent.split('\n').length;
      const b = body.getBoundingClientRect(), g = gutter.getBoundingClientRect(), lh = parseFloat(getComputedStyle(gutter).lineHeight);
      const nums = mark ? mark.textContent.split('\n') : [];
      return { first: nums[0], last: nums.at(-1), scroll: body.scrollTop, total, at: mark ? (mark.getBoundingClientRect().top - b.top) / b.height : null, even: Math.abs(g.height - total * lh) < 1,
        aligned: mark ? Math.abs(mark.getBoundingClientRect().top - g.top - (Number(nums[0]) - 1) * lh) < 1 : null, bg: mark ? getComputedStyle(mark).backgroundColor : '' };
    });
    await page.keyboard.press('Escape');
    return m;
  };
  let mk = await openRef('range');
  check(mk.first === '123' && mk.last === '234' && mk.total === 401 && mk.even && mk.aligned && !/rgba\(0, 0, 0, 0\)|transparent/.test(mk.bg), `the lines a link names are marked in the gutter, each number still beside its line (${JSON.stringify(mk)})`);
  check(Math.abs(mk.at - 0.4) < 0.02, `and the viewer opens with the first of them two fifths of the way down (${mk.at?.toFixed(3)})`);
  mk = await openRef('one');
  check(mk.first === '300' && mk.last === '300' && Math.abs(mk.at - 0.4) < 0.02, `a single line works the same (${JSON.stringify(mk)})`);
  mk = await openRef('past');
  check(mk.first === '390' && mk.last === '401', `a range past the end stops at the last line (${JSON.stringify(mk)})`);
  mk = await openRef('plain');
  check(mk.first === undefined && mk.scroll === 0, `a link without lines opens at the top, nothing marked (${JSON.stringify(mk)})`);
}

// ---- a big text file is fetched in chunks and kept in memory: opening it again asks the server nothing more ----
let chunks = 0, converts = 0;
page.on('request', (r) => {
  if (r.url().endsWith('/cmd') && JSON.parse(r.postData() || '{}').type === 'readChunk') chunks++;
  if (r.url().includes('/convert?')) converts++;
});
const openFile = async (box, name, sel) => {
  await page.locator(`${box} .path-ref`, { hasText: name }).click({ modifiers: ['Meta'] });
  return seen(page.locator(`.modal ${sel}`).first(), 15000);
};
const shown = () => page.locator('.modal .fileview .src').textContent();
const BIG = path.join(WORK, 'big.log');
fs.writeFileSync(BIG, 'line of a big log\n'.repeat(20000));
await showMarkdown(page, 'big', `Log: [big.log](${BIG}:19990-19995), folder: [img](${WORK}/img), small: [calc.py](${WORK}/calc.py)`);
{
  const big = async () => { const ok = await openFile('#big', 'big.log', '.fileview'); const text = ok ? await shown() : ''; await page.keyboard.press('Escape'); return text; };
  const other = async () => { await openFile('#big', 'calc.py', '.fileview'); await page.keyboard.press('Escape'); };
  check(await openFile('#big', 'big.log', '.fileview') && (await shown()).startsWith('line of a big log') && chunks === 1, `a big text file is fetched, then shows in the viewer (${chunks} chunk)`);
  check(await page.locator('.modal .gutter .lines').textContent() === Array.from({ length: 6 }, (_, i) => 19990 + i).join('\n'), 'at the lines its link names');
  await page.keyboard.press('Escape');
  await other();
  check(await big() && chunks === 1, `opened again, it comes from memory (${chunks} chunk in all)`);
  fs.appendFileSync(BIG, 'the line added later\n');
  check((await big()).includes('the line added later') && chunks === 2, `a file that changed on the server is fetched again (${chunks} chunks in all)`);
  // … also when only its modification time says so (same size)
  fs.writeFileSync(BIG, fs.readFileSync(BIG, 'utf8').replace('the line added later', 'THE LINE ADDED LATER'));
  fs.utimesSync(BIG, new Date(), new Date(Date.now() + 5000));
  check((await big()).includes('THE LINE ADDED LATER') && chunks === 3, `one of the same size but a newer modification time too (${chunks} chunks in all)`);
  // not opened for an hour: dropped the next time a file is opened (no timer), so the open after that fetches it again
  await page.evaluate(() => { const now = Date.now; window.__now = now; Date.now = () => now() + 59 * 60e3; });
  await other();
  await page.evaluate(() => { Date.now = window.__now; });
  check(await big() && chunks === 3, `a file opened 59 minutes ago is still kept (${chunks} chunks in all)`);
  await page.evaluate(() => { const now = window.__now; Date.now = () => now() + 61 * 60e3; });
  await other();
  await page.evaluate(() => { Date.now = window.__now; delete window.__now; });
  check(await big() && chunks === 4, `one not opened for an hour was dropped: it is fetched again (${chunks} chunks in all)`);
  // a folder never opens: ⌘-click does nothing (a plain click still copies its path)
  const dir = page.locator('#big .path-ref', { hasText: 'img' });
  await dir.hover();
  await expectSoon(() => page.locator('#big .path-ref.path-dir').count(), 'a link to a folder is known as one once the server says so', 5000);
  await dir.click({ modifiers: ['Meta'] });
  await wait(300);
  check(await page.locator('.modal').count() === 0, 'a folder reference does not open');
}

// ---- an image: shown in a dialog, zoomed and panned in the frame the diagrams have ----
await page.locator('#refs .path-ref', { hasText: 'dot.png' }).click({ modifiers: ['Control'] });
await expectSoon(() => page.evaluate(() => document.querySelector('.modal img.res-media')?.naturalWidth === 2), 'Ctrl-click on an image shows it in a dialog', 15000);
{
  const view = () => page.evaluate(() => {
    const img = document.querySelector('.modal .res-image img'), m = new DOMMatrix(getComputedStyle(document.querySelector('.modal .res-image .diagram-view')).transform);
    return { s: Math.round(m.a * 1000) / 1000, x: Math.round(m.e), y: Math.round(m.f), pixels: img.classList.contains('pixels'), w: Math.round(img.getBoundingClientRect().width) };
  });
  const frame = page.locator('.modal .res-image .diagram');
  const box = await frame.boundingBox();
  const v0 = await view();
  const card = await frame.evaluate((f) => { const c = getComputedStyle(f); return [c.backgroundColor, c.borderTopWidth].join(' '); });
  check(card === 'rgba(0, 0, 0, 0) 0px', `the image lies on the dialog itself: no card behind it (${card})`);
  const dlg = await page.evaluate(() => { const r = document.querySelector('.modal.media-modal')?.getBoundingClientRect(); return r && [r.width / innerWidth, r.height / innerHeight]; });
  check(v0.s === 1 && !v0.pixels && dlg?.every((f) => f > 0.8) && box.height > 400, `an image opens whole, in a dialog of most of the page with room to zoom (${JSON.stringify(v0)}, ${Math.round(box.width)}×${Math.round(box.height)})`);
  await frame.hover();
  const acts = await page.locator('.modal .res-image .diagram button').evaluateAll((bs) => bs.map((b) => b.dataset.act).join());
  check(acts === 'zoom-in,zoom-out,reset', `its buttons: zoom in, zoom out, reset (${acts})`);
  const zoomIn = page.locator('.modal .res-image [data-act="zoom-in"]');
  await zoomIn.click();
  await page.locator('.modal .res-image [data-act="zoom-out"]').click();
  check((await view()).s === 1, 'Zoom out undoes a Zoom in');
  await zoomIn.click();
  const v1 = await view();
  check(v1.s > 1 && Math.abs(v1.w - v0.w * v1.s) <= 1, `Zoom in enlarges it (${JSON.stringify(v1)})`);
  for (let i = 0; i < 4; i++) await zoomIn.click();
  const v2 = await view();
  check(v2.s > 3 && v2.pixels && await page.evaluate(() => getComputedStyle(document.querySelector('.modal .res-image img')).imageRendering) === 'pixelated', `zoomed far in, its pixels are drawn as squares (${JSON.stringify(v2)})`);
  // (each notch zooms ×1.28 at most: 15 take it from ×3 past the cap)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < 15; i++) await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  const v3 = await expectSoon(async () => { const v = await view(); return v.s === 40 && v; }, 'Ctrl-scroll zooms too, up to 40 times', 3000);
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 130, { steps: 4 });
  await page.mouse.up();
  const v4 = await view();
  check(v4.x - v3.x === 60 && v4.y - v3.y === 30, `dragging pans it (${v4.x - v3.x}, ${v4.y - v3.y})`);
  await page.locator('.modal .res-image [data-act="reset"]').click();
  const v5 = await view();
  check(v5.s === 1 && v5.x === 0 && v5.y === 0 && !v5.pixels, `Reset shows it whole again (${JSON.stringify(v5)})`);
  await page.keyboard.press('Escape');
}
// an SVG gets a data: URL (a blob: one has the page's origin: opened in a tab, its scripts would run there)
fs.writeFileSync(path.join(WORK, 'img', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="3" height="2"><script>parent.pwned=1</script><rect width="3" height="2"/></svg>');
await showMarkdown(page, 'svg', `Logo: [logo.svg](${WORK}/img/logo.svg)`);
await openFile('#svg', 'logo.svg', 'img.res-media');
await expectSoon(() => page.evaluate(() => { const i = document.querySelector('.modal img.res-media'); return !!i && i.src.startsWith('data:image/svg+xml') && i.naturalWidth === 3; }), 'an SVG is shown from a data: URL', 5000);
await page.keyboard.press('Escape');

// ---- a bigger file arrives in 1 MB chunks, the dialog showing how far along it is; closing the dialog doesn't stop it ----
fs.writeFileSync(path.join(WORK, 'clip.bin'), Buffer.alloc(2_600_000, 0)); // not a video (that would be checked and converted): just the chunked download
await showMarkdown(page, 'bin', `Data: [clip.bin](${WORK}/clip.bin)`);
{
  const slow = async (route) => { if (JSON.parse(route.request().postData() || '{}').type === 'readChunk') await wait(300); await route.continue().catch(() => {}); };
  await page.route('**/cmd', slow);
  const before = chunks;
  check(await openFile('#bin', 'clip.bin', '.res-wait .res-bar') && /^loading \d+% · 2\.5 MB$/.test(await page.locator('.modal .res-wait .meta').textContent()), 'while a file loads, its dialog shows how far along it is');
  await page.keyboard.press('Escape');
  await expectSoon(() => chunks - before === 3, 'a 2.6 MB file loads in 3 chunks, also once its dialog is closed');
  await page.unroute('**/cmd', slow);
  check(await openFile('#bin', 'clip.bin', '.modal-body > .meta') && (await page.locator('.modal-body').textContent()).startsWith('Binary file') && chunks - before === 3, 'opened again, it is there');
  await page.keyboard.press('Escape');
}
// a file over the limit for its kind is not fetched
{
  const f = path.join(WORK, 'huge.log');
  fs.closeSync(fs.openSync(f, 'w'));
  fs.truncateSync(f, 17 * 1024 * 1024);
  await showMarkdown(page, 'huge', `Huge: [huge.log](${f})`);
  const before = chunks;
  await page.locator('#huge .path-ref').click({ modifiers: ['Meta'] });
  check(await toast('too big to preview') && await page.locator('.modal').count() === 0 && chunks === before, 'a file over the limit is not fetched: a note says so');
}

// ---- an OpenCV-style MPEG-4 Part 2 video (no browser plays it) is converted on this computer (the local client), not the server ----
let hasFfmpeg = true;
try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '2', '-c:v', 'mpeg4', path.join(WORK, 'mocap.mp4')]); } catch { hasFfmpeg = false; }
if (hasFfmpeg) {
  await showMarkdown(page, 'video', `Result: [mocap.mp4](${WORK}/mocap.mp4)`);
  await page.locator('#video .path-ref').click({ modifiers: ['Meta'] });
  const w = await page.waitForFunction(() => document.querySelector('.modal video')?.videoWidth, null, { timeout: 60000 }).then((h) => h.jsonValue(), () => 0);
  check(converts === 1, 'an MPEG-4 Part 2 video is converted by the local client');
  check(w === 320, 'the converted video plays in its dialog'); // H.264, or VP9 in a browser without H.264
  // frame by frame (an MP4 lists its frames; the test video has 30, 15 a second)
  if (await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '')) {
    const bar = page.locator('.modal .res-frames');
    await bar.waitFor({ timeout: 5000 });
    const state = async () => {
      await page.waitForFunction(() => !document.querySelector('.modal video').seeking, null, { timeout: 5000 });
      return page.evaluate(() => {
        const v = document.querySelector('.modal video'), b = document.querySelector('.modal .res-frames');
        return { n: b.querySelector('input').value, of: b.querySelector('.res-frame-of').textContent, shown: Math.floor(v.currentTime * 15 + 1e-6), paused: v.paused, back: !b.querySelectorAll('button')[0].disabled, on: !b.querySelectorAll('button')[1].disabled };
      });
    };
    const to = async (n) => { await bar.locator('input').fill(String(n)); await bar.locator('input').press('Enter'); return state(); };
    let f = await to(20);
    check(f.of === '/ 29' && f.n === '20' && f.shown === 20 && f.paused, `a frame number typed in goes to that frame, paused (${JSON.stringify(f)})`);
    await bar.locator('button[title="Next frame"]').click();
    f = await state();
    check(f.n === '21' && f.shown === 21, `Next frame steps one frame on (${JSON.stringify(f)})`);
    await bar.locator('button[title="Previous frame"]').click();
    await bar.locator('button[title="Previous frame"]').click();
    f = await state();
    check(f.n === '19' && f.shown === 19, `Previous frame steps back, one frame a click (${JSON.stringify(f)})`);
    f = await to(999);
    check(f.n === '29' && f.shown === 29 && !f.on && f.back, `past the end is the last frame, with no step on from it (${JSON.stringify(f)})`);
    f = await to(0);
    check(f.n === '0' && f.shown === 0 && !f.back && f.on, `0 is the first frame (${JSON.stringify(f)})`);
    await page.evaluate(() => document.querySelector('.modal video').play());
    await expectSoon(() => page.evaluate(() => Number(document.querySelector('.modal .res-frames input').value) >= 5), 'while it plays, the number follows the frame on screen', 5000);
    await page.evaluate(() => document.querySelector('.modal video').pause());
  } else console.log('INFO no H.264 in this browser; the frame bar not tested');
  await page.keyboard.press('Escape');
  // the frames are where the file says, also with reordered (B) frames and an edit list, and the browser shows them there
  let bfile = null;
  try { execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=15', '-t', '2', '-c:v', 'libx264', '-bf', '2', '-pix_fmt', 'yuv420p', path.join(WORK, 'bframes.mp4')]); bfile = fs.readFileSync(path.join(WORK, 'bframes.mp4')).toString('base64'); } catch {}
  if (bfile) {
    const r = await page.evaluate(async (b64) => {
      const { frameTimes } = await import('/ui/frames.js');
      const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'video/mp4' });
      const times = await frameTimes(blob);
      const out = { n: times?.length, off: times ? Math.max(...Array.from(times, (t, i) => Math.abs(t - i / 15))) : null, none: await frameTimes(new Blob(['not a video at all, just some text'])), seen: [] };
      const v = document.createElement('video');
      v.muted = true;
      v.src = URL.createObjectURL(blob);
      if (!v.requestVideoFrameCallback || !times) return out;
      await new Promise((ok) => { v.onloadeddata = ok; v.onerror = ok; });
      await new Promise((ok) => { v.requestVideoFrameCallback(ok); setTimeout(ok, 1000); }); // (the first frame's callback, out of the way)
      for (const i of [1, 0, 14, 28, 29]) { // the frame on screen in the middle of frame i's time
        const got = new Promise((ok) => { v.requestVideoFrameCallback((now, meta) => ok(meta.mediaTime)); setTimeout(() => ok(null), 10000); });
        v.currentTime = i < 29 ? (times[i] + times[i + 1]) / 2 : times[i] + 1 / 30;
        const t = await got;
        out.seen.push(t == null ? null : Math.round((t - times[i]) * 1e4) / 1e4);
      }
      URL.revokeObjectURL(v.src);
      return out;
    }, bfile);
    check(r.n === 30 && r.off < 1e-6 && r.none === null, `an MP4's frame times are read from the file, B-frames and all; a file that is no MP4 has none (${JSON.stringify({ n: r.n, off: r.off, none: r.none })})`);
    check(r.seen.length === 0 || r.seen.every((d) => d === 0), `and the browser shows each frame at the time read for it (${JSON.stringify(r.seen)})`);
  } else console.log('INFO no libx264 in this ffmpeg; B-frame times not tested');
} else console.log('INFO no ffmpeg here; conversion not tested');

await endSuite(S);
