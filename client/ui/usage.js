// Usage Analysis, from the samples the daemon takes on a clock (every 30 minutes unless Settings says
// otherwise). Two views, one toggle:
//   total – the level of each limit over time (the number the status line shows; the default);
//   delta – how much of the 5-hour window each hour used, and of the weekly limit each sampling step
//           (half an hour, or the interval when that is longer).
// The weekly chart spans one reset cycle (last reset on the left, next on the right) and carries the
// server's estimate of the rest of the cycle as a dashed line, which is the only dashed line on the
// curve: it runs on backwards (same slope) to where it meets zero or the start of the cycle.
// The charts take whatever height the page leaves them, so the whole page fits without scrolling.
// Beside them, the week by half hour ("Daily peek"): a strip per day, tinted by how much each half hour used.
// Each of the three has ‹ › beside its title, to page back through the history the server keeps.
import { h } from './render.js';

const HOUR = 3600 * 1000;
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// Two samples belong to the same window when their reset times agree (to within 2 minutes).
const sameWindow = (a, b) => a?.resets && b?.resets && Math.abs(new Date(a.resets) - new Date(b.resets)) < 2 * 60 * 1000;

// Percentage points used in each bucket: the rise between consecutive samples, or, right after a
// window reset, everything used since the reset. `ending`: a sample counts in the bucket it closes
// (the rise it reports came before it) instead of the one it opens.
function buckets(samples, key, size, count, now, from, ending = false) {
  const start = from ?? Math.ceil(now / size) * size - size * count;
  const out = Array.from({ length: count }, (_, i) => ({ from: start + i * size, to: start + (i + 1) * size, used: 0, last: null, n: 0 }));
  let prev = null;
  for (const x of samples) {
    const cur = x[key];
    if (!cur || cur.pct == null) continue;
    if (prev && x.t >= start) {
      const used = sameWindow(prev, cur) ? Math.max(0, cur.pct - prev.pct) : cur.pct;
      const b = out[ending ? Math.ceil((x.t - start) / size) - 1 : Math.floor((x.t - start) / size)];
      if (b) { b.used += used; b.last = cur.pct; b.n++; }
    }
    prev = cur;
  }
  return out;
}

const niceMax = (v) => { for (const m of [1, 2, 5, 10, 20, 25, 50, 100]) if (v <= m) return m; return Math.ceil(v / 50) * 50; };
const two = (n) => String(n).padStart(2, '0');
const hhmm = (t) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const isMidnight = (t) => { const d = new Date(t); return !d.getHours() && !d.getMinutes(); }; // day names go under 00:00 only
const day = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const wd = (t) => new Date(t).toLocaleDateString([], { weekday: 'short' });
const md = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const days = (a, b) => `${md(a)} – ${new Date(a).getMonth() === new Date(b).getMonth() ? new Date(b).getDate() : md(b)}`; // "Oct 4 – 10"
const pctText = (p) => `${Math.round(p)}%`; // readings can carry float noise (56.00000000000001)

// A chart drawn at its box's pixel size (so text never scales), redrawn when the box resizes.
function fitted(draw) {
  const wrap = h('div', 'chart');
  let size = '';
  new ResizeObserver(() => {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H || size === `${W}x${H}`) return;
    size = `${W}x${H}`;
    wrap.replaceChildren(...draw(wrap, W, H));
  }).observe(wrap);
  return wrap;
}

