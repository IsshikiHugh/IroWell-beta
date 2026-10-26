import { h, markdown, toolCard, unifiedDiff } from './render.js';
import { enhanceSelect } from './dropdown.js';

const button = (text, run, cls = '') => { const b = h('button', cls, text); b.type = 'button'; b.onclick = run; return b; };
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

const permissionLabels = {
  ':read-only': ['Read only', 'Read files; ask before changes outside the sandbox', 'default'],
  ':workspace': ['Auto · workspace', 'Edit files and run commands in the workspace; ask before going outside it', 'acceptEdits'],
  ':danger-full-access': ['Full access', 'No sandbox restrictions or approval prompts', 'bypassPermissions'],
};
export const codexPermissionValue = s => s.permissions === ':workspace' && s.approvalsReviewer === 'auto_review' ? 'auto-review' : s.permissions || '';
export const codexPermissionSettings = value => ({ permissions: value === 'auto-review' ? ':workspace' : value || null, approvalsReviewer: value === 'auto-review' ? 'auto_review' : null });
export function codexPermissionOptions(options = {}) {
  const native = options.defaultPermissions, auto = options.approvalsReviewer === 'auto_review', requirements = options.requirements;
  const allowed = (policy, reviewer) => (!requirements?.allowedApprovalPolicies || requirements.allowedApprovalPolicies.includes(policy))
    && (!requirements?.allowedApprovalsReviewers || requirements.allowedApprovalsReviewers.includes(reviewer));
  const choices = [{ value: '', label: `Default${auto ? ' · Auto-review' : permissionLabels[native] ? ' · ' + permissionLabels[native][0] : ''}`, description: 'Use native Codex permissions' }];
  for (const p of options.permissions || []) {
    const [label, description, tone] = permissionLabels[p.id] || [p.id, p.description || '', 'default'];
    choices.push({ value: p.id, label, description: p.description || description, tone,
      disabled: p.allowed === false || (!!permissionLabels[p.id] && !allowed(p.id === ':danger-full-access' ? 'never' : 'on-request', 'user')) });
    if (p.id === ':workspace') choices.push({ value: 'auto-review', label: 'Auto-review · Approve for me', tone: 'auto',
      description: 'Automatically review requests to go outside the workspace; keep sandbox restrictions', disabled: p.allowed === false || !allowed('on-request', 'auto_review') });
  }
  return choices;
}
export function codexAuthLabel(a) {
  const p = a.provider;
  return p?.envKey ? `Authentication: environment variable ${p.envKey}`
    : a.requiresOpenaiAuth === false ? 'Authentication: provider configuration; no OpenAI sign-in required'
    : a.account ? `${p?.custom ? 'Native Codex credential: ' : ''}${a.account.type === 'chatgpt' ? (p?.custom ? 'ChatGPT' : 'ChatGPT subscription') : 'API key'}${a.account.email ? ' · ' + a.account.email : ''}${a.account.planType ? ' · ' + a.account.planType : ''}`
    : p?.custom ? 'Native Codex account credential: unavailable' : 'Not signed in';
}

