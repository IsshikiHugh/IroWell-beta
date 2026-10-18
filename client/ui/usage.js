// Usage Analysis, from the samples the daemon takes on a clock (every 30 minutes unless Settings says
// otherwise): the level of each limit over time, the number the status line shows.
// The weekly chart spans one reset cycle (last reset on the left, next on the right) and carries the
// server's estimate of the rest of the cycle as a dashed line, which is the only dashed line on the
// curve: it runs on backwards (same slope) to where it meets zero or the start of the cycle.
// The charts take whatever height the page leaves them, so the whole page fits without scrolling.
// Under them, the tokens of each day of the week ("Weekly tokens"). Beside the three, the week by half
// hour ("Daily peek"): a strip per day, tinted by what each half hour cost.
// Each card has ‹ › beside its title, to page back through the history the server keeps.
import { h, chevronButton, timeUntil, windowNow, limitLevel } from './render.js';

const HOUR = 3600 * 1000;
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

// Two samples belong to the same window when their reset times agree (to within 2 minutes).
const sameWindow = (a, b) => a?.resets && b?.resets && Math.abs(new Date(a.resets) - new Date(b.resets)) < 2 * 60 * 1000;

// Percentage points used in each of `count` buckets: the rise between consecutive samples, or, right after a
// window reset, everything used since the reset. A sample counts in the bucket it closes (the rise it reports
// came before it): `slot(t)`, the bucket the moment `t` is in (-1 for none), is asked for the moment before it.
function buckets(samples, key, count, slot) {
  const out = Array.from({ length: count }, () => ({ used: 0 }));
  let prev = null;
  for (const x of samples) {
    const cur = x[key];
    if (!cur || cur.pct == null) continue;
    if (prev) {
      const b = out[slot(x.t - 1)];
      if (b) b.used += sameWindow(prev, cur) ? Math.max(0, cur.pct - prev.pct) : cur.pct;
    }
    prev = cur;
  }
  return out;
}

const two = (n) => String(n).padStart(2, '0');
const hhmm = (t) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const isMidnight = (t) => { const d = new Date(t); return !d.getHours() && !d.getMinutes(); }; // day names go under 00:00 only
const day = (t) => new Date(t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const wd = (t) => new Date(t).toLocaleDateString([], { weekday: 'short' });
const md = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const days = (a, b) => `${md(a)} – ${new Date(a).getMonth() === new Date(b).getMonth() ? new Date(b).getDate() : md(b)}`; // "Oct 4 – 10"
const pctText = (p) => `${Math.round(p)}%`; // readings can carry float noise (56.00000000000001)

// A chart drawn at its box's pixel size (so text never scales), redrawn when the box resizes.
function fitted(draw, cls = 'chart') {
  const wrap = h('div', cls);
  let size = '';
  new ResizeObserver(() => {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H || size === `${W}x${H}`) return;
    size = `${W}x${H}`;
    wrap.replaceChildren(...draw(wrap, W, H));
  }).observe(wrap);
  return wrap;
}

// A label anchored at the right edge of the x axis (the weekly cycle's reset); regular ticks keep clear of it.
const END_GAP = 110;
function endTick(s, W, H, R, B, text) {
  const t = svg('text', { x: W - R, y: H - B + 14, class: 'tick', 'text-anchor': 'end' });
  t.textContent = text;
  s.append(t);
}

// Where the x axis is labelled: every `every` from `start` (the weekly cycle's days), or (`clock`) at its multiples on
// the local clock (00:00, 06:00, …; a time zone of +5:30 lines up as well), stepped on the calendar so a clock change
// keeps them there.
function tickTimes(start, end, every, clock) {
  const out = [];
  if (!clock) {
    for (let t = start; t < end; t += every) out.push(t);
    return out;
  }
  const d = new Date(start), step = every / HOUR;
  for (let hr = Math.floor(d.getHours() / step) * step; ; hr += step) {
    const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hr).getTime();
    if (t >= end) return out;
    if (t >= start) out.push(t);
  }
}

