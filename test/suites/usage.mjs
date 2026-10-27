// Plan usage: the usage card, and the usage page (level curves, Daily peek's week and month, Weekly tokens, cost at
// API rates, paging back, the estimate, the sync bar, what it draws before the answers come); hourly sampling; the
// logo's turn. On synthetic history and transcripts. No model.
import fs from 'node:fs';
import { PORT, check, until, wait, startClient, openPage, endSuite, workDir, routeCmd } from '../lib.mjs';
import { usageHistory, costTranscripts, soon } from './_qb.mjs';

const { file: usageFile, fiveResets } = usageHistory(process.env.IRO_DIR);
const cost = costTranscripts();
// (no background round of the client's: one would mix its sync bar with the page's own round)
process.env.IRO_NO_USAGE_SYNC = '1';
// a blank session open (with nothing open, the page shows the usage page by itself)
const WORK = workDir('usage-work');
const { client, cmd: rpc } = await startClient(PORT);
await rpc({ type: 'addFolder', path: WORK }); // (before the page opens: see settings.mjs)
const { browser, page, errors } = await openPage(PORT);
const url = page.url();
await rpc({ type: 'new', cwd: WORK, blank: true });
await page.locator(`.folder[data-dir="${WORK}"] .sess`).first().click({ timeout: 10000 });
await page.locator('#feed').waitFor({ timeout: 5000 });

// ---- the usage card: the server's latest level (the synthetic history's last sample), pushed, not polled ----
await soon(() => page.locator('#sb-7d').textContent(), (t) => /Weekly50%/.test(t), 'the usage card shows the server\'s level');
// under each bar a triangle marks how far the reset window has run (the synthetic week resets in 4 days: 3/7 in)
const tickAt = (id) => page.locator(`${id} .uc-tick`).evaluate((t) => parseFloat(t.style.left), null, { timeout: 1000 }).catch(() => NaN);
const weekTick = await tickAt('#sb-7d'), fiveTick = await tickAt('#sb-5h');
// (the synthetic 5-hour window may have reset since the suite began: then it is empty, and has no triangle)
check(Math.abs(weekTick - 300 / 7) < 0.5 && ((fiveTick >= 0 && fiveTick <= 100) || (Number.isNaN(fiveTick) && Date.now() >= fiveResets)),
  `the usage card marks the time into each window (5h ${fiveTick}%, week ${weekTick}%)`);

// ---- the usage page ----
// Opening it marks the card without moving anything in it (no size or position change, not even half a pixel).
// (found and measured in one look: the card is drawn anew now and then, and a row found a moment before is
// no longer on the page, all zeros)
const cardBoxes = () => page.evaluate(() => {
  const els = [...document.querySelectorAll('#usageBtn, #usageBtn .uc-top, #usageBtn .uc-bar, #usageBtn .uc-tick')];
  return els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].join(','); }).join(' ')
    + ' ' + getComputedStyle(els[0]).borderWidth + ' ' + getComputedStyle(els[0]).boxShadow.replace(/.*inset[^,]*,\s*/, '');
});
// (the triangles move on the page's minute clock: both looks are taken within one minute, else again)
let cardShut, cardOpen;
// (the round of the usage page a fresh page opened by itself is over)
await page.waitForFunction(() => !document.getElementById('usageSync').classList.contains('on'), null, { timeout: 10000 });
for (let i = 0; i < 3; i++) {
  if (Date.now() % 60000 > 58500) await wait(60000 - (Date.now() % 60000) + 300);
  const minute = Math.floor(Date.now() / 60000);
  cardShut = await cardBoxes();
  // (the sync bar beside the page's title, as it changes from here on)
  await page.evaluate(() => {
    const el = document.getElementById('usageSync');
    window.syncSeen = [];
    window.syncOb?.disconnect();
    (window.syncOb = new MutationObserver(() => window.syncSeen.push(`${el.classList.contains('on') ? 'on' : 'off'} ${el.textContent}`))).observe(el, { attributes: true, childList: true, subtree: true });
  });
  await page.click('#usageBtn');
  cardOpen = await cardBoxes();
  if (Math.floor(Date.now() / 60000) === minute) break;
  await page.click('#usageBack');
  await page.waitForFunction(() => !document.getElementById('usageSync').classList.contains('on'), null, { timeout: 10000 });
}
check(cardOpen === cardShut, `opening the usage page does not shift or lift the usage card${cardOpen === cardShut ? '' : ` (${cardShut} | ${cardOpen})`}`);
// (the page is drawn anew as each answer comes, and a chart draws its curve a frame after it is put in: the
// curves are counted in the same look that finds them, as a later one can land between a redraw and that frame)
const curves = () => [...document.querySelectorAll('.usage-page .chart-svg')].map((x) => x.querySelectorAll('path.line').length);
const lines = await page.waitForFunction(`(() => { const c = (${curves})(); return c.length === 2 && c.every((n) => n >= 1) && c; })()`, null, { timeout: 8000 })
  .then((r) => r.jsonValue(), () => page.evaluate(curves));
