// Long-lived daemon on the remote host. Owns every Claude session so they keep
// running when the laptop disconnects. Clients talk newline-delimited JSON over
// a Unix socket (reached through `ssh host node attach.mjs`, no TCP port).
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { query, listSessions, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';

const DIR = process.env.IRO_DIR || path.join(os.homedir(), '.iro-coding');
const SOCK = path.join(DIR, 'daemon.sock');
const BOOT = randomUUID(); // lets clients notice a daemon restart
// Fingerprint of this file: the client compares it with its own copy to spot an outdated deploy.
const CODE = createHash('sha1').update(fs.readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 12);
const MAX_TOOL_OUTPUT = 20000; // chars kept per tool result in the event log
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const OURS_FILE = path.join(DIR, 'sessions.json'); // Claude session ids started from this UI

function loadOurs() {
  try { return new Set(JSON.parse(fs.readFileSync(OURS_FILE, 'utf8'))); } catch { return new Set(); }
}
const ours = loadOurs();
function rememberOurs(id) {
  if (!id || ours.has(id)) return;
  ours.add(id);
  try { fs.writeFileSync(OURS_FILE, JSON.stringify([...ours].slice(-500))); } catch (e) { log('cannot save', OURS_FILE, e.message); }
}

// Where each transcript lives: ~/.claude/projects/<project>/<session id>.jsonl
function transcriptIndex() {
  const root = path.join(CLAUDE_DIR, 'projects');
  const index = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return index; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) index.set(f.slice(0, -6), path.join(root, d, f));
  }
  return index;
}

// cwd and entrypoint from the head of a transcript (listSessions() sometimes leaves cwd out).
// entrypoint: "cli" = terminal, "sdk-ts" = this UI (and other TypeScript SDK apps), "sdk-cli" = `claude -p` runs.
const metaCache = new Map(); // file -> { mtime, meta }
function transcriptMeta(file) {
  if (!file) return {};
  let st;
  try { st = fs.statSync(file); } catch { return {}; }
  const hit = metaCache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.meta;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(st.size, 256 << 10));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const str = (key) => {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
    return m ? JSON.parse(`"${m[1]}"`) : undefined;
  };
  const meta = { cwd: str('cwd'), entrypoint: str('entrypoint'), hasMessages: /"type":"(user|assistant)"/.test(text) };
  metaCache.set(file, { mtime: st.mtimeMs, meta });
  return meta;
}
const transcriptCwd = (id) => transcriptMeta(transcriptIndex().get(id)).cwd || null;

const log = (...a) => console.log(new Date().toISOString(), ...a);
process.on('uncaughtException', (e) => log('uncaught', e));
process.on('unhandledRejection', (e) => log('unhandled', e));

// ---- event log: every UI-visible change is an event with a global seq ----
const events = [];
let seq = 0;
const subscribers = new Set(); // clients that have synced and get live events

const line = (obj) => JSON.stringify(obj) + '\n';

// Streaming deltas are live-only: not logged, not replayed.
function partial(sid, p) {
  const l = line({ type: 'partial', sid, ...p });
  for (const c of subscribers) c.write(l);
}

function emit(sid, ev) {
  const e = { type: 'event', seq: ++seq, sid, ts: Date.now(), ...ev };
  events.push(e);
  const l = line(e);
  for (const c of subscribers) c.write(l);
}

// ---- sessions ----
const sessions = new Map();

// Async-iterable queue feeding user messages into query() (streaming input mode).
function inbox() {
  const q = [];
  let wake = null;
  return {
    push(m) { q.push(m); wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (q.length) yield q.shift();
        await new Promise((r) => (wake = r));
      }
    },
  };
}

function setState(s, state) {
  if (s.state === state || s.state === 'ended') return;
  s.state = state;
  emit(s.id, { kind: 'state', state });
}

function askApproval(s, tool, input, opts = {}) {
  const { signal } = opts;
  if (signal?.aborted) return Promise.resolve({ behavior: 'deny', message: 'Request aborted' });
  const rid = randomUUID();
  // "Always allow" writes these permission rules; not offered when the CLI says it would grant too much.
  const suggestions = opts.suppressAlwaysAllowRule ? undefined : opts.suggestions?.length ? opts.suggestions : undefined;
  return new Promise((resolve) => {
    s.pending.set(rid, { resolve, input, suggestions });
    emit(s.id, {
      kind: 'approval', rid, tool, input,
      toolUseId: opts.toolUseID, agentId: opts.agentID,
      title: opts.title, description: opts.description, reason: opts.decisionReason,
      canAlways: !!suggestions,
    });
    setState(s, 'waiting');
    signal?.addEventListener('abort', () => {
      if (!s.pending.has(rid)) return;
      settle(s, rid, false);
    }, { once: true });
  });
}

function settle(s, rid, allow, { answers, always } = {}) {
  const p = s.pending.get(rid);
  if (!p) return;
  s.pending.delete(rid);
  always = !!(allow && always && p.suggestions);
  emit(s.id, { kind: 'approval_done', rid, allow, ...(allow && answers ? { answers } : {}), ...(always ? { always } : {}) });
  if (!s.pending.size) setState(s, 'running');
  p.resolve(allow
    ? {
        behavior: 'allow',
        updatedInput: answers ? { ...p.input, answers } : p.input,
        ...(always ? { updatedPermissions: p.suggestions } : {}),
      }
    : { behavior: 'deny', message: 'The user denied this action.' });
}

const clip = (t, n = MAX_TOOL_OUTPUT) => (t.length > n ? t.slice(0, n) + `\n… (${t.length - n} more chars)` : t);

// Keep the event log small: it is replayed over ssh on every reconnect.
function slim(s, m) {
  if (m.type === 'user') {
    const { tool_use_result, ...rest } = m;
    const blocks = Array.isArray(rest.message?.content) ? rest.message.content : null;
    const content = blocks
      ? blocks.map((b) => (b.type === 'tool_result' ? { ...b, content: clipResult(b.content) } : b))
      : rest.message?.content;
    const out = { ...rest, message: { ...rest.message, content } };
    // Edit/Write report a patch with real file line numbers; keep just that for the diff view.
    const tr = blocks?.find((b) => b.type === 'tool_result');
    const patch = tool_use_result?.structuredPatch;
    const toolName = tr && s.toolNames.get(tr.tool_use_id);
    // Subagent report without the harness framing the model sees.
    if ((toolName === 'Agent' || toolName === 'Task') && tool_use_result?.status) {
      const r = tool_use_result;
      out.agent = {
        status: r.status,
        text: Array.isArray(r.content) ? clip(r.content.map((c) => c.text || '').join('\n')) : undefined,
        toolUses: r.totalToolUseCount, durationMs: r.totalDurationMs, tokens: r.totalTokens,
      };
    }
    if (tr && Array.isArray(patch) && (toolName === 'Edit' || toolName === 'Write')) {
      let budget = 3000;
      out.patch = {
        filePath: tool_use_result.filePath,
        type: tool_use_result.type,
        hunks: patch.filter((h) => (budget -= h.lines.length) >= 0),
        truncated: budget < 0,
      };
    }
    return out;
  }
  if (m.type === 'assistant') {
    const content = [];
    for (const b of m.message.content) {
      if (b.type === 'tool_use') s.toolNames.set(b.id, b.name);
      if (b.type === 'redacted_thinking') continue;
      if (b.type === 'thinking') {
        if (b.thinking?.trim()) content.push({ type: 'thinking', thinking: clip(b.thinking) });
        continue;
      }
      content.push(b);
    }
    return { ...m, message: { ...m.message, content } };
  }
  return m;
}