// Whether points[i] follows points[i - 1] with no sample missed between them. The sampling step is read
// off the samples, not taken from this server's setting alone: the history is the account's, each of its
// machines samples at its own interval, and Settings changes one. So besides `every` (this server's), a
// gap is a step when no interval Settings offers is longer than it would have to be (STEP_MAX) and a gap
// beside it is as long: an hourly machine's samples make a line on a half-hourly server's page, and a
// slot missed among half-hourly samples still breaks one.
const STEP_MAX = HOUR;
function follows(points, i, every) {
  const gap = (j) => (j > 0 && j < points.length ? points[j].t - points[j - 1].t : 0);
  const d = gap(i);
  return d <= every * 1.5 || (d <= STEP_MAX * 1.5 && d <= Math.max(gap(i - 1), gap(i + 1)) * 1.5);
}

// The level of a limit over time: a 2px line (with a faint area under it), broken where samples
// are missing; hovering shows the nearest sample.
const lineChart = (points, opts) => fitted((wrap, W, H) => drawLine(wrap, W, H, points, opts));
function drawLine(wrap, W, H, points, { start, end, tickEvery, label, tooltip, tickLabel, endLabel, proj, every }) {
  const L = 40, R = 8, T = 10, B = 34;
  const plotW = W - L - R, plotH = H - T - B;
  const X = (t) => L + ((t - start) / (end - start)) * plotW;
  const Y = (v) => T + plotH - (Math.min(100, v) / 100) * plotH;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', role: 'img', 'aria-label': label });
  for (let i = 0; i <= 2; i++) {
    const v = 50 * i, y = Y(v);
    s.append(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: i ? 'grid' : 'axis' }));
    const t = svg('text', { x: L - 6, y: y + 3, class: 'tick', 'text-anchor': 'end' });
    t.textContent = v === 100 ? '100%' : `${v}`;
    s.append(t);
  }
  let lastDay = '';
  for (const t of tickTimes(start, end, tickEvery, !tickLabel)) {
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
  // Runs of samples without a gap (see `follows`; a gap means the machines were off, e.g. a laptop
  // asleep, or a sample failed), which the area under the curve spans without a line.
  // A reset breaks the curve: the next stretch starts from zero at the reset time, with no line drawn down to it.
  const stretches = []; // each a list of runs, with gaps between them
  let runs = null, run = null;
  points.forEach((p, i) => {
    const prev = run?.[run.length - 1];
    if (prev?.resets && !sameWindow(prev, p)) {
      stretches.push((runs = [(run = [])]));
      const r = new Date(prev.resets).getTime();
      if (r > prev.t && r < p.t) run.push({ t: r, pct: 0 });
    } else if (!prev) stretches.push((runs = [(run = [])]));
    if (run.length && !follows(points, i, every)) runs.push((run = []));
    run.push(p);
  });
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
  const step = (label, by, ok) => {
    const b = chevronButton(label, by < 0, () => go(by));
    b.disabled = !ok;
    return b;
  };
  nav.append(step(`Previous ${what}`, -1, older), h('span', 'chart-range', range), step(`Next ${what}`, 1, newer));
  return nav;
}
// A card's title row: the title, then `mid` (a node: the estimate, a key) and the pager at the right.
const chartHead = (title, nav, mid) => {
  const row = h('div', 'chart-head');
  row.append(h('h3', null, title));
  if (mid) row.append(mid);
  row.append(nav);
  return row;
};

