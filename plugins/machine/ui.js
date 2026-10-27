// Machine: the load of the tab's server (its daemon reads it: api.machine, server/machine.mjs). The tile is a
// small picture of it: a column per core, and under them, when there are NVIDIA GPUs, a pair per
// GPU (its use, its memory); many columns are averaged down to what fits. A click opens htop and nvitop on
// one page: the cores, memory and swap, then the GPUs (none without nvidia-smi), the processes on them, and
// every process, by CPU or by memory.
import { h } from '/ui/render.js';

const TILE_MS = 3000, PAGE_MS = 2000; // how often each reads
const COL = 3, GAP = 1; // a tile column's width and the gap between columns (px)
const MAX_ROWS = 300; // processes listed (the busiest)

const pct = (x) => `${Math.round(x)}%`;
function bytes(n) {
  if (n == null) return '–';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
}
function uptime(s) {
  const d = Math.floor(s / 86400), hh = String(Math.floor(s / 3600) % 24).padStart(2, '0'), mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${hh}:${mm}`;
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
// `items` averaged, in order, into at most n groups.
function fit(items, n, f = (g) => avg(g)) {
  if (items.length <= n) return items.map((x) => f([x]));
  const out = [];
  for (let i = 0; i < n; i++) out.push(f(items.slice(Math.floor((i * items.length) / n), Math.floor(((i + 1) * items.length) / n))));
  return out;
}

// Reads every `ms` (not while the page is hidden), handing each read to draw, or the error to fail.
function every(ms, read, draw, fail) {
  let timer, gone = false;
  const tick = async () => {
    if (!document.hidden) {
      try { const d = await read(); if (!gone) draw(d); } catch (e) { if (!gone) fail(/: 400$/.test(e.message) ? new Error('the server runs an older IroWell: update it') : e); }
    }
    if (!gone) timer = setTimeout(tick, ms);
  };
  tick();
  return () => { gone = true; clearTimeout(timer); };
}

// A meter: a bar (the page's own, as on the usage card) filled to `share` (0–1).
function meter(cls) {
  const bar = h('div', `uc-bar mc-bar ${cls}`), fill = h('span', 'uc-fill');
  bar.append(fill);
  return { bar, set: (share) => { fill.style.width = `${Math.max(0, Math.min(1, share || 0)) * 100}%`; } };
}

function drawTile(el, d) {
  const width = el.clientWidth - 12; // (its padding)
  const n = Math.max(1, Math.floor((width + GAP) / (COL + GAP)));
  const col = (cls, v) => { const c = h('i', cls); c.style.setProperty('--v', String(Math.max(0, Math.min(1, v)))); return c; };
  const cpu = h('div', 'mc-row');
  cpu.append(...fit(d.cpus, n).map((v) => col('cpu', v)));
  const rows = [cpu];
  if (d.gpus?.length) {
    const gpu = h('div', 'mc-row');
    const pairs = fit(d.gpus, Math.max(1, Math.floor((n + 1) / 3)), (g) => ({ util: avg(g.map((x) => x.util ?? 0)) / 100, mem: avg(g.map((x) => (x.memTotal ? x.memUsed / x.memTotal : 0))) }));
    for (const p of pairs) { const pair = h('span', 'mc-pair'); pair.append(col('gpu', p.util), col('vram', p.mem)); gpu.append(pair); }
    rows.push(gpu);
  }
  el.replaceChildren(...rows);
  el.classList.toggle('two', rows.length > 1);
  const gpus = (d.gpus || []).map((g) => `GPU ${g.index} ${pct(g.util ?? 0)} · ${bytes(g.memUsed)}/${bytes(g.memTotal)}`);
  el.title = [`CPU ${pct(avg(d.cpus) * 100)} · Mem ${bytes(d.mem.used)}/${bytes(d.mem.total)}`, ...gpus].join('\n');
}

// ---- the page ----
const PROC_COLS = [
  ['pid', 'PID', 'num'], ['user', 'USER'], ['cpu', '%CPU', 'num', true], ['mem', '%MEM', 'num', true], ['rss', 'RES', 'num'],
  ['time', 'TIME', 'num'], ['state', 'S'], ['command', 'COMMAND', 'cmd'],
];
const GPU_PROC_COLS = [
  ['gpu', 'GPU', 'num'], ['pid', 'PID', 'num'], ['user', 'USER'], ['gmem', 'GPU MEM', 'num'], ['cpu', '%CPU', 'num'], ['mem', '%MEM', 'num'],
  ['time', 'TIME', 'num'], ['command', 'COMMAND', 'cmd'],
];
// A command as htop shows it: the program's name, then its arguments, quieter.
function command(p) {
  const text = p.command || '', prog = p.prog || text.split(' ')[0];
  const td = h('td', 'cmd');
  td.title = text;
  td.append(h('span', 'mc-prog', prog.split('/').pop() || prog));
  const args = text.slice(prog.length);
  if (args) td.append(h('span', 'mc-args', args));
  return td;
}
function cell(key, p) {
  if (key === 'command') return command(p);
  const text = key === 'rss' ? bytes(p.rss) : key === 'gmem' ? bytes(p.gmem) : key === 'cpu' || key === 'mem' ? (p[key] ?? 0).toFixed(1) : String(p[key] ?? '–');
  return h('td', PROC_COLS.concat(GPU_PROC_COLS).find((c) => c[0] === key)?.[2] || '', text);
}
function table(cols, onSort) {
  const t = h('table', 'mc-procs'), head = h('tr'), body = h('tbody');
  for (const [key, label, cls, sorts] of cols) {
    const th = h('th', `${cls || ''}${sorts ? ' sorts' : ''}`, label);
    th.dataset.key = key;
    if (sorts) th.onclick = () => onSort(key);
    head.append(th);
  }
  const thead = h('thead');
  thead.append(head);
  t.append(thead, body);
  return { t, body, head };
}

function openPage(el, api) {
  const top = h('div', 'mc-top');
  const summary = h('div', 'mc-sum');
  const cores = h('div', 'mc-cores');
  const mems = h('div', 'mc-mems');
  top.append(summary, cores, mems);
  const gpuSec = h('div', 'mc-gpus');
  const gpuProcWrap = h('div', 'mc-table');
  const procWrap = h('div', 'mc-table mc-all');
  el.append(top, gpuSec, gpuProcWrap, procWrap);

  let sortBy = 'cpu';
  const all = table(PROC_COLS, (key) => { sortBy = key; if (last) draw(last); });
  procWrap.append(all.t);
  const onGpu = table(GPU_PROC_COLS);
  gpuProcWrap.append(onGpu.t);

  const coreMeters = [];
  const memMeter = meter('mem'), swapMeter = meter('swap');
  const memRow = (label, m) => {
    const row = h('div', 'mc-meter'), val = h('span', 'mc-val');
    row.append(h('span', 'mc-label', label), m.bar, val);
    mems.append(row);
    return val;
  };
  const memVal = memRow('Mem', memMeter), swapVal = memRow('Swp', swapMeter);
  let gpuCards = [];
  let last = null;

  function draw(d) {
    last = d;
    summary.textContent = `${d.host} · Tasks ${d.procs?.length ?? '–'} · Load ${d.load.map((x) => x.toFixed(2)).join(' ')} · Uptime ${uptime(d.uptime)}`;
    // the cores, as htop's meters
    while (coreMeters.length < d.cpus.length) {
      const m = meter('cpu'), row = h('div', 'mc-meter'), val = h('span', 'mc-val');
      row.append(h('span', 'mc-label', String(coreMeters.length)), m.bar, val);
      cores.append(row);
      coreMeters.push({ m, val });
    }
    d.cpus.forEach((v, i) => { coreMeters[i].m.set(v); coreMeters[i].val.textContent = pct(v * 100); });
    memMeter.set(d.mem.used / d.mem.total);
    memVal.textContent = `${bytes(d.mem.used)}/${bytes(d.mem.total)}`;
    swapMeter.set(d.swap.total ? d.swap.used / d.swap.total : 0);
    swapVal.textContent = `${bytes(d.swap.used)}/${bytes(d.swap.total)}`;

    // the GPUs, as nvitop's
    const gpus = d.gpus || [];
    gpuSec.hidden = gpuProcWrap.hidden = !gpus.length;
    if (gpuCards.length !== gpus.length) {
      gpuCards = gpus.map(() => {
        const card = h('div', 'mc-gpu'), head = h('div', 'mc-gpu-head'), name = h('span', 'mc-gpu-name'), facts = h('span', 'mc-gpu-facts');
        head.append(name, facts);
        const util = meter('gpu'), vram = meter('vram');
        const uRow = h('div', 'mc-meter'), uVal = h('span', 'mc-val'), vRow = h('div', 'mc-meter'), vVal = h('span', 'mc-val');
        uRow.append(h('span', 'mc-label', 'UTL'), util.bar, uVal);
        vRow.append(h('span', 'mc-label', 'MEM'), vram.bar, vVal);
        const meters = h('div', 'mc-gpu-meters');
        meters.append(uRow, vRow);
        card.append(head, meters);
        return { card, name, facts, util, vram, uVal, vVal };
      });
      gpuSec.replaceChildren(...gpuCards.map((c) => c.card));
    }
    gpus.forEach((g, i) => {
      const c = gpuCards[i];
      c.name.textContent = `${g.index}  ${g.name}`;
      c.facts.textContent = [g.temp != null && `${g.temp}°C`, g.fan != null && `Fan ${g.fan}%`,
        g.power != null && `${Math.round(g.power)}${g.powerLimit != null ? `/${Math.round(g.powerLimit)}` : ''} W`].filter(Boolean).join(' · ');
      c.util.set((g.util ?? 0) / 100);
      c.uVal.textContent = g.util != null ? pct(g.util) : 'N/A';
      c.vram.set(g.memTotal ? g.memUsed / g.memTotal : 0);
      c.vVal.textContent = `${bytes(g.memUsed)}/${bytes(g.memTotal)}`;
    });

    // the processes on the GPUs, then every process
    const byPid = new Map((d.procs || []).map((p) => [p.pid, p]));
    const gpuProcs = gpus.flatMap((g) => g.procs.map((gp) => ({ ...(byPid.get(gp.pid) || { pid: gp.pid, command: '' }), gpu: g.index, gmem: gp.mem })))
      .sort((a, b) => a.gpu - b.gpu || b.gmem - a.gmem);
    gpuProcWrap.hidden = !gpuProcs.length;
    onGpu.body.replaceChildren(...gpuProcs.map((p) => { const tr = h('tr'); tr.append(...GPU_PROC_COLS.map(([k]) => cell(k, p))); return tr; }));

    const procs = [...(d.procs || [])].sort((a, b) => (b[sortBy] - a[sortBy]) || (b.cpu - a.cpu)).slice(0, MAX_ROWS);
    for (const th of all.head.children) th.classList.toggle('on', th.dataset.key === sortBy);
    all.body.replaceChildren(...procs.map((p) => { const tr = h('tr'); tr.append(...PROC_COLS.map(([k]) => cell(k, p))); return tr; }));
  }

  return every(PAGE_MS, () => api.machine({ procs: true }), draw, (e) => { summary.textContent = `Couldn't read the server's state: ${e.message}`; });
}

export default {
  tile(el, api) {
    return every(TILE_MS, () => api.machine(), (d) => { el.classList.remove('bad'); drawTile(el, d); },
      (e) => { el.classList.add('bad'); el.textContent = '!'; el.title = `Machine: ${e.message}`; });
  },
  open: openPage,
};