function clipResult(c) {
  if (typeof c === 'string') return clip(c);
  if (!Array.isArray(c)) return c;
  return c.map((b) => (b.type === 'text' ? { ...b, text: clip(b.text) } : { type: 'text', text: `[${b.type}]` }));
}

const FORWARD = new Set(['assistant', 'user', 'result']);

async function run(s) {
  s.q = query({
    prompt: s.inbox,
    options: {
      cwd: s.cwd,
      canUseTool: (tool, input, opts) => askApproval(s, tool, input, opts),
      includePartialMessages: true,
      promptSuggestions: true,
      ...(s.model ? { model: s.model } : {}),
      ...(s.mode ? { permissionMode: s.mode } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.resume ? { resume: s.resume } : {}),
      stderr: (d) => log(`[${s.id}] stderr`, d.trimEnd()),
    },
  });
  try {
    for await (const m of s.q) {
      s.lastMsgAt = Date.now();
      if (activity(s, m)) continue;
      if (m.type === 'system' && m.subtype === 'init') {
        if (!s.initDone) s.mode = m.permissionMode; // initial mode: shown by the init event itself
        else if (m.permissionMode && m.permissionMode !== s.mode) setMeta(s, { mode: m.permissionMode });
        if (s.initDone) continue; // init repeats every turn
        s.initDone = true;
        s.claudeSessionId = m.session_id;
        rememberOurs(m.session_id);
        emit(s.id, { kind: 'init', model: m.model, mode: m.permissionMode, claudeSessionId: m.session_id });
        refreshStats(s);
      } else if (m.type === 'system' && m.subtype === 'session_state_changed' && m.state === 'idle') {
        s.queued = 0; // authoritative when the CLI reports it (e.g. after an interrupt)
        if (!s.pending.size) setState(s, 'idle');
      } else if (m.type === 'system' && m.subtype === 'status') {
        if (m.permissionMode && m.permissionMode !== s.mode) setMeta(s, { mode: m.permissionMode });
      } else if (m.type === 'prompt_suggestion') {
        emit(s.id, { kind: 'suggest', text: String(m.suggestion || '').slice(0, 500) });
      } else if (m.type === 'stream_event') {
        streamDelta(s, m.event, m.parent_tool_use_id);
      } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
        emit(s.id, { kind: 'sys', subtype: 'compact', trigger: m.compact_metadata?.trigger, pre: m.compact_metadata?.pre_tokens, post: m.compact_metadata?.post_tokens });
      } else if (m.type === 'system' && m.subtype === 'api_retry') {
        emit(s.id, { kind: 'sys', subtype: 'retry', attempt: m.attempt, max: m.max_retries, status: m.error_status, delay: m.retry_delay_ms });
      } else if (m.type === 'system' && m.subtype === 'local_command_output') {
        emit(s.id, { kind: 'sys', subtype: 'local', text: clip(String(m.content ?? '')) });
      } else if (m.type === 'user' && !m.parent_tool_use_id && parseNotification(m.message?.content)) {
        emit(s.id, { kind: 'notify', ...parseNotification(m.message.content) });
        if (s.state === 'idle') setState(s, 'running'); // Claude answers it with a turn of its own
      } else if (FORWARD.has(m.type)) {
        const msg = slim(s, m);
        if (msg.type === 'assistant' && !msg.message.content.length) continue; // thinking only
        // Claude can start a turn on its own (e.g. a background task finished).
        if (msg.type === 'assistant' && s.state === 'idle') setState(s, 'running');
        emit(s.id, { kind: 'msg', msg });
        if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
          s.turnText = (s.turnText || '') + msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        }
        if (m.type === 'result' && --s.queued <= 0) {
          s.queued = 0;
          setState(s, 'idle');
          refreshStats(s);
          if (m.num_turns) predictNext(s);
        }
      }
    }
  } catch (e) {
    log(`[${s.id}] query failed`, e);
    emit(s.id, { kind: 'error', text: String(e?.message || e) });
  }
  for (const rid of [...s.pending.keys()]) settle(s, rid, false);
  setState(s, 'ended');
}

// ---- activity: what the session is doing right now (live only, not logged) ----
function taskView(t) {
  return { id: t.id, description: t.description, type: t.type, status: t.status, background: !!t.background,
    toolUses: t.toolUses, tokens: t.tokens, lastTool: t.lastTool, started: t.started };
}
const runningTasks = (s) => [...s.tasks.values()].filter((t) => t.status === 'running' || t.status === 'pending').map(taskView);
function sendTasks(s) {
  partial(s.id, { op: 'tasks', tasks: runningTasks(s), procs: s.procs || [] });
}

