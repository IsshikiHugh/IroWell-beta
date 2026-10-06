// The Settings panel: what a new session starts with (model, effort, permission mode) and how often the
// server samples plan usage. Both are kept on the server (so every tab and browser agrees); each change is
// saved as soon as it is made. A default left on "Claude's default" follows Claude Code's own settings.json.
import { h } from './render.js';
import { ask } from './dialog.js';

// `ctx`: { openModal, call, getSettings, models(): the model list (loaded first), modes, efforts }
export async function openSettings(ctx) {
  const models = await ctx.models();
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
  const saveDefault = (key) => async (v) => !!(await ctx.call('setSettings', { defaults: { [key]: v || null } }));

  body.append(
    h('h4', null, 'New sessions'),
    h('div', 'set-note', 'What a new session starts with. A draft you have already changed keeps your choice; "Claude\'s default" follows your Claude Code settings.'),
    row('Model', 'The model a new session runs',
      select([['', 'Claude\'s default'], ...models.map((m) => [m.value, m.displayName || m.value])], st.defaults.model, saveDefault('model'))),
    row('Effort', 'How much it thinks before answering',
      select([['', 'Claude\'s default'], ...ctx.efforts.map(([v, label]) => [v, label])], st.defaults.effort, saveDefault('effort'))),
    row('Permission mode', 'How a new session asks before it acts',
      select([['', 'Claude\'s default'], ...ctx.modes], st.defaults.mode, async (v) => {
        // every new session would then run every tool without asking: the same question as picking it in a session
        if (v === 'bypassPermissions' && !await ask('Bypass permissions: every new session will run every tool without asking. Continue?')) return false;
        return saveDefault('mode')(v);
      })),
    h('h4', null, 'Usage'),
    row('Sampling interval', 'How often the server records plan usage, on the clock (:00, :30…), page open or not',
      select(st.intervals.map((m) => [String(m), m === 60 ? 'Every hour' : `Every ${m} minutes`]), String(st.usageInterval), async (v) => !!(await ctx.call('setSettings', { usageInterval: Number(v) })))),
  );
}
