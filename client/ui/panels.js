// Panels for /usage and /context, drawn from the SDK's structured data instead of terminal text.
import { h } from './render.js';

const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n)));
const pct = (x) => `${Math.round(x)}%`;

function resetsIn(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  const mins = Math.max(0, Math.round((t - Date.now()) / 60000));
  const rel = mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.round(mins / 1440)}d`;
  const abs = t.toLocaleString([], mins < 24 * 60 ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `resets in ${rel} · ${abs}`;
}

function meter(value, { label, sub }) {
  const row = h('div', 'meter-row');
  const top = h('div', 'meter-top');
  top.append(h('span', 'meter-label', label), h('span', 'meter-value', value == null ? '—' : pct(value)));
  const bar = h('div', 'meter');
  const fill = h('div', 'meter-fill ' + (value >= 90 ? 'hot' : value >= 70 ? 'warm' : 'ok'));
  fill.style.width = `${Math.min(100, Math.max(0, value || 0))}%`;
  bar.append(fill);
  row.append(top, bar);
  if (sub) row.append(h('div', 'meter-sub', sub));
  return row;
}

const WINDOWS = {
  five_hour: 'Current session (5-hour window)',
  seven_day: 'This week · all models',
  seven_day_opus: 'This week · Opus',
  seven_day_sonnet: 'This week · Sonnet',
  seven_day_oauth_apps: 'This week · connected apps',
  seven_day_cowork: 'This week · Cowork',
};

export function usagePanel(u) {
  const root = h('div', 'panel');
  if (u.subscription_type) root.append(h('div', 'plan-badge', `Claude ${u.subscription_type[0].toUpperCase()}${u.subscription_type.slice(1)} plan`));

  const rl = u.rate_limits;
  if (u.rate_limits_available && rl) {
    const sec = h('section', 'panel-sec');
    sec.append(h('h4', null, 'Plan limits'));
    for (const [key, label] of Object.entries(WINDOWS)) {
      const w = rl[key];
      if (w && w.utilization != null) sec.append(meter(w.utilization, { label, sub: resetsIn(w.resets_at) }));
    }
    for (const m of rl.model_scoped || []) {
      if (m.utilization != null) sec.append(meter(m.utilization, { label: `This week · ${m.display_name}`, sub: resetsIn(m.resets_at) }));
    }
    const x = rl.extra_usage;
    if (x?.is_enabled) {
      const money = (v) => (v == null ? '—' : `${x.currency || '$'}${(v / 100).toFixed(2)}`);
      sec.append(meter(x.utilization, { label: 'Extra usage this month', sub: `${money(x.used_credits)} of ${money(x.monthly_limit)}` }));
    }
    root.append(sec);
  } else {
    root.append(h('div', 'muted', 'Plan limits don’t apply to this login (API key or cloud provider).'));
  }

  const s = u.session;
  if (s) {
    const sec = h('section', 'panel-sec');
    sec.append(h('h4', null, 'This session'));
    const stats = h('div', 'stat-row');
    const stat = (v, l) => { const d = h('div', 'stat'); d.append(h('div', 'stat-v', v), h('div', 'stat-l', l)); stats.append(d); };
    stat(`$${s.total_cost_usd.toFixed(2)}`, 'at API rates');
    stat(`${Math.round(s.total_api_duration_ms / 1000)}s`, 'model time');
    stat(`+${s.total_lines_added} / −${s.total_lines_removed}`, 'lines changed');
    sec.append(stats);
    const models = Object.entries(s.model_usage || {});
    if (models.length) {
      const t = h('table', 'help');
      const head = h('tr');
      for (const c of ['Model', 'Input', 'Cache read', 'Output', 'Cost']) head.append(h('th', null, c));
      t.append(head);
      for (const [name, m] of models) {
        const tr = h('tr');
        tr.append(h('td', 'mono', name), h('td', null, fmtK(m.inputTokens + m.cacheCreationInputTokens)), h('td', null, fmtK(m.cacheReadInputTokens)),
          h('td', null, fmtK(m.outputTokens)), h('td', null, `$${m.costUSD.toFixed(3)}`));
        t.append(tr);
      }
      sec.append(t);
    }
    root.append(sec);
  }
  return root;
}

// The CLI names its theme colours; map them onto the page palette.
const COLORS = {
  claude: 'var(--accent)', warning: '#d9a441', purple: '#8b6cd9', green: '#4caf7d', blue: '#4a8fd9', red: '#d9534f',
  cyan: '#3bb3c3', orange: '#e08a3c', pink: '#d96ca8', yellow: '#cdb534', inactive: '#9a958e', promptBorder: 'var(--line)',
};
const colorOf = (name) => COLORS[(name || '').split('_')[0]] || '#9a958e';

export function contextPanel(c) {
  const root = h('div', 'panel');
  root.append(h('div', 'ctx-total', `${fmtK(c.totalTokens)} of ${fmtK(c.maxTokens)} tokens used · ${pct(c.percentage)}`), h('div', 'muted', c.model));

  const shown = c.categories.filter((k) => !k.isDeferred && k.kind !== 'deferred');
  const bar = h('div', 'ctx-bar');
  for (const k of shown) {
    if (!k.tokens) continue;
    const seg = h('div', 'ctx-seg ' + k.kind);
    seg.style.width = `${(k.tokens / c.maxTokens) * 100}%`;
    seg.style.background = k.kind === 'free' ? 'transparent' : colorOf(k.color);
    seg.title = `${k.name}: ${fmtK(k.tokens)}`;
    bar.append(seg);
  }
  root.append(bar);

  const legend = h('div', 'ctx-legend');
  for (const k of shown) {
    const it = h('div', 'ctx-leg');
    const sw = h('span', 'swatch ' + k.kind);
    sw.style.background = k.kind === 'free' ? 'transparent' : colorOf(k.color);
    it.append(sw, h('span', null, k.name), h('span', 'muted', `${fmtK(k.tokens)} · ${((k.tokens / c.maxTokens) * 100).toFixed(1)}%`));
    legend.append(it);
  }
  root.append(legend);

  // The same square grid the terminal draws, as real squares.
  if (c.gridRows?.length) {
    const grid = h('div', 'ctx-grid');
    grid.style.gridTemplateColumns = `repeat(${c.gridRows[0].length}, 1fr)`;
    for (const row of c.gridRows) for (const sq of row) {
      const d = h('div', 'sq' + (sq.isFilled ? ' filled' : ''));
      if (sq.isFilled) { d.style.background = colorOf(sq.color); d.style.opacity = String(0.35 + 0.65 * (sq.squareFullness ?? 1)); }
      d.title = `${sq.categoryName}: ${fmtK(sq.tokens)}`;
      grid.append(d);
    }
    root.append(grid);
  }

  const deferred = c.categories.filter((k) => k.isDeferred || k.kind === 'deferred');
  if (deferred.length) root.append(h('div', 'muted small', `Loaded on demand, not in context now: ${deferred.map((k) => `${k.name} ${fmtK(k.tokens)}`).join(' · ')}`));

  const details = (title, rows, cols) => {
    if (!rows?.length) return;
    const d = h('details', 'panel-more');
    d.append(h('summary', null, `${title} (${rows.length})`));
    const t = h('table', 'help');
    for (const r of rows) {
      const tr = h('tr');
      cols.forEach((col, i) => tr.append(h('td', i === 0 ? 'mono' : null, col(r))));
      t.append(tr);
    }
    d.append(t);
    root.append(d);
  };
  const byTokens = (a, b) => b.tokens - a.tokens;
  details('Memory files', c.memoryFiles, [(r) => r.path, (r) => r.type, (r) => fmtK(r.tokens)]);
  details('Skills', c.skills?.skillFrontmatter?.slice().sort(byTokens), [(r) => r.name, (r) => r.source, (r) => fmtK(r.tokens)]);
  const servers = new Map();
  for (const t of c.mcpTools || []) {
    const s = servers.get(t.serverName) || { name: t.serverName, tools: 0, loaded: 0, tokens: 0 };
    s.tools++; s.tokens += t.tokens; if (t.isLoaded) s.loaded++;
    servers.set(t.serverName, s);
  }
  details('MCP servers', [...servers.values()].sort(byTokens), [(r) => r.name, (r) => `${r.tools} tools, ${r.loaded} loaded`, (r) => fmtK(r.tokens)]);
  details('Agents', c.agents?.slice().sort(byTokens), [(r) => r.agentType, (r) => r.source, (r) => fmtK(r.tokens)]);
  details('System prompt', c.systemPromptSections?.slice().sort(byTokens), [(r) => r.name, () => '', (r) => fmtK(r.tokens)]);
  details('System tools', c.systemTools?.slice().sort(byTokens), [(r) => r.name, () => '', (r) => fmtK(r.tokens)]);
  return root;
}