// Processes a session left running on its own (nohup/setsid/`&` from its Bash tool): they carry the
// session's CLAUDE_CODE_SESSION_ID in their environment but no longer descend from its CLI process.
// Linux only (/proc); scanned every 10 s.
const HAS_PROC = fs.existsSync('/proc/self/environ');
let bootTime = 0;
try { bootTime = Number(/btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]); } catch {}
function procStat(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(rest[1]), start: bootTime + Number(rest[19]) / 100 };
  } catch { return null; }
}
function descendsFrom(pid, ancestor) {
  for (let p = pid, i = 0; p > 1 && i < 64; i++) {
    if (p === ancestor) return true;
    p = procStat(p)?.ppid ?? 0;
  }
  return false;
}
function procScan() {
  if (!HAS_PROC) return;
  const byId = new Map();
  for (const s of sessions.values()) if (s.claudeSessionId) byId.set(s.claudeSessionId, s);
  if (!byId.size) return;
  const found = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync('/proc'); } catch { return; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    let env;
    try { env = fs.readFileSync(`/proc/${d}/environ`, 'latin1'); } catch { continue; }
    const m = /(?:^|\0)CLAUDE_CODE_SESSION_ID=([0-9a-f-]{36})/.exec(env);
    const s = m && byId.get(m[1]);
    if (!s) continue;
    const cli = Number(/(?:^|\0)CLAUDE_PID=(\d+)/.exec(env)?.[1] || 0);
    const pid = Number(d);
    if (cli && descendsFrom(pid, cli)) continue; // still under the CLI: a tool call or MCP server
    const st = procStat(pid);
    let cmd = '';
    try { cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch {}
    if (!found.has(s)) found.set(s, []);
    found.get(s).push({ pid, ppid: st?.ppid, cmd: cmd.slice(0, 300), started: st ? Math.round(st.start * 1000) : null });
  }
  for (const s of sessions.values()) {
    const all = found.get(s) || [];
    const pids = new Set(all.map((p) => p.pid));
    const roots = all.filter((p) => !pids.has(p.ppid)) // show each job once, by its top process
      .map((p) => ({ ...p, children: all.filter((c) => c.ppid === p.pid).length }));
    const key = roots.map((p) => p.pid).join(',');
    if (key !== (s.procKey || '')) {
      s.procKey = key;
      s.procs = roots;
      sendTasks(s);
    }
  }
}
setInterval(procScan, 10000);
// Returns true when the message is only activity information.
function activity(s, m) {
  if (m.type === 'system' && m.subtype === 'thinking_tokens') {
    partial(s.id, { op: 'act', what: 'thinking', tokens: m.estimated_tokens });
    return true;
  }
  if (m.type === 'tool_progress') {
    partial(s.id, { op: 'act', what: 'tool', toolUseId: m.tool_use_id, tool: m.tool_name, elapsed: m.elapsed_time_seconds, parent: m.parent_tool_use_id });
    return true;
  }
  if (m.type !== 'system') return false;
  const t = m.task_id && (s.tasks.get(m.task_id) || { id: m.task_id, started: Date.now(), status: 'running' });
  switch (m.subtype) {
    case 'task_started':
      Object.assign(t, { description: m.description, type: m.subagent_type || m.task_type || m.workflow_name || 'task', background: !!m.is_backgrounded });
      break;
    case 'task_updated':
      if (m.patch.status) t.status = m.patch.status;
      if (m.patch.description) t.description = m.patch.description;
      if (m.patch.is_backgrounded != null) t.background = m.patch.is_backgrounded;
      break;
    case 'task_progress':
      Object.assign(t, { description: m.description || t.description, toolUses: m.usage?.tool_uses, tokens: m.usage?.total_tokens, lastTool: m.last_tool_name });
      break;
    case 'task_notification':
      t.status = m.status;
      break;
    case 'background_tasks_changed': {
      const alive = new Set(m.tasks.map((x) => x.task_id));
      for (const x of m.tasks) {
        const cur = s.tasks.get(x.task_id) || { id: x.task_id, started: Date.now(), status: 'running' };
        Object.assign(cur, { description: x.description, type: cur.type || x.task_type, background: true });
        s.tasks.set(x.task_id, cur);
      }
      for (const [id, x] of s.tasks) if (x.background && !alive.has(id) && x.status === 'running') x.status = 'completed';
      sendTasks(s);
      return true;
    }
    default:
      return false;
  }
  s.tasks.set(t.id, t);
  sendTasks(s);
  return true;
}

// A heartbeat for every busy session: proves the daemon is alive and says how long the CLI has been quiet.
setInterval(() => {
  for (const s of sessions.values()) {
    const busy = s.state === 'running' || s.state === 'waiting';
    const bg = [...(s.tasks?.values() || [])].some((t) => t.status === 'running');
    if (!busy && !bg) continue;
    partial(s.id, { op: 'tick', turnStart: s.turnStart, quietMs: s.lastMsgAt ? Date.now() - s.lastMsgAt : null, at: Date.now() });
  }
}, 3000);

// model / permission mode / title changes
function setMeta(s, meta) {
  Object.assign(s, meta);
  emit(s.id, { kind: 'meta', ...meta });
}

function streamDelta(s, ev, parent) {
  const p = parent ? { parent } : {};
  if (ev.type === 'content_block_start') {
    const t = ev.content_block?.type;
    if (t === 'text' || t === 'thinking') partial(s.id, { op: 'start', block: t, ...p });
  } else if (ev.type === 'content_block_delta') {
    const d = ev.delta;
    if (d?.type === 'text_delta') partial(s.id, { op: 'delta', block: 'text', text: d.text, ...p });
    else if (d?.type === 'thinking_delta') partial(s.id, { op: 'delta', block: 'thinking', text: d.thinking, ...p });
  }
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function sendText(s, text, images = []) {
  try { s.predQ?.close(); } catch {} // a guess for the previous turn is useless now
  if (!(s.state === 'running' || s.state === 'waiting')) s.turnStart = Date.now();
  s.lastMsgAt = Date.now();
  s.lastUserText = text;
  s.turnText = '';
  s.turnNo = (s.turnNo || 0) + 1;
  images = (Array.isArray(images) ? images : [])
    .filter((im) => IMAGE_TYPES.has(im?.media_type) && typeof im.data === 'string' && im.data.length < 7_000_000)
    .slice(0, 5);
  emit(s.id, { kind: 'user_text', text, ...(images.length ? { images } : {}) });
  s.queued++;
  setState(s, s.pending.size ? 'waiting' : 'running');
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), { type: 'text', text }]
    : text;
  s.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
}

// "~/x", "x" (relative to home) and "/abs/x" all work.
function resolveDir(input) {
  const raw = (input || '').trim() || '~';
  const expanded = raw.replace(/^~(?=$|\/)/, os.homedir());
  const dir = path.resolve(os.homedir(), expanded);
  try {
    // The real path, as the CLI records it in transcripts: symlinked spellings are the same folder.
    if (fs.statSync(dir).isDirectory()) return fs.realpathSync(dir);
  } catch {}
  return null;
}

// Background tasks and subagents report back through a user message the CLI writes itself.
function parseNotification(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
  if (!text.trimStart().startsWith('<task-notification>')) return null;
  const tag = (t) => (new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(text)?.[1] ?? '').trim();
  const num = (t) => { const v = tag(t); return v ? Number(v) : undefined; };
  return {
    taskId: tag('task-id'), status: tag('status'), summary: tag('summary'), result: clip(tag('result'), 8000),
    tokens: num('subagent_tokens'), toolUses: num('tool_uses'), durationMs: num('duration_ms'),
  };
}