check(lines.length === 2 && lines[0] >= 1 && lines[1] >= 1, `the usage page is the level curves (${lines})`);
check(await page.locator('#feed').isHidden(), 'it replaces the conversation view');
{ // the sync bar: the round of questions the client puts to the machines for the page (here one, this machine), then gone
  // (as it was when the round ended: the next round can start right after)
  const seen = await page.waitForFunction(() => window.syncSeen.some((s) => s.startsWith('on ')) && window.syncSeen.at(-1).startsWith('off ') && [...window.syncSeen], null, { timeout: 8000 })
    .then((r) => r.jsonValue(), () => page.evaluate(() => window.syncSeen));
  // (how far: by how much of the answers has arrived, so the level only ever rises within a round: the page's
  // round, from its 0% for as long as the bar shows it)
  const first = seen.indexOf('on Reading the usage samples…0%');
  let last = first;
  while (first >= 0 && seen[last + 1]?.startsWith('on Reading the usage samples…')) last++;
  const levels = first < 0 ? [] : seen.slice(first, last + 1).map((s) => parseInt(s.split('…')[1], 10));
  check(levels.length && levels.at(-1) === 100 && levels.every((v, i) => !i || v >= levels[i - 1]) && seen.at(-1).startsWith('off '),
    `the usage page shows the client reading the machines' samples, as far as they have arrived, and then no more (${seen.join(' | ')})`);
  const bar = page.locator('#usageSync');
  await soon(() => bar.evaluate((el) => getComputedStyle(el).opacity === '0' && !el.title && el.querySelector('.uc-fill').style.width === '100%'), (v) => v, 'a finished round fades, with its bar full');
}
check(await page.evaluate(() => { const v = document.getElementById('usageView'); return v.scrollHeight <= v.clientHeight + 1; }), 'the usage page fits without scrolling');