const barChart = (data, opts) => fitted((wrap, W, H) => drawBars(wrap, W, H, data, opts));
// A label anchored at the right edge of the x axis (the weekly cycle's reset); regular ticks keep clear of it.
const END_GAP = 110;
function endTick(s, W, H, R, B, text) {
  const t = svg('text', { x: W - R, y: H - B + 14, class: 'tick', 'text-anchor': 'end' });
  t.textContent = text;
  s.append(t);
}
function drawBars(wrap, W, H, data, { unitLabel, labelEvery, tooltip, tickLabel, endLabel }) {
  const unit = data.length > 1 ? data[1].from - data[0].from : HOUR; // one bar's time
  const L = 40, R = 8, T = 22, B = 34;
  const max = niceMax(Math.max(1, ...data.map((d) => d.used)));
  const plotW = W - L - R, plotH = H - T - B;
  const step = plotW / data.length;
  const bw = Math.max(2, step - 2); // 2px gap between bars
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', role: 'img', 'aria-label': unitLabel });
  // recessive grid + y labels
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, y = T + plotH - (v / max) * plotH;
    s.append(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: i ? 'grid' : 'axis' }));
    const t = svg('text', { x: L - 6, y: y + 3, class: 'tick', 'text-anchor': 'end' });
    t.textContent = `${+v.toFixed(1)}`;
    s.append(t);
  }
  const yl = svg('text', { x: 0, y: 10, class: 'tick', 'text-anchor': 'start' });
  yl.textContent = '% pts';
  s.append(yl);
  let lastDay = '';
  data.forEach((d, i) => {
    const x = L + i * step + (step - bw) / 2;
    const hgt = (d.used / max) * plotH;
    const y = T + plotH - hgt;
    if (d.used > 0) {
      const r = Math.min(4, bw / 2, hgt); // rounded data end, anchored to the baseline
      s.append(svg('path', {
        class: 'bar',
        d: `M${x},${T + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${T + plotH} Z`,
      }));
    }
    const hit = svg('rect', { x: L + i * step, y: T, width: step, height: plotH, class: 'hit' });
    hit.addEventListener('mouseenter', (ev) => show(ev, d, i));
    hit.addEventListener('mousemove', (ev) => show(ev, d, i));
    hit.addEventListener('mouseleave', hide);
    s.append(hit);
    // Clock-time labels fall on the local clock (every 6 hours: 00, 06, 12, 18), so midnight gets its day.
    if ((tickLabel ? i % labelEvery === 0 : onClock(d.from, labelEvery * unit)) && !(endLabel && L + i * step + step / 2 > W - R - END_GAP)) {
      const t = svg('text', { x: L + i * step + step / 2, y: H - B + 14, class: 'tick', 'text-anchor': tickLabel && !i ? 'start' : 'middle' });
      t.textContent = tickLabel ? tickLabel(d.from, i === 0) : hhmm(d.from);
      s.append(t);
      if (!tickLabel && day(d.from) !== lastDay && isMidnight(d.from)) {
        lastDay = day(d.from);
        const t2 = svg('text', { x: L + i * step + step / 2, y: H - B + 27, class: 'tick day', 'text-anchor': 'middle' });
        t2.textContent = day(d.from);
        s.append(t2);
      }
    }
  });
  if (endLabel) endTick(s, W, H, R, B, endLabel);
  const tip = h('div', 'chart-tip');
  tip.hidden = true;
  let marker = null;
  function show(ev, d, i) {
    tip.innerHTML = '';
    tip.append(...tooltip(d));
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    tip.style.left = `${Math.min(ev.clientX - r.left + 12, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${ev.clientY - r.top - tip.offsetHeight - 10}px`;
    marker?.remove();
    marker = svg('rect', { x: L + i * step, y: T, width: step, height: plotH, class: 'hover-band' });
    s.insertBefore(marker, s.firstChild);
  }
  function hide() { tip.hidden = true; marker?.remove(); marker = null; }
  return [s, tip];
}

// The level of a limit over time: a 2px line (with a faint area under it), broken where samples
// are missing; hovering shows the nearest sample.
// Milliseconds on the local clock (so a time zone of +5:30 lines up as well), and whether `t` falls
// on a multiple of `every` there.
const localMs = (t) => t - new Date(t).getTimezoneOffset() * 60000;
const onClock = (t, every) => localMs(t) % every === 0;

