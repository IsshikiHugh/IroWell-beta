import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CodexRpc, codexInstallation } from './codex-rpc.mjs';

const UI_INSTRUCTIONS = 'The user reads this conversation in IroWell, a web UI. Use Markdown links with absolute paths for local files. Use Markdown links for web URLs. Tool output, plans, progress messages and final answers have their own UI; no custom text markers are needed.';
const approvals = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']);
const busy = s => s.starting || s.turnId || s.pending.size || s.outbox.length || s.recovering;
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

function providerInfo(config) {
  const id = config.model_provider || 'openai', p = config.model_providers?.[id] || {};
  // Only display fields cross into the UI; provider config can contain credentials and headers.
  let baseUrl = null;
  if (p.base_url) {
    const url = new URL(p.base_url);
    url.username = url.password = url.search = url.hash = '';
    baseUrl = url.toString();
  }
  return { id, name: p.name || id, custom: !['openai', 'ollama', 'lmstudio'].includes(id), baseUrl,
    envKey: p.requires_openai_auth ? null : p.env_key || null };
}

function permissionSettings(s) {
  if (!s.permissions) return s.nativePermissionSettings;
  const builtin = s.permissions.startsWith(':');
  return { ...s.nativePermissionSettings, permissions: s.permissions,
    ...(builtin ? { approvalPolicy: s.permissions === ':danger-full-access' ? 'never' : 'on-request', approvalsReviewer: s.approvalsReviewer || 'user' } : {}) };
}