{ // beside the charts: Daily peek, the week by half hour, a strip per day (each from 04:00), tinted by what it cost at API rates; under a day, what it added to the weekly limit and what it cost
  const wk = () => page.locator('.week-sec').evaluate((s) => {
    const r = s.getBoundingClientRect(), c = document.querySelector('.usage-charts').getBoundingClientRect();
    return { cols: s.querySelectorAll('.week-col').length, cells: s.querySelectorAll('.week-cell').length, used: s.querySelectorAll('.week-cell:not(.none):not(.b0)').length,
      days: s.querySelectorAll('.week-day').length, today: s.querySelectorAll('.week-day.today').length, now: s.querySelectorAll('.week-now').length,
      hour: s.querySelector('.week-hour span').textContent, beside: r.left >= c.right && Math.abs(r.top - c.top) < 1 && Math.abs(r.height - c.height) < 1 };
  });
  const priced = (await rpc({ type: 'usageCost' })).data || [];
  const sum = priced.reduce((n, x) => n + x[1], 0);
  check(Math.abs(sum - cost.answers * 2.004 - cost.other) < 1e-6, `the cost is each answer's tokens at its model's prices (Sonnet 5.5's cache reads, Haiku 5.5's long prompts), an answer counted once (${sum} for ${cost.answers} answers and ${cost.other})`);
  const toks = priced.reduce((n, x) => n.map((v, i) => v + (x[i + 2] || 0)), [0, 0, 0]);
  check(toks[0] === cost.answers * 1000 + 1e5 && toks[1] === cost.answers * 1.1e6 + 1.1e6 && toks[2] === cost.answers * 5e4 + 2e6,
    `and its tokens: the input not cached, the cache read and written, the output, an answer counted once (${toks})`);
  await page.locator('.week-cell:not(.none)').first().waitFor({ timeout: 5000 }); // (the cost comes after the charts)
  const cur = await wk();
  check(cur.cols === 7 && cur.days === 7 && cur.cells === 336 && cur.hour === '04:00', `the week grid has 7 days of 48 half hours, from 04:00 (${JSON.stringify(cur)})`);
  check(cur.beside, 'it stands beside the two charts, as tall as both');
  // the user's call: a day is one unbroken strip, its bands touching (no grid of separate cells), only the strip with corners
  const strip = await page.locator('.week-strip').first().evaluate((x) => {
    const c = [...x.children].map((e) => e.getBoundingClientRect());
    return { n: c.length, gaps: c.slice(1).filter((r, i) => Math.abs(r.top - c[i].bottom) > 0.01).length, corners: getComputedStyle(x.children[5]).borderRadius, round: parseFloat(getComputedStyle(x).borderRadius), shadows: [...x.children].filter((e) => getComputedStyle(e).boxShadow !== 'none').length };
  });
  check(strip.n === 48 && strip.gaps === 0 && strip.corners === '0px' && strip.round > 0 && strip.shadows === 0, `each day is one unbroken strip, not separate cells (${JSON.stringify(strip)})`);
  const blank = await page.locator('.week-sec').evaluate((s) => {
    const bg = (e) => getComputedStyle(e).backgroundColor;
    const none = s.querySelector('.week-cell.none'); // (none in the week's last half hour: nothing is still to come)
    return { strip: bg(s.querySelector('.week-strip')), none: none ? bg(none) : null, zero: bg(s.querySelector('.week-ramp .b0')) };
  });
  check(blank.strip === blank.zero && (blank.none === null || blank.none === 'rgba(0, 0, 0, 0)'), `a half hour without a sample looks the same as one that used nothing (${JSON.stringify(blank)})`);
  check((await page.locator('.week-sec h3').textContent()) === 'Daily peek' && (await page.locator('.week-read').textContent()) === '', 'titled Daily peek, with nothing read out until a half hour is pointed at');
  check(cur.today === 1 && cur.now === 1, 'this week marks today and the time now');
  check(!(await page.locator('.week-sec .chart-nav button').nth(1).isEnabled()), 'there is no week after this one');
  // the synthetic 3 days may reach into the week before (always, early in a week)
  const before = page.locator('.week-sec .chart-nav button').first();
  let used = cur.used, back = false;
  if (await before.isEnabled()) {
    const range = await page.locator('.week-sec .chart-range').textContent();
    await before.click();
    back = true;
    const prev = await wk();
    check((await page.locator('.week-sec .chart-range').textContent()) !== range && prev.cells === 336 && prev.today === 0 && prev.now === 0, 'the arrow shows the week before, with no "now" in it');
    used += prev.used;
    if (!prev.used || cur.used > prev.used) { await page.locator('.week-sec .chart-nav button').nth(1).click(); back = false; }
  }
  check(used > 100, `the half hours the samples rose in are tinted (${used})`);
  const sums = await page.locator('.week-sum b').allTextContents();
  const pts = sums.filter((x) => x !== '—').map(Number);
  check(pts.length >= 1 && pts.every((n) => n > 0 && n <= 40) && sums.some((x) => /^\+\d/.test(x)), `under a day: the points it added to the weekly limit, not to the 5-hour window (${sums})`);
  const costs = await page.locator('.week-sum span:first-of-type').allTextContents();
  check(costs.some((x) => /^\$\d/.test(x)) && costs.every((x) => x === '—' || /^\$\d/.test(x)), `and what it cost (${costs})`);
  await page.locator('.week-cell:not(.none):not(.b0)').first().hover();
  const read = await page.locator('.week-read').textContent();
  check(/\d\d:\d\d–\d\d:\d\d · \$\d+\.\d\d$/.test(read), `hovering a half hour reads its time and what it cost (${read})`);
  const lifted = await page.locator('.week-sec').evaluate((s) => { const l = s.querySelector('.week-lift'), c = s.querySelector('.week-cell.on'); return l && { shadow: getComputedStyle(l).boxShadow, same: getComputedStyle(l).backgroundColor === getComputedStyle(c).backgroundColor, inCol: l.parentElement === c.closest('.week-col') }; });
  check(lifted && lifted.same && lifted.inCol && lifted.shadow !== 'none', `the half hour pointed at is lifted out of its strip, with a shadow (${JSON.stringify(lifted)})`);
  // right of the days, the week as a whole: a smooth curve of each half hour's cost over the week, and the week's totals
  const tot = await page.locator('.week-sec').evaluate((s) => ({ rows: s.querySelectorAll('.week-tot .week-bar').length, curve: s.querySelector('.week-curve path.line')?.getAttribute('d') || '',
    lines: [...s.querySelector('.week-tot-sum').children].map((c) => c.textContent) }));
  const dayPts = pts.reduce((n, x) => n + x, 0);
  check(tot.rows === 48 && / C/.test(tot.curve) && tot.lines.length === 3 && Math.abs(Number(tot.lines[0]) - dayPts) < 0.5 && /^\$\d/.test(tot.lines[1]) && /h$/.test(tot.lines[2]),
    `the week column: a curve over 48 half hours, and the week's totals (points, cost, hours) only (${JSON.stringify({ ...tot, curve: tot.curve.slice(0, 40) })})`);
  await page.locator('.week-bar').nth(40).hover();
  const readTot = await page.locator('.week-read').textContent();
  check(await page.locator('.week-dot').isVisible() && /^The week · \d\d:\d\d–\d\d:\d\d · \$\d+(\.\d+)? · on \d days?$/.test(readTot), `pointing at the curve marks it with a dot and reads that half hour over the week (${readTot})`);
  if (back) await page.locator('.week-sec .chart-nav button').nth(1).click();
  await page.mouse.move(5, 5);
  // Week / Month at its foot: the month, a strip a day on the same scale, paged by month; a day's totals read out with its half hours
  const views = page.locator('.week-sec .seg button');
  check(JSON.stringify(await views.allTextContents()) === '["Week","Month"]' && await page.locator('.week-sec .seg button.active').textContent() === 'Week', 'Daily peek opens on the week, with Week / Month at its foot');
  await views.nth(1).click();
  const mon = await wk(), nDays = await page.evaluate(() => { const d = new Date(Date.now() - 4 * 3600e3); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); });
  const mRange = await page.locator('.week-sec .chart-range').textContent();
  const mFoot = await page.locator('.week-sec').evaluate((s) => ({ sums: s.querySelectorAll('.week-sum').length, tot: s.querySelector('.week-tot-sum').children.length, month: s.classList.contains('month'), labels: s.querySelectorAll('.week-day b').length }));
  check(mon.cols === nDays && mon.cells === nDays * 48 && mon.today === 1 && mon.now === 1 && new RegExp(`^\\w+ 1 – ${nDays}$`).test(mRange) && mFoot.month && !mFoot.sums && mFoot.tot === 3 && mFoot.labels >= 1 && mFoot.labels <= 7,
    `Month shows this month, a strip a day, the dates over a few of them, and the month's totals only (${JSON.stringify({ ...mon, range: mRange, ...mFoot })})`);
  let mUsed = mon.used, mBack = false;
  if (mon.used < used) { await page.locator('.week-sec .chart-nav button').first().click(); mBack = true; mUsed += (await wk()).used; } // (early in a month: the synthetic days reach into the one before)
  check(mUsed === used, `the month tints the same half hours as the weeks (${mUsed} vs ${used})`);
  await page.locator('.week-cell:not(.none):not(.b0)').first().hover();
  const mRead = await page.locator('.week-read').textContent();
  check(/\d\d:\d\d–\d\d:\d\d · \$\d+\.\d\d · day (\+\S+ )?\$\S+ \S+h$/.test(mRead), `pointing at a half hour in a month reads its day's totals too (${mRead})`);
  if (mBack) await page.locator('.week-sec .chart-nav button').nth(1).click();
  await page.mouse.move(5, 5);
  await views.first().click();
  check((await wk()).cols === 7 && await page.locator('.week-sec .seg button.active').textContent() === 'Week', 'and Week brings the week back');
}