// What the user typed, from a stored user message; '' for injected text; null for tool results.
function promptText(content) {
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content) && !content.some((b) => b.type === 'tool_result')) {
    text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const n = content.filter((b) => b.type === 'image').length;
    if (n) text = `[${n} image${n > 1 ? 's' : ''}] ${text}`;
  } else return null;
  const cmd = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/.exec(text);
  if (cmd) return `${cmd[1]} ${cmd[2] || ''}`.trim();
  if (/^\s*(<local-command-|<system-reminder>|Caveat: The messages below)/.test(text)) return '';
  return text;
}

function newSession({ cwd, title, model, mode, resume }) {
  const s = {
    id: randomUUID().slice(0, 8), cwd, title, state: 'idle', queued: 0, model: model || undefined, mode: mode || undefined,
    resume, inbox: inbox(), pending: new Map(), toolNames: new Map(), tasks: new Map(),
  };
  sessions.set(s.id, s);
  return s;
}

// ---- status line: model, effort, context, plan limits, session totals ----
const branchCache = new Map(); // cwd -> { at, branch }
function gitBranch(cwd) {
  const hit = branchCache.get(cwd);
  if (hit && Date.now() - hit.at < 15000) return hit.branch;
  let branch = null;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim() || null;
  } catch {}
  branchCache.set(cwd, { at: Date.now(), branch });
  return branch;
}

async function collectStats(s) {
  const out = {
    cwd: s.cwd, branch: gitBranch(s.cwd), mode: s.mode, title: s.title, claudeSessionId: s.claudeSessionId,
  };
  if (!s.q || s.state === 'ended' || s.closed) return out;
  const q = s.q;
  const [ctx, cfg, use] = await Promise.all([
    q.getContextUsage({ detail: 'summary' }).catch(() => null),
    q.getSettings().catch(() => null),
    (typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function'
      ? q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) : Promise.resolve(null)).catch(() => null),
  ]);
  if (ctx) out.ctx = { used: ctx.totalTokens, max: ctx.maxTokens, pct: ctx.percentage };
  if (cfg?.applied) { out.model = cfg.applied.model; out.effort = cfg.applied.effort; }
  if (use?.session) {
    const u = use.session;
    let inTok = 0, outTok = 0;
    for (const m of Object.values(u.model_usage || {})) {
      inTok += (m.inputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0);
      outTok += m.outputTokens || 0;
    }
    out.session = { cost: u.total_cost_usd, durationMs: u.total_duration_ms, added: u.total_lines_added, removed: u.total_lines_removed, inTok, outTok };
  }
  const rl = use?.rate_limits;
  if (rl) {
    const w = (x) => (x && x.utilization != null ? { pct: x.utilization, resets: x.resets_at } : null);
    out.limits = { five: w(rl.five_hour), week: w(rl.seven_day) };
  }
  return out;
}

// ---- plan usage history: sampled every 10 minutes and kept on the server ----
// Source: a live session's usage API; with no session running, the same endpoint the terminal
// status line uses, with the CLI's own OAuth token (Linux: ~/.claude/.credentials.json).
const USAGE_FILE = path.join(DIR, 'usage.jsonl');
const USAGE_KEEP = 35 * 24 * 3600 * 1000;
let lastSample = 0;
function recordUsage(limits) {
  if (!limits || (!limits.five && !limits.week)) return;
  const now = Date.now();
  if (now - lastSample < 60 * 1000) return; // at most one sample a minute
  lastSample = now;
  try { fs.appendFileSync(USAGE_FILE, JSON.stringify({ t: now, ...limits }) + '\n'); } catch (e) { log('cannot write', USAGE_FILE, e.message); }
}
async function usageFromApi() {
  let token;
  try { token = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken; } catch {}
  if (!token) return null;
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) return null;
  const u = await r.json();
  const w = (x) => (x && x.utilization != null ? { pct: x.utilization, resets: x.resets_at } : null);
  return { five: w(u.five_hour), week: w(u.seven_day) };
}
async function sampleUsage() {
  try {
    const s = [...sessions.values()].find((x) => x.q && x.state !== 'ended' && !x.closed);
    let limits = null;
    if (s) limits = (await collectStats(s)).limits;
    if (!limits) limits = await usageFromApi();
    recordUsage(limits);
  } catch (e) { log('usage sample failed', e.message); }
}
function pruneUsage() {
  try {
    const cut = Date.now() - USAGE_KEEP;
    const lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean);
    const keep = lines.filter((l) => { try { return JSON.parse(l).t >= cut; } catch { return false; } });
    if (keep.length < lines.length) fs.writeFileSync(USAGE_FILE, keep.join('\n') + '\n');
  } catch {}
}
setTimeout(sampleUsage, 20 * 1000);
setInterval(sampleUsage, 10 * 60 * 1000);
setInterval(pruneUsage, 6 * 3600 * 1000);

async function refreshStats(s) {
  try {
    s.stats = await collectStats(s);
    recordUsage(s.stats.limits);
    emit(s.id, { kind: 'stats', ...s.stats });
  } catch (e) { log(`[${s.id}] stats failed`, e.message); }
}

// ---- folders in the sidebar ----
// The directories the UI lists. Removing one only unregisters it here; its sessions and Claude's
// memory of them stay on disk, so adding the folder back brings its history back too.
const FOLDERS_FILE = path.join(DIR, 'folders.json');
let folders = null;
try { folders = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf8')); } catch {}
function saveFolders() {
  try { fs.writeFileSync(FOLDERS_FILE, JSON.stringify(folders)); } catch (e) { log('cannot save', FOLDERS_FILE, e.message); }
  partial('', { op: 'folders', folders });
}
function addFolder(dir) {
  folders ??= [];
  if (folders.includes(dir)) return;
  folders.push(dir);
  saveFolders();
}
// Directories of recent sessions on this host, newest first (for the folder picker, and the first start).
async function recentDirs(limit = 20, onlyOurs = false) {
  const seen = new Set();
  for (const x of await listSessions({ limit: 300 })) {
    if (onlyOurs && !ours.has(x.sessionId)) continue;
    const d = x.cwd;
    if (!d || seen.has(d) || !resolveDir(d)) continue;
    seen.add(d);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

// ---- next-prompt suggestions ----
// The SDK's own promptSuggestions don't arrive in headless sessions, so after each turn a small
// model guesses the next prompt from the last exchange only (cheap: no tools, no project context).
const SETTINGS_FILE = path.join(DIR, 'settings.json');
let settings = { suggest: true };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings)); } catch {} }

