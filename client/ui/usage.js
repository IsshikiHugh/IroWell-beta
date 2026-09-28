// Plan usage page, from the samples the daemon takes every 10 minutes. Two views, one toggle:
//   delta – how much of the 5-hour window each hour used, and of the weekly limit each half hour;
//   total – the level of each limit over time (the number the status line shows).
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
function buckets(samples, key, size, count, now) {
  const end = Math.ceil(now / size) * size;
  const start = end - size * count;
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

function barChart(data, { unitLabel, labelEvery, tooltip }) {
  const wrap = h('div', 'chart');
  const W = 900, H = 232, L = 40, R = 8, T = 22, B = 34;
  const max = niceMax(Math.max(1, ...data.map((d) => d.used)));
  const plotW = W - L - R, plotH = H - T - B;
  const step = plotW / data.length;
  const bw = Math.max(2, step - 2); // 2px gap between bars
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': unitLabel });
  // recessive grid + y labels
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, y = T + plotH - (v / max) * plotH;
    s.append(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: i ? 'grid' : 'axis' }));
    const t = svg('text', { x: L - 6, y: y + 3, class: 'tick', 'text-anchor': 'end' });
    t.textContent = `${+v.toFixed(1)}`;
    s.append(t);
  }
  const yl = svg('text', { x: L - 6, y: 10, class: 'tick', 'text-anchor': 'end' });
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
    if (i % labelEvery === 0) {
      const t = svg('text', { x: L + i * step + step / 2, y: H - B + 14, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = hhmm(d.from);
      s.append(t);
      if (day(d.from) !== lastDay && isMidnight(d.from)) {
        lastDay = day(d.from);
        const t2 = svg('text', { x: L + i * step + step / 2, y: H - B + 27, class: 'tick day', 'text-anchor': 'middle' });
        t2.textContent = day(d.from);
        s.append(t2);
      }
    }
  });
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
  wrap.append(s, tip);
  return wrap;
}

