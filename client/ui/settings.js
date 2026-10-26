// The Settings panel, grouped by where each setting holds. Local: kept on the server the page is on, for
// that machine only (every tab and browser on it agreeing): what a new session starts with (model, effort,
// permission mode), the output style, the page's theme colour and how often plan usage is sampled.
// Global: kept on this computer (the client) and sent to every server when it updates: the UI skills. Each change is saved as soon as it is made. A default
// left on "Claude's default" follows Claude Code's own settings.json.
import { h } from './render.js';
import { ask } from './dialog.js';

// `ctx`: { openModal, call, openSkills(): the UI Skills page, openPlugins(): the Plugins page, openStyles(): the Output style page, getSettings, models(): the model list (loaded first), modes, efforts,
//   colors: the colour names, setThemeColor(name), serverName(): the server the page is on }
export async function openSettings(ctx) {
  // (away mode's own: none from a server that has no away mode)
  const [models, away, slack] = await Promise.all([ctx.models(), ctx.call('awayState', {}, { quiet: true }), ctx.call('awaySlack', {}, { quiet: true })]);
  const st = ctx.getSettings() || { defaults: {}, usageInterval: 30, intervals: [30] };
  const body = ctx.openModal('Settings');
  body.classList.add('settings');
  body.parentElement.style.width = 'min(560px, 100%)';

  const row = (label, hint, control) => {
    const r = h('div', 'set-row');
    const text = h('div', 'set-text');
    text.append(h('div', 'set-label', label), h('div', 'set-hint', hint));
    const saved = h('span', 'set-saved');
    r.append(text, saved, control);
    let last = control.value;
    control.onchange = async () => {
      saved.textContent = '';
      const ok = await control.save(control.value);
      if (!ok) control.value = last; else last = control.value; // (refused or failed: back to what is kept)
      saved.textContent = ok ? 'Saved' : '';
      setTimeout(() => { saved.textContent = ''; }, 1500);
    };
    return r;
  };
  const select = (options, value, save) => {
    const el = h('select', 'set-select');
    for (const [v, label] of options) { const o = h('option', null, label); o.value = v; el.append(o); }
    if (value && ![...el.options].some((o) => o.value === value)) { const o = h('option', null, value); o.value = value; el.append(o); } // no longer listed
    el.value = value || '';
    el.save = save;
    return el;
  };
  // A row that opens a page instead of holding a value.
  const link = (label, hint, text, open) => {
    const r = h('div', 'set-row');
    const t = h('div', 'set-text');
    t.append(h('div', 'set-label', label), h('div', 'set-hint', hint));
    const b = h('button', 'set-open', `${text} →`);
    b.type = 'button';
    b.onclick = open;
    r.append(t, b);
    return r;
  };
  // A group's heading; Local names the machine it is for.
  const where = (name, machine) => {
    const head = h('h4', null, name);
    if (machine) head.append(h('span', 'set-hint', machine));
    return head;
  };
  const saveDefault = (key) => async (v) => !!(await ctx.call('setSettings', { defaults: { [key]: v || null } }));

  body.append(
    where('Local', `(${ctx.serverName() || 'this server'})`),
    row('Model', 'The model a new session runs',
      select([['', 'Claude\'s default'], ...models.map((m) => [m.value, m.displayName || m.value])], st.defaults.model, saveDefault('model'))),
    row('Effort', 'How much it thinks before answering',
      select([['', 'Claude\'s default'], ...ctx.efforts.map(([v, label]) => [v, label])], st.defaults.effort, saveDefault('effort'))),
    row('Permission mode', 'How a new session asks before it acts',
      select([['', 'Claude\'s default'], ...ctx.modes], st.defaults.mode, async (v) => {
        // every new session would then run every tool without asking: the same question as picking it in a session
        if (v === 'bypassPermissions' && !await ask(null, { ok: 'Bypass permissions' })) return false;
        return saveDefault('mode')(v);
      })),
    link('Output style', 'How Claude answers: Claude Code\'s output styles, shared with the terminal', 'Open', ctx.openStyles),
    row('Theme colour', 'The page\'s colour where a session has none of its own (/color)',
      select([['', 'Clay (built in)'], ...ctx.colors.map((n) => [n, n[0].toUpperCase() + n.slice(1)])], st.color, async (v) => ctx.setThemeColor(v))),
    row('Sampling interval', 'How often the server records plan usage, on the clock (:00, :30…), page open or not',
      select(st.intervals.map((m) => [String(m), m === 60 ? 'Every hour' : `Every ${m} minutes`]), String(st.usageInterval), async (v) => !!(await ctx.call('setSettings', { usageInterval: Number(v) })))),
    ...(away ? awaySection(away, slack, { row, call: ctx.call }) : []),
    where('Global'),
    link('UI skills', 'The system prompt and skills that tell Claude what this web UI can show', 'Manage', ctx.openSkills),
    link('Plugins', 'What plugins add to this page, and on which servers their widgets show', 'Manage', ctx.openPlugins),
  );
}