async function predictNext(s) {
  if (!settings.suggest || !s.lastUserText || !s.turnText) return;
  const turn = s.turnNo;
  const prompt = 'This is the end of a session between a user and a coding assistant.\n\n'
    + `User: ${s.lastUserText.slice(-1500)}\n\nAssistant: ${s.turnText.slice(-3000)}\n\n`
    + 'Write the message the user will most likely send next: a natural follow-up request, at most 15 words, '
    + 'in the user\'s language, no quotes. Reply with only that message. Reply with just - only if the work is '
    + 'clearly finished and nothing would naturally follow.';
  let text = '';
  let q;
  try {
    try { s.predQ?.close(); } catch {}
    q = query({ prompt, options: { cwd: s.cwd, model: 'haiku', tools: [], maxTurns: 1, persistSession: false, settingSources: [] } });
    s.predQ = q;
    for await (const m of q) {
      if (m.type === 'assistant') text += m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (m.type === 'result') break;
    }
  } catch (e) { if (s.turnNo === turn) log(`[${s.id}] suggestion failed`, e.message); return; }
  finally { if (s.predQ === q) s.predQ = null; }
  text = text.trim().split('\n')[0].replace(/^["'“]|["'”]$/g, '').trim();
  if (process.env.IRO_DEBUG) log(`[${s.id}] suggestion for turn ${turn} (now ${s.turnNo}, ${s.state}) from "${s.lastUserText.slice(0, 40)}": ${text}`);
  if (!text || text === '-' || s.turnNo !== turn || s.state !== 'idle') return; // the user moved on
  emit(s.id, { kind: 'suggest', text: text.slice(0, 200) });
}

// ---- /btw threads ----
const BTW_FILE = path.join(DIR, 'btw.json');
const btwThreads = new Map(); // bid -> { bid, claudeSessionId, cwd, created, messages: [{ role, text }], busy, proc }
try {
  for (const t of JSON.parse(fs.readFileSync(BTW_FILE, 'utf8'))) btwThreads.set(t.bid, t);
} catch {}
function saveBtw() {
  const keep = [...btwThreads.values()].sort((a, b) => b.created - a.created).slice(0, 300)
    .map(({ bid, claudeSessionId, cwd, created, messages }) => ({ bid, claudeSessionId, cwd, created, messages }));
  try {
    fs.writeFileSync(BTW_FILE + '.tmp', JSON.stringify(keep));
    fs.renameSync(BTW_FILE + '.tmp', BTW_FILE); // never leave a half-written file behind
  } catch (e) { log('cannot save', BTW_FILE, e.message); }
}
const BTW_IDLE = 20 * 60 * 1000;

// One CLI process per open thread, fed through an inbox like a session. If it has gone
// (idle timeout, daemon restart) the thread is re-forked with its earlier Q&A in the prompt.
function btwAsk(t, text) {
  const out = (p) => partial(t.sid, { bid: t.bid, ...p });
  const sid = [...sessions.values()].find((x) => x.claudeSessionId === t.claudeSessionId && !x.closed)?.id || t.sid;
  t.sid = sid;
  const PREFIX = '(Side question. Answer briefly from what you already know in this conversation; do not use tools.)\n\n';
  if (!t.proc) {
    const earlier = t.messages.slice(0, -1);
    const recap = earlier.length
      ? 'Earlier in this side discussion:\n' + earlier.map((m) => `${m.role === 'user' ? 'Q' : 'A'}: ${m.text}`).join('\n') + '\n\nNext question: '
      : '';
    const box = inbox();
    const q = query({
      prompt: box,
      options: {
        cwd: t.cwd, resume: t.claudeSessionId, forkSession: true, persistSession: false,
        tools: [], includePartialMessages: true,
        stderr: (d) => log(`[btw ${t.bid}] stderr`, d.trimEnd()),
      },
    });
    t.proc = { q, box, answer: '' };
    (async () => {
      const proc = t.proc;
      try {
        for await (const m of q) {
          if (m.type === 'stream_event' && m.event.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
            out({ op: 'btw', text: m.event.delta.text });
          } else if (m.type === 'assistant') {
            proc.answer += m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
          } else if (m.type === 'result') {
            const answer = proc.answer || (m.subtype === 'success' ? String(m.result || '') : `(${m.subtype})`);
            proc.answer = '';
            t.messages.push({ role: 'assistant', text: answer, at: Date.now() });
            t.busy = false;
            saveBtw();
            out({ op: 'btw-done', text: answer });
            clearTimeout(proc.idle);
            proc.idle = setTimeout(() => { try { q.close(); } catch {} }, BTW_IDLE);
          }
        }
      } catch (e) {
        log(`[btw ${t.bid}] failed`, e);
        if (t.busy) {
          t.busy = false;
          t.messages.pop(); // the question never got an answer; let it be asked again
          saveBtw();
          out({ op: 'btw-done', error: String(e?.message || e) });
        }
      }
      if (t.proc === proc) t.proc = null;
    })();
    t.proc.box.push({ type: 'user', message: { role: 'user', content: PREFIX + recap + text }, parent_tool_use_id: null });
  } else {
    clearTimeout(t.proc.idle);
    t.proc.box.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }
}

// ---- videos the browser can't decode: convert with ffmpeg (H.264 + AAC) into a disk cache ----
// e.g. OpenCV's 'mp4v' writes MPEG-4 Part 2, which no browser plays.
const PLAYABLE = new Set(['h264', 'vp8', 'vp9', 'av1']);
const MEDIA_DIR = path.join(DIR, 'media-cache');
const MEDIA_BUDGET = 2 * 1024 ** 3; // 2 GB on disk, oldest converted files go first
const mediaJobs = new Map(); // cache key -> { key, out, progress, done, error, size }
const has = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const HAS_FFMPEG = has('ffmpeg') && has('ffprobe');

function probeVideo(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', file], { timeout: 15000 }).toString();
  const j = JSON.parse(out);
  return { codec: j.streams?.[0]?.codec_name, duration: Number(j.format?.duration) || 0 };
}

function trimMediaCache() {
  let files = [];
  try { files = fs.readdirSync(MEDIA_DIR).filter((f) => f.endsWith('.mp4')).map((f) => { const p = path.join(MEDIA_DIR, f); const st = fs.statSync(p); return { p, size: st.size, at: st.atimeMs }; }); } catch { return; }
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.at - b.at)) {
    if (total <= MEDIA_BUDGET) break;
    try { fs.rmSync(f.p); total -= f.size; } catch {}
  }
}