// Daily peek, the week by half hour: seven strips, Sunday first, each a day from 04:00 down to 04:00
// the next morning (so a late night stays in its own day), a band per half hour (per sampling interval
// when that is longer). A band's tint is what its work would cost at API rates (`cost`, which the server
// reads off the transcripts, its own and the account's other machines': [[start of a half hour, $], …];
// null until it has answered), and pointing at one reads the amount. Under a day: what it added to the
// weekly limit, what it cost, and the hours with any spending. A band still to come is the bare strip,
// which looks the same as one that cost nothing. On the right, the week as a whole: per half hour of the
// day, what it cost over the seven days (a smooth curve through those amounts); under it, the week's totals.
const DAY_FROM = 4; // the hour a day starts at
// A smooth path through points [x, y] (y rising) that never swings past them: a monotone cubic
// (Fritsch–Carlson) with x as a function of y, so a half hour that cost nothing stays on the axis.
function smooth(p) {
  const n = p.length, f = (v) => v.toFixed(1);
  if (n < 2) return n ? `M${f(p[0][0])},${f(p[0][1])}` : '';
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((p[i + 1][0] - p[i][0]) / (p[i + 1][1] - p[i][1]));
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], q = a * a + b * b;
    if (q > 9) { const t = 3 / Math.sqrt(q); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let out = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const k = (p[i + 1][1] - p[i][1]) / 3;
    out += ` C${f(p[i][0] + m[i] * k)},${f(p[i][1] + k)} ${f(p[i + 1][0] - m[i + 1] * k)},${f(p[i + 1][1] - k)} ${f(p[i + 1][0])},${f(p[i + 1][1])}`;
  }
  return out;
}
// 04:00 on the Sunday of the week `t` is in (by the local clock: 03:00 on a Sunday is still the week before), `off` weeks from it.
function weekStart(t, off = 0) {
  const c = new Date(t), d = new Date(c.getFullYear(), c.getMonth(), c.getDate() - (c.getHours() < DAY_FROM ? 1 : 0), 12);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay() + 7 * off, DAY_FROM).getTime();
}
// The week from `start` (weekStart) on the local calendar: day k runs from days[k] to days[k + 1], 04:00 on its date
// to 04:00 on the next, so a day with a clock change is 23 or 25 hours long. `dayOf(t)`: the day `t` is in (-1 outside
// the week). `time(k, min)`: when the clock shows `min` minutes past 04:00 on day k (a time the clock skips comes out
// an hour later).
function weekOf(start) {
  const s = new Date(start);
  const time = (k, min = 0) => new Date(s.getFullYear(), s.getMonth(), s.getDate() + k, DAY_FROM, min).getTime();
  const days = Array.from({ length: 8 }, (_, k) => time(k));
  const dayOf = (t) => {
    if (!(t >= days[0] && t < days[7])) return -1;
    let k = 0;
    while (t >= days[k + 1]) k++;
    return k;
  };
  return { days, time, dayOf };
}
// Minutes on the local clock from the 04:00 before `t` (in an hour the clock goes back over, the same minutes come twice).
const clockMin = (t) => { const d = new Date(t); return ((d.getHours() - DAY_FROM + 24) % 24) * 60 + d.getMinutes() + d.getSeconds() / 60; };
// "HH:MM", `min` minutes past 04:00 (Daily peek's rows: the same on every day, whatever the clock did).
const rowTime = (min) => { const m = DAY_FROM * 60 + min; return `${two(Math.floor(m / 60) % 24)}:${two(m % 60)}`; };
const money = (v) => (v >= 100 ? `$${Math.round(v)}` : v >= 10 ? `$${v.toFixed(1)}` : `$${v.toFixed(2)}`);
const dollars = (v) => (v >= 10 ? `$${Math.round(v)}` : `$${v.toFixed(1)}`); // (under the strips)
const hrs = (n) => `${+n.toFixed(1)}h`;
function weekCard(samples, cost, { now, size, pos }) {
  const sec = h('section', 'week-sec');
  const rows = Math.round((24 * HOUR) / size), step = size / 60000; // (a band's minutes)
  const first = Math.min(samples.find((x) => x.week?.pct != null)?.t ?? now, cost?.[0]?.[0] ?? now);
  const oldest = Math.round((weekStart(first) - weekStart(now)) / (7 * 24 * HOUR)); // the first week on file (0 or less)
  // The week `off` weeks back: its bands, day by day, a row for every `step` minutes on the clock from 04:00 (so a row
  // keeps its time on every day: an hour the clock skips leaves its rows empty, one it repeats adds to them), each with
  // its first moment and what it cost; `slot(t)`: the band `t` is in (-1 outside the week).
  const cells = (off) => {
    const wk = weekOf(weekStart(now, off));
    const slot = (t) => { const k = wk.dayOf(t); return k < 0 ? -1 : k * rows + Math.floor(clockMin(t) / step); };
    const data = Array.from({ length: 7 * rows }, (_, i) => ({ from: wk.time(Math.floor(i / rows), (i % rows) * step), used: 0 }));
    for (let i = data.length - 2; i >= 0; i--) data[i].from = Math.min(data[i].from, data[i + 1].from); // (rows the clock skips: at the moment it skips them)
    for (const [t, usd] of cost || []) { const b = data[slot(t)]; if (b) b.used += usd; }
    return { wk, slot, data };
  };
  // One scale for every week on file, so weeks compare: the darkest tint from the 95th percentile up
  // (a few very dear half hours as the top of the scale would flatten the rest).
  const all = [];
  for (let off = oldest; off <= 0; off++) for (const b of cells(off).data) if (b.used > 0) all.push(b.used);
  all.sort((a, b) => a - b);
  const top = all[Math.floor(all.length * 0.95)] || 1;
  const draw = () => {
    const off = (pos.week = Math.max(oldest, Math.min(0, pos.week)));
    const { wk, slot, data } = cells(off);
    const weekly = buckets(samples, 'week', 7 * rows, slot);
    const nav = pager(days(wk.days[0], wk.days[6]), 'week', { older: off > oldest, newer: off < 0, go: (by) => { pos.week += by; draw(); } });
    const read = h('div', 'week-read');
    const names = h('div', 'week-days'), grid = h('div', 'week-grid'), foot = h('div', 'week-foot');
    const hours = h('div', 'week-hours');
    for (let r = 0; r < rows; r++) {
      const l = h('div', 'week-hour');
      if ((r * size) % (2 * HOUR) === 0) l.append(h('span', null, rowTime(r * step)));
      hours.append(l);
    }
    hours.append(h('span', 'week-hour-end', rowTime(rows * step)));
    grid.append(hours);
    const units = h('div', 'week-foot-l');
    units.append(h('span', null, 'pts'), h('span', null, 'cost'), h('span', null, 'active'));
    foot.append(units);
    for (let d = 0; d < 7; d++) {
      const day1 = data.slice(d * rows, (d + 1) * rows);
      const t0 = wk.days[d], today = now >= t0 && now < wk.days[d + 1];
      const name = h('div', 'week-day' + (today ? ' today' : ''));
      name.append(h('b', null, wd(t0)), h('span', null, String(new Date(t0).getDate())));
      names.append(name);
      const col = h('div', 'week-col'), strip = h('div', 'week-strip');
      const total = weekly.slice(d * rows, (d + 1) * rows).reduce((n, b) => n + b.used, 0);
      let busy = 0, spent = 0;
      day1.forEach((b, r) => {
        const c = h('div', 'week-cell ' + (b.from > now || !cost ? 'none' : `b${b.used > 0 ? 1 + Math.min(4, Math.floor((b.used / top) * 5)) : 0}`));
        c.dataset.i = d * rows + r;
        strip.append(c);
        if (b.used > 0) { busy++; spent += b.used; }
      });
      col.append(strip);
      if (today) {
        const line = h('div', 'week-now');
        line.style.top = `${(clockMin(now) / (24 * 60)) * 100}%`;
        col.append(line);
      }
      grid.append(col);
      const sum = h('div', 'week-sum');
      sum.append(h('b', null, total ? `+${+total.toFixed(1)}` : '—'), h('span', null, spent ? dollars(spent) : '—'), h('span', null, busy ? hrs((busy * size) / HOUR) : '—'));
      foot.append(sum);
    }
    // The week as a whole.
    const prof = Array.from({ length: rows }, (_, r) => {
      let usd = 0, n = 0;
      for (let d = 0; d < 7; d++) { const u = data[d * rows + r].used; if (u > 0) { usd += u; n++; } }
      return { usd, n };
    });
    const peak = Math.max(0, ...prof.map((p) => p.usd)) || 1;
    // The curve is drawn at the column's pixel size (redrawn when it resizes); a row per half hour on top
    // of it is what the pointer reads, with a dot on the curve.
    const hits = h('div', 'week-tot-rows');
    prof.forEach((p, r) => {
      const row = h('div', 'week-bar');
      row.dataset.r = r;
      hits.append(row);
    });
    const dot = svg('circle', { r: 3.5, class: 'week-dot' });
    dot.style.display = 'none';
    let at = [];
    const tot = fitted((wrap, W, H) => {
      at = prof.map((p, r) => [(p.usd / peak) * W * 0.86, ((r + 0.5) / rows) * H]);
      const d = smooth(at);
      const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'week-curve', 'aria-hidden': 'true' });
      s.append(svg('path', { d: `${d} L0,${at[rows - 1][1].toFixed(1)} L0,${at[0][1].toFixed(1)} Z`, class: 'area' }), svg('path', { d, class: 'line' }), dot);
      return [s, hits];
    }, 'week-tot');
    tot.append(hits);
    grid.append(tot);
    names.append(h('div', 'week-tot-h')); // (no title over the week column: an empty slot keeps the days over their strips)
    const pts = weekly.reduce((n, b) => n + b.used, 0);
    const spent = data.reduce((n, b) => n + (b.used > 0 ? b.used : 0), 0);
    const busy = (data.filter((b) => b.used > 0).length * size) / HOUR;
    const all = h('div', 'week-tot-sum');
    all.append(h('b', null, pts ? `+${+pts.toFixed(1)}` : '—'), h('span', null, spent ? dollars(spent) : '—'), h('span', null, busy ? hrs(busy) : '—'));
    foot.append(all);
    // The half hour pointed at is lifted out of its strip: a copy of it over the strip, with a shadow all
    // round (the strip clips what is drawn inside it).
    const lift = h('div', 'week-lift');
    let on = null;
    const point = (c) => {
      if (c === on) return;
      on?.classList.remove('on');
      on = c;
      lift.remove();
      if (!c) { read.textContent = ''; dot.style.display = 'none'; return; }
      c.classList.add('on');
      if (c.dataset.i != null) {
        const r = +c.dataset.i % rows, bg = getComputedStyle(c).backgroundColor;
        lift.style.top = `${(r / rows) * 100}%`;
        lift.style.height = `${100 / rows}%`;
        lift.style.background = bg === 'rgba(0, 0, 0, 0)' ? '' : bg;
        c.closest('.week-col').append(lift);
      }
      dot.style.display = c.dataset.r != null && at.length ? '' : 'none';
      if (c.dataset.r != null) {
        const r = +c.dataset.r, p = prof[r];
        if (at.length) { dot.setAttribute('cx', at[r][0]); dot.setAttribute('cy', at[r][1]); }
        read.textContent = `The week · ${rowTime(r * step)}–${rowTime((r + 1) * step)}${!cost ? '' : p.usd > 0 ? ` · ${money(p.usd)} · on ${p.n} day${p.n > 1 ? 's' : ''}` : ' · nothing spent'}`;
        return;
      }
      const b = data[+c.dataset.i], r = +c.dataset.i % rows;
      const note = b.from > now ? 'not yet' : !cost ? '' : b.used > 0 ? money(b.used) : 'nothing spent';
      read.textContent = `${day(b.from)} · ${rowTime(r * step)}–${rowTime((r + 1) * step)}${note && ` · ${note}`}`;
    };
    grid.onmousemove = (ev) => point(ev.target.closest('.week-cell, .week-bar'));
    grid.onmouseleave = () => point(null);
    const legend = h('div', 'week-legend');
    const ramp = h('span', 'week-ramp');
    for (let i = 0; i <= 5; i++) ramp.append(h('i', `b${i}`));
    legend.append(h('span', null, 'Less'), ramp, h('span', null, 'More'));
    sec.replaceChildren(chartHead('Daily peek', nav), read, names, grid, foot, legend);
  };
  draw();
  return sec;
}