const nativePermissions = config => config.default_permissions || { 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access' }[config.sandbox_mode];

// Codex owns its history/config/credentials. This file only stores IroWell presentation and unsent input.
export function createCodex({ dir, sessions, remote, emit, partial, resetEvents, resolveDir, addFolder, closeShells = () => {} }) {
  const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const stateDir = path.join(dir, 'codex', createHash('sha256').update(home).digest('hex').slice(0, 12));
  const recordsDir = path.join(stateDir, 'threads');
  const recordPath = id => path.join(recordsDir, createHash('sha256').update(id).digest('hex') + '.json');
  const records = () => fs.existsSync(recordsDir) ? Object.fromEntries(fs.readdirSync(recordsDir).filter(f => f.endsWith('.json')).map(f => { const r = read(path.join(recordsDir, f)); return [r.nativeSessionId, r]; })) : {};
  const installation = codexInstallation(dir), rpc = new CodexRpc(installation);
  const starting = new Map(), nonces = new Map(), closing = new Map(), children = new Map();
  const requestKey = id => `${process.pid}:${id}`;
  let loginId = null, changingAccount = false, account = null, limits = null;
  const own = () => [...sessions.values()].filter(s => s.engine === 'codex');
  const leases = new Set();
  const leasePath = id => path.join(stateDir, `lease-${createHash('sha256').update(id).digest('hex')}`);
  function claim(id) {
    if (leases.has(id)) return;
    const file = leasePath(id);
    fs.mkdirSync(stateDir, { recursive: true });
    if (fs.existsSync(file)) {
      const owner = read(file);
      let running = false;
      if (owner.pid) try { process.kill(owner.pid, 0); running = true; } catch (e) { running = e.code !== 'ESRCH'; }
      if (running) throw new Error('Another IroWell runtime still owns this Codex conversation');
      fs.rmSync(file, { force: true });
    }
    fs.writeFileSync(file, JSON.stringify({ pid: rpc.proc.pid }), { flag: 'wx', mode: 0o600 });
    leases.add(id);
  }
  function unclaim(id) { if (leases.delete(id)) fs.rmSync(leasePath(id), { force: true }); }
  const find = id => own().find(s => s.nativeSessionId === id && !s.closed);
  const event = (s, e) => emit(s.id, { engine: 'codex', nativeSessionId: s.nativeSessionId, ...e });
  function save(s, extra = {}) {
    if (!s.nativeSessionId) return;
    fs.mkdirSync(recordsDir, { recursive: true });
    const file = recordPath(s.nativeSessionId), previous = read(file);
    const record = { ...previous, nativeSessionId: s.nativeSessionId, cwd: s.cwd, title: s.title, color: s.color, t: s.lastMsgAt || s.created || previous.t,
      ...(s.pending ? { model: s.modelChoice, effort: s.effortChoice, mode: s.mode, permissions: s.permissions, approvalsReviewer: s.approvalsReviewer, outbox: s.outbox } : {}), ...extra };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const state = (s, value) => { s.state = value; event(s, { kind: 'state', state: value }); };
  const queueChanged = s => { save(s); event(s, { kind: 'queue', items: s.outbox.map(m => ({ qid: m.qid, text: m.text, images: m.images.length })) }); };
  const requireSession = sid => {
    const s = sessions.get(sid);
    if (!s || s.engine !== 'codex' || s.closed) throw new Error('Codex session is not running');
    return s;
  };
  async function validatePermissions(s) {
    const [list, { requirements }] = await Promise.all([rpc.call('permissionProfile/list', { cwd: s.cwd }), rpc.call('configRequirements/read')]);
    if (s.permissions && !list.data.some(p => p.id === s.permissions && p.allowed !== false)) throw new Error('This permission profile is not available');
    if (s.approvalsReviewer && !['user', 'auto_review'].includes(s.approvalsReviewer)) throw new Error('Unknown approval reviewer');
    const selected = permissionSettings(s);
    if (selected?.approvalsReviewer && requirements?.allowedApprovalsReviewers && !requirements.allowedApprovalsReviewers.includes(selected.approvalsReviewer)) throw new Error('This approval reviewer is not allowed on this host');
    if (selected?.approvalPolicy && requirements?.allowedApprovalPolicies && !requirements.allowedApprovalPolicies.some(p => JSON.stringify(p) === JSON.stringify(selected.approvalPolicy))) throw new Error('This approval policy is not allowed on this host');
  }
  function create(args, sid = randomUUID().slice(0, 8)) {
    const s = { id: sid, engine: 'codex', nativeSessionId: args.nativeSessionId, cwd: args.cwd, title: args.title || args.text?.trim().slice(0, 60) || 'New session',
      modelChoice: args.model, effortChoice: args.effort, mode: args.mode || 'default', permissions: args.permissions, approvalsReviewer: args.approvalsReviewer,
      color: args.color, state: 'idle', created: Date.now(), pending: new Map(), tasks: new Map(), outbox: args.outbox || [],
      items: new Map(), sent: new Set(args.sent || []), starting: true };
    s.done = new Promise(resolve => { s.finished = resolve; });
    sessions.set(sid, s);
    return s;
  }
  function effective(s, result) {
    s.nativeSessionId = result.thread.id;
    s.model = result.model;
    s.effort = result.reasoningEffort;
    s.cwd = result.cwd || result.thread.cwd || s.cwd;
    s.permissionLabel = result.activePermissionProfile?.title || result.activePermissionProfile?.id || JSON.stringify(result.sandbox);
    s.nativePermissions = result.activePermissionProfile?.id;
    s.approvalPolicy = result.approvalPolicy;
    s.effectiveReviewer = result.approvalsReviewer;
    s.historyMode = result.thread.historyMode;
    s.starting = false;
    save(s, { hidden: false, managed: true });
  }
  async function threadParams(args) {
    const { config } = await rpc.call('config/read', { cwd: args.cwd });
    const nativePermissionSettings = { permissions: nativePermissions(config) || ':workspace',
      approvalPolicy: config.approval_policy || 'on-request', approvalsReviewer: config.approvals_reviewer || 'user' };
    return { nativePermissionSettings, params: { cwd: args.cwd, config: { thread_unload_delay_secs: 0 }, ...(args.model ? { model: args.model } : {}),
      ...(args.permissions ? permissionSettings({ ...args, nativePermissionSettings }) : {}),
      developerInstructions: [config.developer_instructions, UI_INSTRUCTIONS].filter(Boolean).join('\n\n') } };
  }
  async function open(args, sid, method = 'thread/start') {
    const cwd = resolveDir(args.cwd);
    if (!cwd) throw new Error(`Not a directory on this host: ${args.cwd}`);
    const { params, nativePermissionSettings } = await threadParams({ ...args, cwd });
    const s = create({ ...args, cwd }, sid);
    s.nativePermissionSettings = nativePermissionSettings;
    try {
      if (method === 'thread/resume') claim(args.nativeSessionId);
      const result = await rpc.call(method, { ...params, ...(args.nativeSessionId ? { threadId: args.nativeSessionId, excludeTurns: true } : { serviceName: 'irowell' }),
        ...(method === 'thread/fork' ? { deferGoalContinuation: true } : {}), ...(args.at ? { lastTurnId: args.at } : {}) });
      // Notifications may arrive before the response: thread/started contains the identity.
      effective(s, result);
      if (!args.permissions) s.nativePermissionSettings = { permissions: s.nativePermissions, approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer };
      if (method !== 'thread/resume') claim(s.nativeSessionId);
      addFolder(s.cwd);
      event(s, { kind: 'created', cwd: s.cwd, title: s.title, nonce: args.nonce, model: s.model, modelChoice: s.modelChoice, mode: s.mode, effort: s.effort, effortChoice: s.effortChoice,
        color: s.color, permissions: s.permissions, approvalsReviewer: s.approvalsReviewer, historyMode: s.historyMode, resumed: method !== 'thread/start', fromUi: true });
      event(s, { kind: 'init', model: s.model, effort: s.effort, mode: s.mode, permissionLabel: s.permissionLabel, effectiveReviewer: s.effectiveReviewer, historyMode: s.historyMode });
      if (method !== 'thread/start') {
        const page = await history(s.nativeSessionId).catch(e => { event(s, { kind: 'error', text: e.message }); return { turns: [], cursor: null }; });
        event(s, { kind: 'codex_history', ...page });
        event(s, { kind: 'sys', subtype: method === 'thread/fork' ? 'branched' : 'resumed' });
      }
      if (s.outbox.length) { s.recovering = true; queueChanged(s); }
      return s;
    } catch (e) {
      // A timed-out resume may have loaded the thread. Release its lease only after confirmed unload.
      s.starting = false;
      if (leases.has(s.nativeSessionId)) await release(s).catch(() => {});
      sessions.delete(s.id); s.finished(); throw e;
    }
  }
  async function history(threadId, cursor) {
    const mode = find(threadId)?.historyMode || (await rpc.call('thread/read', { threadId, includeTurns: false })).thread.historyMode;
    if (mode === 'legacy') { const r = await rpc.call('thread/read', { threadId, includeTurns: true }); return { turns: r.thread.turns, cursor: null, historyMode: mode }; }
    const page = await rpc.call('thread/turns/list', { threadId, limit: 30, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    return { turns: [...page.data].reverse(), cursor: page.nextCursor || null, historyMode: mode };
  }
  async function resume(args, sid) {
    const id = args.nativeSessionId;
    const existing = find(id);
    if (existing) return { sid: existing.id, existing: true };
    const upstream = [...remote()].find(([, r]) => r.engine === 'codex' && r.nativeSessionId === id && !r.closed);
    if (upstream) return { sid: upstream[0], existing: true };
    if (starting.has(id)) return starting.get(id);
    const record = read(recordPath(id));
    if (!record?.managed && !args.confirmStopped) throw new Error('Confirm the original Codex client has stopped, or continue in a new branch.');
    const work = (async () => {
      const old = own().find(s => s.nativeSessionId === id && s.closed);
      if (old) await old.done;
      const s = await open({ ...record, ...args }, sid, 'thread/resume');
      return { sid: s.id };
    })();
    starting.set(id, work);
    try { return await work; } finally { starting.delete(id); }
  }
  async function send(s, input) {
    if (changingAccount) throw new Error('Complete or cancel Codex sign-in before sending');
    if (s.recovering) throw new Error('The last execution ended unexpectedly. Reattach before sending; queued messages have been kept.');
    const qid = input.messageId || randomUUID();
    if (s.sent.has(qid)) return;
    s.sent.add(qid);
    s.outbox.push({ qid, text: input.text, images: input.images || [], skills: input.skills || [] });
    queueChanged(s);
    await drain(s);
  }
  async function drain(s) {
    if (s.closed || s.detaching || s.starting || s.turnId || s.pending.size || s.recovering || s.releasing || !s.outbox.length) return;
    s.starting = true;
    const message = s.outbox[0];
    try {
      const input = [{ type: 'text', text: message.text }];
      for (const { name, path } of message.skills || []) input.push({ type: 'skill', name, path });
      for (const im of message.images) {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(im.media_type) || typeof im.data !== 'string') throw new Error('Unsupported image');
        const bytes = Buffer.from(im.data, 'base64');
        const file = path.join(stateDir, 'images', createHash('sha256').update(bytes).digest('hex') + '.' + im.media_type.slice(6));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        input.push({ type: 'localImage', path: file });
      }
      state(s, 'running');
      s.lastMsgAt = s.turnStart = Date.now();
      const params = { threadId: s.nativeSessionId, input, clientUserMessageId: message.qid,
        ...permissionSettings(s), model: s.modelChoice || s.model };
      params.collaborationMode = { mode: s.mode, settings: { model: s.modelChoice || s.model, reasoning_effort: s.effortChoice || s.effort || null, developer_instructions: null } };
      // Remove only after dispatch. An unknown result is never retried automatically.
      const response = rpc.request('turn/start', params);
      s.outbox.shift(); queueChanged(s);
      const { turn } = await response;
      if (s.finishedTurn !== turn.id) s.turnId = turn.id;
    } catch (e) {
      s.recovering = true;
      state(s, 'idle');
      event(s, { kind: 'error', text: `${e.message}. Reattach to reconcile the conversation before continuing.` });
      throw e;
    } finally {
      s.starting = false;
      if (!s.recovering && !s.turnId) void drain(s).catch(() => {});
    }
  }
  function clearApprovals(s) {
    for (const rid of s.pending.keys()) event(s, { kind: 'codex_approval_done', rid });
    s.pending.clear();
  }
  rpc.on('notification', ({ method, params: p }) => {
    if (method === 'account/login/completed') { loginId = null; changingAccount = false; partial('', { op: 'codex-login', ...p }); return; }
    if (method === 'account/updated') { account = null; partial('', { op: 'codex-account' }); return; }
    if (method === 'account/rateLimits/updated') { limits = p; partial('', { op: 'codex-limits', limits }); return; }
    if (method === 'thread/started' && p.thread.parentThreadId) { children.set(p.thread.id, children.get(p.thread.parentThreadId) || p.thread.parentThreadId); return; }
    if (method === 'thread/closed') { closing.get(p.threadId)?.(); children.delete(p.threadId); return; }
    const child = children.get(p.threadId);
    const s = find(child || p.threadId);
    if (!s) return;
    if (child) {
      if (method.startsWith('turn/') || method === 'thread/tokenUsage/updated') return;
      p = { ...p, nativeTurnId: p.turnId, turnId: s.turnId, sourceThreadId: p.threadId };
    }
    if (method === 'turn/started') { s.turnId = p.turn.id; state(s, 'running'); }
    else if (method === 'turn/completed') {
      s.turnId = null; s.finishedTurn = p.turn.id; s.onStopped?.();
      clearApprovals(s);
      event(s, { kind: 'codex_turn', turn: p.turn });
      state(s, 'idle'); save(s);
      void drain(s).catch(() => {});
    } else if (method === 'item/started' || method === 'item/completed') {
      s.items.set(p.item.id, p.item);
      event(s, { kind: 'codex_item', item: p.item, turnId: p.turnId, sourceThreadId: p.sourceThreadId, completed: method === 'item/completed' });
    } else if (method.startsWith('item/') && /delta$/i.test(method)) {
      const item = s.items.get(p.itemId);
      if (item) {
        const key = method.includes('outputDelta') ? 'aggregatedOutput' : 'text';
        s.items.set(p.itemId, { ...item, [key]: (item[key] || '') + (p.delta || '') });
      }
      event(s, { kind: 'codex_delta', itemId: p.itemId, turnId: p.turnId, delta: p.delta || '', method });
    } else if (method === 'item/fileChange/patchUpdated') {
      const item = { ...s.items.get(p.itemId), id: p.itemId, type: 'fileChange', changes: p.changes };
      s.items.set(item.id, item); event(s, { kind: 'codex_item', item, turnId: p.turnId });
    } else if (method === 'item/mcpToolCall/progress') event(s, { kind: 'codex_progress', itemId: p.itemId, turnId: p.turnId, message: p.message });
    else if (method === 'turn/plan/updated') event(s, { kind: 'codex_plan', ...p });
    else if (method === 'turn/diff/updated') event(s, { kind: 'codex_diff', ...p });
    else if (method === 'thread/tokenUsage/updated') { s.tokenUsage = p.tokenUsage; event(s, { kind: 'codex_usage', tokenUsage: p.tokenUsage }); }
    else if (method === 'serverRequest/resolved') {
      s.pending.delete(requestKey(p.requestId));
      event(s, { kind: 'codex_approval_done', rid: requestKey(p.requestId) });
      if (!s.pending.size) state(s, s.turnId ? 'running' : 'idle');
    } else if (method === 'error') event(s, { kind: 'error', text: p.error?.message || 'Codex reported an error' });
  });
  rpc.on('request', ({ id, method, params }) => {
    const s = find(children.get(params.threadId) || params.threadId);
    if (!s || !approvals.has(method)) { rpc.reject(id, 'IroWell does not support this request'); return; }
    const rid = requestKey(id);
    s.pending.set(rid, { id, method, params });
    event(s, { kind: 'codex_approval', rid, method, params: children.has(params.threadId) ? { ...params, nativeTurnId: params.turnId, turnId: s.turnId } : params });
    if (params.isBlocking !== false) state(s, 'waiting');
  });
  rpc.on('exit', why => {
    changingAccount = false; loginId = null;
    children.clear();
    for (const id of [...leases]) unclaim(id);
    for (const done of closing.values()) done();
    closing.clear();
    for (const s of own().filter(s => !s.closed)) {
      clearApprovals(s); s.recovering = true; s.turnId = null; s.onStopped?.();
      event(s, { kind: 'error', text: `${why}. Reattach to read the saved conversation; no input was resent.` });
      state(s, 'ended'); s.closed = true; s.finished(); save(s);
    }
  });
  async function release(s) {
    if (s.turnId || s.pending.size || s.starting || s.outbox.length || s.releasing) return false;
    s.releasing = true;
    let timer;
    try {
      // Descendants and managed terminals must finish before the old writer can be released.
      const terminals = await rpc.call('thread/backgroundTerminals/list', { threadId: s.nativeSessionId });
      const descendants = await rpc.call('thread/list', { ancestorThreadId: s.nativeSessionId, limit: 100 });
      if (terminals.data.length || terminals.nextCursor || descendants.nextCursor || descendants.data.some(t => t.status?.type === 'active')) return false;
      const unloaded = new Promise(resolve => {
        closing.set(s.nativeSessionId, () => resolve(true));
        timer = setTimeout(() => resolve(false), 15000);
      });
      const r = await rpc.call('thread/unsubscribe', { threadId: s.nativeSessionId });
      const ok = r.status === 'notLoaded' || await unloaded;
      if (!ok) await rpc.call('thread/resume', { threadId: s.nativeSessionId, excludeTurns: true });
      else unclaim(s.nativeSessionId);
      return ok;
    } finally { clearTimeout(timer); closing.delete(s.nativeSessionId); s.releasing = false; }
  }
  async function close(s) {
    s.detaching = true;
    let timer;
    try {
      s.outbox = []; queueChanged(s);
      if (s.turnId) {
        const stopped = new Promise((resolve, reject) => {
          s.onStopped = resolve;
          timer = setTimeout(() => reject(new Error('Codex is still stopping; try detaching again after the turn ends')), 10000);
        });
        await Promise.all([rpc.call('turn/interrupt', { threadId: s.nativeSessionId, turnId: s.turnId }), stopped]);
      }
      if (s.closed) return;
      await rpc.call('thread/backgroundTerminals/clean', { threadId: s.nativeSessionId });
      if (!await release(s)) throw new Error('Codex still has background work; the session remains attached.');
      s.closed = true; state(s, 'ended'); s.finished(); event(s, { kind: 'closed' });
    } finally { clearTimeout(timer); delete s.onStopped; s.detaching = false; }
  }
  function approve(s, { rid, result }) {
    const p = s.pending.get(rid);
    if (!p) throw new Error('This request has already been answered or expired');
    if (p.method.endsWith('Execution/requestApproval') || p.method.endsWith('Change/requestApproval')) {
      const choices = p.params.availableDecisions || ['accept', 'acceptForSession', 'decline', 'cancel'];
      if (!choices.some(x => JSON.stringify(x) === JSON.stringify(result?.decision))) throw new Error('That decision was not offered by Codex');
    } else if (p.method === 'item/permissions/requestApproval') {
      // UI offers the requested grant as a whole, or an empty grant. Never accepts invented permissions.
      if (!result || !['turn', 'session'].includes(result.scope) || ![JSON.stringify({}), JSON.stringify(p.params.permissions)].includes(JSON.stringify(result.permissions))) throw new Error('Invalid permission grant');
    } else if (p.method === 'item/tool/requestUserInput' && (!result?.answers || typeof result.answers !== 'object')) throw new Error('Answers are required');
    else if (p.method === 'mcpServer/elicitation/request' && !['accept', 'decline', 'cancel'].includes(result?.action)) throw new Error('Invalid form response');
    rpc.answer(p.id, result);
    s.pending.delete(rid); event(s, { kind: 'codex_approval_done', rid });
    if (!s.pending.size) state(s, s.turnId ? 'running' : 'idle');
  }
  const handlers = {
    async new(_c, args) {
      if (changingAccount) throw new Error('Complete or cancel Codex sign-in before starting a conversation');
      if (!args.blank && !args.text?.trim()) throw new Error('First message is empty');
      if (args.nonce && nonces.has(args.nonce)) return nonces.get(args.nonce);
      const work = (async () => { const s = await open(args); if (!args.blank) await send(s, args).catch(() => {}); return { sid: s.id }; })();
      if (args.nonce) nonces.set(args.nonce, work);
      return work;
    },
    resume: (_c, args) => resume(args),
    transcript: (_c, args) => history(args.nativeSessionId, args.cursor),
    async history(_c, args) {
      const result = await rpc.call('thread/list', { cwd: args.cwd, cursor: args.cursor, limit: 50, sourceKinds: ['cli', 'vscode', 'appServer', ...(args.all ? ['exec', 'unknown'] : [])] });
      const saved = records();
      return { data: result.data.filter(t => !t.parentThreadId).map(t => ({ engine: 'codex', nativeSessionId: t.id, title: t.name || t.preview || 'Codex session', cwd: t.cwd,
        lastModified: t.updatedAt * 1000, fromUi: !!saved[t.id]?.managed, source: 'Codex', openAs: find(t.id)?.id, historyMode: t.historyMode })), nextCursor: result.nextCursor };
    },
    send: (_c, args) => send(requireSession(args.sid), args),
    async queue(_c, args) {
      const s = requireSession(args.sid);
      if (args.op === 'add') throw new Error('Run this command after the current Codex turn finishes');
      const i = s.outbox.findIndex(m => m.qid === args.qid);
      if (i < 0) throw new Error('That message is no longer queued');
      const [m] = s.outbox.splice(i, 1);
      if (args.op === 'remove') { queueChanged(s); return m; }
      s.outbox.unshift(m); s.recovering = false; queueChanged(s);
      if (s.turnId) await rpc.call('turn/interrupt', { threadId: s.nativeSessionId, turnId: s.turnId });
      else await drain(s);
    },
    approve: (_c, args) => approve(requireSession(args.sid), args),
    interrupt(_c, args) { const s = requireSession(args.sid); if (s.turnId) return rpc.call('turn/interrupt', { threadId: s.nativeSessionId, turnId: s.turnId }); },
    async branch(_c, args) {
      const src = sessions.get(args.sid);
      const s = await open({ ...args, nativeSessionId: src?.nativeSessionId || args.nativeSessionId, cwd: src?.cwd || args.cwd,
        title: args.title || `${src?.title || 'Session'} (branch)`, model: src?.modelChoice, effort: src?.effortChoice, mode: src?.mode, permissions: src?.permissions, approvalsReviewer: src?.approvalsReviewer }, undefined, 'thread/fork');
      return { sid: s.id };
    },
    async rewind(_c, args) {
      const s = requireSession(args.sid);
      if (busy(s)) throw new Error('Finish or interrupt the current turn and remove queued messages before reverting');
      if (!args.confirmConversationOnly) throw new Error('Reverting conversation history does not restore files');
      await rpc.call('thread/revert', { threadId: s.nativeSessionId, beforeTurnId: args.turnId });
      const page = await history(s.nativeSessionId);
      resetEvents(s.id); s.items.clear();
      event(s, { kind: 'codex_reset', ...page });
      return { files: [], text: args.text || '' };
    },
    async setModel(_c, { sid, model }) {
      const s = requireSession(sid); s.modelChoice = model || undefined; s.effortChoice = undefined; save(s);
      event(s, { kind: 'meta', model: s.modelChoice || '', effort: '' }); return { nextTurn: true };
    },
    setMode(_c, { sid, mode }) {
      if (!['default', 'plan'].includes(mode)) throw new Error('Unknown Codex work mode');
      const s = requireSession(sid); s.mode = mode; s.modeSet = true; save(s); event(s, { kind: 'meta', mode });
    },
    setEffort(_c, { sid, effort }) { const s = requireSession(sid); s.effortChoice = effort || undefined; save(s); event(s, { kind: 'meta', effort }); },
    async setPermissions(_c, { sid, permissions, approvalsReviewer }) {
      const s = requireSession(sid);
      await validatePermissions({ ...s, permissions, approvalsReviewer });
      s.permissions = permissions; s.approvalsReviewer = approvalsReviewer || null; save(s); event(s, { kind: 'meta', permissions, approvalsReviewer: s.approvalsReviewer });
    },
    async models() { const r = await rpc.call('model/list'); return r.data.map(m => ({ ...m, value: m.model, resolvedModel: m.model })); },
    async engineOptions(_c, { cwd } = {}) {
      const [config, permissions, modes, skills, requirements] = await Promise.all([
        rpc.call('config/read', { cwd }), rpc.call('permissionProfile/list', { cwd }), rpc.call('collaborationMode/list'), rpc.call('skills/list', { cwds: cwd ? [cwd] : [] }), rpc.call('configRequirements/read')]);
      const keys = ['model', 'model_reasoning_effort', 'model_provider', 'default_permissions', 'sandbox_mode', 'approval_policy', 'approvals_reviewer'];
      return { model: config.config.model, effort: config.config.model_reasoning_effort, provider: providerInfo(config.config), permissions: permissions.data, defaultPermissions: nativePermissions(config.config),
        sources: Object.fromEntries(keys.map(key => [key, config.origins?.[key]?.name || null])),
        approvalPolicy: config.config.approval_policy, approvalsReviewer: config.config.approvals_reviewer, modes: modes.data, skills: skills.data, requirements: requirements.requirements };
    },
    async engineSkills(_c, { cwd, forceReload = false }) {
      return rpc.call('skills/list', { cwds: [resolveDir(cwd)], forceReload });
    },
    async engineEnvironment(_c, { cwd, sid } = {}) {
      const s = sessions.get(sid);
      const threadId = s?.engine === 'codex' && !s.closed ? s.nativeSessionId : undefined;
      const skills = await rpc.call('skills/list', { cwds: cwd ? [cwd] : [], forceReload: true });
      const mcp = [];
      let cursor;
      do {
        const page = await rpc.call('mcpServerStatus/list', { threadId, cursor, limit: 100, detail: 'toolsAndAuthOnly' });
        mcp.push(...page.data.map(p => ({ name: p.name, runtimeStatus: p.runtimeStatus, authStatus: p.authStatus })));
        cursor = page.nextCursor;
      } while (cursor);
      return { skills: skills.data, mcp, threadId };
    },
    async engineAccount(_c, { cwd } = {}) {
      const [result, { config }] = await Promise.all([rpc.call('account/read'), rpc.call('config/read', { cwd })]);
      const provider = providerInfo(config);
      account = result.account;
      limits = provider.id === 'openai' && account?.type === 'chatgpt' ? await rpc.call('account/rateLimits/read').catch(() => null) : null;
      return { account, limits, provider, requiresOpenaiAuth: result.requiresOpenaiAuth, home, ...installation.status() };
    },
    codexImage(_c, { path: file }) {
      const mime = { '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(file).toLowerCase()];
      if (!mime || fs.statSync(file).size > 10 * 1024 * 1024) throw new Error('Image preview unavailable');
      return { media_type: mime, data: fs.readFileSync(file).toString('base64') };
    },
    codexInfo() { return { ...installation.status(), home }; },
    codexInstall() {
      void installation.install().then(() => partial('', { op: 'codex-install', ...installation.status() }), () => partial('', { op: 'codex-install', ...installation.status() }));
      return installation.status();
    },
    async authLogin(_c, args) {
      if (own().some(s => !s.closed && busy(s)) || [...remote()].some(([, r]) => r.engine === 'codex' && !r.closed)) throw new Error('Wait for Codex work and upgrades to finish before changing the shared login');
      const p = args.apiKey ? { type: 'apiKey', apiKey: args.apiKey } : { type: args.device ? 'chatgptDeviceCode' : 'chatgpt' };
      if (changingAccount) throw new Error('A Codex login is already in progress');
      changingAccount = true;
      try {
        const r = await rpc.call('account/login/start', p);
        if (changingAccount) { loginId = r.loginId || null; changingAccount = !!loginId; }
        return r;
      } catch (e) { changingAccount = false; throw e; }
    },
    async authCancel() { if (loginId) await rpc.call('account/login/cancel', { loginId }); loginId = null; changingAccount = false; },
    async authLogout() {
      if (own().some(s => !s.closed && busy(s)) || [...remote()].some(([, r]) => r.engine === 'codex' && !r.closed)) throw new Error('Wait for Codex work and upgrades to finish before signing out');
      if (changingAccount) throw new Error('Complete or cancel Codex sign-in first');
      changingAccount = true;
      try { await rpc.call('account/logout'); account = limits = null; } finally { changingAccount = false; }
    },
    async status(_c, { sid }) {
      const s = requireSession(sid);
      const [a, mcp] = await Promise.all([rpc.call('account/read'), rpc.call('mcpServerStatus/list')]);
      return { ...stats(s), state: s.state, account: a.account, mcp: mcp.data, host: os.hostname() };
    },
    stats: (_c, { sid }) => stats(requireSession(sid)),
    async activity(_c, { sid }) {
      const s = requireSession(sid), r = await rpc.call('thread/backgroundTerminals/list', { threadId: s.nativeSessionId });
      s.tasks = new Map(r.data.map(t => [t.itemId, { id: t.itemId, description: t.command, status: 'running', type: 'local_bash', background: true }]));
      return { state: s.state, turnStart: s.turnStart, tasks: [...s.tasks.values()], procs: [] };
    },
    commands: () => [],
    usage: () => handlers.engineAccount(),
    context: (_c, { sid }) => stats(requireSession(sid)),
    async rename(_c, args) {
      const s = sessions.get(args.sid) || { ...read(recordPath(args.nativeSessionId)), nativeSessionId: args.nativeSessionId, id: args.sid };
      s.title = String(args.title).trim().slice(0, 120);
      await rpc.call('thread/name/set', { threadId: s.nativeSessionId, name: s.title }); save(s); event(s, { kind: 'meta', title: s.title });
    },
    setColor(_c, args) {
      const s = sessions.get(args.sid) || { ...read(recordPath(args.nativeSessionId)), nativeSessionId: args.nativeSessionId, id: args.sid };
      s.color = args.color || null; save(s); event(s, { kind: 'meta', color: s.color });
    },
    close: (_c, { sid }) => close(requireSession(sid)),
    async archive(_c, args) {
      const s = sessions.get(args.sid) || { ...read(recordPath(args.nativeSessionId)), id: args.sid, nativeSessionId: args.nativeSessionId };
      if (s.pending && !s.closed) await close(s);
      closeShells(args.sid);
      save(s, { hidden: true }); event(s, { kind: 'archived' });
    },
  };
  function stats(s) {
    const usage = s.tokenUsage?.last, max = s.tokenUsage?.modelContextWindow;
    return { engine: 'codex', nativeSessionId: s.nativeSessionId, cwd: s.cwd, title: s.title, model: s.modelChoice || s.model,
      effort: s.effortChoice || s.effort, mode: s.mode, permissions: s.permissions, approvalsReviewer: s.approvalsReviewer, permissionLabel: s.permissionLabel,
      ctx: usage && max ? { used: usage.totalTokens, max, pct: usage.totalTokens / max * 100 } : null, tokenUsage: s.tokenUsage };
  }
  return {
    handlers, rpc, installation, release, validatePermissions,
    canMove: s => !busy(s),
    async handover(s) {
      if (!await release(s)) return null;
      s.closed = true; s.finished();
      return { engine: 'codex', nativeSessionId: s.nativeSessionId, cwd: s.cwd, title: s.title, color: s.color, model: s.modelChoice, effort: s.effortChoice, mode: s.mode, permissions: s.permissions, approvalsReviewer: s.approvalsReviewer, sent: [...s.sent] };
    },
    takeOver: args => resume({ ...args, confirmStopped: true }, args.sid),
    dormant() {
      const running = new Set([...remote()].filter(([, r]) => r.engine === 'codex' && !r.closed).map(([, r]) => r.nativeSessionId));
      for (const [id, r] of Object.entries(records())) {
        if (r.hidden || running.has(id)) continue;
        const sid = randomUUID().slice(0, 8);
        emit(sid, { kind: 'created', engine: 'codex', nativeSessionId: id, cwd: r.cwd, title: r.title, color: r.color, dormant: true, lastActive: r.t, fromUi: !!r.managed });
        emit(sid, { kind: 'closed', engine: 'codex', nativeSessionId: id });
      }
    },
  };
}