{ // under the two charts: Weekly tokens, a pair of bars a day (the input with its cache at the foot, and the output beside it)
  const tk = () => page.locator('.tok-sec').evaluate((s) => ({ title: s.querySelector('h3').textContent, keys: s.querySelector('.tok-keys').textContent, names: s.querySelectorAll('.tok-name').length,
    days: s.querySelectorAll('.tok-day').length, ins: s.querySelectorAll('.tok-day .k-in').length, caches: s.querySelectorAll('.tok-day .k-cache').length, outs: s.querySelectorAll('.tok-day .k-out').length,
    scales: [s.querySelectorAll('.tick.k-in-t').length, s.querySelectorAll('.tick.k-out-t').length] }));
  let t = await tk(), back = false;
  if (!t.days) { // (early on a Sunday: the work is all in the week before)
    await page.locator('.tok-sec .chart-nav button').first().click();
    back = true;
    await page.waitForFunction(() => document.querySelectorAll('.tok-sec .tok-name').length === 7, null, { timeout: 3000 });
    t = await tk();
  }
  check(t.title === 'Weekly tokens' && /input.*cache.*output/.test(t.keys) && t.names === 7 && t.days >= 1 && t.ins === t.days && t.caches === t.days && t.outs === t.days && t.scales.join() === '3,3', `Weekly tokens: a pair of bars for each day with work, the input's scale on the left and the output's on the right (${JSON.stringify(t)})`);
  await page.locator('.tok-day .hit').first().hover();
  const on = await page.locator('.tok-sec').evaluate((s) => ({ on: s.querySelectorAll('.tok-day.on').length, tip: s.querySelector('.tok-tip').hidden ? '' : s.querySelector('.tok-tip').textContent }));
  // (the shadow fades in)
  const shadow = await soon(() => page.locator('.tok-day.on .tok-shadow').evaluate((x) => {
    const cut = document.querySelector(x.getAttribute('clip-path').slice(4, -1) + ' rect'), axis = x.closest('svg').querySelector('.axis');
    return { opacity: getComputedStyle(x).opacity, blurred: !!document.querySelector(x.getAttribute('filter').slice(4, -1) + ' feGaussianBlur'), cutAt: +cut.getAttribute('height'), axis: +axis.getAttribute('y1') };
  }, null, { timeout: 1000 }), (s) => s.opacity === '1' && s.blurred && s.cutAt === s.axis && on.on === 1 && /tokens/.test(on.tip) && /input.*cache.*%.*output/.test(on.tip),
  `pointing at a day shadows its pair (none under it: cut off at the axis) and reads its tokens (${JSON.stringify(on)})`, 3000);
  await page.mouse.move(5, 5);
  check(await page.locator('.tok-tip').isHidden() && await page.locator('.tok-day.on').count() === 0, 'and both go when the pointer leaves');
  if (back) await page.locator('.tok-sec .chart-nav button').nth(1).click();
}