// Weekly tokens: the weeks of Daily peek, and its days (04:00 to 04:00). A day is a pair of bars side by
// side: the input, with its cache (read and written) at the foot in a lighter shade of it, and the output.
// The cost rows carry the counts: [start of a half hour, $, input, cache, output]. Two scales, as output
// is a small part of the tokens: the input's on the left, the output's on the right, each the busiest
// day rounded up. Pointing at a day lifts its pair with a soft shadow (left, top and right, none under
// it: the axis is cut off) and reads its counts beside it.
const tokShort = (n) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${n >= 1e7 ? Math.round(n / 1e6) : +(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`);
const tokLong = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`);
// The top of the scale: twice a round step (1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 × a power of ten) at or over half of `v`.
const niceTop = (v) => {
  if (!(v > 0)) return 2;
  const e = 10 ** Math.floor(Math.log10(v / 2));
  return 2 * [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * e >= v / 2) * e;
};
// A bar whose top corners round by `rl` and `rr`.
function barPath(x, y, w, hgt, rl, rr) {
  const a = Math.min(rl, hgt, w / 2), b = Math.min(rr, hgt, w / 2), f = (v) => v.toFixed(1);
  return `M${f(x)},${f(y + hgt)} V${f(y + a)} Q${f(x)},${f(y)} ${f(x + a)},${f(y)} H${f(x + w - b)} Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + b)} V${f(y + hgt)} Z`;
}
function tokenCard(cost, { now, pos }) {
  const sec = h('section', 'chart-sec tok-sec');
  const DAY = 24 * HOUR;
  const counted = (cost || []).filter((r) => (r[2] || 0) + (r[3] || 0) + (r[4] || 0) > 0);
  const oldest = counted.length ? Math.round((weekStart(counted[0][0]) - weekStart(now)) / (7 * DAY)) : 0;
  const draw = () => {
    const off = (pos.tok = Math.max(oldest, Math.min(0, pos.tok || 0)));
    const wk = weekOf(weekStart(now, off));
    const week = Array.from({ length: 7 }, (_, d) => ({ from: wk.days[d], to: wk.days[d + 1], input: 0, cache: 0, output: 0 }));
    for (const [t, , i = 0, c = 0, o = 0] of counted) {
      const b = week[wk.dayOf(t)];
      if (b) { b.input += i; b.cache += c; b.output += o; }
    }
    const nav = pager(days(wk.days[0], wk.days[6]), 'week', { older: off > oldest, newer: off < 0, go: (by) => { pos.tok += by; draw(); } });
    const keys = h('div', 'tok-keys');
    for (const [k, name] of [['in', 'input'], ['cache', 'cache'], ['out', 'output']]) {
      const key = h('span');
      key.append(h('i', `k-${k}`), name);
      keys.append(key);
    }
    sec.replaceChildren(chartHead('Weekly tokens', nav, keys), fitted((wrap, W, H) => drawTokens(wrap, W, H, week, now)));
  };
  draw();
  return sec;
}
let tokIds = 0;
function drawTokens(wrap, W, H, week, now) {
  const L = 40, R = 40, T = 10, B = 34;
  const plotW = W - L - R, plotH = H - T - B, base = T + plotH;
  const sum = (b) => b.input + b.cache + b.output;
  const topIn = niceTop(Math.max(...week.map((b) => b.input + b.cache))), topOut = niceTop(Math.max(...week.map((b) => b.output)));
  const Y = (v) => base - (v / topIn) * plotH, Yo = (v) => base - (v / topOut) * plotH;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'tok-svg', role: 'img', 'aria-label': 'Tokens by day this week: input with its cache (left scale), and output (right scale)' });
  for (let i = 0; i <= 2; i++) {
    const y = Y((topIn / 2) * i);
    s.append(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: i ? 'grid' : 'axis' }));
    const a = svg('text', { x: L - 6, y: y + 3, class: 'tick k-in-t', 'text-anchor': 'end' });
    a.textContent = i ? tokShort((topIn / 2) * i) : '0';
    const b = svg('text', { x: W - R + 6, y: y + 3, class: 'tick k-out-t', 'text-anchor': 'start' });
    b.textContent = i ? tokShort((topOut / 2) * i) : '0';
    s.append(a, b);
  }
  const slot = plotW / 7, w = Math.max(4, Math.min(24, slot * 0.25));
  // The shadow's blur, and the cut at the axis that keeps it off the foot of the bars (ids of their own,
  // as the page may hold more than one of these charts).
  const blur = `tok-blur-${++tokIds}`, clip = `tok-clip-${tokIds}`, defs = svg('defs');
  const filter = svg('filter', { id: blur, filterUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H });
  filter.append(svg('feGaussianBlur', { stdDeviation: 3.5 }));
  const cut = svg('clipPath', { id: clip });
  cut.append(svg('rect', { x: 0, y: 0, width: W, height: base }));
  defs.append(filter, cut);
  s.append(defs);
  const tip = h('div', 'chart-tip tok-tip');
  tip.hidden = true;
  const groups = [];
  week.forEach((b, d) => {
    const cx = L + slot * (d + 0.5), g = svg('g', { class: 'tok-day' });
    const today = now >= b.from && now < b.to;
    const name = svg('text', { x: cx, y: base + 14, class: 'tick tok-name' + (today ? ' today' : ''), 'text-anchor': 'middle' });
    const wd1 = svg('tspan', { class: 'tok-wd' });
    wd1.textContent = wd(b.from);
    name.append(wd1, ` ${new Date(b.from).getDate()}`);
    s.append(name);
    if (b.from > now || !sum(b)) return;
    // The shadow behind the pair (the outline of both, blurred, cut off at the axis), then the input
    // column (the cache drawn over its foot) and the output beside it.
    const a = Y(b.input + b.cache), c = Yo(b.output), f = (v) => v.toFixed(1);
    g.append(svg('path', { d: `M${f(cx - w)},${f(base)} V${f(a)} H${f(cx)} V${f(c)} H${f(cx + w)} V${f(base)} Z`, class: 'tok-shadow', filter: `url(#${blur})`, 'clip-path': `url(#${clip})` }));
    if (base - a > 0) g.append(svg('path', { d: barPath(cx - w, a, w, base - a, 3, 0), class: 'k-in' }));
    if (b.cache > 0) g.append(svg('path', { d: barPath(cx - w, Y(b.cache), w, base - Y(b.cache), b.input > 0 ? 0 : 3, 0), class: 'k-cache' }));
    if (base - c > 0) g.append(svg('path', { d: barPath(cx, c, w, base - c, 0, 3), class: 'k-out' }));
    const hit = svg('rect', { x: cx - slot / 2, y: 0, width: slot, height: H, class: 'hit' });
    hit.dataset.d = d;
    g.append(hit);
    s.append(g);
    groups[d] = { g, cx, top: Math.min(a, c) };
  });
  let on = null;
  const show = (d) => {
    const it = groups[d] ?? null;
    if (it === on) return;
    on?.g.classList.remove('on');
    on = it;
    if (!it) { tip.hidden = true; return; }
    it.g.classList.add('on');
    const b = week[d], total = sum(b);
    const row = (k, name, v) => {
      const r = h('div', 'tok-row');
      r.append(h('i', `k-${k}`), h('span', null, name), h('span', 'tok-n', v));
      return r;
    };
    const today = now < b.to;
    tip.replaceChildren(h('div', 'tip-t', `${day(b.from)}${today ? ' (so far)' : ''}`), h('div', 'tok-tip-v', `${tokLong(total)} tokens`),
      row('in', 'input', tokLong(b.input)), row('cache', 'cache', `${tokLong(b.cache)} · ${Math.round((b.cache / total) * 100)}%`), row('out', 'output', tokLong(b.output)));
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${d < 5 ? it.cx + w + 10 : it.cx - w - 10 - tw}px`;
    tip.style.top = `${Math.max(0, Math.min(H - th, it.top - 4))}px`;
  };
  s.addEventListener('mousemove', (ev) => { const d = ev.target.dataset?.d; show(d == null ? -1 : +d); });
  s.addEventListener('mouseleave', () => show(-1));
  return [s, tip];
}

// The charts show the samples on the clock only; the numbers on top show `live`, the level on the status
// line, when it is newer than the last sample. `interval`: the sampling interval in minutes.
// `pos`: how far back each card is paged ({ five, cycle, week, tok }: 0 the latest, -1 the stretch before, …);
// the caller's object, changed in place as the ‹ › are used, so a redraw keeps the place.
export function usagePage(samples, { forecast, live, cost = null, interval = 30, pos = { five: 0, cycle: 0, week: 0, tok: 0 } } = {}) {
  const now = Date.now();
  const every = interval * 60 * 1000;
  const root = h('div', 'usage-page');
  const sampled = [...samples].reverse().find((x) => x.five || x.week);
  const latest = live && (live.five || live.week) && (!sampled || live.t > sampled.t) ? live : sampled;
  // The server's estimate for the rest of the cycle, when it has one for this window.
  const f = sameWindow(forecast?.week, latest?.week) ? forecast.week : null;
  const tiles = h('div', 'stat-row');
  // A window whose reset has passed is empty until the next reading, as on the status line; the colour is where the
  // limit will be at its reset (limitLevel, as the sidebar's meters).
  const tile = (label, lim, windowMs, sub, fc = null) => {
    const w = windowNow(lim, now), pct = w?.pct, level = limitLevel(w, windowMs, { forecast: fc, now });
    const d = h('div', 'stat' + (level === 'hot' || level === 'warm' ? ` ${level}` : ''));
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
  tile('5-hour window', latest?.five, 5 * HOUR, latest?.five?.resets ? `resets in ${timeUntil(latest.five.resets, now)}` : '');
  tile('Weekly limit', latest?.week, 7 * 24 * HOUR, wRes ? `resets ${wd(wRes)} ${hhmm(wRes)} · in ${timeUntil(latest.week.resets, now)}` : '', f);
  root.append(tiles);

  if (samples.length < 2) {
    root.append(h('div', 'muted', `The server samples plan usage every ${interval} minutes (Settings changes that); the charts fill in as samples arrive.`));
  }

  // One reset cycle for the weekly chart: from the last reset to the next (the last 7 days when unknown).
  // Daily peek's bands are half an hour, or the sampling interval when that is longer.
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
  // The estimate (`f`, above) on the weekly chart: a dashed line, and its text in the title row.
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

  const sec1 = h('section', 'chart-sec five-sec');
  const sec2 = h('section', 'chart-sec cycle-sec');
  // The 5-hour window, 48 hours at a time.
  const five = () => {
    const end = Math.ceil(now / HOUR) * HOUR + pos.five * HOURS5 * HOUR, start = end - HOURS5 * HOUR;
    const nav = pager(`${md(start)} ${hhmm(start)} – ${md(end)} ${hhmm(end)}`, '48 hours', { older: firstOf('five') < start, newer: pos.five < 0, go: (by) => { pos.five += by; five(); } });
    sec1.replaceChildren(chartHead('5-hour window', nav), lineChart(levels(samples, 'five', start, end), {
      start, end, tickEvery: 6 * HOUR, every, label: 'Percentage of the 5-hour window used over time',
      tooltip: (p) => [h('div', 'tip-t', `${day(p.t)} ${hhmm(p.t)}`), h('div', 'tip-v', pctText(p.pct)), h('div', 'tip-s', p.resets ? `window resets ${day(new Date(p.resets))} ${hhmm(new Date(p.resets))}` : '')],
    }));
  };
  // The weekly limit, a reset cycle at a time; the estimate belongs to the cycle that is running.
  const weekly = () => {
    pos.cycle = Math.max(1 - cycles.length, Math.min(0, pos.cycle));
    const end = cycles[cycles.length - 1 + pos.cycle], start = end - WEEK * HALF, cur = !pos.cycle;
    const resetTick = `reset ${wd(end)} ${hhmm(end)}`; // the cycle's end, at the right edge
    const nav = pager(days(start, end), 'week', { older: pos.cycle > 1 - cycles.length, newer: !cur, go: (by) => { pos.cycle += by; weekly(); } });
    sec2.replaceChildren(chartHead('Weekly limit', nav, cur && estimate ? h('span', 'chart-est' + (hot ? ' hot' : ''), estimate) : null), lineChart(levels(samples, 'week', start, end), {
      start, end, tickEvery: 24 * HOUR, tickLabel: cycleTick, proj: cur ? proj : null, every, label: 'Percentage of the weekly limit used this cycle',
      endLabel: resetTick,
      tooltip: (p) => [h('div', 'tip-t', `${day(p.t)} ${hhmm(p.t)}`), h('div', 'tip-v', pctText(p.pct)), h('div', 'tip-s', p.resets ? `resets ${day(new Date(p.resets))} ${hhmm(new Date(p.resets))}` : '')],
    }));
  };
  five();
  weekly();
  const main = h('div', 'usage-main');
  const charts = h('div', 'usage-charts');
  charts.append(sec1, sec2, tokenCard(cost, { now, pos }));
  // Today's points include what the limit has risen since the last sample: the live level counts as the latest one.
  main.append(charts, weekCard(live && latest === live ? [...samples, live] : samples, cost, { now, size: HALF, pos }));
  root.append(main);
  return root;
}
