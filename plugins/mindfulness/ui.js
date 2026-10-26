// Mindfulness: a minute of paced breathing, like the Apple Watch's. The tile is a small circle; a click
// fades the page into a dark one with a circle that grows as you breathe in and shrinks as you breathe out.
// Each breath done lights a spot at the top; the fifth ends it.
// seconds: breathe in, hold, breathe out, hold
const IN = 4, HOLD_IN = 1, OUT = 6, HOLD_OUT = 1, BREATHS = 5;
const CYCLE = IN + HOLD_IN + OUT + HOLD_OUT;
const SMALL = 0.3; // the circle breathed out, as a share of its size breathed in
const DIM = 400; // ms the dark page takes to cover the window
const FADE = 1000; // ms the circle takes to show, once the page is dark
const WAIT = 1000; // ms it rests, shown, before the first breath
const START = DIM + FADE + WAIT; // ms from the click to the first breath
const LINGER = 1500; // ms the last spot shows before it closes
const CURSOR = 1500; // ms the mouse pointer stays after it moves (to reach ✕); hidden otherwise
// The ripples: rings that breathe the same way, this many ms ahead (so you see a turn coming), this strong.
const LEADS = [{ ms: 500, alpha: 0.5 }, { ms: 1000, alpha: 0.25 }];

const div = (cls) => Object.assign(document.createElement('div'), { className: cls });

export default {
  tile(el) {
    el.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/></svg>';
  },
  open(el, api) {
    const back = el.closest('.modal-back');
    const circle = div('mf-circle'), dots = div('mf-dots');
    el.append(circle);
    const anims = [back?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DIM, easing: 'ease-out' })].filter(Boolean);
    // breathed out: small, the gradient as it is in ui.css (76.6%: its far corner, the default); breathed in:
    // big, the middle paler and the colour deepening only near the edge
    const small = { transform: `scale(${SMALL})`, '--mf-c0': 'hsl(165 30% 70%)', '--mf-c1': 'hsl(170 26% 55%)', '--mf-hint': '50%', '--mf-r': '76.6%', '--mf-cy': '42%' };
    const big = { transform: 'scale(1)', '--mf-c0': 'hsl(162 22% 76%)', '--mf-c1': 'hsl(172 30% 46%)', '--mf-hint': '82%', '--mf-r': '52%', '--mf-cy': '48%' };
    const breathe = (node, out, inn, lead = 0) => node.animate([
      { ...out, easing: 'ease-in-out' },
      { ...inn, offset: IN / CYCLE },
      { ...inn, offset: (IN + HOLD_IN) / CYCLE, easing: 'ease-in-out' },
      { ...out, offset: (IN + HOLD_IN + OUT) / CYCLE },
      out,
    ], { duration: CYCLE * 1000, iterations: BREATHS, delay: START - lead, fill: 'both' });
    const fadeIn = (node) => node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE, delay: DIM, fill: 'both' });
    const breath = breathe(circle, small, big);
    anims.push(fadeIn(circle), breath);
    for (const { ms, alpha } of LEADS) {
      const ring = div('mf-ring');
      ring.style.setProperty('--mf-a', alpha);
      el.append(ring); // (after the circle: drawn over it, seen while it is smaller)
      anims.push(fadeIn(ring), breathe(ring, { '--mf-s': SMALL }, { '--mf-s': 1 }, ms));
    }
    for (let i = 0; i < BREATHS; i++) dots.append(div('mf-slot')); // (unseen: each spot's fixed place)
    el.append(dots);

    // A spot for each breath done, read off the circle's own animation (so it keeps time with it).
    let frame, closing, lit = 0;
    const count = () => {
      const done = Math.max(0, Math.min(BREATHS, Math.floor((breath.currentTime - START) / (CYCLE * 1000))));
      while (lit < done) {
        const dot = div('mf-dot');
        dots.children[lit++].append(dot);
        anims.push(dot.animate([{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 700, easing: 'ease-out', fill: 'both' }));
      }
      if (done < BREATHS) frame = requestAnimationFrame(count);
      else closing = setTimeout(() => api.close(), LINGER);
    };
    frame = requestAnimationFrame(count);

    // The mouse pointer: hidden, but shown while it moves.
    let still;
    const hide = () => back?.classList.add('mf-still');
    const onMove = () => { back?.classList.remove('mf-still'); clearTimeout(still); still = setTimeout(hide, CURSOR); };
    hide();
    back?.addEventListener('mousemove', onMove);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(closing);
      clearTimeout(still);
      anims.forEach((a) => a.cancel());
    };
  },
};