{ // opened, the page draws at once from what the client has on file, then the fresh samples and cost over it as they come
  const onFile = await rpc({ type: 'usageHistory', days: 35, cached: true }), fresh = await rpc({ type: 'usageHistory', days: 35 });
  const costOnFile = await rpc({ type: 'usageCost', days: 35, cached: true });
  check(onFile.data?.length > 100 && onFile.data.length === fresh.data?.length && costOnFile.data?.length > 100,
    `the client answers from what it has on file when asked to (${onFile.data?.length} samples of ${fresh.data?.length}, ${costOnFile.data?.length} half hours of cost)`);
  // every answer held back, the client's on file too: the page draws what this browser drew last, at once
  let release;
  const held = new Promise((r) => { release = r; });
  const unroute = await routeCmd(page, ['usageHistory', 'usageForecast', 'usageCost'], async (route) => { await held; await route.continue().catch(() => {}); }); // (one let go as the route is taken away is sent on anyway)
  await page.click('#usageBack');
  // (the week's token bars may be none yet: early on a Sunday the work is all in the week before)
  const drawn = () => document.querySelectorAll('.usage-page .chart-svg path.line').length >= 2 && document.querySelectorAll('.tok-sec .tok-name').length === 7 && !!document.querySelector('.week-sec .week-curve');
  // (timed in the page, from the click to the first frame it is drawn in: not the test's round trips; the page
  // left behind is still in the DOM, so the first look is a frame after the click has drawn the new one)
  await page.evaluate(`(() => {
    const drawn = ${drawn};
    window.drawnIn = null;
    document.getElementById('usageBtn').addEventListener('click', () => {
      const t0 = performance.now();
      const look = () => { if (drawn()) window.drawnIn = Math.round(performance.now() - t0); else requestAnimationFrame(look); };
      requestAnimationFrame(look);
    }, { capture: true, once: true });
  })()`);
  await page.click('#usageBtn');
  const ms = await page.waitForFunction(() => window.drawnIn != null && [window.drawnIn], null, { timeout: 3000 }).then(async (r) => (await r.jsonValue())[0], () => NaN);
  check(ms < 1500, `it is drawn from what this browser drew last while the answers are still out (${ms} ms)`);
  const answers = Promise.all(['usageHistory', 'usageForecast'].map((type) => page.waitForResponse((r) => r.url().endsWith('/cmd') && !!r.request().postData()?.startsWith(`{"type":"${type}"`), { timeout: 5000 })));
  release();
  await answers;
  await unroute();
  check(await page.waitForFunction(drawn, null, { timeout: 3000 }).then(() => true, () => false), 'and the fresh ones drawn over it keep the charts');
  // a fresh page opens the usage page by itself, before it is connected: it is drawn once it is
  const p3 = await page.context().newPage();
  await p3.goto(url);
  // (a redraw with fresher data can land at any moment, and its curves come a frame later: they are counted in
  // the same look that finds them)
  const p3Lines = await p3.waitForFunction(() => { const n = document.querySelectorAll('.usage-page .chart-svg path.line').length; return n >= 2 && n; }, null, { timeout: 8000 })
    .then((r) => r.jsonValue(), () => 0);
  check(p3Lines >= 2, 'a fresh page opens the usage page by itself, drawn once connected');
  await p3.close();
}