function convert(file, st, info, key) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const out = path.join(MEDIA_DIR, `${key}.mp4`);
  const job = { key, source: file, out, progress: 0, done: false };
  mediaJobs.set(key, job);
  const tmp = out + '.part';
  const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', tmp];
  const ff = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  let last = 0;
  ff.stdout.setEncoding('utf8');
  ff.stdout.on('data', (d) => {
    const m = /out_time_us=(\d+)/g;
    let x, us = null;
    while ((x = m.exec(d))) us = Number(x[1]);
    if (us != null && info.duration) {
      job.progress = Math.min(0.99, us / 1e6 / info.duration);
      if (Date.now() - last > 700) { last = Date.now(); partial('', { op: 'media', key, progress: job.progress }); }
    }
  });
  ff.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  ff.on('close', (code) => {
    if (code === 0) {
      fs.renameSync(tmp, out);
      Object.assign(job, { done: true, progress: 1, size: fs.statSync(out).size });
      trimMediaCache();
    } else {
      fs.rmSync(tmp, { force: true });
      Object.assign(job, { done: true, error: err.trim().split('\n').pop() || `ffmpeg exited with ${code}` });
      mediaJobs.delete(key);
    }
    partial('', { op: 'media', key, progress: job.progress, done: true, path: job.error ? undefined : out, size: job.size, error: job.error });
  });
}

// ---- files: @-mention completion and the file viewer ----
const fileCache = new Map(); // cwd -> { at, files }
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache', 'dist', 'build', '.next', '.mypy_cache']);

function listFiles(cwd) {
  const hit = fileCache.get(cwd);
  if (hit && Date.now() - hit.at < 30000) return hit.files;
  let files;
  try {
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n').filter(Boolean).slice(0, 50000);
  } catch {
    files = [];
    const walk = (dir, rel, depth) => {
      if (depth > 8 || files.length >= 20000) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (files.length >= 20000) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth + 1); }
        else if (e.isFile()) files.push(r);
      }
    };
    walk(cwd, '', 0);
  }
  const dirs = new Set();
  for (const f of files) for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i + 1));
  const all = [...dirs, ...files];
  fileCache.set(cwd, { at: Date.now(), files: all });
  return all;
}

// Subsequence match; prefer hits in the file name, then shorter paths.
function fuzzy(paths, q, limit = 30) {
  q = q.toLowerCase();
  if (!q) return paths.filter((p) => !p.slice(0, -1).includes('/')).slice(0, limit);
  const scored = [];
  for (const p of paths) {
    const lp = p.toLowerCase();
    let i = 0, j = 0;
    while (i < lp.length && j < q.length) { if (lp[i] === q[j]) j++; i++; }
    if (j < q.length) continue;
    const base = lp.slice(lp.lastIndexOf('/', lp.length - 2) + 1);
    const score = (base.includes(q) ? 0 : lp.includes(q) ? 1000 : 2000) + p.length;
    scored.push([score, p]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1]);
}

const MAX_VIEW = 1 << 20;

function readForView(file) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Not a file');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(st.size, MAX_VIEW));
  fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  if (buf.subarray(0, 8000).includes(0)) return { path: file, size: st.size, binary: true };
  return { path: file, size: st.size, text: buf.toString('utf8'), truncated: st.size > MAX_VIEW };
}