// The level of a limit over time: a 2px line (with a faint area under it), broken where samples
// are missing; hovering shows the nearest sample.
function lineChart(points, { start, end, tickEvery, label, tooltip }) {
  const wrap = h('div', 'chart');
  const W = 900, H = 232, L = 40, R = 8, T = 22, B = 34;
  const plotW = W - L - R, plotH = H - T - B;
  const X = (t) => L + ((t - start) / (end - start)) * plotW;
  const Y = (v) => T + plotH - (Math.min(100, v) / 100) * plotH;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': label });
  for (let i = 0; i <= 4; i++) {
    const v = 25 * i, y = Y(v);
    s.append(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: i ? 'grid' : 'axis' }));
    const t = svg('text', { x: L - 6, y: y + 3, class: 'tick', 'text-anchor': 'end' });
    t.textContent = `${v}`;
    s.append(t);
  }
  const yl = svg('text', { x: L - 6, y: 10, class: 'tick', 'text-anchor': 'end' });
  yl.textContent = '% used';
  s.append(yl);
  let lastDay = '';
  for (let t = start; t < end; t += tickEvery) {
    const x = X(t);
    const a = svg('text', { x, y: H - B + 14, class: 'tick', 'text-anchor': 'middle' });
    a.textContent = hhmm(t);
    s.append(a);
    if (day(t) !== lastDay && isMidnight(t)) {
      lastDay = day(t);
      const b = svg('text', { x, y: H - B + 27, class: 'tick day', 'text-anchor': 'middle' });
      b.textContent = lastDay;
      s.append(b);
    }
  }
  // Runs of samples no more than 25 minutes apart.
  const runs = [];
  let run = null;
  for (const p of points) {
    if (!run || p.t - run[run.length - 1].t > 25 * 60 * 1000) runs.push((run = []));
    run.push(p);
  }
  for (const r of runs) {
    const d = r.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.pct).toFixed(1)}`).join(' ');
    if (r.length > 1) s.append(svg('path', { d: `${d} L${X(r[r.length - 1].t).toFixed(1)},${T + plotH} L${X(r[0].t).toFixed(1)},${T + plotH} Z`, class: 'area' }));
    s.append(svg('path', { d, class: 'line' }));
  }
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
  wrap.append(s, tip);
  return wrap;
}
const levels = (samples, key, start) => samples.filter((x) => x.t >= start && x[key]?.pct != null).map((x) => ({ t: x.t, pct: x[key].pct, resets: x[key].resets }));

// Level view's table: where the limit stood at the end of each hour / half hour.
function levelTable(data, what) {
  const d = h('details', 'chart-table');
  d.append(h('summary', null, 'Show as a table'));
  const t = h('table', 'help');
  const hr = h('tr');
  for (const c of ['From', 'To', `Level (${what})`]) hr.append(h('th', null, c));
  t.append(hr);
  for (const b of [...data].reverse()) {
    if (b.last == null) continue;
    const tr = h('tr');
    tr.append(h('td', null, `${day(b.from)} ${hhmm(b.from)}`), h('td', null, hhmm(b.to)), h('td', null, `${b.last}%`));
    t.append(tr);
  }
  d.append(t);
  return d;
}

function table(data, what) {
  const d = h('details', 'chart-table');
  d.append(h('summary', null, 'Show as a table'));
  const t = h('table', 'help');
  const hr = h('tr');
  for (const c of ['From', 'To', `Used (${what})`, 'Level at the end']) hr.append(h('th', null, c));
  t.append(hr);
  for (const b of [...data].reverse()) {
    if (!b.n) continue;
    const tr = h('tr');
    tr.append(h('td', null, `${day(b.from)} ${hhmm(b.from)}`), h('td', null, hhmm(b.to)), h('td', null, `+${b.used.toFixed(1)}`), h('td', null, b.last == null ? '' : `${b.last}%`));
    t.append(tr);
  }
  d.append(t);
  return d;
}

export function usagePage(samples, { view = 'delta', onView } = {}) {
  const now = Date.now();
  const root = h('div', 'usage-page');
  const latest = [...samples].reverse().find((x) => x.five || x.week);
  const tiles = h('div', 'stat-row');
  const tile = (v, l) => { const d = h('div', 'stat'); d.append(h('div', 'stat-v', v), h('div', 'stat-l', l)); tiles.append(d); };
  const resetIn = (iso) => { if (!iso) return ''; const m = Math.max(0, Math.round((new Date(iso) - now) / 60000)); return m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.round(m / 1440)}d`; };
  tile(latest?.five ? `${latest.five.pct}%` : '—', `5-hour window${latest?.five?.resets ? ` · resets in ${resetIn(latest.five.resets)}` : ''}`);
  tile(latest?.week ? `${latest.week.pct}%` : '—', `weekly limit${latest?.week?.resets ? ` · resets in ${resetIn(latest.week.resets)}` : ''}`);
  tile(String(samples.length), samples.length ? `samples since ${day(samples[0].t)} ${hhmm(samples[0].t)}` : 'samples (one every 10 minutes)');
  root.append(tiles);

  const bar = h('div', 'usage-view');
  const seg = h('div', 'seg');
  for (const [v, label, title] of [['delta', 'Used per interval', 'How much each hour / half hour used'], ['total', 'Level over time', 'The percentage used, as the status line shows it']]) {
    const b = h('button', v === view ? 'on' : '', label);
    b.title = title;
    b.onclick = () => onView?.(v);
    seg.append(b);
  }
  bar.append(seg);
  root.append(bar);
  if (samples.length < 2) {
    root.append(h('div', 'muted', 'The server samples plan usage every 10 minutes; the charts fill in as samples arrive.'));
  }

  const HOURS5 = 48, WEEK = 7 * 24 * 2;
  const sec1 = h('section', 'chart-sec');
  const sec2 = h('section', 'chart-sec');
  if (view === 'total') {
    const end = Math.ceil(now / HOUR) * HOUR;
    sec1.append(h('h3', null, '5-hour window: level'), h('div', 'muted small', 'Percentage of the current 5-hour window used, last 48 hours. It drops to zero when the window resets.'));
    sec1.append(lineChart(levels(samples, 'five', end - HOURS5 * HOUR), {
      start: end - HOURS5 * HOUR, end, tickEvery: 6 * HOUR, label: 'Percentage of the 5-hour window used over time',
      tooltip: (p) => [h('div', 'tip-t', `${day(p.t)} ${hhmm(p.t)}`), h('div', 'tip-v', `${p.pct}%`), h('div', 'tip-s', p.resets ? `window resets ${day(new Date(p.resets))} ${hhmm(new Date(p.resets))}` : '')],
    }), levelTable(buckets(samples, 'five', HOUR, HOURS5, now), '5h'));
    const wEnd = Math.ceil(now / (HOUR / 2)) * (HOUR / 2), wStart = wEnd - WEEK * (HOUR / 2);
    sec2.append(h('h3', null, 'Weekly limit: level'), h('div', 'muted small', 'Percentage of the weekly limit used, last 7 days.'));
    sec2.append(lineChart(levels(samples, 'week', wStart), {
      start: wStart, end: wEnd, tickEvery: 12 * HOUR, label: 'Percentage of the weekly limit used over time',
      tooltip: (p) => [h('div', 'tip-t', `${day(p.t)} ${hhmm(p.t)}`), h('div', 'tip-v', `${p.pct}%`), h('div', 'tip-s', p.resets ? `resets ${day(new Date(p.resets))} ${hhmm(new Date(p.resets))}` : '')],
    }), levelTable(buckets(samples, 'week', HOUR / 2, WEEK, now), 'weekly'));
  } else {
    const five = buckets(samples, 'five', HOUR, HOURS5, now);
    sec1.append(h('h3', null, '5-hour window: used each hour'), h('div', 'muted small', 'Percentage points of the current 5-hour window used in each hour, last 48 hours.'));
    sec1.append(barChart(five, {
      unitLabel: 'Percentage points of the 5-hour window used per hour', labelEvery: 6,
      tooltip: (d) => [h('div', 'tip-t', `${day(d.from)} ${hhmm(d.from)}–${hhmm(d.to)}`), h('div', 'tip-v', `+${d.used.toFixed(1)} pts`), h('div', 'tip-s', d.last == null ? 'no samples' : `window at ${d.last}%`)],
    }), table(five, '% pts of 5h'));
    const week = buckets(samples, 'week', HOUR / 2, WEEK, now);
    sec2.append(h('h3', null, 'Weekly limit: used each half hour'), h('div', 'muted small', 'Percentage points of the weekly limit used in each half hour, last 7 days. The limit is reported in whole percent, so small half hours can show 0.'));
    sec2.append(barChart(week, {
      unitLabel: 'Percentage points of the weekly limit used per half hour', labelEvery: 24,
      tooltip: (d) => [h('div', 'tip-t', `${day(d.from)} ${hhmm(d.from)}–${hhmm(d.to)}`), h('div', 'tip-v', `+${d.used.toFixed(1)} pts`), h('div', 'tip-s', d.last == null ? 'no samples' : `weekly at ${d.last}%`)],
    }), table(week, '% pts of weekly'));
  }
  root.append(sec1, sec2);
  return root;
}
