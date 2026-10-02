// Usage Analysis, from the samples the daemon takes every 30 minutes. Two views, one toggle:
//   total – the level of each limit over time (the number the status line shows; the default);
//   delta – how much of the 5-hour window each hour used, and of the weekly limit each half hour.
// The weekly chart spans one reset cycle (last reset on the left, next on the right) and carries the
// server's estimate of the rest of the cycle as a dashed line. The charts take whatever height the
// page leaves them, so the whole page fits without scrolling.
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
// window reset, everything used since the reset.
function buckets(samples, key, size, count, now, from) {
  const start = from ?? Math.ceil(now / size) * size - size * count;
  const out = Array.from({ length: count }, (_, i) => ({ from: start + i * size, to: start + (i + 1) * size, used: 0, last: null, n: 0 }));
  let prev = null;
  for (const x of samples) {
    const cur = x[key];
    if (!cur || cur.pct == null) continue;
    if (prev && x.t >= start) {
      const used = sameWindow(prev, cur) ? Math.max(0, cur.pct - prev.pct) : cur.pct;
      const b = out[Math.floor((x.t - start) / size)];
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
    if (i % labelEvery === 0 && !(endLabel && L + i * step + step / 2 > W - R - END_GAP)) {
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
const lineChart = (points, opts) => fitted((wrap, W, H) => drawLine(wrap, W, H, points, opts));
function drawLine(wrap, W, H, points, { start, end, tickEvery, label, tooltip, tickLabel, endLabel, proj, now }) {
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
  for (let t = start; t < end; t += tickEvery) {
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
  // Runs of samples without a gap (the server samples every 30 minutes; a longer gap means it was
  // off, e.g. a laptop asleep, or a sample failed), bridged by a dashed line. A reset breaks the curve:
  // the next stretch starts from zero at the reset time, with no line drawn down to it.
  const GAP = 45 * 60 * 1000;
  const stretches = []; // each a list of runs, the runs joined by dashed bridges
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
    rs.forEach((r, i) => {
      if (i) s.append(svg('path', { d: `M${xy(rs[i - 1][rs[i - 1].length - 1])} L${xy(r[0])}`, class: 'bridge' }));
      s.append(svg('path', { d: `M${r.map(xy).join(' L')}`, class: 'line' }));
    });
  }
  // The estimate (computed by the server): dashed from the last sample on; flat at 100% once it gets there.
  if (proj?.length > 1) s.append(svg('path', { d: proj.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.pct).toFixed(1)}`).join(' '), class: 'proj' }));
  if (now && now > start && now < end) s.append(svg('line', { x1: X(now), x2: X(now), y1: T, y2: T + plotH, class: 'now' }));
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
    return best && Math.abs(best.t - t) < 30 * 60 * 1000 ? best : null;
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
const levels = (samples, key, start) => samples.filter((x) => x.t >= start && x[key]?.pct != null).map((x) => ({ t: x.t, pct: x[key].pct, resets: x[key].resets }));

export function usagePage(samples, { view = 'total', forecast, onView } = {}) {
  const now = Date.now();
  const root = h('div', 'usage-page');
  const latest = [...samples].reverse().find((x) => x.five || x.week);
  const tiles = h('div', 'stat-row');
  const resetIn = (iso) => { if (!iso) return ''; const m = Math.max(0, Math.round((new Date(iso) - now) / 60000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`; };
  const tile = (label, lim, sub) => {
    const pct = lim?.pct;
    const d = h('div', 'stat' + (pct >= 85 ? ' hot' : pct >= 50 ? ' warm' : ''));
    const v = h('div', 'stat-v', pct == null ? '—' : `${pct}%`);
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
  for (const [v, label, title] of [['delta', 'Usage Delta', 'How much each hour / half hour used'], ['total', 'Usage Accumulated', 'The percentage used, as the status line shows it']]) {
    const b = h('button', v === view ? 'on' : '', label);
    b.title = title;
    b.onclick = () => onView?.(v);
    seg.append(b);
  }
  bar.append(seg);
  root.append(bar);
  if (samples.length < 2) {
    root.append(h('div', 'muted', 'The server samples plan usage every 30 minutes; the charts fill in as samples arrive.'));
  }

  // One reset cycle for the weekly chart: from the last reset to the next (the last 7 days when unknown).
  const HOURS5 = 48, WEEK = 7 * 24 * 2, HALF = HOUR / 2;
  const cycleEnd = wRes && wRes > now ? +wRes : Math.ceil(now / HALF) * HALF;
  const cycleStart = cycleEnd - WEEK * HALF;
  const cycleTick = (t, first) => (first ? `${wd(t)} ${hhmm(t)}` : wd(t));
  const resetTick = `reset ${wd(cycleEnd)} ${hhmm(cycleEnd)}`; // the cycle's end, at the right edge
  // The server's estimate for the rest of the cycle, when it has one for this window.
  const f = forecast?.week && wRes && Math.abs(new Date(forecast.week.resets) - wRes) < 2 * 60 * 1000 ? forecast.week : null;
  let proj = null, estimate = '', hot = false;
  if (f && f.pct != null) {
    const endT = f.hitAt && f.hitAt < cycleEnd ? f.hitAt : cycleEnd;
    const endV = f.hitAt && f.hitAt < cycleEnd ? 100 : Math.min(100, f.atReset);
    proj = [{ t: f.t, pct: f.pct }, { t: endT, pct: endV }];
    if (endT < cycleEnd) proj.push({ t: cycleEnd, pct: 100 });
    hot = !!(f.hitAt && f.hitAt < cycleEnd);
    estimate = hot ? `estimate: 100% at ${wd(f.hitAt)} ~${hhmm(Math.round(f.hitAt / HOUR) * HOUR)}` : `estimate: ${Math.round(f.atReset)}% at the reset`;
  }
  const head = (sec, title, note, est) => {
    const row = h('div', 'chart-head');
    row.append(h('h3', null, title), h('span', 'chart-note', note));
    if (est) row.append(h('span', 'chart-est' + (hot ? ' hot' : ''), est));
    sec.append(row);
  };

  const sec1 = h('section', 'chart-sec');
  const sec2 = h('section', 'chart-sec');
  sec1.style.setProperty('--c', '#c15f3c');
  sec2.style.setProperty('--c', '#b7791f');
  if (view === 'total') {
    const end = Math.ceil(now / HOUR) * HOUR;
    head(sec1, '5-hour window', 'percentage used, last 48 hours · starts again from zero when the window resets');
    sec1.append(lineChart(levels(samples, 'five', end - HOURS5 * HOUR), {
      start: end - HOURS5 * HOUR, end, tickEvery: 6 * HOUR, label: 'Percentage of the 5-hour window used over time',
      tooltip: (p) => [h('div', 'tip-t', `${day(p.t)} ${hhmm(p.t)}`), h('div', 'tip-v', `${p.pct}%`), h('div', 'tip-s', p.resets ? `window resets ${day(new Date(p.resets))} ${hhmm(new Date(p.resets))}` : '')],
    }));
    head(sec2, 'Weekly limit', proj ? 'this reset cycle · solid: used so far · dashed: estimate' : 'this reset cycle', estimate);
    sec2.append(lineChart(levels(samples, 'week', cycleStart), {
      start: cycleStart, end: cycleEnd, tickEvery: 24 * HOUR, tickLabel: cycleTick, proj, now, label: 'Percentage of the weekly limit used this cycle',
      endLabel: resetTick,
      tooltip: (p) => [h('div', 'tip-t', `${day(p.t)} ${hhmm(p.t)}`), h('div', 'tip-v', `${p.pct}%`), h('div', 'tip-s', p.resets ? `resets ${day(new Date(p.resets))} ${hhmm(new Date(p.resets))}` : '')],
    }));
  } else {
    const five = buckets(samples, 'five', HOUR, HOURS5, now);
    head(sec1, '5-hour window', 'points used each hour, last 48 hours');
    sec1.append(barChart(five, {
      unitLabel: 'Percentage points of the 5-hour window used per hour', labelEvery: 6,
      tooltip: (d) => [h('div', 'tip-t', `${day(d.from)} ${hhmm(d.from)}–${hhmm(d.to)}`), h('div', 'tip-v', `+${d.used.toFixed(1)} pts`), h('div', 'tip-s', d.last == null ? 'no samples' : `window at ${d.last}%`)],
    }));
    const week = buckets(samples, 'week', HALF, WEEK, now, cycleStart);
    head(sec2, 'Weekly limit', 'points used each half hour, this reset cycle · whole percents, so quiet half hours show 0', estimate);
    sec2.append(barChart(week, {
      unitLabel: 'Percentage points of the weekly limit used per half hour', labelEvery: 48, tickLabel: cycleTick, endLabel: resetTick,
      tooltip: (d) => [h('div', 'tip-t', `${day(d.from)} ${hhmm(d.from)}–${hhmm(d.to)}`), h('div', 'tip-v', `+${d.used.toFixed(1)} pts`), h('div', 'tip-s', d.last == null ? 'no samples' : `weekly at ${d.last}%`)],
    }));
  }
  root.append(sec1, sec2);
  return root;
}