{ // a line joins samples one sampling step apart, and the step is the samples' own: the history is the account's,
  // and another of its machines may sample every hour while this server's setting says every 30 minutes
  const runs = await page.evaluate(async () => {
    const { usagePage } = await import('/ui/usage.js');
    const H = 3600e3, end = Math.floor(Date.now() / H) * H, resets = new Date(end + 30 * H).toISOString();
    // The weekly chart's lines (one per run of samples) for samples taken these many hours ago, on a page of a 30-minute server.
    const lines = async (hoursAgo) => {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:800px;display:flex;flex-direction:column;visibility:hidden';
      box.append(usagePage(hoursAgo.map((h) => ({ t: end - h * H, five: null, week: { pct: 60 - h, resets } })), { interval: 30 }));
      document.body.append(box);
      for (let i = 0; i < 40 && box.querySelectorAll('.chart-svg').length < 2; i++) await new Promise((r) => setTimeout(r, 50)); // (drawn once its box is measured)
      const n = box.querySelectorAll('.chart-sec')[1].querySelectorAll('path.line').length;
      box.remove();
      return n;
    };
    return {
      hourly: await lines([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]),
      asleep: await lines([10, 9, 8, 7, 3, 2, 1, 0]), // (nothing for 4 hours)
      missed: await lines([5, 4.5, 4, 3.5, 2.5, 2, 1.5, 1]), // (every half hour, but for the slot 3 hours ago)
      slower: await lines([5, 4.5, 4, 3.5, 3, 2, 1, 0]), // (every half hour, then every hour)
    };
  });
  check(runs.hourly === 1 && runs.slower === 1, `samples an hour apart make one line on the page of a server that samples every 30 minutes (${JSON.stringify(runs)})`);
  check(runs.asleep === 2 && runs.missed === 2, `and a line still breaks where samples are missing (${JSON.stringify(runs)})`);
}
{ // the half hour still running is drawn with what it has cost so far, not left bare until it ends; before the cost is known the week is bare
  const running = await page.evaluate(async () => {
    const { usagePage } = await import('/ui/usage.js');
    const now = Date.now(), tinted = (cost) => usagePage([], { cost }).querySelectorAll('.week-cell:not(.none):not(.b0)').length;
    return { unknown: usagePage([], {}).querySelectorAll('.week-cell:not(.none)').length, none: tinted([]), now: tinted([[Math.floor(now / 300e3) * 300e3, 3]]) };
  });
  check(running.unknown === 0 && running.none === 0 && running.now === 1, `the running half hour shows what it has cost so far (${JSON.stringify(running)})`);
}
{ // each chart pages back too: the 5-hour one 48 hours at a time, the weekly one a reset cycle at a time, the tokens a week at a time
  const navs = page.locator('.usage-charts .chart-nav');
  check(await navs.count() === 3 && !(await navs.nth(0).locator('button').nth(1).isEnabled()) && !(await navs.nth(1).locator('button').nth(1).isEnabled()) && !(await navs.nth(2).locator('button').nth(1).isEnabled()), 'each chart has ‹ range ›, with nothing after the latest');
  const range = await navs.nth(0).locator('.chart-range').textContent();
  await navs.nth(0).locator('button').first().click();
  const fiveLines = page.locator('.usage-charts .chart-sec').first().locator('.chart-svg path.line');
  await soon(async () => ({ range: await navs.nth(0).locator('.chart-range').textContent(), lines: await fiveLines.count(), charts: await page.locator('.usage-page .chart-svg').count() }),
    (v) => v.range !== range && v.lines >= 1 && v.charts === 2, '‹ on the 5-hour chart shows the 48 hours before'); // (a chart is drawn once its box is measured)
  await navs.nth(0).locator('button').nth(1).click();
  check((await navs.nth(0).locator('.chart-range').textContent()) === range, '› comes back to the latest');
  await fiveLines.first().waitFor({ timeout: 3000 });
  // (the synthetic history has one weekly cycle: nothing before it)
  check(!(await navs.nth(1).locator('button').first().isEnabled()), 'the weekly chart has no cycle before the only one on file');
  await page.mouse.move(5, 5);
}
// (polled, the pointer moved there again each time, a pixel apart: a redraw with fresher data can land in between)
let tries = 0;
check(await until(async () => {
  const box = await page.locator('.usage-page .chart-svg').nth(1).boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width * 0.35 + (tries++ % 2), box.y + box.height * 0.5); // the cycle's past (the right part is still to come)
  return /\d+%/.test(await page.locator('.chart-tip').nth(1).textContent().catch(() => '')) && await page.locator('.chart-tip').nth(1).isVisible();
}, 3000), 'hovering the curve shows the level');
{ // no dashed bridges over gaps (the area still spans them); the estimate is the dashed line and runs on backwards
  const d = await page.locator('.usage-page .chart-svg').nth(1).evaluate((x) => {
    const p = x.querySelector('path.proj');
    const pts = p ? p.getAttribute('d').match(/-?[\d.]+,-?[\d.]+/g).map((q) => q.split(',').map(Number)) : [];
    const last = [...x.querySelectorAll('path.line')].at(-1).getAttribute('d').match(/-?[\d.]+,-?[\d.]+/g).at(-1).split(',').map(Number);
    const axis = parseFloat(x.querySelector('line.axis').getAttribute('y1')), left = parseFloat(x.querySelector('line.axis').getAttribute('x1'));
    return { bridges: x.querySelectorAll('path.bridge').length, n: pts.length, first: pts[0], last, axis, left };
  });
  check(d.bridges === 0, 'the curve has no dashed bridges');
  check(d.n >= 2 && d.first[0] < d.last[0] && (Math.abs(d.first[0] - d.left) < 1.5 || Math.abs(d.first[1] - d.axis) < 1.5), `the estimate extends backwards to the start of the cycle or to zero (${JSON.stringify(d)})`);
}
{ // the estimate runs through the level now and the level 24 hours before
  const xs = fs.readFileSync(usageFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = xs.at(-1), prior = xs.find((x) => x.t === last.t - 24 * 3600e3);
  const f = (await rpc({ type: 'usageForecast' })).data?.week;
  const want = prior ? (last.week.pct - prior.week.pct) / 24 : NaN;
  check(f && Math.abs(f.slopePerHour - want) < 1e-6, `the estimate's slope is the last 24 hours' rise (${f?.slopePerHour} vs ${want} per hour)`);
  check(await page.locator('.usage-page .chart-svg').nth(1).locator('line.now').count() === 0, 'no vertical "now" line on the weekly chart');
}
await page.click('#usageBack');
check(await page.locator('#feed').isVisible(), 'Back returns to the session');

{ // sampled every hour (Settings), the usage page follows: Daily peek has one band per hour of the week
  await rpc({ type: 'setSettings', usageInterval: 60 });
  await page.click('#usageBtn');
  await soon(() => page.locator('.usage-page .week-cell').count(), (n) => n === 168, 'with hourly samples Daily peek has 168 bands');
  await page.click('#usageBack');
  // a fresh page may draw the usage page before the settings arrive (a server over ssh answers in the order
  // asked, the settings last): it must not stay on half hours
  const p2 = await page.context().newPage();
  let release;
  const held = new Promise((r) => { release = r; });
  await routeCmd(p2, 'getSettings', async (route) => { await held; await route.continue(); });
  await p2.goto(url);
  if (await p2.locator('#usageView').isHidden()) await p2.click('#usageBtn');
  await p2.waitForFunction(() => document.querySelectorAll('.usage-page .week-cell').length === 336, null, { timeout: 8000 }); // (drawn by half hours meanwhile)
  release();
  await soon(() => p2.locator('.usage-page .week-cell').count(), (n) => n === 168, 'and by hours once they do');
  await p2.close();
  await rpc({ type: 'setSettings', usageInterval: 30 });
}

{ // the logo turns: once when the sidebar's name is clicked; and while the usage page has nothing to draw, large in
  // its middle and in the sidebar. Data that comes mid-turn waits for the turn to end: it never stops half way.
  // (on a page whose clock the test moves: a turn takes 4 s of it, and none of the test's)
  const lctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await lctx.clock.install();
  const lp = await lctx.newPage();
  lp.on('pageerror', (e) => errors.push(e.message));
  lp.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await lp.goto(url);
  await lp.locator('#conn .dot.up').waitFor({ timeout: 10000 });
  await lp.locator('#usageView').waitFor({ timeout: 10000 }); // (a fresh page opens on the usage page: back to an empty one)
  await lp.click('#usageBack');
  await lp.waitForFunction(() => !document.getElementById('usageSync').classList.contains('on'), null, { timeout: 10000 });
  await lp.evaluate(() => localStorage.removeItem('iro-usage-page')); // (nothing this browser drew before)
  await lp.clock.pauseAt(await lp.evaluate(() => Date.now() + 100));
  const brand = () => lp.evaluate(() => [...document.querySelectorAll('.brand-logo svg > path')].map((p) => p.getAttribute('d')).join());
  // at rest: a turn under way (connecting) has ended, and nothing moves for a second
  await lp.clock.fastForward(4100);
  const still = await brand();
  await lp.clock.fastForward(1000);
  const atRest = still === await brand();
  const name = lp.locator('.brand-name');
  const box = await name.boundingBox();
  await name.click({ position: { x: box.width - 12, y: box.height / 2 } }); // (on the name, past the logo)
  await lp.clock.fastForward(600);
  const turned = await brand() !== still;
  check(atRest && turned && await name.evaluate((el) => getComputedStyle(el).userSelect) === 'none',
    'a click on the name in the sidebar turns the logo, and the name is not text to select');
  await lp.clock.fastForward(3500); // (that turn ends)
  let release;
  const held = new Promise((r) => (release = r));
  await routeCmd(lp, ['usageHistory', 'usageForecast'], async (route) => { await held; await route.fallback(); });
  // (timed in the page's clock, from the logo turning in its middle to the page drawn)
  await lp.evaluate(() => {
    const t = window.turnTimes = {};
    const ob = new MutationObserver(() => {
      if (!t.wait && document.querySelector('#usageBody .usage-wait svg')) t.wait = performance.now();
      if (t.wait && document.querySelector('#usageBody .usage-page')) { t.drawn = performance.now(); ob.disconnect(); }
    });
    ob.observe(document.getElementById('usageBody'), { childList: true, subtree: true });
  });
  await lp.click('#usageBtn');
  await lp.clock.fastForward(1200);
  // the answers come 1.2 s into the turn, and are in the page before its clock moves on
  const answers = Promise.all(['usageHistory', 'usageForecast'].map((type) => lp.waitForResponse((r) => r.url().endsWith('/cmd') && r.request().postData()?.startsWith(`{"type":"${type}"`) && !r.request().postData().includes('"cached"'), { timeout: 5000 })));
  release();
  await answers;
  for (let i = 0; i < 5; i++) await lp.evaluate(() => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); }));
  await lp.clock.fastForward(2600);
  const mid = await lp.evaluate(() => ({ wait: !!document.querySelector('#usageBody .usage-wait svg'), drawn: !!document.querySelector('.usage-page') }));
  await lp.clock.runFor(300); // (frame by frame over the turn's end)
  const end = await lp.evaluate(() => ({ drawn: !!document.querySelector('.usage-page'), ms: Math.round(window.turnTimes.drawn - window.turnTimes.wait) }));
  check(mid.wait && !mid.drawn && end.drawn && end.ms >= 3950 && end.ms <= 4100,
    `the usage page with nothing to draw: the logo turns in its middle, and the data that came mid-turn is drawn when the turn ends (${JSON.stringify({ mid, end })})`);
  // (the sidebar's turns too while the page's sync bar runs: it stands still on itself once that is over)
  await lp.waitForFunction(() => !document.getElementById('usageSync').classList.contains('on'), null, { timeout: 10000 });
  await lp.clock.fastForward(4100);
  const stopped = await brand();
  await lp.clock.fastForward(1000);
  check(stopped === still && await brand() === still, 'and the sidebar\'s logo then stops on itself');
  await lctx.close();
}

await endSuite({ browser, client, errors });