// Away mode (server/away.mjs), kept on the server (so under Local): how long a request waits for you before it is
// reminded and then given up, and the Slack app it reaches you through (its tokens are never shown, only whether
// they are set). Its rows sit under a heading of their own within the group.
function awaySection(away, slack, { row, call }) {
  const minutes = (key, value) => {
    const el = h('input', 'set-num');
    el.type = 'number';
    el.min = '1';
    el.value = String(value);
    el.save = async (v) => !!(await call('awaySettings', { [key]: Number(v) }));
    return el;
  };
  const title = (text) => { const r = h('div', 'set-row'); r.append(h('div', 'set-text set-label set-sub', text)); return r; };
  const out = [
    title('Away mode'),
    row('Alignment check remind after', '', minutes('alignRemindMin', away.alignRemindMin)),
    row('Give up alignment and continue after', '', minutes('giveUpMin', away.giveUpMin)),
  ];
  const head = h('div', 'set-row');
  const copy = h('a', null, 'Copy the app manifest');
  copy.href = '#';
  copy.className = 'set-link';
  copy.onclick = async (ev) => {
    ev.preventDefault();
    try { await navigator.clipboard.writeText(slack?.manifest || ''); copy.textContent = 'Copied'; } catch { copy.textContent = 'Could not copy'; }
    setTimeout(() => { copy.textContent = 'Copy the app manifest'; }, 1500);
  };
  head.append(h('div', 'set-text set-label set-sub', 'Slack'), copy);
  out.push(head);
  const field = (label, id, placeholder, set) => {
    const r = h('div', 'set-row set-field');
    const lab = h('label', 'set-text set-label', label);
    lab.htmlFor = id;
    const inp = h('input', 'set-token');
    inp.id = id;
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.placeholder = set ? `${placeholder} (saved)` : placeholder;
    r.append(lab, inp);
    out.push(r);
    return inp;
  };
  const app = field('App token', 'awayApp', 'xapp-…', slack?.appToken);
  const bot = field('Bot token', 'awayBot', 'xoxb-…', slack?.botToken);
  const member = field('Your member ID', 'awayMember', 'U0123ABCD', false);
  member.value = slack?.userId || '';
  const foot = h('div', 'set-row set-foot');
  const saved = h('span', 'set-saved');
  const save = h('button', 'primary', 'Save');
  save.type = 'button';
  save.onclick = async () => {
    const body = {};
    if (app.value.trim()) body.appToken = app.value.trim();
    if (bot.value.trim()) body.botToken = bot.value.trim();
    if (member.value.trim()) body.userId = member.value.trim();
    save.disabled = true;
    const r = await call('awaySlackSet', body); // (Slack is asked first: a token it refuses is said so, and not kept)
    save.disabled = false;
    if (!r) return;
    app.value = bot.value = '';
    app.placeholder = 'xapp-… (saved)';
    bot.placeholder = 'xoxb-… (saved)';
    saved.textContent = 'Saved';
    setTimeout(() => { saved.textContent = ''; }, 1500);
  };
  foot.append(saved, save);
  out.push(foot);
  return out;
}