// Native items retain their identities from streaming through history/reconnect.
export function createCodexFeed({ startTurn, turn, preamble, sendApproval, loadImage, completed, plan }) {
  const turns = new Map(), items = new Map(), pending = new Map(), images = new Set();
  function ensure(id, item) {
    if (!turns.has(id)) {
      const text = item?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || 'Codex';
      startTurn({ text, turnId: id, uuid: item?.id, engine: 'codex' });
      const t = turn(); t.codexId = id; turns.set(id, t);
    } else if (item?.type === 'userMessage') {
      turns.get(id).sec.querySelector('.turn-q-text').textContent = item.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
    }
    return turns.get(id);
  }
  function update(item, turnId, done = false) {
    const t = ensure(turnId, item);
    if (item.type === 'userMessage') {
      if (!images.has(item.id)) {
        images.add(item.id);
        const row = h('div', 'thumbs');
        for (const part of item.content || []) {
          if (part.type === 'image') { const im = h('img'); im.src = part.url; im.loading = 'lazy'; row.append(im); }
          else if (part.type === 'localImage') {
            const im = h('img'); im.alt = part.path; im.loading = 'lazy'; row.append(im);
            loadImage(part.path).then(r => { if (r) im.src = `data:${r.media_type};base64,${r.data}`; });
          }
        }
        if (row.childNodes.length) t.sec.querySelector('.turn-q-scroll').append(row);
      }
      return;
    }
    let entry = items.get(item.id);
    if (!entry) {
      const el = h('div', 'codex-item');
      t.body.append(el); entry = { el, item }; items.set(item.id, entry);
    }
    entry.item = item;
    const { el } = entry;
    el.dataset.item = item.id;
    if (item.type === 'agentMessage') {
      el.classList.toggle('codex-commentary', item.phase === 'commentary');
      const text = markdown(item.text || ''); text.classList.add('assistant');
      el.replaceChildren(text);
    } else if (item.type === 'reasoning') {
      const open = el.querySelector('details')?.open;
      const detail = h('details', 'thinking');
      detail.append(h('summary', null, 'Thinking'), markdown(item.text || (item.summary || []).join('\n')));
      detail.open = open || false; el.replaceChildren(detail);
    } else {
      if (!entry.api) {
        const tool = item.type === 'commandExecution' ? { name: 'Bash', input: { command: item.command, description: item.command } }
          : item.type === 'fileChange' ? { name: 'File changes' }
          : item.type === 'mcpToolCall' ? { name: `mcp__${item.server}__${item.tool}`, input: item.arguments }
          : item.type === 'webSearch' ? { name: 'WebSearch', input: { query: item.query } }
          : item.type === 'collabAgentToolCall' ? { name: 'Agent', input: { description: item.tool, prompt: item.prompt } }
          : { name: item.type, input: item };
        entry.api = toolCard({ id: item.id, ...tool });
        el.replaceChildren(entry.api.card);
      }
      const api = entry.api, failed = !!item.exitCode || item.status === 'failed';
      if (item.type === 'fileChange') {
        const body = api.card.querySelector('.tool-body'); body.replaceChildren();
        for (const change of item.changes || []) body.append(markdown(`[${change.path}](${change.path})`), unifiedDiff(change.diff || ''));
        api.card.querySelector('.tool-sum').textContent = (item.changes || []).map(c => c.path.split('/').pop()).join(', ');
      } else {
        const content = item.type === 'commandExecution' ? item.aggregatedOutput || ''
          : item.type === 'mcpToolCall' ? pretty(item.result || item.error || '')
          : item.type === 'collabAgentToolCall' ? Object.values(item.agentsStates || {}).map(a => `${a.status}${a.message ? '\n' + a.message : ''}`).join('\n')
          : item.type === 'webSearch' ? item.query || pretty(item.action) : pretty(item);
        api.setResult({ content, is_error: failed });
      }
      api.card.classList.toggle('running', !done);
      api.card.classList.toggle('done', done && !failed);
      api.card.classList.toggle('error', failed);
    }
  }
  function addHistory(page) {
    for (const t of page.turns || []) {
      for (const item of t.items || []) update(item, t.id, t.status !== 'inProgress');
      finish(t);
    }
  }
  function finish(t) {
    const row = turns.get(t.id);
    if (!row) return;
    row.lastUuid = t.status === 'inProgress' ? null : t.id;
    row.foot.replaceChildren(h('span', 'meta', { inProgress: 'Working…', completed: 'Completed', interrupted: 'Interrupted', failed: 'Failed' }[t.status] || ''));
    if (t.error?.message) row.body.append(h('div', 'err', t.error.message));
    completed?.(t);
  }
  function event(e) {
    if (e.kind === 'codex_history' || e.kind === 'codex_reset') addHistory(e);
    else if (e.kind === 'codex_item') update(e.item, e.turnId, e.completed);
    else if (e.kind === 'codex_delta') {
      const prior = items.get(e.itemId)?.item;
      const command = e.method.includes('commandExecution');
      const item = { ...(prior || { id: e.itemId, type: command ? 'commandExecution' : e.method.includes('reasoning') ? 'reasoning' : 'agentMessage' }) };
      const field = command ? 'aggregatedOutput' : 'text'; item[field] = (item[field] || '') + e.delta;
      update(item, e.turnId);
    } else if (e.kind === 'codex_progress') {
      const entry = items.get(e.itemId);
      if (entry) { let p = entry.el.querySelector('.codex-progress'); if (!p) { p = h('div', 'codex-progress'); entry.el.append(p); } p.textContent = e.message; }
    } else if (e.kind === 'codex_turn') finish(e.turn);
    else if (e.kind === 'codex_plan') plan(e.plan || []);
    else if (e.kind === 'codex_diff') {
      const t = ensure(e.turnId);
      let d = t.body.querySelector('.codex-turn-diff');
      if (!d) {
        d = toolCard({ id: e.turnId + '-diff', name: 'Changes', input: { description: 'Files changed this turn' } }).card;
        d.classList.add('codex-turn-diff', 'done'); d.classList.remove('running'); t.body.append(d);
      }
      d.querySelector('.tool-body').replaceChildren(unifiedDiff(e.diff));
    } else if (e.kind === 'codex_approval') {
      if (pending.has(e.rid)) return;
      const card = approvalCard(e, result => sendApproval(e.rid, result));
      let api = items.get(e.params.itemId)?.api;
      if (!api) {
        api = toolCard({ id: e.rid, name: e.method.includes('requestUserInput') ? 'AskUserQuestion' : 'Approval', input: { questions: e.params.questions } });
        (e.params.turnId ? ensure(e.params.turnId).body : preamble()).append(api.card);
      }
      api.setApproval(card);
      pending.set(e.rid, { card, api });
    } else if (e.kind === 'codex_approval_done') {
      const request = pending.get(e.rid);
      if (request) { request.card.replaceChildren(h('span', 'meta', 'Request resolved')); request.card.classList.add('settled'); request.api.card.classList.remove('asking'); pending.delete(e.rid); }
    }
  }
  return { event };
}

