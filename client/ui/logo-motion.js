// The logo in motion (designed in notes/logo/anim, "W2‴"). One turn takes 4 s and leaves the logo a quarter
// turn on, which looks just the same, so turns run back to back and always end on the logo itself:
//   1. 0–1.2 s, the wind-up: each line turns back 24° about its middle and moves 2.6 in (a 井 grid) while the
//      whole turns back 20°: easy at first, slower and slower, still creeping when it lets go;
//   2. 1.2–2.4 s, the release: on to the pinwheel (each line +34°, 4.2 in; the whole at 65°), held 0.3 s;
//   3. 2.7–3.5 s, back to the logo (the whole at 90°), held 0.5 s.
// Every frame redraws the weave: each line loses the line lying over it, widened by the gap, so the
// crossings stay right however the lines move. The turning stops only between turns, never half way.
import { LOGO_BARS, LOGO_GAP, LOGO_VIEWBOX } from './logo.js';

const TURN = 4000; // ms
const deg = Math.PI / 180;
function bezier(x1, y1, x2, y2) { // CSS cubic-bezier
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1;
    for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; }
    return by((lo + hi) / 2);
  };
}
// [from, to] (ms into the turn), the shape it moves to (phi: each line's turn and d: how far in, about its own
// middle; th: the whole's turn, degrees clockwise), and how it moves; between moves it holds still.
const MOVES = [
  [0, 1200, { phi: -24, d: 2.6, th: -20 }, bezier(0.5, 0, 0.1, 1)],
  [1200, 2400, { phi: 34, d: 4.2, th: 65 }, bezier(0.45, 0, 0.25, 1)],
  [2700, 3500, { phi: 0, d: 0, th: 90 }, bezier(0.65, 0, 0.35, 1)],
];
const REST = { phi: 0, d: 0, th: 0 };
function shapeAt(ms) {
  let s = REST;
  for (const [a, b, to, ease] of MOVES) {
    if (ms <= a) break;
    if (ms >= b) { s = to; continue; }
    const t = ease((ms - a) / (b - a));
    return { phi: s.phi + (to.phi - s.phi) * t, d: s.d + (to.d - s.d) * t, th: s.th + (to.th - s.th) * t };
  }
  return s;
}

// a clockwise turn on screen (y points down)
const turn = ([x, y], a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };
const C = [32, 32];
// each line's middle, and the way out from the centre through it
const MID = LOGO_BARS.map((b) => {
  const xs = b.map((p) => p[0]), ys = b.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
});
const OUT = MID.map(([x, y]) => { const n = Math.hypot(x - C[0], y - C[1]); return [(x - C[0]) / n, (y - C[1]) / n]; });
function paths({ phi, d, th }) {
  return LOGO_BARS.map((bar, i) => 'M' + bar.map((p) => {
    const q = turn([p[0] - MID[i][0], p[1] - MID[i][1]], phi * deg);
    const r = turn([q[0] + MID[i][0] - OUT[i][0] * d - C[0], q[1] + MID[i][1] - OUT[i][1] * d - C[1]], th * deg);
    return (r[0] + C[0]).toFixed(3) + ' ' + (r[1] + C[1]).toFixed(3);
  }).join('L') + 'Z');
}

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches; // (as the sidebar's dots: no motion then)

// The logo drawn into `host` (in currentColor), able to turn. `id` prefixes its mask ids (unique per copy on a page).
//   hold(reason, on): turn for as long as any reason holds; when the last one goes, the turn under way ends first.
//   once(): one turn (a turn under way counts as it).
//   settled(): resolves when the logo stands still (at once if it does).
export class LogoMotion {
  constructor(host, id) {
    this.svg = el('svg', { viewBox: LOGO_VIEWBOX, 'aria-hidden': 'true' });
    const defs = el('defs', {});
    this.lines = []; this.cuts = [];
    for (let i = 0; i < 4; i++) {
      const m = el('mask', { id: `${id}-m${i}`, maskUnits: 'userSpaceOnUse', x: -32, y: -32, width: 128, height: 128 });
      const cut = el('path', { fill: '#000', stroke: '#000', 'stroke-width': 2 * LOGO_GAP, 'stroke-linejoin': 'miter', 'stroke-miterlimit': 10 });
      m.append(el('rect', { x: -32, y: -32, width: 128, height: 128, fill: '#fff' }), cut);
      defs.append(m); this.cuts.push(cut);
    }
    this.svg.append(defs);
    for (let i = 0; i < 4; i++) { const p = el('path', { fill: 'currentColor', mask: `url(#${id}-m${i})` }); this.svg.append(p); this.lines.push(p); }
    host.replaceChildren(this.svg);
    this.reasons = new Set();
    this.running = false;
    this.waiters = [];
    this.draw(REST);
  }
  draw(shape) {
    const d = paths(shape);
    for (let i = 0; i < 4; i++) { this.lines[i].setAttribute('d', d[i]); this.cuts[i].setAttribute('d', d[(i + 1) % 4]); }
  }
  hold(reason, on) {
    if (!on) { this.reasons.delete(reason); return; }
    this.reasons.add(reason);
    this.start();
  }
  once() { this.start(); }
  settled() { return this.running ? new Promise((r) => this.waiters.push(r)) : Promise.resolve(); }
  start() {
    if (this.running || still()) return;
    this.running = true;
    this.t0 = performance.now();
    requestAnimationFrame(this.frame);
  }
  stop(draw) {
    this.running = false;
    if (draw) this.draw(REST);
    for (const r of this.waiters.splice(0)) r();
  }
  // (a frame can come late, a hidden tab's much later: a turn that has ended is over, held or not)
  frame = (now) => {
    if (!this.svg.isConnected) return this.stop(false); // taken off the page
    let t = now - this.t0;
    if (t >= TURN) {
      if (!this.reasons.size) return this.stop(true);
      const n = Math.floor(t / TURN);
      this.t0 += n * TURN; t -= n * TURN;
    }
    this.draw(shapeAt(t));
    requestAnimationFrame(this.frame);
  };
}