const lineChart = (points, opts) => fitted((wrap, W, H) => drawLine(wrap, W, H, points, opts));
function drawLine(wrap, W, H, points, { start, end, tickEvery, label, tooltip, tickLabel, endLabel, proj, every }) {
  const L = 40, R = 8, T = 22, B = 34;
  const plotW = W - L - R, plotH = H - T - B;
  const X = (t) => L + ((t - start) / (end - start)) * plotW;
  const Y = (v) => T + plotH - (Math.min(100, v) / 100) * plotH;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', role: 'img', 'aria-label': label });
  for (let i = 0; i <= 4; i++) {
    const v = 25 * i, y = Y(v);
    s.append(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: i ? 'grid' : 'axis' }));
    const t = svg('text', { x: L - 6, y: y + 3, class: 'tick', 'text-anchor': 'end' });
    t.textContent = `${v}`;
    s.append(t);
  }
  const yl = svg('text', { x: 0, y: 10, class: 'tick', 'text-anchor': 'start' });
  yl.textContent = '% used';
  s.append(yl);
  let lastDay = '';
  const first = tickLabel ? start : start + ((tickEvery - (localMs(start) % tickEvery)) % tickEvery); // on the local clock
  for (let t = first; t < end; t += tickEvery) {
    const x = X(t);
    if (endLabel && x > W - R - END_GAP) continue; // leave room for the label at the right edge
    const a = svg('text', { x, y: H - B + 14, class: 'tick', 'text-anchor': t === start && tickLabel ? 'start' : 'middle' });
    a.textContent = tickLabel ? tickLabel(t, t === start) : hhmm(t);
    s.append(a);
    if (!tickLabel && day(t) !== lastDay && isMidnight(t)) {
      lastDay = day(t);
      const b = svg('text', { x, y: H - B + 27, class: 'tick day', 'text-anchor': 'middle' });
      b.textContent = lastDay;
      s.append(b);
    }
  }
  if (endLabel) endTick(s, W, H, R, B, endLabel);
  // Runs of samples without a gap (the server samples every `every` ms; a longer gap means it was
  // off, e.g. a laptop asleep, or a sample failed), which the area under the curve spans without a line.
  // A reset breaks the curve: the next stretch starts from zero at the reset time, with no line drawn down to it.
  const GAP = every * 1.5;
  const stretches = []; // each a list of runs, with gaps between them
  let runs = null, run = null;
  for (const p of points) {
    const prev = run?.[run.length - 1];
    if (prev?.resets && !sameWindow(prev, p)) {
      stretches.push((runs = [(run = [])]));
      const r = new Date(prev.resets).getTime();
      if (r > prev.t && r < p.t) run.push({ t: r, pct: 0 });
    } else if (!prev) stretches.push((runs = [(run = [])]));
    if (run.length && p.t - run[run.length - 1].t > GAP) runs.push((run = []));
    run.push(p);
  }
  const xy = (p) => `${X(p.t).toFixed(1)},${Y(p.pct).toFixed(1)}`;
  for (const rs of stretches) {
    const all = rs.flat();
    if (all.length > 1) s.append(svg('path', { d: `M${all.map(xy).join(' L')} L${X(all[all.length - 1].t).toFixed(1)},${T + plotH} L${X(all[0].t).toFixed(1)},${T + plotH} Z`, class: 'area' }));
    for (const r of rs) s.append(svg('path', { d: `M${r.map(xy).join(' L')}`, class: 'line' }));
  }
  // The estimate (computed by the server): dashed from the last sample on; flat at 100% once it gets there.
  if (proj?.length > 1) s.append(svg('path', { d: proj.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.pct).toFixed(1)}`).join(' '), class: 'proj' }));
  const hit = svg('rect', { x: L, y: T, width: plotW, height: plotH, class: 'hit' });
  const tip = h('div', 'chart-tip');
  tip.hidden = true;
  const guide = svg('line', { y1: T, y2: T + plotH, class: 'guide' });
  const dot = svg('circle', { r: 4.5, class: 'dot' });
  guide.style.display = dot.style.display = 'none';
  s.append(guide, dot, hit);
  const nearest = (t) => {
    let best = null;
    for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best && Math.abs(best.t - t) < every ? best : null;
  };
  hit.addEventListener('mousemove', (ev) => {
    const box = s.getBoundingClientRect();
    const t = start + ((((ev.clientX - box.left) / box.width) * W - L) / plotW) * (end - start);
    const p = nearest(t);
    if (!p) return hide();
    guide.setAttribute('x1', X(p.t)); guide.setAttribute('x2', X(p.t));
    dot.setAttribute('cx', X(p.t)); dot.setAttribute('cy', Y(p.pct));
    guide.style.display = dot.style.display = '';
    tip.innerHTML = '';
    tip.append(...tooltip(p));
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    tip.style.left = `${Math.min(ev.clientX - r.left + 12, r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${ev.clientY - r.top - tip.offsetHeight - 10}px`;
  });
  const hide = () => { tip.hidden = true; guide.style.display = dot.style.display = 'none'; };
  hit.addEventListener('mouseleave', hide);
  return [s, tip];
}
const levels = (samples, key, start, end) => samples.filter((x) => x.t >= start && x.t <= end && x[key]?.pct != null).map((x) => ({ t: x.t, pct: x[key].pct, resets: x[key].resets }));

// ‹ range › at the right of a card's title: `go(-1)` shows the stretch before, `go(1)` the one after
// (`what`: the stretch a step covers, for the buttons' names); a way with nothing to show is disabled.
function pager(range, what, { older, newer, go }) {
  const nav = h('div', 'chart-nav');
  const step = (label, d, by, ok) => {
    const b = h('button');
    b.title = label;
    b.setAttribute('aria-label', label);
    const icon = svg('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true' });
    icon.append(svg('path', { d }));
    b.append(icon);
    b.disabled = !ok;
    b.onclick = () => go(by);
    return b;
  };
  nav.append(step(`Previous ${what}`, 'M15 18l-6-6 6-6', -1, older), h('span', 'chart-range', range), step(`Next ${what}`, 'M9 18l6-6-6-6', 1, newer));
  return nav;
}
const chartHead = (title, nav, est, hot) => {
  const row = h('div', 'chart-head');
  row.append(h('h3', null, title));
  if (est) row.append(h('span', 'chart-est' + (hot ? ' hot' : ''), est));
  row.append(nav);
  return row;
};

// Daily peek, the week by half hour: seven strips, Sunday first, each a day from 04:00 down to 04:00
// the next morning (so a late night stays in its own day), a band per half hour (per sampling interval
// when that is longer). A band's tint is how much of the 5-hour window it used: both limits are read in
// whole percents, and half an hour seldom moves the weekly one. A band with nothing to show (still to
// come, or no sample taken) is the bare strip, which looks the same as one that used nothing.
const DAY_FROM = 4; // the hour a day starts at
// 04:00 on the Sunday of the week `t` is in, `off` weeks from it.
function weekStart(t, off = 0) {
  const d = new Date(t - DAY_FROM * HOUR);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay() + 7 * off, DAY_FROM).getTime();
}
function weekCard(samples, { now, size, pos }) {
  const sec = h('section', 'week-sec');
  sec.style.setProperty('--c', '#c15f3c');
  const rows = Math.round((24 * HOUR) / size);
  const first = samples.find((x) => x.five?.pct != null)?.t ?? now;
  const oldest = Math.round((weekStart(first) - weekStart(now)) / (7 * 24 * HOUR)); // the first week on file (0 or less)
  const cells = (off) => buckets(samples, 'five', size, 7 * rows, now, weekStart(now, off), true);
  // One scale for every week on file, so weeks compare: the darkest tint from the 95th percentile up
  // (a sample after a gap carries hours of use, and as the top of the scale would flatten the rest).
  const all = [];
  for (let off = oldest; off <= 0; off++) for (const b of cells(off)) if (b.used > 0) all.push(b.used);
  all.sort((a, b) => a - b);
  const top = Math.max(4, all[Math.floor(all.length * 0.95)] || 0);
  const draw = () => {
    const off = (pos.week = Math.max(oldest, Math.min(0, pos.week)));
    const data = cells(off);
    const nav = pager(days(data[0].from, data[6 * rows].from), 'week', { older: off > oldest, newer: off < 0, go: (by) => { pos.week += by; draw(); } });
    const read = h('div', 'week-read');
    const names = h('div', 'week-days'), grid = h('div', 'week-grid'), foot = h('div', 'week-foot');
    const hours = h('div', 'week-hours');
    for (let r = 0; r < rows; r++) {
      const l = h('div', 'week-hour');
      if ((r * size) % (2 * HOUR) === 0) l.append(h('span', null, hhmm(data[r].from)));
      hours.append(l);
    }
    hours.append(h('span', 'week-hour-end', hhmm(data[rows - 1].to)));
    grid.append(hours);
    const units = h('div', 'week-foot-l');
    units.append(h('span', null, 'pts'), h('span', null, 'active'));
    foot.append(units);
    for (let d = 0; d < 7; d++) {
      const day1 = data.slice(d * rows, (d + 1) * rows);
      const t0 = day1[0].from, today = now >= t0 && now < day1[rows - 1].to;
      const name = h('div', 'week-day' + (today ? ' today' : ''));
      name.append(h('b', null, wd(t0)), h('span', null, String(new Date(t0).getDate())));
      names.append(name);
      const col = h('div', 'week-col'), strip = h('div', 'week-strip');
      let total = 0, busy = 0;
      day1.forEach((b, r) => {
        const c = h('div', 'week-cell ' + (b.to > now || !b.n ? 'none' : `b${b.used > 0 ? 1 + Math.min(4, Math.floor((b.used / top) * 5)) : 0}`));
        c.dataset.i = d * rows + r;
        strip.append(c);
        if (b.used > 0) { total += b.used; busy++; }
      });
      col.append(strip);
      if (today) {
        const line = h('div', 'week-now');
        line.style.top = `${((now - t0) / (rows * size)) * 100}%`;
        col.append(line);
      }
      grid.append(col);
      const sum = h('div', 'week-sum');
      sum.append(h('b', null, total ? `+${+total.toFixed(1)}` : '—'), h('span', null, busy ? `${+((busy * size) / HOUR).toFixed(1)}h` : '—'));
      foot.append(sum);
    }
    let on = null;
    const point = (c) => {
      if (c === on) return;
      on?.classList.remove('on');
      on = c;
      read.classList.toggle('on', !!c);
      if (!c) { read.textContent = ''; return; }
      c.classList.add('on');
      const b = data[+c.dataset.i];
      const used = b.to > now ? 'not yet' : !b.n ? 'no samples' : b.used > 0 ? `+${+b.used.toFixed(1)} pts` : 'nothing used';
      read.textContent = `${day(b.from)} · ${hhmm(b.from)}–${hhmm(b.to)} · ${used}`;
    };
    grid.onmousemove = (ev) => point(ev.target.closest('.week-cell'));
    grid.onmouseleave = () => point(null);
    const legend = h('div', 'week-legend');
    const ramp = h('span', 'week-ramp');
    for (let i = 0; i <= 5; i++) ramp.append(h('i', `b${i}`));
    legend.append(h('span', null, 'Less'), ramp, h('span', null, 'More'), h('span', 'week-unit', `% of the 5-hour window per ${stepName(size)}`));
    sec.replaceChildren(chartHead('Daily peek', nav), read, names, grid, foot, legend);
  };
  draw();
  return sec;
}

// The charts show the samples on the clock only; the numbers on top show `live`, the level on the status
// line, when it is newer than the last sample. `interval`: the sampling interval in minutes.
const stepName = (ms) => (ms === HOUR / 2 ? 'half hour' : ms === HOUR ? 'hour' : `${ms / 60000} minutes`);
// `pos`: how far back each card is paged ({ five, cycle, week }: 0 the latest, -1 the stretch before, …);
// the caller's object, changed in place as the ‹ › are used, so a redraw keeps the place.
export function usagePage(samples, { view = 'total', forecast, live, onView, interval = 30, pos = { five: 0, cycle: 0, week: 0 } } = {}) {
  const now = Date.now();
  const every = interval * 60 * 1000;
  const root = h('div', 'usage-page');
  const sampled = [...samples].reverse().find((x) => x.five || x.week);
  const latest = live && (live.five || live.week) && (!sampled || live.t > sampled.t) ? live : sampled;
  const tiles = h('div', 'stat-row');
  const resetIn = (iso) => { if (!iso) return ''; const m = Math.max(0, Math.round((new Date(iso) - now) / 60000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`; };
  const tile = (label, lim, sub) => {
    // A window whose reset has passed is empty until the next reading, as on the status line.
    const pct = lim?.resets && new Date(lim.resets) <= now ? 0 : lim?.pct;
    const d = h('div', 'stat' + (pct >= 85 ? ' hot' : pct >= 50 ? ' warm' : ''));
    const v = h('div', 'stat-v', pct == null ? '—' : pctText(pct));
    if (sub) v.append(h('span', 'stat-s', sub));
    const bar = h('div', 'stat-bar');
    const fill = h('div', 'stat-fill');
    fill.style.width = `${Math.min(100, pct || 0)}%`;
    bar.append(fill);
    d.append(h('div', 'stat-l', label), v, bar);
    tiles.append(d);
  };
  const wRes = latest?.week?.resets ? new Date(latest.week.resets) : null;
  tile('5-hour window', latest?.five, latest?.five?.resets ? `resets in ${resetIn(latest.five.resets)}` : '');
  tile('Weekly limit', latest?.week, wRes ? `resets ${wd(wRes)} ${hhmm(wRes)} · in ${resetIn(latest.week.resets)}` : '');
  root.append(tiles);

  const bar = h('div', 'usage-view');
  const seg = h('div', 'seg');
  for (const [v, label, title] of [['delta', 'Usage Delta', `How much each hour / ${stepName(Math.max(HOUR / 2, every))} used`], ['total', 'Usage Accumulated', 'The percentage used, as the status line shows it']]) {
    const b = h('button', v === view ? 'on' : '', label);
    b.title = title;
    b.onclick = () => onView?.(v);
    seg.append(b);
  }
  bar.append(seg);
  root.append(bar);
  if (samples.length < 2) {
    root.append(h('div', 'muted', `The server samples plan usage every ${interval} minutes (Settings changes that); the charts fill in as samples arrive.`));
  }

  // One reset cycle for the weekly chart: from the last reset to the next (the last 7 days when unknown).
  // The weekly bars are half an hour wide, or as wide as the sampling interval when that is longer.
  const HOURS5 = 48, HALF = Math.max(HOUR / 2, every), WEEK = Math.round((7 * 24 * HOUR) / HALF);
  const cycleEnd = wRes && wRes > now ? +wRes : Math.ceil(now / HALF) * HALF;
  const cycleStart = cycleEnd - WEEK * HALF;
  const cycleTick = (t, first) => (first ? `${wd(t)} ${hhmm(t)}` : wd(t));
  // Every weekly reset the samples have seen, oldest first, then this cycle's: the cycles ‹ › pages through.
  const cycles = [];
  for (const x of samples) {
    const r = x.week?.resets ? new Date(x.week.resets).getTime() : 0;
    if (r && r < cycleEnd - 2 * 60 * 1000 && r - (cycles.at(-1) || 0) > 2 * 60 * 1000) cycles.push(r);
  }
  cycles.push(cycleEnd);
  // The server's estimate for the rest of the cycle, when it has one for this window.
  const f = forecast?.week && wRes && Math.abs(new Date(forecast.week.resets) - wRes) < 2 * 60 * 1000 ? forecast.week : null;
  let proj = null, estimate = '', hot = false;
  if (f && f.pct != null) {
    const endT = f.hitAt && f.hitAt < cycleEnd ? f.hitAt : cycleEnd;
    const endV = f.hitAt && f.hitAt < cycleEnd ? 100 : Math.min(100, f.atReset);
    proj = [{ t: f.t, pct: f.pct }, { t: endT, pct: endV }];
    // Backwards from the first point, at the same slope: down to zero, or to the start of the cycle.
    const slope = endT > f.t ? (endV - f.pct) / (endT - f.t) : 0;
    const back = slope > 0 ? Math.max(cycleStart, f.t - f.pct / slope) : cycleStart;
    if (back < f.t) proj.unshift({ t: back, pct: Math.max(0, f.pct - slope * (f.t - back)) });
    if (endT < cycleEnd) proj.push({ t: cycleEnd, pct: 100 });
    hot = !!(f.hitAt && f.hitAt < cycleEnd);
    estimate = hot ? `estimate: 100% at ${wd(f.hitAt)} ~${hhmm(Math.round(f.hitAt / HOUR) * HOUR)}` : `estimate: ${Math.round(f.atReset)}% at the reset`;
  }
  const firstOf = (key) => samples.find((x) => x[key]?.pct != null)?.t ?? now;

  const sec1 = h('section', 'chart-sec');
  const sec2 = h('section', 'chart-sec');
  sec1.style.setProperty('--c', '#c15f3c');
  sec2.style.setProperty('--c', '#b7791f');
  // The 5-hour window, 48 hours at a time.
  const five = () => {
    const end = Math.ceil(now / HOUR) * HOUR + pos.five * HOURS5 * HOUR, start = end - HOURS5 * HOUR;
    const nav = pager(`${md(start)} ${hhmm(start)} – ${md(end)} ${hhmm(end)}`, '48 hours', { older: firstOf('five') < start, newer: pos.five < 0, go: (by) => { pos.five += by; five(); } });
    sec1.replaceChildren(chartHead('5-hour window', nav), view === 'total'
      ? lineChart(levels(samples, 'five', start, end), {
        start, end, tickEvery: 6 * HOUR, every, label: 'Percentage of the 5-hour window used over time',
        tooltip: (p) => [h('div', 'tip-t', `${day(p.t)} ${hhmm(p.t)}`), h('div', 'tip-v', pctText(p.pct)), h('div', 'tip-s', p.resets ? `window resets ${day(new Date(p.resets))} ${hhmm(new Date(p.resets))}` : '')],
      })
      : barChart(buckets(samples, 'five', HOUR, HOURS5, now, start), {
        unitLabel: 'Percentage points of the 5-hour window used per hour', labelEvery: 6,
        tooltip: (d) => [h('div', 'tip-t', `${day(d.from)} ${hhmm(d.from)}–${hhmm(d.to)}`), h('div', 'tip-v', `+${d.used.toFixed(1)} pts`), h('div', 'tip-s', d.last == null ? 'no samples' : `window at ${pctText(d.last)}`)],
      }));
  };
  // The weekly limit, a reset cycle at a time; the estimate belongs to the cycle that is running.
  const weekly = () => {
    pos.cycle = Math.max(1 - cycles.length, Math.min(0, pos.cycle));
    const end = cycles[cycles.length - 1 + pos.cycle], start = end - WEEK * HALF, cur = !pos.cycle;
    const resetTick = `reset ${wd(end)} ${hhmm(end)}`; // the cycle's end, at the right edge
    const nav = pager(days(start, end), 'week', { older: pos.cycle > 1 - cycles.length, newer: !cur, go: (by) => { pos.cycle += by; weekly(); } });
    sec2.replaceChildren(chartHead('Weekly limit', nav, cur ? estimate : '', hot), view === 'total'
      ? lineChart(levels(samples, 'week', start, end), {
        start, end, tickEvery: 24 * HOUR, tickLabel: cycleTick, proj: cur ? proj : null, every, label: 'Percentage of the weekly limit used this cycle',
        endLabel: resetTick,
        tooltip: (p) => [h('div', 'tip-t', `${day(p.t)} ${hhmm(p.t)}`), h('div', 'tip-v', pctText(p.pct)), h('div', 'tip-s', p.resets ? `resets ${day(new Date(p.resets))} ${hhmm(new Date(p.resets))}` : '')],
      })
      : barChart(buckets(samples, 'week', HALF, WEEK, now, start), {
        unitLabel: `Percentage points of the weekly limit used per ${stepName(HALF)}`, labelEvery: Math.round((24 * HOUR) / HALF), tickLabel: cycleTick, endLabel: resetTick,
        tooltip: (d) => [h('div', 'tip-t', `${day(d.from)} ${hhmm(d.from)}–${hhmm(d.to)}`), h('div', 'tip-v', `+${d.used.toFixed(1)} pts`), h('div', 'tip-s', d.last == null ? 'no samples' : `weekly at ${pctText(d.last)}`)],
      }));
  };
  five();
  weekly();
  const main = h('div', 'usage-main');
  const charts = h('div', 'usage-charts');
  charts.append(sec1, sec2);
  main.append(charts, weekCard(samples, { now, size: HALF, pos }));
  root.append(main);
  return root;
}