// ---- client commands ----
// A command with an `id` is a request: its return value (or thrown error) is sent back as a reply.
const handlers = {
  // Replay history, then start live events. Same tick => no gap, no reordering.
  sync(c, { since = 0, boot }) {
    if (boot !== BOOT) since = 0;
    for (const e of events) if (e.seq > since) c.write(line(e));
    subscribers.add(c);
  },
  // `blank`: start without a first message (e.g. /clear).
  new(c, { cwd, text, nonce, model, mode, effort, images, blank }) {
    if (!blank && (typeof text !== 'string' || !text.trim())) throw new Error('First message is empty');
    const dir = resolveDir(cwd);
    if (!dir) throw new Error(`Not a directory on this host: ${cwd}`);
    const s = newSession({ cwd: dir, title: blank ? 'New session' : text.trim().slice(0, 60), model, mode });
    if (effort) s.effort = effort;
    addFolder(dir);
    emit(s.id, { kind: 'created', cwd: dir, title: s.title, nonce, model: s.model, mode: s.mode });
    run(s);
    if (!blank) sendText(s, text, images);
    return { sid: s.id };
  },
  // Reopen a past Claude Code session (from this daemon, the terminal, anywhere on this host).
  async resume(c, { claudeSessionId, cwd, title, nonce }) {
    for (const s of sessions.values()) {
      if (s.claudeSessionId === claudeSessionId && s.state !== 'ended' && !s.closed) return { sid: s.id, existing: true };
    }
    // The CLI finds a transcript by its project directory, so resume in the original one.
    const original = cwd || transcriptCwd(claudeSessionId);
    if (!original) throw new Error('Cannot tell which directory this session was started in');
    const dir = resolveDir(original);
    if (!dir) throw new Error(`The session's directory no longer exists: ${original}`);
    const history = await getSessionMessages(claudeSessionId, { dir });
    if (!history.length) throw new Error('This session has no readable messages');
    addFolder(dir);
    const s = newSession({ cwd: dir, title: title || 'Resumed session', resume: claudeSessionId });
    s.claudeSessionId = claudeSessionId;
    emit(s.id, { kind: 'created', cwd: dir, title: s.title, nonce, resumed: true, claudeSessionId });
    for (const m of history) {
      const note = m.type === 'user' && !m.parent_tool_use_id && parseNotification(m.message?.content);
      if (note) { emit(s.id, { kind: 'notify', ...note }); continue; }
      const prompt = m.type === 'user' && !m.parent_tool_use_id ? promptText(m.message?.content) : null;
      if (prompt === '') continue; // harness-injected text, not something the user typed
      if (prompt != null) {
        emit(s.id, { kind: 'user_text', text: prompt });
      } else if (m.type === 'user' || m.type === 'assistant') {
        const msg = slim(s, { type: m.type, message: m.message, parent_tool_use_id: m.parent_tool_use_id });
        if (msg.type === 'assistant' && !msg.message.content.length) continue;
        emit(s.id, { kind: 'msg', msg });
      }
    }
    emit(s.id, { kind: 'sys', subtype: 'resumed' });
    run(s); // the CLI waits for the next message
    return { sid: s.id };
  },
  send(c, { sid, text, images }) {
    const s = sessions.get(sid);
    if (!s || s.state === 'ended' || s.closed) throw new Error('Session is not running');
    if (typeof text !== 'string' || !text.trim()) return;
    sendText(s, text, images);
  },
  approve(c, { sid, rid, allow, answers, always }) {
    const s = sessions.get(sid);
    if (s) settle(s, rid, !!allow, { answers: answers && typeof answers === 'object' ? answers : undefined, always });
  },
  interrupt(c, { sid }) {
    sessions.get(sid)?.q?.interrupt().catch((e) => log('interrupt failed', e));
  },
  async setModel(c, { sid, model }) {
    const s = live(sid);
    await s.q.setModel(model || undefined);
    setMeta(s, { model: model || undefined });
    refreshStats(s);
  },
  async setMode(c, { sid, mode }) {
    const s = live(sid);
    await s.q.setPermissionMode(mode);
    setMeta(s, { mode });
    refreshStats(s);
  },
  async setEffort(c, { sid, effort }) {
    const s = live(sid);
    await s.q.applyFlagSettings({ effortLevel: effort || null });
    s.effort = effort || undefined;
    await refreshStats(s);
  },
  // What a session is busy with right now, for a page that just opened it.
  activity(c, { sid }) {
    const s = sessions.get(sid);
    if (!s) throw new Error('No such session');
    return {
      state: s.state, turnStart: s.turnStart, quietMs: s.lastMsgAt ? Date.now() - s.lastMsgAt : null,
      tasks: runningTasks(s), procs: s.procs || [],
    };
  },
  // Background work per session, for the sidebar colours.
  overview() {
    procScan();
    return [...sessions.values()].map((s) => ({ sid: s.id, tasks: runningTasks(s).length, procs: (s.procs || []).length }));
  },
  async stopTask(c, { sid, taskId }) {
    await live(sid).q.stopTask(taskId);
  },
  killProc(c, { sid, pid }) {
    const s = sessions.get(sid);
    if (!s?.procs?.some((p) => p.pid === pid)) throw new Error('Not one of this session\'s background processes');
    process.kill(pid, 'SIGTERM');
    setTimeout(procScan, 1500);
  },
  setColor(c, { sid, color }) {
    const s = sessions.get(sid);
    if (!s) throw new Error('No such session');
    setMeta(s, { color: color || null });
  },
  // Fresh numbers for the status line (the UI polls this for the session on screen).
  async stats(c, { sid }) {
    const s = sessions.get(sid);
    if (!s) throw new Error('No such session');
    s.stats = await collectStats(s);
    return s.stats;
  },
  async commands(c, { sid }) {
    const s = live(sid);
    return (s.commandsCache ??= await s.q.supportedCommands());
  },
  async models(c, { sid }) {
    const s = sid ? live(sid) : [...sessions.values()].find((x) => x.q && x.state !== 'ended');
    if (!s) return [];
    return (s.modelsCache ??= await s.q.supportedModels());
  },
  complete(c, { sid, cwd, query: q = '' }) {
    const dir = sessions.get(sid)?.cwd || (cwd && resolveDir(cwd)); // a draft has only its folder
    if (!dir) throw new Error('No such session');
    return fuzzy(listFiles(dir), String(q));
  },
  // Is this video playable in a browser as is? If not, convert it (or join the running conversion).
  prepareMedia(c, { path: p }) {
    const file = path.resolve(os.homedir(), String(p || ''));
    const st = fs.statSync(file);
    if (!HAS_FFMPEG) return { path: file, size: st.size, playable: null }; // can't tell; let the browser try
    let info;
    try { info = probeVideo(file); } catch { return { path: file, size: st.size, playable: null }; } // not a video ffprobe knows
    if (PLAYABLE.has(info.codec)) return { path: file, size: st.size, playable: true, codec: info.codec };
    const key = createHash('sha1').update(`${file}:${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 16);
    const out = path.join(MEDIA_DIR, `${key}.mp4`);
    if (fs.existsSync(out)) { fs.utimesSync(out, new Date(), new Date()); return { path: out, size: fs.statSync(out).size, playable: true, converted: true, codec: info.codec }; }
    const job = mediaJobs.get(key) || (convert(file, st, info, key), mediaJobs.get(key));
    return { converting: true, key, progress: job.progress, codec: info.codec };
  },
  // A slice of a file, base64, for the resource list (images, video): read in chunks so a big
  // file streams over the ssh pipe with progress instead of one giant message.
  readChunk(c, { path: p, offset = 0, length = 1 << 20 }) {
    const file = path.resolve(os.homedir(), String(p || ''));
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Not a file');
    const n = Math.max(0, Math.min(Number(length) || 0, 4 << 20, st.size - offset));
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, Number(offset) || 0); } finally { fs.closeSync(fd); }
    return { size: st.size, offset, data: buf.toString('base64'), eof: offset + n >= st.size };
  },
  usageHistory(c, { days = 7 } = {}) {
    const cut = Date.now() - Math.min(35, Number(days) || 7) * 24 * 3600 * 1000;
    let lines = [];
    try { lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n'); } catch {}
    const out = [];
    for (const l of lines) { if (!l) continue; try { const x = JSON.parse(l); if (x.t >= cut) out.push(x); } catch {} }
    return out;
  },
  // Where a path mentioned in the conversation really is: relative ones are taken from the session directory.
  stat(c, { sid, path: p }) {
    const s = sessions.get(sid);
    const base = s?.cwd || os.homedir();
    const file = path.resolve(base, String(p || '').replace(/^~(?=$|\/)/, os.homedir()));
    try {
      const st = fs.statSync(file);
      return { path: file, exists: true, dir: st.isDirectory(), size: st.size };
    } catch {
      return { path: file, exists: false };
    }
  },
  readFile(c, { sid, path: p }) {
    const s = sessions.get(sid);
    const base = s?.cwd || os.homedir();
    const file = path.resolve(base, String(p || '').replace(/^~(?=$|\/)/, os.homedir()));
    return readForView(file);
  },
  // Terminal sessions and the ones from this UI by default; `all` adds headless `claude -p` / Python SDK runs.
  async history(c, { all = false, cwd } = {}) {
    const list = await listSessions(cwd ? { dir: cwd, includeWorktrees: false, limit: 400 } : { limit: all ? 150 : 400 });
    const index = transcriptIndex();
    const open = new Map([...sessions.values()].filter((s) => !s.closed && s.state !== 'ended').map((s) => [s.claudeSessionId, s.id]));
    const out = [];
    for (const x of list) {
      const meta = transcriptMeta(index.get(x.sessionId));
      if (!meta.hasMessages) continue; // empty stubs
      const headless = meta.entrypoint === 'sdk-cli' || meta.entrypoint === 'sdk-py';
      if (headless && !all && !ours.has(x.sessionId)) continue;
      if (cwd && resolveDir(x.cwd || meta.cwd) !== resolveDir(cwd)) continue; // not its subdirectories or worktrees
      out.push({
        claudeSessionId: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || '(untitled)',
        cwd: x.cwd || meta.cwd, lastModified: x.lastModified, gitBranch: x.gitBranch,
        openAs: open.get(x.sessionId), fromUi: ours.has(x.sessionId) || meta.entrypoint === 'sdk-ts',
        source: meta.entrypoint === 'cli' ? 'terminal' : headless ? 'headless' : meta.entrypoint === 'sdk-ts' ? 'sdk' : meta.entrypoint,
      });
      if (out.length >= 150) break;
    }
    return out;
  },
  // Structured data behind /usage and /context, rendered as panels by the UI.
  async usage(c, { sid }) {
    const q = live(sid).q;
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET; // experimental in the SDK
    if (typeof fn !== 'function') throw new Error('This SDK version has no usage API');
    return fn.call(q, { skipBehaviors: true });
  },
  async context(c, { sid }) {
    return live(sid).q.getContextUsage({ detail: 'summary' });
  },
  // /btw: side conversations on a throwaway fork of the session (no tools, never saved as a session),
  // so they can run while the main turn is busy and never show up in it. Follow-ups continue the thread.
  btw(c, { sid, text, bid }) {
    const s = sessions.get(sid);
    if (!s?.claudeSessionId) throw new Error('/btw needs a conversation to ask about: send a message first');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Usage: /btw <question>');
    let t = bid && btwThreads.get(bid);
    if (bid && !t) throw new Error('That side thread is gone');
    if (!t) {
      t = { bid: randomUUID().slice(0, 8), sid: s.id, claudeSessionId: s.claudeSessionId, cwd: s.cwd, created: Date.now(), messages: [] };
      btwThreads.set(t.bid, t);
    }
    if (t.busy) throw new Error('Still answering the previous question');
    t.messages.push({ role: 'user', text, at: Date.now() });
    t.busy = true;
    saveBtw();
    btwAsk(t, text);
    return { bid: t.bid };
  },
  btwList(c, { sid }) {
    const s = sessions.get(sid);
    const id = s?.claudeSessionId;
    return [...btwThreads.values()]
      .filter((t) => id && t.claudeSessionId === id)
      .sort((a, b) => b.created - a.created)
      .map(({ bid, created, messages, busy }) => ({ bid, created, messages, busy: !!busy }));
  },
  btwClose(c, { bid }) {
    const t = btwThreads.get(bid);
    if (t?.proc) { try { t.proc.q.close(); } catch {} t.proc = null; }
  },
  // The sidebar's folders. The first time, they are the directories of recent sessions from this UI.
  async folders() {
    if (!folders) {
      folders = [...new Set([...sessions.values()].map((s) => s.cwd))];
      for (const d of await recentDirs(8, true).catch(() => [])) if (!folders.includes(d)) folders.push(d);
      saveFolders();
    }
    return folders;
  },
  addFolder(c, { path: p }) {
    const dir = resolveDir(p);
    if (!dir) throw new Error(`Not a directory on this host: ${p}`);
    addFolder(dir);
    return { path: dir, folders };
  },
  removeFolder(c, { path: p }) {
    folders = (folders || []).filter((d) => d !== p);
    saveFolders();
    return { folders };
  },
  // Subdirectories of a directory, for the folder picker.
  ls(c, { path: p }) {
    const dir = resolveDir(p);
    if (!dir) throw new Error(`Not a directory on this host: ${p}`);
    let dirs = [];
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() || (e.isSymbolicLink() && resolveDir(path.join(dir, e.name))))
        .map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 2000);
    } catch (e) { throw new Error(`Cannot list ${dir}: ${e.code || e.message}`); }
    return { path: dir, dirs };
  },
  recentDirs() { return recentDirs(20); },
  setSuggest(c, { on }) {
    settings.suggest = !!on;
    saveSettings();
    return { suggest: settings.suggest };
  },
  async status(c, { sid }) {
    const s = sessions.get(sid);
    if (!s) throw new Error('No such session');
    const out = { cwd: s.cwd, model: s.model, mode: s.mode, claudeSessionId: s.claudeSessionId, host: os.hostname(), state: s.state };
    if (s.q && s.state !== 'ended' && !s.closed) {
      out.account = await s.q.accountInfo().catch(() => null);
      out.mcp = await s.q.mcpServerStatus().catch(() => null);
    }
    return out;
  },
  async rename(c, { sid, title }) {
    const s = sessions.get(sid);
    if (!s || typeof title !== 'string' || !title.trim()) return;
    setMeta(s, { title: title.trim().slice(0, 120) });
    if (s.claudeSessionId) await renameSession(s.claudeSessionId, s.title, { dir: s.cwd }).catch((e) => log('rename failed', e));
  },
  close(c, { sid }) {
    const s = sessions.get(sid);
    if (!s || s.closed) return;
    s.closed = true;
    for (const rid of [...s.pending.keys()]) settle(s, rid, false);
    try { s.q?.close(); } catch {}
    emit(s.id, { kind: 'closed' });
  },
};

function live(sid) {
  const s = sessions.get(sid);
  if (!s?.q || s.state === 'ended' || s.closed) throw new Error('Session is not running');
  return s;
}

function reply(c, obj) { c.write(line(obj)); }

function dispatch(c, cmd) {
  let out;
  try {
    out = handlers[cmd.type](c, cmd);
  } catch (e) {
    out = Promise.reject(e);
  }
  if (cmd.id == null) {
    Promise.resolve(out).catch((e) => reply(c, { type: 'error', text: String(e?.message || e) }));
    return;
  }
  Promise.resolve(out).then(
    (data) => reply(c, { type: 'reply', id: cmd.id, data: data ?? null }),
    (e) => reply(c, { type: 'reply', id: cmd.id, error: String(e?.message || e) }),
  );
}

function onClient(c) {
  reply(c, { type: 'hello', boot: BOOT, seq, pid: process.pid, host: os.hostname(), code: CODE, home: os.homedir() });
  let buf = '';
  c.setEncoding('utf8');
  c.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!l) continue;
      let cmd;
      try { cmd = JSON.parse(l); } catch (e) { log('bad command', l.slice(0, 200), e); continue; }
      if (Object.hasOwn(handlers, cmd.type)) dispatch(c, cmd);
      else if (cmd.id != null) reply(c, { type: 'reply', id: cmd.id, error: `The server doesn't know "${cmd.type}": redeploy it (node client/client.mjs deploy --host …)` });
    }
  });
  const drop = () => subscribers.delete(c);
  c.on('close', drop);
  c.on('error', drop);
}

// ---- start: refuse to run twice, clean up a stale socket ----
fs.mkdirSync(DIR, { recursive: true });
const probe = net.connect(SOCK);
probe.on('connect', () => { log('daemon already running'); process.exit(0); });
probe.on('error', () => {
  fs.rmSync(SOCK, { force: true });
  const server = net.createServer(onClient);
  server.on('error', (e) => { log('cannot listen on', SOCK, e.message); process.exit(1); });
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o600);
    log('daemon listening on', SOCK, 'pid', process.pid);
  });
});
