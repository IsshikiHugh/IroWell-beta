// Host defaults are separate for each engine. Native Codex configuration stays owned by Codex.
import { h } from './render.js';
import { ask } from './dialog.js';
import { codexPermissionOptions, codexPermissionValue, codexPermissionSettings, codexAuthLabel } from './codex.js';

export function openSettings(ctx) {
  let st = ctx.getSettings();
  const host = ctx.serverName() || 'this server';
  const body = ctx.openModal('Settings');
  body.classList.add('settings');
  body.parentElement.style.width = 'min(620px, 100%)';
  const tabs = h('div', 'set-tabs'), content = h('div');
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Settings category');
  body.append(h('div', 'set-note', host), tabs, content);
  const button = (label, run) => { const b = h('button', 'set-open', label); b.type = 'button'; b.onclick = run; return b; };
  const note = text => h('div', 'set-note', text);
  const group = text => h('h4', null, text);
  const link = (label, hint, text, open) => {
    const r = h('div', 'set-row'), info = h('div', 'set-text');
    info.append(h('div', 'set-label', label), h('div', 'set-hint', hint));
    r.append(info, button(`${text} →`, open)); return r;
  };
  const select = (name, options, value, save) => {
    const el = h('select', 'set-select'); el.name = name; el.save = save;
    for (const entry of options) {
      const { value: v, label, disabled, description } = Array.isArray(entry) ? { value: entry[0], label: entry[1] } : entry;
      const o = h('option', null, label); o.value = v; o.disabled = !!disabled; o.title = description || ''; el.append(o);
    }
    if (value && ![...el.options].some(o => o.value === value)) { const o = h('option', null, `${value} (not currently listed)`); o.value = value; el.append(o); }
    el.value = value || ''; return el;
  };
  const row = (label, hint, control) => {
    const r = h('label', 'set-row'), info = h('span', 'set-text'), saved = h('span', 'set-saved');
    info.append(h('span', 'set-label', label), typeof hint === 'string' ? h('span', 'set-hint', hint) : hint);
    r.append(info, saved, control);
    let last = control.value;
    control.onchange = async () => {
      saved.textContent = ''; control.disabled = true;
      try {
        const ok = await control.save(control.value);
        if (!ok) control.value = last; else last = control.value;
        saved.textContent = ok ? 'Saved' : '';
        setTimeout(() => { saved.textContent = ''; }, 1500);
      } finally { control.disabled = false; }
    };
    return r;
  };
  const details = title => { const el = h('details', 'set-details'); el.append(h('summary', null, title)); return el; };
  const save = async values => { const result = await ctx.call('setSettings', values); if (!result) return false; st = result; return true; };
  const source = origin => {
    if (!origin) return 'native config';
    const label = { user: 'user config', project: 'project config', system: 'system config', sessionFlags: 'runtime override', packagedDefaults: 'Codex default', mdm: 'managed config', enterpriseManaged: 'managed config' }[origin.type] || 'managed config';
    return origin.profile ? `${label} · ${origin.profile}` : label;
  };

  function general(pane) {
    const engine = select('default-engine', [['', 'Remember per project'], ['claude', 'Claude'], ['codex', 'Codex']], st.defaultEngine, v => save({ defaultEngine: v || null }));
    engine.disabled = !('defaultEngine' in st);
    pane.append(group(`On this host (${host})`),
      row('Theme colour', 'The page colour when a session has none of its own (/color)', select('theme', [['', 'Clay (built in)'], ...ctx.colors.map(n => [n, n[0].toUpperCase() + n.slice(1)])], st.color, v => ctx.setThemeColor(v))),
      row('New session engine', engine.disabled ? 'Reconnect to update this server first' : 'Remember each project’s last choice, or start with a fixed engine', engine),
      group('Across hosts'), link('UI plugins', 'IroWell widgets and the servers they appear on', 'Manage', ctx.openPlugins));
  }
  async function claude(pane) {
    pane.append(note('Loading Claude models…'));
    const models = await ctx.models();
    if (!pane.isConnected) return;
    pane.replaceChildren(note(`Defaults apply to new Claude sessions on ${host}.`), group('New session defaults'));
    if (!models.length) pane.append(note('Claude models are unavailable on this host.'));
    const def = st.defaults;
    const saveDefault = key => value => save({ engine: 'claude', defaults: { [key]: value || null } });
    pane.append(
      row('Model', 'Follow Claude Code, or set an IroWell default', select('claude-model', [['', 'Use Claude config'], ...models.map(m => [m.value, m.displayName || m.value])], def.model, saveDefault('model'))),
      row('Effort', 'How much it thinks before answering', select('claude-effort', [['', 'Use Claude config'], ...ctx.efforts], def.effort, saveDefault('effort'))),
      row('Permission mode', 'How a new Claude session asks before it acts', select('claude-mode', [['', 'Use Claude config'], ...ctx.modes], def.mode, async v => {
        if (v === 'bypassPermissions' && !await ask(null, { ok: 'Bypass permissions' })) return false;
        return saveDefault('mode')(v);
      })), group('Claude features'),
      link('Output style', 'Shared with Claude Code on this host', 'Open', ctx.openStyles),
      link('UI skills', 'Claude’s IroWell instructions · across hosts', 'Manage', ctx.openSkills),
      row('Sampling interval', 'Record Claude subscription usage on this host, whether the page is open or not',
        select('sampling', st.intervals.map(m => [String(m), m === 60 ? 'Every hour' : `Every ${m} minutes`]), String(st.usageInterval), v => save({ usageInterval: Number(v) }))));
  }
  async function codex(pane) {
    if (!('codexDefaults' in st)) {
      pane.append(note('Reconnect to update this server before changing Codex defaults.')); return;
    }
    pane.append(note('Loading Codex configuration…'));
    const info = await ctx.call('codexInfo', {}, { quiet: true });
    if (!pane.isConnected) return;
    if (!info?.installed || info.error) {
      pane.replaceChildren(note(info?.error || 'Codex is not installed on this host.'), button('Install or diagnose Codex →', () => ctx.openCodexAccount(ctx.cwd))); return;
    }
    const [options, models, account] = await Promise.all([
      ctx.call('engineOptions', { engine: 'codex', cwd: ctx.cwd }, { quiet: true }),
      ctx.call('models', { engine: 'codex' }, { quiet: true }),
      ctx.call('engineAccount', { engine: 'codex', cwd: ctx.cwd }, { quiet: true }),
    ]);
    if (!pane.isConnected) return;
    if (!options || !models) {
      pane.replaceChildren(note('Could not read Codex configuration.'), button('Open diagnostics →', () => ctx.openCodexAccount(ctx.cwd))); return;
    }
    pane.replaceChildren(note(ctx.cwd ? `Native configuration preview: ${ctx.cwd}` : 'Native configuration preview: host defaults'));
    const provider = options.provider;
    pane.append(link('Model provider', `${provider.custom ? 'Custom model provider' : 'Model provider'}: ${provider.name}${provider.name !== provider.id ? ` · ${provider.id}` : ''}`, 'Account & details', () => ctx.openCodexAccount(ctx.cwd)));
    if (provider.baseUrl) pane.append(note('API endpoint: ' + provider.baseUrl));
    if (account) pane.append(note(codexAuthLabel(account)));
    if (provider.custom) pane.append(note('Follows native provider settings, including cc-switch. Balance and billing are managed by the provider.'));
    const defaults = h('div');
    const footer = note(`Defaults apply to new Codex sessions on ${host}. Existing conversations keep their settings.`);
    function paintDefaults() {
      const def = st.codexDefaults || {}, selected = models.find(m => m.value === (def.model || options.model));
      const effective = (value, key) => {
        const nativeKey = { effort: 'model_reasoning_effort', permissions: options.sources?.default_permissions ? 'default_permissions' : 'sandbox_mode' }[key] || key;
        const origin = options.sources?.[nativeKey];
        const hint = h('span', 'set-hint', `Effective: ${value || 'Codex default'} · ${def[key] ? 'IroWell default' : source(origin)}`);
        hint.title = origin?.file || origin?.dotCodexFolder || '';
        if (key === 'effort' && value === 'ultra') hint.append(ctx.effortBars(value));
        return hint;
      };
      const update = async values => {
        const ok = await save({ engine: 'codex', cwd: ctx.cwd, defaults: values });
        if (ok) { paintDefaults(); footer.textContent = `Saved · Applies to new Codex sessions on ${host}.`; }
        return ok;
      };
      const permissionOptions = codexPermissionOptions(options), permissionValue = codexPermissionValue(def);
      const permissionLabel = permissionValue ? permissionOptions.find(p => p.value === permissionValue)?.label || permissionValue : permissionOptions[0].label.replace(/^Default(?: · )?/, '') || 'Codex default';
      permissionOptions[0].label = 'Use Codex config';
      defaults.replaceChildren(group('New session defaults'),
        row('Model', effective(selected?.displayName || def.model || options.model, 'model'), select('codex-model', [['', 'Use Codex config'], ...models.map(m => [m.value, m.displayName || m.value])], def.model, v => update({ model: v || null, effort: null }))),
        row('Effort', effective(def.effort || options.effort, 'effort'), select('codex-effort', [['', 'Use Codex config'], ...(selected?.supportedReasoningEfforts || []).map(e => [e.reasoningEffort, e.reasoningEffort])], def.effort, v => update({ effort: v || null }))),
        row('Work mode', 'Execute a task, or discuss a plan first', select('codex-mode', [['default', 'Execute'], ['plan', 'Plan']], def.mode || 'default', v => update({ mode: v }))),
        row('Permissions', effective(permissionLabel, 'permissions'), select('codex-permissions', permissionOptions, permissionValue, async v => {
          if (v === ':danger-full-access' && !await ask('New Codex sessions would run without sandbox restrictions or approval prompts.', { ok: 'Enable full access' })) return false;
          return update(codexPermissionSettings(v));
        })));
    }
    paintDefaults(); pane.append(defaults, group('Native environment'));
    const environment = details('Skills & MCP');
    environment.append(note('Reading the native environment…'));
    environment.ontoggle = async () => {
      if (!environment.open || environment.dataset.loaded) return;
      environment.dataset.loaded = 'true';
      const result = await ctx.call('engineEnvironment', { engine: 'codex', cwd: ctx.cwd, sid: ctx.sid });
      if (!result || !environment.isConnected) { delete environment.dataset.loaded; return; }
      environment.querySelector('.set-note').remove();
      environment.append(group('Skills'));
      const skills = result.skills.flatMap(entry => entry.skills);
      if (!skills.length) environment.append(note('No native skills found for this project.'));
      for (const skill of skills) {
        const entry = details(`${skill.name} · ${skill.scope}${skill.enabled ? '' : ' · disabled'}`);
        entry.append(note(skill.description), h('code', 'set-path', skill.path)); environment.append(entry);
      }
      for (const entry of result.skills) for (const error of entry.errors || []) environment.append(note(`${error.path}: ${error.message}`));
      environment.append(group(result.threadId ? 'MCP · current session' : 'MCP · host configuration'));
      if (!result.threadId) environment.append(note('Open a Codex session to inspect its MCP connections for this project.'));
      if (!result.mcp.length) environment.append(note('No MCP servers found.'));
      for (const server of result.mcp) {
        const status = { notStarted: 'Not started', starting: 'Connecting', connected: 'Connected', authenticationRequired: 'Authentication required', failed: 'Connection failed', cancelled: 'Cancelled', disabled: 'Disabled' }[server.runtimeStatus] || 'Connection status unavailable';
        const auth = { notLoggedIn: 'Not signed in', bearerToken: 'API token', oAuth: 'OAuth', unsupported: 'No sign-in support' }[server.authStatus] || server.authStatus;
        environment.append(note(`${server.name} · ${status} · ${auth}`));
      }
    };
    const runtime = details('Configuration & runtime');
    runtime.append(note(`Codex ${info.version} · ${info.platform}`), h('code', 'set-path', info.home),
      note('New sessions resolve native configuration for their own project. This does not change existing sessions or write to Codex configuration.'),
      button('Re-read native configuration ↻', async () => { ctx.refreshCodex(); await show('codex'); }));
    pane.append(environment, runtime, footer);
  }
  async function show(name) {
    st = ctx.getSettings();
    for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    const pane = h('div', 'set-content'); pane.id = `settings-${name}`; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', `settings-tab-${name}`);
    content.replaceChildren(pane);
    await ({ general, claude, codex })[name](pane);
  }
  for (const name of ['general', 'claude', 'codex']) {
    const tab = button(name === 'general' ? 'General' : name === 'claude' ? 'Claude' : 'Codex', () => show(name));
    tab.className = 'set-tab'; tab.dataset.tab = name; tab.id = `settings-tab-${name}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', `settings-${name}`); tabs.append(tab);
  }
  void show(ctx.engine || 'general');
}