function approvalCard(e, send) {
  const p = e.params, card = h('div', 'approval codex-approval');
  const title = p.reason || (e.method.includes('requestUserInput') ? 'Codex needs your answer' : 'Codex needs your approval');
  if (!e.method.includes('requestUserInput')) card.append(h('div', 'ask', title));
  const actions = h('div', 'btns');
  const submit = async result => {
    for (const b of actions.querySelectorAll('button')) b.disabled = true;
    try { await send(result); } finally { for (const b of actions.querySelectorAll('button')) b.disabled = false; }
  };
  if (e.method === 'item/tool/requestUserInput') {
    const fields = new Map();
    for (const q of p.questions) {
      const field = h('div', 'q'); field.append(h('div', 'qtext', q.question));
      const opts = h('div', 'opts');
      const input = h(q.isSecret ? 'input' : 'textarea', 'other'); if (q.isSecret) input.type = 'password'; else input.rows = 1; input.placeholder = 'Type your own answer'; input.setAttribute('aria-label', q.question);
      for (const o of q.options || []) {
        const lab = h('label', 'opt'), radio = h('input'), text = h('span', 'opt-text');
        radio.type = 'radio'; radio.name = `${e.rid}-${q.id}`; radio.value = o.label;
        text.append(h('span', 'opt-label', o.label)); if (o.description) text.append(h('span', 'desc', o.description));
        lab.append(radio, text); opts.append(lab);
      }
      opts.onchange = () => { input.value = ''; };
      input.oninput = () => { opts.querySelectorAll('input').forEach(r => { r.checked = false; }); };
      field.append(opts, input); card.append(field); fields.set(q.id, () => input.value || opts.querySelector('input:checked')?.value || '');
    }
    actions.append(button('Submit', () => submit({ answers: Object.fromEntries([...fields].map(([id, read]) => [id, { answers: [read()] }])) }), 'primary'));
  } else if (e.method === 'item/permissions/requestApproval') {
    card.append(h('pre', null, pretty(p.permissions)));
    actions.append(button('Allow this turn', () => submit({ permissions: p.permissions, scope: 'turn' }), 'primary'),
      button('Allow this session', () => submit({ permissions: p.permissions, scope: 'session' })), button('Deny', () => submit({ permissions: {}, scope: 'turn' })));
  } else if (e.method === 'mcpServer/elicitation/request') {
    card.append(h('div', null, p.message || 'MCP request'));
    const fields = [];
    if (p.url) {
      const a = h('a', null, 'Open authorization page ↗');
      if (/^https?:\/\//.test(p.url)) a.href = p.url;
      a.target = '_blank'; a.rel = 'noopener noreferrer'; card.append(a);
    }
    for (const [name, schema] of Object.entries(p.requestedSchema?.properties || {})) {
      const label = h('label', null, schema.title || name);
      const multiple = schema.type === 'array';
      const choices = schema.oneOf || schema.enum?.map((value, i) => ({ const: value, title: schema.enumNames?.[i] || String(value) }))
        || schema.items?.anyOf || schema.items?.enum?.map(value => ({ const: value, title: String(value) }));
      const json = !choices && !['string', 'boolean', 'integer', 'number'].includes(schema.type);
      const input = h(choices ? 'select' : json ? 'textarea' : 'input');
      if (choices) {
        input.multiple = multiple;
        for (const c of choices) { const o = h('option', null, c.title || c.const); o.value = c.const; o.selected = multiple ? schema.default?.includes(c.const) : schema.default === c.const; input.append(o); }
      } else if (!json) input.type = schema.type === 'boolean' ? 'checkbox' : ['integer', 'number'].includes(schema.type) ? 'number' : schema.format === 'email' ? 'email' : 'text';
      if (schema.type === 'boolean') input.checked = schema.default === true;
      else if (!choices && schema.default != null) input.value = json ? pretty(schema.default) : schema.default;
      if (schema.description) input.title = schema.description;
      for (const [key, attr] of [['minLength', 'minLength'], ['maxLength', 'maxLength'], ['minimum', 'min'], ['maximum', 'max']]) if (schema[key] != null) input[attr] = schema[key];
      if (schema.type === 'number') input.step = 'any';
      input.required = p.requestedSchema?.required?.includes(name) && schema.type !== 'boolean';
      const value = () => choices && multiple ? [...input.selectedOptions].map(o => o.value) : json ? JSON.parse(input.value) : schema.type === 'boolean' ? input.checked : ['number', 'integer'].includes(schema.type) ? Number(input.value) : input.value;
      input.oninput = () => input.setCustomValidity('');
      label.append(input); card.append(label); fields.push({ name, input, value });
    }
    actions.append(button('Submit', () => {
      const content = {};
      for (const f of fields) {
        if (!f.input.reportValidity()) return;
        if (!f.input.required && !f.input.value && f.input.type !== 'checkbox') continue;
        try { content[f.name] = f.value(); } catch { f.input.setCustomValidity('Enter valid JSON for this field'); f.input.reportValidity(); return; }
      }
      submit({ action: 'accept', ...(p.mode === 'url' ? {} : { content }) });
    }, 'primary'), button('Decline', () => submit({ action: 'decline' })), button('Cancel', () => submit({ action: 'cancel' })));
  } else {
    if (p.command) card.append(h('pre', null, p.command));
    if (p.cwd) card.append(h('div', 'muted', p.cwd));
    if (p.grantRoot) card.append(h('div', null, `Write scope: ${p.grantRoot}`));
    if (p.additionalPermissions) card.append(h('pre', null, pretty(p.additionalPermissions)));
    const labels = { accept: 'Allow once', acceptForSession: 'Allow this session', decline: 'Deny', cancel: 'Cancel turn' };
    const choices = p.availableDecisions || ['accept', 'acceptForSession', 'decline', 'cancel'];
    for (const decision of choices) {
      const label = typeof decision === 'string' ? labels[decision] || decision : 'Apply persistent rule';
      if (typeof decision === 'object') card.append(h('pre', null, pretty(decision)));
      actions.append(button(label, () => submit({ decision }), decision === 'accept' ? 'primary' : ''));
    }
  }
  card.append(actions); return card;
}

export function createCodexControls({ call, session, host, redraw, openModal, onClose, ask, openModelPanel, effortBars, modeView, modeItem }) {
  const controls = h('div', 'codex-controls');
  const model = h('select'), effort = h('select'), mode = h('select'), permissions = h('select');
  model.id = 'codexModel'; effort.id = 'codexEffort'; mode.id = 'codexMode'; permissions.id = 'codexPermissions';
  const accountButton = button('Codex account', () => showAccount(), 'sb-act'); accountButton.id = 'codexAccount';
  const modelButton = button('', openModelPanel, 'dd-btn mb-btn'); modelButton.id = 'codexModelBtn'; modelButton.title = 'Model and effort (⌥M)';
  const option = (select, value, label) => { const o = h('option', null, label); o.value = value; select.append(o); return o; };
  for (const [el, title] of [[model, 'Model'], [effort, 'Reasoning effort'], [mode, 'Work mode'], [permissions, 'Permissions']]) { el.title = title; el.setAttribute('aria-label', title); }
  option(mode, 'default', 'Execute').title = 'Make changes and run commands';
  option(mode, 'plan', 'Plan').title = 'Discuss a plan before implementation';
  model.className = effort.className = 'dd-native';
  controls.append(model, effort, modelButton, mode, permissions, accountButton);
  const menus = [mode, permissions].map(el => enhanceSelect(el, { className: 'dd-modepick', button: modeView, item: modeItem }));
  const catalogs = new Map();
  let key = '', loaded = null, error = null, refreshAccount = null, shownModel, shownEffort;
  function reset() { catalogs.clear(); key = ''; loaded = error = null; }
  async function change(type, values) {
    const { s, sid } = session();
    if (s.draft) {
      Object.assign(s, values);
      s[{ setModel: 'modelSet', setEffort: 'effortSet', setMode: 'modeSet', setPermissions: 'permissionsSet' }[type]] = true;
      if (type === 'setModel') s.effortSet = true;
    }
    else {
      s.codexSettingsPending = true; redraw();
      try { const r = await call(type, { sid, engine: 'codex', ...values }); if (r !== undefined) Object.assign(s, values); }
      finally { s.codexSettingsPending = false; redraw(); }
    }
    redraw();
  }
  model.onchange = () => change('setModel', { model: model.value, modelChoice: model.value, effort: '', effortChoice: '' });
  effort.onchange = () => change('setEffort', { effort: effort.value, effortChoice: effort.value });
  mode.onchange = () => change('setMode', { mode: mode.value, modeSet: true });
  permissions.onchange = async () => {
    if (permissions.value === ':danger-full-access' && !await ask('Codex can access files and run commands without sandbox restrictions or approval prompts.', { ok: 'Enable full access' })) return redraw();
    change('setPermissions', codexPermissionSettings(permissions.value));
  };
  async function load(s) {
    const k = `${host()}\n${s.cwd}`;
    if (key !== k) { key = k; loaded = null; error = null; }
    if (!catalogs.has(k)) catalogs.set(k, Promise.all([
      call('models', { engine: 'codex' }, { quiet: true }), call('engineOptions', { engine: 'codex', cwd: s.cwd }, { quiet: true }),
    ]).then(([models, options]) => models && options ? { models, options } : null));
    const data = await catalogs.get(k);
    if (key !== k) return;
    if (!data) { error = 'Open Codex account to install or diagnose'; render(); return; }
    loaded = data; render();
  }
  function render() {
    const { s } = session();
    controls.hidden = s?.engine !== 'codex';
    if (controls.hidden) return;
    const k = `${host()}\n${s.cwd}`;
    if (key !== k || (!loaded && !error)) void load(s);
    const provider = loaded?.options.provider;
    accountButton.textContent = provider?.custom ? `Codex · ${provider.id}` : 'Codex account';
    accountButton.title = provider ? `${provider.custom ? 'Custom model provider' : 'Model provider'}: ${provider.name}${provider.baseUrl ? '\n' + provider.baseUrl : ''}` : 'Codex account and runtime';
    const models = loaded?.models || [];
    model.replaceChildren(); option(model, '', 'Native model');
    for (const m of models) option(model, m.value, m.displayName || m.value);
    model.value = s.modelChoice || '';
    const current = models.find(m => m.value === (s.modelChoice || s.model || loaded?.options.model));
    const effectiveEffort = s.effortChoice || s.effort || loaded?.options.effort;
    const modelName = current?.displayName || s.modelChoice || s.model || loaded?.options.model || 'Model';
    // Keep the bars mounted while streaming so the Ultra animation can finish its cycle.
    if (shownModel !== modelName || shownEffort !== effectiveEffort) {
      const eff = h('span', 'dd-effort');
      eff.append(effortBars(effectiveEffort), h('span', 'dd-label', effectiveEffort || 'Default'));
      modelButton.replaceChildren(h('span', 'dd-label mb-name', modelName), eff);
      shownModel = modelName; shownEffort = effectiveEffort;
    }
    effort.replaceChildren(); option(effort, '', 'Native effort');
    for (const e of current?.supportedReasoningEfforts || []) option(effort, e.reasoningEffort, e.reasoningEffort);
    effort.value = s.effortChoice || '';
    mode.value = s.mode || 'default';
    permissions.replaceChildren();
    for (const p of codexPermissionOptions({ ...loaded?.options, defaultPermissions: s.permissionLabel || loaded?.options.defaultPermissions, approvalsReviewer: s.effectiveReviewer || loaded?.options.approvalsReviewer })) {
      const o = option(permissions, p.value, p.label); o.dataset.tone = p.tone || 'default'; o.title = p.description; o.disabled = !!p.disabled;
    }
    permissions.value = codexPermissionValue(s);
    for (const el of [model, effort, mode, permissions]) el.disabled = !loaded || !!s.pending || s.codexSettingsPending || s.closed || s.state === 'ended';
    modelButton.disabled = model.disabled;
    for (const menu of menus) menu.refresh();
    controls.title = error || (s.state === 'running' || s.state === 'waiting' ? 'Changes apply to the next turn' : 'Uses the execution machine’s native Codex configuration');
  }
  async function showAccount({ cwd = session().s?.cwd } = {}) {
    const body = openModal('Codex · provider, account and runtime');
    let timer, login;
    onClose(() => { refreshAccount = null; clearTimeout(timer); if (login) void call('authCancel', { engine: 'codex' }); });
    async function draw() {
      const info = await call('codexInfo');
      if (!info || !body.isConnected) return;
      body.replaceChildren(h('div', 'muted', `Codex ${info.version} · ${info.platform || ''}`), h('div', 'muted', info.home));
      if (!info.installed || info.error) {
        body.append(h('p', null, info.error || 'Install the pinned Codex runtime on this host. Your global Codex installation is kept.'), button(info.installing ? 'Installing…' : 'Install on this host', async () => { await call('codexInstall'); draw(); }, 'primary'));
        body.querySelector('button').disabled = info.installing;
        if (info.installing) timer = setTimeout(draw, 1500);
        return;
      }
      const a = await call('engineAccount', { engine: 'codex', cwd });
      if (!a || !body.isConnected) return;
      const p = a.provider;
      if (p) {
        body.append(h('p', null, `${p.custom ? 'Using custom model provider' : 'Model provider'}: ${p.id}${p.name !== p.id ? ' · ' + p.name : ''}`));
        if (p.baseUrl) body.append(h('p', null, 'API endpoint: ' + p.baseUrl));
      }
      body.append(h('p', null, codexAuthLabel(a)));
      if (p?.custom) body.append(h('p', 'muted', 'Uses this host’s native Codex provider settings, including changes made by cc-switch. Balance and usage are managed by your provider.'));
      const buckets = a.limits?.rateLimitsByLimitId || (a.limits?.rateLimits ? { codex: a.limits.rateLimits } : {});
      for (const [name, bucket] of Object.entries(buckets)) for (const w of [bucket.primary, bucket.secondary].filter(Boolean)) {
        body.append(h('div', 'codex-limit', `${bucket.limitName || name} · ${w.windowDurationMins ?? '?'} min · ${w.usedPercent ?? '?'}% used${w.resetsAt ? ' · resets ' + new Date(w.resetsAt * 1000).toLocaleString() : ''}`));
      }
      if (!p?.custom && !Object.keys(buckets).length) body.append(h('div', 'muted', 'Subscription limits unavailable'));
      const startLogin = async params => {
        if (a.account && !await ask('This changes the native Codex login on this host, including other Codex clients.', { ok: 'Change login' })) return;
        const r = await call('authLogin', { engine: 'codex', ...params });
        if (!r) return;
        if (!body.isConnected) { if (r.loginId) await call('authCancel', { engine: 'codex' }); return; }
        if (r.type === 'apiKey') { reset(); redraw(); return draw(); }
        login = r.loginId;
        body.replaceChildren(h('p', null, 'Complete sign-in in your browser.'));
        const link = h('a', null, 'Open sign-in page ↗'); link.href = r.verificationUrl || r.authUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; body.append(link);
        if (r.userCode) body.append(h('pre', null, r.userCode));
        body.append(button('I have completed sign-in', async () => { login = null; reset(); redraw(); await draw(); }));
      };
      const loginControls = p?.custom ? h('details') : body;
      if (p?.custom) { loginControls.append(h('summary', null, 'Manage native Codex login')); body.append(loginControls); }
      loginControls.append(button('Sign in with ChatGPT', () => startLogin({ device: host() !== 'local' }), 'primary'));
      if (host() !== 'local') loginControls.append(h('p', 'muted', 'If device login is disabled, enable it in ChatGPT security settings, or use codex login over an SSH forward of localhost:1455.'));
      const keyInput = h('input'); keyInput.type = 'password'; keyInput.placeholder = 'API key (billed separately)'; keyInput.autocomplete = 'off';
      loginControls.append(keyInput, button('Use API key', () => { const apiKey = keyInput.value; keyInput.value = ''; if (apiKey) startLogin({ apiKey }); }));
      if (a.account) loginControls.append(button('Sign out', async () => { if (await ask('This signs out native Codex on this host, including other Codex clients.', { ok: 'Sign out' })) { await call('authLogout', { engine: 'codex' }); draw(); } }));
    }
    refreshAccount = async d => { if (d.op === 'codex-login') login = null; await draw(); if (d.error && body.isConnected) body.append(h('p', 'err', d.error)); };
    await draw();
  }
  return { el: controls, render, showAccount, reset, modelButton,
    modelPicker() {
      if (!loaded || model.disabled) return null;
      return { choices: [{ value: '', displayName: 'Default · ' + (loaded.options.model || 'Native model'), description: 'Use the native Codex model configuration' }, ...loaded.models],
        value: model.value, effort: effort.value, efforts(value) {
          const m = loaded.models.find(m => m.value === (value || loaded.options.model));
          return [['', 'Default', 'Use native reasoning effort'], ...(m?.supportedReasoningEfforts || []).map(e => [e.reasoningEffort, e.reasoningEffort, e.description || ''])];
        }, async apply(value, reasoning) {
          if (value !== model.value) await change('setModel', { model: value, modelChoice: value, effort: '', effortChoice: '' });
          await change('setEffort', { effort: reasoning, effortChoice: reasoning });
        } };
    }, onPartial(d) {
    if (d.op === 'codex-install' || d.op === 'codex-account' || d.op === 'codex-login') { reset(); redraw(); }
    if (d.op !== 'codex-limits') void refreshAccount?.(d);
  } };
}
