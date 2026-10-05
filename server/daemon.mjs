// Long-lived daemon on the remote host. Owns every Claude session so they keep
// running when the laptop disconnects. Clients talk newline-delimited JSON over
// a Unix socket (reached through `ssh host node attach.mjs`, no TCP port).
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query, listSessions, getSessionMessages, renameSession } from '@anthropic-ai/claude-agent-sdk';

const DIR = process.env.IRO_DIR || path.join(os.homedir(), '.iro-coding');
const SOCK = path.join(DIR, 'daemon.sock');
const BOOT = randomUUID(); // lets clients notice a daemon restart
// The release folder this daemon runs from (releases/r<time> on a host; see client/client.mjs).
const RELEASE = path.basename(path.dirname(fileURLToPath(import.meta.url)));
// Fingerprint of this file: the client compares it with its own copy to spot an outdated server.
// What Claude is told about the web UI it is shown in (appended to Claude Code's system prompt): kept in
// ui-prompt.md next to this file, read once at start.
const UI_PROMPT_FILE = new URL('./ui-prompt.md', import.meta.url);
const UI_PROMPT = fs.existsSync(UI_PROMPT_FILE) ? fs.readFileSync(UI_PROMPT_FILE, 'utf8').trim() : '';
// Fingerprint of this file and the UI prompt (client/main.mjs takes the same one of its checkout).
const CODE = createHash('sha1').update(fs.readFileSync(new URL(import.meta.url))).update(fs.existsSync(UI_PROMPT_FILE) ? fs.readFileSync(UI_PROMPT_FILE) : '').digest('hex').slice(0, 12);
// The SDK ships its own Claude Code; it doesn't auto-update like the terminal's `claude`. The daemon
// compares it with the newest SDK on npm, and the UI offers "Update server" when it falls behind.
const SDK = { version: null, cc: null, latest: null, latestCc: null };
try {
  const pkg = JSON.parse(fs.readFileSync(new URL('./node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8'));
  Object.assign(SDK, { version: pkg.version, cc: pkg.claudeCodeVersion || null });
} catch {}
// Whether that Claude Code is logged in here, asked of it (`claude auth status`): without a login every
// turn ends at once with "Not logged in", so the UI says so up front, with the command that logs in.
// `cmd` is the SDK's own binary: the host may have no `claude` on PATH (both share ~/.claude).
const AUTH = { loggedIn: null, cmd: '' };
const CLAUDE_BIN = (() => {
  const dir = new URL('./node_modules/@anthropic-ai/', import.meta.url);
  try {
    for (const d of fs.readdirSync(dir)) {
      if (!d.startsWith('claude-agent-sdk-')) continue;
      for (const f of ['claude', 'claude.exe']) { const p = fileURLToPath(new URL(`${d}/${f}`, dir)); if (fs.existsSync(p)) return p; }
    }
  } catch {}
  return '';
})();
if (CLAUDE_BIN) AUTH.cmd = `${CLAUDE_BIN.startsWith(os.homedir() + path.sep) ? '~' + CLAUDE_BIN.slice(os.homedir().length) : CLAUDE_BIN} auth login`;
let authTimer = null;
function checkAuth() {
  if (!CLAUDE_BIN) return;
  execFile(CLAUDE_BIN, ['auth', 'status', '--json'], { timeout: 20000 }, (e, stdout) => {
    let loggedIn;
    try { loggedIn = JSON.parse(stdout).loggedIn === true; } catch { return; } // (it couldn't tell: keep what we had)
    // Until it is logged in, ask again every 15 s, so the notice goes away soon after you log in.
    clearTimeout(authTimer);
    if (!loggedIn) authTimer = setTimeout(checkAuth, 15000);
    if (loggedIn === AUTH.loggedIn) return;
    AUTH.loggedIn = loggedIn;
    const l = line({ type: 'partial', sid: '', op: 'auth', auth: AUTH });
    for (const c of clients) c.write(l); // every client, also one between its hello and its sync
  });
}
// Who you are on this host, for the avatar on your messages: git's user.name, else the login name.
let USER_NAME = '';
try { USER_NAME = execFileSync('git', ['config', '--global', 'user.name'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(); } catch {}
if (!USER_NAME) try { USER_NAME = os.userInfo().username; } catch {}
const MAX_TOOL_OUTPUT = 20000; // chars kept per tool result in the event log
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const OURS_FILE = path.join(DIR, 'sessions.json'); // Claude session ids started from this UI

// State files are shared with a daemon of the previous version while it hands its sessions over (see
// "rolling updates"), so every write re-reads the file and changes only its own entry.
const readJson = (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? dflt; } catch { return dflt; } };
function writeJson(file, value) {
  try {
    fs.writeFileSync(file + `.${process.pid}.tmp`, JSON.stringify(value));
    fs.renameSync(file + `.${process.pid}.tmp`, file); // never leave a half-written file behind
  } catch (e) { log('cannot save', file, e.message); }
}
// Read the file afresh, change it with `fn` (in place, or return the new value), and save it.
// `fn` returning false leaves the file as it was. Returns the value as saved (or as read).
function updateJson(file, dflt, fn) {
  const v = readJson(file, dflt);
  const r = fn(v);
  if (r === false) return v;
  writeJson(file, r ?? v);
  return r ?? v;
}
// A path as the user writes it: `~` is the home directory, a relative one is in `base` (default home).
const expandHome = (p) => String(p ?? '').replace(/^~(?=$|\/)/, os.homedir());
const userPath = (p, base = os.homedir()) => path.resolve(base, expandHome(p));
// A session's title as the UI gives one (its first message), for a session it lists from disk.
const titleOf = (x) => x.customTitle || x.firstPrompt?.trim().slice(0, 60) || x.summary || 'Session';
const ours = new Set(readJson(OURS_FILE, []));
function rememberOurs(id) {
  if (!id || ours.has(id)) return;
  updateJson(OURS_FILE, [], (all) => {
    for (const x of all) ours.add(x);
    ours.add(id);
    return [...ours].slice(-500);
  });
}

// The sidebar's sessions outlive the daemon: each folder remembers its RECENT_MAX most recently
// used sessions ({ dir: [{ id, title, t }] }, newest first). A restarted daemon lists them as detached.
const RECENT_FILE = path.join(DIR, 'recent.json');
const RECENT_MAX = 8;
let recent = readJson(RECENT_FILE, {});
// `bump`: the session was just used (a message, a reply, a reattach); otherwise only its title changed.
function touchRecent(s, bump = true) {
  const id = s.claudeSessionId;
  if (!id) return;
  if (bump) unarchive(id);
  recent = updateJson(RECENT_FILE, recent, (all) => {
    const list = all[s.cwd] || [];
    const old = list.find((x) => x.id === id);
    if (!old && !bump) return false;
    const entry = { id, title: s.title, t: bump || !old ? Date.now() : old.t };
    all[s.cwd] = [entry, ...list.filter((x) => x.id !== id)].sort((a, b) => b.t - a.t).slice(0, RECENT_MAX);
  });
}

// Sessions archived from the sidebar (Claude session ids): out of recent.json, and kept out when a
// restarted daemon re-seeds it. Using one again (a reopen from Past sessions, a message) unarchives it.
const ARCHIVED_FILE = path.join(DIR, 'archived.json');
function archive(id) {
  updateJson(ARCHIVED_FILE, [], (all) => !all.includes(id) && [...all, id].slice(-2000));
  recent = updateJson(RECENT_FILE, recent, (all) => { for (const dir of Object.keys(all)) all[dir] = all[dir].filter((x) => x.id !== id); });
}
function unarchive(id) {
  updateJson(ARCHIVED_FILE, [], (all) => all.includes(id) && all.filter((x) => x !== id));
}

// Each session's /color, by Claude session id: kept apart from recent.json so it survives the
// session dropping out of the top RECENT_MAX, a missing recent.json, detach, reattach and restarts.
const COLORS_FILE = path.join(DIR, 'colors.json');
let colors = readJson(COLORS_FILE, {});
function saveColor(s) {
  if (!s.claudeSessionId) return;
  colors = updateJson(COLORS_FILE, colors, (all) => { if (s.color) all[s.claudeSessionId] = s.color; else delete all[s.claudeSessionId]; });
}

// A rewound session nobody has written to since: its transcript still ends with the turns rewound
// away, so until its next message every resume must start at the rewind point (claude id -> uuid).
const REWINDS_FILE = path.join(DIR, 'rewinds.json');
const rewindPoint = (id) => (id && readJson(REWINDS_FILE, {})[id]) || undefined;
function setRewindPoint(id, uuid) {
  if (!id) return;
  updateJson(REWINDS_FILE, {}, (all) => {
    if (uuid) all[id] = uuid; else if (id in all) delete all[id]; else return false;
  });
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
// A 'data' listener that calls `fn` with each complete, non-empty line.
// Only the new chunk is searched: a 48 MB message (pasted images) arrives in ~750 chunks, and
// rescanning the whole buffer each time would stall the event loop for seconds.
function lines(fn) {
  let buf = '';
  return (chunk) => {
    let from = 0, i;
    while ((i = chunk.indexOf('\n', from)) >= 0) {
      const l = (buf + chunk.slice(from, i)).trim();
      buf = '';
      from = i + 1;
      if (l) fn(l);
    }
    buf += chunk.slice(from);
  };
}

// Streaming deltas are live-only: not logged, not replayed.
function partial(sid, p) {
  if (movedAway(sid)) return;
  const l = line({ type: 'partial', sid, ...p });
  for (const c of subscribers) c.write(l);
}

function emit(sid, ev) {
  if (movedAway(sid)) return; // the new daemon carries this session on, under the same sid
  const e = { type: 'event', seq: ++seq, sid, ts: Date.now(), ...ev };
  events.push(e);
  const l = line(e);
  for (const c of subscribers) c.write(l);
}

// ---- sessions ----
const sessions = new Map();
const alive = (s) => !!s && !s.closed && s.state !== 'ended'; // its CLI runs here (not detached)
const REWINDING = 'This session is rewinding: try again in a moment';

// The model list when no session runs here yet (a new session's draft): a CLI started only to
// ask, closed before any message. Kept; a failure is retried after a minute.
let modelsProbe = null;
async function probeModels() {
  const q = query({ prompt: inbox(), options: { cwd: os.homedir(), persistSession: false } });
  try {
    return await Promise.race([q.supportedModels(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 30e3))]);
  } catch (e) {
    log('model list', e.message);
    setTimeout(() => (modelsProbe = null), 60e3);
    return [];
  } finally {
    q.close();
  }
}

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

// What each SDK message does to its session, by `type/subtype` (system messages) or `type`. A message
// no entry knows is left out. (Live activity, e.g. thinking tokens or tool progress: activity().)
const ON_MESSAGE = {
  'system/init'(s, m) {
    if (!s.initDone) s.mode = m.permissionMode; // initial mode: shown by the init event itself
    else if (m.permissionMode && m.permissionMode !== s.mode) setMeta(s, { mode: m.permissionMode });
    if (s.initDone) return; // init repeats every turn
    s.initDone = true;
    if (s.resumeAt) setRewindPoint(s.claudeSessionId, null); // the transcript now goes on from the rewind point
    s.claudeSessionId = m.session_id;
    rememberOurs(m.session_id);
    touchRecent(s);
    if (s.color) saveColor(s); // coloured before its id was known
    emit(s.id, { kind: 'init', model: m.model, mode: m.permissionMode, claudeSessionId: m.session_id });
    refreshStats(s);
  },
  'system/session_state_changed'(s, m) {
    // Idle is authoritative when the CLI reports it (e.g. after an interrupt), but it comes after the
    // result: if the next queued message went in at that result, this idle is about the turn before it.
    if (m.state !== 'idle' || s.sentSinceResult) return;
    s.queued = 0;
    if (!s.pending.size) setState(s, 'idle');
    drainQueue(s);
  },
  'system/status'(s, m) {
    if (m.permissionMode && m.permissionMode !== s.mode) setMeta(s, { mode: m.permissionMode });
  },
  prompt_suggestion(s, m) { emit(s.id, { kind: 'suggest', text: String(m.suggestion || '').slice(0, 500) }); },
  stream_event(s, m) { streamDelta(s, m.event, m.parent_tool_use_id); },
  // A hook that ran: shown in the turn when it said something or failed (silent successes are skipped).
  'system/hook_response'(s, m) {
    const out = String(m.stderr || m.stdout || m.output || '').trim();
    if (out || m.outcome !== 'success') emit(s.id, { kind: 'sys', subtype: 'hook', event: m.hook_event, name: m.hook_name, outcome: m.outcome, exit: m.exit_code, text: clip(out) });
  },
  'system/informational'(s, m) {
    if (m.level !== 'info') emit(s.id, { kind: 'sys', subtype: 'info', level: m.level, text: clip(String(m.content || '')) });
  },
  'system/compact_boundary'(s, m) {
    emit(s.id, { kind: 'sys', subtype: 'compact', trigger: m.compact_metadata?.trigger, pre: m.compact_metadata?.pre_tokens, post: m.compact_metadata?.post_tokens });
  },
  'system/api_retry'(s, m) {
    emit(s.id, { kind: 'sys', subtype: 'retry', attempt: m.attempt, max: m.max_retries, status: m.error_status, delay: m.retry_delay_ms });
  },
  'system/local_command_output'(s, m) { emit(s.id, { kind: 'sys', subtype: 'local', text: clip(String(m.content ?? '')) }); },
  user(s, m) {
    const note = !m.parent_tool_use_id && parseNotification(m.message?.content);
    if (!note) return addMessage(s, m);
    emit(s.id, { kind: 'notify', ...note });
    if (s.state === 'idle') setState(s, 'running'); // Claude answers it with a turn of its own
  },
  assistant: (s, m) => addMessage(s, m),
  result: (s, m) => addMessage(s, m),
};
// A conversation message: into the event log, and a result ends the turn (then the next queued one goes).
function addMessage(s, m) {
  const msg = slim(s, m);
  if (msg.type === 'assistant' && !msg.message.content.length) return; // thinking only
  // Claude can start a turn on its own (e.g. a background task finished).
  if (msg.type === 'assistant' && s.state === 'idle') setState(s, 'running');
  emit(s.id, { kind: 'msg', msg });
  // A "<synthetic>" message is the CLI's own answer (a slash command, or "Not logged in"), not Claude's.
  if (msg.type === 'assistant' && msg.message.model === '<synthetic>') {
    if (/not logged in/i.test(msg.message.content.map((b) => b.text || '').join(' '))) checkAuth(); // e.g. logged out from a terminal
  } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
    s.turnText = (s.turnText || '') + msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (m.type !== 'result') return;
  touchRecent(s);
  s.sentSinceResult = false;
  if (--s.queued > 0) return;
  s.queued = 0;
  setState(s, 'idle');
  refreshStats(s, true);
  if (m.num_turns) predictNext(s);
  drainQueue(s);
}


async function run(s) {
  s.q = query({
    prompt: s.inbox,
    options: {
      cwd: s.cwd,
      // As close to the terminal's `claude` as a headless CLI gets: Claude Code's own system prompt
      // (without it the SDK sends an empty one), the permission mode from settings.json
      // (permissions.defaultMode; the SDK would force "default"), file checkpoints as the terminal
      // keeps them, and Stop sparing background tasks (the Tasks tab stops them one by one).
      // Bypass permissions can be picked (like `claude --allow-dangerously-skip-permissions`; the UI
      // asks first). The Artifact tools and forked subagents, which a headless CLI leaves out, are
      // turned on unless the environment says otherwise (CLAUDE_CODE_ARTIFACT=0 / _FORK_SUBAGENT=0).
      // `append`: what the terminal's prompt can't know about this UI (ui-prompt.md).
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(UI_PROMPT ? { append: UI_PROMPT } : {}) },
      resolvePermissionModeInCli: true,
      enableFileCheckpointing: true,
      perTaskStopAffordance: true,
      allowDangerouslySkipPermissions: true,
      // A comment sent to Claude on an artifact is first checked against the permission to reply. In auto
      // mode that check asks the classifier, which a headless CLI reports as unavailable, and the comment is
      // then dropped without a word: allowing the tool by rule lets the comment start a turn, as in the terminal.
      allowedTools: ['ArtifactComments'],
      env: { ...process.env, CLAUDE_CODE_ARTIFACT: process.env.CLAUDE_CODE_ARTIFACT ?? '1', CLAUDE_CODE_FORK_SUBAGENT: process.env.CLAUDE_CODE_FORK_SUBAGENT ?? '1' },
      // Hook runs and a one-line summary of what each subagent is doing, as the terminal shows them.
      includeHookEvents: true,
      agentProgressSummaries: true,
      // A branch: a copy of the conversation (up to `at`, an assistant message) under a new session id.
      ...(s.fork ? { forkSession: true } : {}),
      // A branch, or a rewind: the conversation only up to this assistant message.
      ...(s.fork?.at || s.resumeAt ? { resumeSessionAt: s.fork?.at || s.resumeAt } : {}),
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
      // A message this code can't handle must not end the session: the CLI is still running.
      try {
        if (activity(s, m)) continue;
        (ON_MESSAGE[`${m.type}/${m.subtype}`] || ON_MESSAGE[m.type])?.(s, m);
      } catch (e) {
        log(`[${s.id}] cannot handle ${m?.type}/${m?.subtype}`, e);
      }
    }
  } catch (e) {
    log(`[${s.id}] query failed`, e);
    emit(s.id, { kind: 'error', text: String(e?.message || e) });
  }
  for (const rid of [...s.pending.keys()]) settle(s, rid, false);
  if (!s.replaced) { // (a rewind restarts the CLI under the same sid: that session goes on)
    setState(s, 'ended');
    clearQueue(s);
  }
  s.finished();
}

// ---- activity: what the session is doing right now (live only, not logged) ----
function taskView(t) {
  return { id: t.id, description: t.description, type: t.type, status: t.status, background: !!t.background,
    toolUses: t.toolUses, tokens: t.tokens, lastTool: t.lastTool, started: t.started, summary: t.summary };
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
      if (m.patch?.status) t.status = m.patch.status;
      if (m.patch?.description) t.description = m.patch.description;
      if (m.patch?.is_backgrounded != null) t.background = m.patch.is_backgrounded;
      break;
    case 'task_progress':
      Object.assign(t, { description: m.description || t.description, toolUses: m.usage?.tool_uses, tokens: m.usage?.total_tokens, lastTool: m.last_tool_name, summary: m.summary || t.summary });
      break;
    case 'task_notification':
      t.status = m.status;
      break;
    case 'background_tasks_changed': {
      const list = m.tasks || [];
      const alive = new Set(list.map((x) => x.task_id));
      for (const x of list) {
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
  if ('title' in meta) touchRecent(s, false);
  if ('color' in meta) saveColor(s);
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
  const uuid = randomUUID(); // the CLI keeps it: a rewind names this message by it
  emit(s.id, { kind: 'user_text', text, uuid, ...(images.length ? { images } : {}) });
  touchRecent(s);
  s.queued++;
  s.sentSinceResult = true;
  setState(s, s.pending.size ? 'waiting' : 'running');
  const content = images.length
    ? [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })), { type: 'text', text }]
    : text;
  s.inbox.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null });
}

// ---- queued messages ----
// A message sent while Claude is busy waits here until the turn ends; handed to the CLI at once it
// would slip into the running turn. Each one becomes a turn of its own, in order. "Send now" moves
// one to the front and interrupts the turn (the terminal's Ctrl+X Ctrl+S).
const turnBusy = (s) => s.state === 'running' || s.state === 'waiting' || s.queued > 0;
function emitQueue(s) {
  emit(s.id, { kind: 'queue', items: s.outbox.map((m) => ({ qid: m.qid, text: m.text, images: m.images.length })) });
}
function enqueue(s, text, images = []) {
  (s.outbox ||= []).push({ qid: randomUUID().slice(0, 8), text, images: Array.isArray(images) ? images : [] });
  emitQueue(s);
}
function drainQueue(s) {
  if (!s.outbox?.length || turnBusy(s) || !alive(s)) return;
  const m = s.outbox.shift();
  emitQueue(s);
  sendText(s, m.text, m.images);
}
function clearQueue(s) {
  if (!s.outbox?.length) return;
  s.outbox = [];
  emitQueue(s);
}

// "~/x", "x" (relative to home) and "/abs/x" all work.
function resolveDir(input) {
  const dir = userPath((input || '').trim() || '~');
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

// `id`: a session handed over by the previous daemon keeps the sid the UI knows it by.
function newSession({ cwd, title, model, mode, resume }, id = randomUUID().slice(0, 8)) {
  const s = {
    id, cwd, title, state: 'idle', queued: 0, model: model || undefined, mode: mode || undefined,
    resume, inbox: inbox(), pending: new Map(), toolNames: new Map(), tasks: new Map(), created: Date.now(),
  };
  s.done = new Promise((r) => (s.finished = r)); // run() has returned: its CLI is gone
  sessions.set(s.id, s);
  return s;
}

// ---- status line: model, effort, context, plan limits, session totals ----
const limitWindow = (x) => (x && x.utilization != null ? { pct: x.utilization, resets: x.resets_at } : null);
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
  if (!s.q || !alive(s)) return out;
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
  if (rl) out.limits = { five: limitWindow(rl.five_hour), week: limitWindow(rl.seven_day) };
  return out;
}

// ---- plan usage: the history (sampled on the hour and the half hour) and the level on screen ----
// The usage API is the endpoint the terminal status line uses, with the CLI's own OAuth token
// (Linux: ~/.claude/.credentials.json). It is asked at most once per USAGE_GAP, whoever asks (the
// sampler, a client coming back to the page), except that the sampler's first ask in a half hour goes.
const USAGE_FILE = path.join(DIR, 'usage.jsonl');
const USAGE_KEEP = 35 * 24 * 3600 * 1000;
const USAGE_GAP = (Number(process.env.IRO_USAGE_GAP_MIN) || 5) * 60 * 1000;
// An older reading: from an earlier window, or lower within the same one (the level only rises).
function older(cur, prev) {
  if (cur?.pct == null || prev?.pct == null || !cur.resets || !prev.resets) return false;
  const d = new Date(cur.resets) - new Date(prev.resets);
  return d < -2 * 60 * 1000 || (Math.abs(d) < 2 * 60 * 1000 && cur.pct < prev.pct);
}
const isOlder = (l, than) => older(l.five, than?.five) || older(l.week, than?.week);
let lastRecord = null;
function recordUsage(limits) {
  if (!limits || (!limits.five && !limits.week)) return;
  if (process.env.IRO_NO_USAGE_RECORD) return; // a test that brings its own usage history (and asks no API)
  lastRecord ??= readUsage().at(-1) || {};
  if (limits.t <= (lastRecord.t || 0) || isOlder(limits, lastRecord)) return;
  lastRecord = { t: limits.t, five: limits.five, week: limits.week };
  try { fs.appendFileSync(USAGE_FILE, JSON.stringify(lastRecord) + '\n'); } catch {}
}
async function usageFromApi() {
  let token;
  try { token = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth?.accessToken; } catch {}
  // macOS keeps Claude Code's login in the Keychain, not in a file: without this a laptop records
  // nothing while no session is open (the token is the one the CLI keeps fresh).
  if (!token && process.platform === 'darwin' && !process.env.CLAUDE_CONFIG_DIR) {
    try {
      const raw = execFileSync('security', ['find-generic-password', '-a', os.userInfo().username, '-s', 'Claude Code-credentials', '-w'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      token = JSON.parse(raw).claudeAiOauth?.accessToken;
    } catch {}
  }
  if (!token) return null;
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) { log('usage API', r.status); return null; }
  const u = await r.json();
  return { t: Date.now(), five: limitWindow(u.five_hour), week: limitWindow(u.seven_day) };
}
let askedAt = 0, asking = null, lastApi = null;
// The usage API, unless it was asked less than `gap` ago: then the answer it gave (or null).
function askUsage(gap = USAGE_GAP) {
  if (asking) return asking;
  if (Date.now() - askedAt < gap || process.env.IRO_NO_USAGE_RECORD) return Promise.resolve(lastApi);
  askedAt = Date.now();
  asking = usageFromApi().catch((e) => { log('usage API', e.message); return null; }).then((l) => {
    asking = null;
    if (l) { lastApi = l; setLimits(l); }
    return lastApi;
  });
  return asking;
}
// One sample per interval (Settings: 30 minutes by default), taken on the local clock (:00 and :30).
// It looks every minute, so a slot a sleeping laptop, a restart or a failed query missed is filled as
// soon as it can be (a failed query is asked again after USAGE_GAP). A sample is stamped with its slot,
// even when it was filled late (the API refused at :30 and answered at :40), so the charts only ever
// show samples on the clock.
async function sampleUsage() {
  if (retiring) return; // an update has begun: the new daemon keeps the history, one writer only
  const now = new Date();
  const every = settings.usageInterval;
  const slot = new Date(now).setMinutes(now.getMinutes() - (now.getMinutes() % every), 0, 0);
  lastRecord ??= readUsage().at(-1) || {};
  if ((lastRecord.t || 0) >= slot) return;
  const l = await askUsage(Math.min(USAGE_GAP, now - slot));
  if (l && l.t >= slot) recordUsage({ ...l, t: slot });
}

// The level the status line shows: one per account, the newest reading from the usage API or from
// a session that just finished a turn (its numbers came with the API call it just made). Every
// change is pushed to the clients; nothing on the page polls.
let limitsNow = null;
function setLimits(l) {
  if (!l || (!l.five && !l.week)) return;
  if (limitsNow && (l.t <= limitsNow.t || isOlder(l, limitsNow))) return;
  limitsNow = { t: l.t, five: l.five, week: l.week };
  const msg = line({ type: 'partial', op: 'limits', limits: limitsNow });
  for (const c of subscribers) c.write(msg);
}
{ const x = readUsage().at(-1); if (x) limitsNow = { t: x.t, five: x.five, week: x.week }; }

// (every interval Settings offers is a multiple of 5 minutes, and so is every sample on the clock)
const onSlot = (t) => { const d = new Date(t); return d.getMinutes() % 5 === 0 && !d.getSeconds() && !d.getMilliseconds(); };
// The samples in usage.jsonl, oldest first (unreadable lines skipped).
function readUsage() {
  let lines = [];
  try { lines = fs.readFileSync(USAGE_FILE, 'utf8').split('\n'); } catch {}
  const out = [];
  for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out;
}
function pruneUsage() {
  const all = readUsage();
  const keep = all.filter((x) => x.t >= Date.now() - USAGE_KEEP);
  if (keep.length < all.length) try { fs.writeFileSync(USAGE_FILE, keep.map((x) => JSON.stringify(x) + '\n').join('')); } catch {}
}
setTimeout(sampleUsage, 20 * 1000);
setInterval(sampleUsage, 60 * 1000);
setInterval(pruneUsage, 6 * 3600 * 1000);

// `turnEnd`: the session has just made its API calls, so its plan limits are current.
async function refreshStats(s, turnEnd) {
  try {
    s.stats = await collectStats(s);
    if (turnEnd && s.stats.limits) setLimits({ t: Date.now(), ...s.stats.limits });
    emit(s.id, { kind: 'stats', ...s.stats });
  } catch (e) { log(`[${s.id}] stats failed`, e.message); }
}

// ---- folders in the sidebar ----
// The directories the UI lists. Removing one only unregisters it here; its sessions and Claude's
// memory of them stay on disk, so adding the folder back brings its history back too.
const FOLDERS_FILE = path.join(DIR, 'folders.json');
let folders = readJson(FOLDERS_FILE, null);
function changeFolders(fn) {
  let changed = false;
  folders = updateJson(FOLDERS_FILE, folders, (all) => { const r = fn(all ?? []); changed = r !== false; return r; }) ?? [];
  if (changed) partial('', { op: 'folders', folders });
}
const addFolder = (dir) => changeFolders((all) => !all.includes(dir) && [...all, dir]);
// Claude Code's settings files, strongest first: managed > local > project > user.
const claudeSettingFiles = (cwd) => [
  process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json',
  path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'), path.join(CLAUDE_DIR, 'settings.json'),
];
// A setting as the CLI resolves it: the first of those files that has it.
function claudeSetting(cwd, pick) {
  for (const f of claudeSettingFiles(cwd)) {
    const v = pick(readJson(f, {}));
    if (typeof v === 'string' && v) return v;
  }
}
const settingsDefaultMode = (cwd) => claudeSetting(cwd, (j) => j?.permissions?.defaultMode) || 'default';
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
// `defaults`: what a new session starts with ({ model, effort, mode }; a missing one follows Claude's own
// settings). `usageInterval`: minutes between plan-usage samples (a divisor of 60, so samples sit on the clock).
const USAGE_INTERVALS = [5, 10, 15, 20, 30, 60];
const settings = { suggest: true, usageInterval: 30, defaults: {}, ...readJson(SETTINGS_FILE, {}) };
if (!USAGE_INTERVALS.includes(settings.usageInterval)) settings.usageInterval = 30;
const shownSettings = () => ({ suggest: settings.suggest, usageInterval: settings.usageInterval, defaults: settings.defaults, intervals: USAGE_INTERVALS });

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
      if (m.type === 'assistant' && m.message.model !== '<synthetic>') text += m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
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
// bid -> { bid, claudeSessionId, cwd, created, messages: [{ role, text }], busy, proc }
const btwThreads = new Map(readJson(BTW_FILE, []).map((t) => [t.bid, t]));
function saveBtw() {
  const mine = [...btwThreads.values()].map(({ bid, claudeSessionId, cwd, created, messages }) => ({ bid, claudeSessionId, cwd, created, messages }));
  updateJson(BTW_FILE, [], (saved) => {
    const all = new Map(saved.map((t) => [t.bid, t])); // threads the other daemon saved stay
    for (const t of mine) all.set(t.bid, t);
    return [...all.values()].sort((a, b) => b.created - a.created).slice(0, 300);
  });
}
// A thread started under the other daemon: read it from the file.
function btwThread(bid) {
  if (!btwThreads.has(bid)) { const t = readJson(BTW_FILE, []).find((x) => x.bid === bid); if (t) btwThreads.set(bid, t); }
  return btwThreads.get(bid);
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
            proc.idle = setTimeout(() => {
              if (t.proc === proc) t.proc = null; // the next question starts a fresh process, not this closing one
              try { q.close(); } catch {}
            }, BTW_IDLE);
          }
        }
      } catch (e) {
        log(`[btw ${t.bid}] failed`, e);
        proc.error = String(e?.message || e);
      }
      clearTimeout(proc.idle);
      if (t.proc !== proc) return; // replaced by a newer process, which owns t.busy now
      t.proc = null;
      // Ended (crashed, closed) in the middle of an answer: without this the thread stays "answering" for good.
      if (t.busy) {
        t.busy = false;
        t.messages.pop(); // the question never got an answer; let it be asked again
        saveBtw();
        out({ op: 'btw-done', error: proc.error || 'The side conversation stopped before answering' });
      }
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
      mediaJobs.delete(key); // the file is the record now: once the cache drops it, it is converted again
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
    // Bounded: it runs on the event loop, and a hung network mount must not stop every session.
    files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd, maxBuffer: 64 << 20, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split('\n').filter(Boolean).slice(0, 50000);
  } catch (e) {
    files = [];
    if (e.code === 'ETIMEDOUT') { log(`git ls-files in ${cwd} took over 5 s: no @ completion there for now`); fileCache.set(cwd, { at: Date.now(), files }); return files; }
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

// `/abs`, `~/x`, `./x`, `../x`: the entries of that folder, kept in the user's spelling.
function browse(cwd, q, limit = 50) {
  if (q === '~' || q === '..') q += '/';
  const cut = q.lastIndexOf('/') + 1;
  const head = q.slice(0, cut), name = q.slice(cut).toLowerCase();
  const dir = userPath(head, cwd);
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const isDir = (e) => e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, e.name)).isDirectory(); } catch { return false; } })());
  const hits = ents
    .filter((e) => e.name.toLowerCase().startsWith(name) && (name.startsWith('.') || !e.name.startsWith('.')))
    .map((e) => head + e.name + (isDir(e) ? '/' : ''))
    .sort((a, b) => b.endsWith('/') - a.endsWith('/') || a.localeCompare(b));
  return hits.slice(0, limit);
}

const MAX_VIEW = 1 << 20;

// A path from the conversation: `~` is the home directory, a relative one is in the session's directory.
const sessionPath = (sid, p) => userPath(p, sessions.get(sid)?.cwd);

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

// Reopen a past Claude Code session (from this daemon, the terminal, anywhere on this host).
const resuming = new Map(); // claudeSessionId -> promise of the resume in progress
// A transcript as the events the UI draws (earlier conversation of a resumed or detached session).
async function historyEvents(claudeSessionId, dir) {
  const history = await getSessionMessages(claudeSessionId, { dir });
  if (!history.length) throw new Error('This session has no readable messages');
  const out = [];
  const s = { toolNames: new Map() };
  for (const m of history) {
    const note = m.type === 'user' && !m.parent_tool_use_id && parseNotification(m.message?.content);
    if (note) { out.push({ kind: 'notify', ...note }); continue; }
    const prompt = m.type === 'user' && !m.parent_tool_use_id ? promptText(m.message?.content) : null;
    if (prompt === '') continue; // harness-injected text, not something the user typed
    if (prompt != null) {
      out.push({ kind: 'user_text', text: prompt, uuid: m.uuid });
    } else if (m.type === 'user' || m.type === 'assistant') {
      const msg = slim(s, { type: m.type, uuid: m.uuid, message: m.message, parent_tool_use_id: m.parent_tool_use_id });
      if (msg.type === 'assistant' && !msg.message.content.length) continue;
      out.push({ kind: 'msg', msg });
    }
  }
  return out;
}

// A rewound session nobody has written to since: its transcript's tail is not the conversation.
function upToRewind(claudeSessionId, history) {
  const at = rewindPoint(claudeSessionId);
  const cut = at ? history.findIndex((e) => e.kind === 'msg' && e.msg.uuid === at) : -1;
  return cut >= 0 ? history.slice(0, cut + 1) : history;
}

async function resumeSession({ claudeSessionId, cwd, title, color, nonce }) {
  // The CLI finds a transcript by its project directory, so resume in the original one.
  const original = cwd || transcriptCwd(claudeSessionId);
  if (!original) throw new Error('Cannot tell which directory this session was started in');
  const dir = resolveDir(original);
  if (!dir) throw new Error(`The session's directory no longer exists: ${original}`);
  const history = upToRewind(claudeSessionId, await historyEvents(claudeSessionId, dir));
  addFolder(dir);
  const s = newSession({ cwd: dir, title: title || 'Resumed session', resume: claudeSessionId });
  s.claudeSessionId = claudeSessionId;
  s.resumeAt = rewindPoint(claudeSessionId);
  // A reattached session keeps its /color: the UI passes the detached copy's, else the remembered one.
  s.color = (typeof color === 'string' && color) || colors[claudeSessionId];
  emit(s.id, { kind: 'created', cwd: dir, title: s.title, nonce, resumed: true, claudeSessionId, ...(s.color ? { color: s.color } : {}) });
  if (s.color && colors[claudeSessionId] !== s.color) saveColor(s);
  touchRecent(s);
  for (const ev of history) emit(s.id, ev);
  emit(s.id, { kind: 'sys', subtype: 'resumed' });
  run(s); // the CLI waits for the next message
  return { sid: s.id };
}

// ---- shells: plain terminals a session opens in its folder ----
// Each runs your login shell in a pseudo-terminal made by python3 (on every macOS and Linux host; no
// native module to build): stdin and stdout are the terminal, fd 3 takes "<cols> <rows>" resizes, and
// the shell's pid comes first on stderr. It starts in the session's folder even when your startup files
// cd elsewhere (a config.fish's `cd ~`): fish runs `cd` with -C, after its config and before the first
// prompt; zsh and bash read your files through the small ones in SHELL_INIT, which cd last. Any other
// shell is sent ` cd '<folder>'` once its first prompt is up, unless you have typed by then.
// A shell outlives the page (a reload or another tab shows its recent output) but not the daemon:
// when the daemon goes (an update included) python3 sees its stdin close and hangs the shell up.
const PTY_PY = `
import os, pty, sys, select, fcntl, termios, struct, signal
cols, rows, home = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
def size(fd, c, r): fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
pid, fd = pty.fork()
if pid == 0:
    size(0, cols, rows)
    sh = os.environ.get('SHELL') or '/bin/sh'
    name, init, args = os.path.basename(sh), os.environ.pop('IRO_SHELL_INIT', ''), [sh, '-l']
    if name == 'fish':
        args = [sh, '-l', '-C', "cd '%s'" % home.replace('\\\\', '\\\\\\\\').replace("'", "\\\\'")]
    elif name == 'zsh' and init:
        os.environ.update(IRO_ZDOTDIR=os.environ.get('ZDOTDIR') or os.environ.get('HOME', ''), ZDOTDIR=init + '/zsh', IRO_CD=home)
    elif name == 'bash' and init:
        os.environ['IRO_CD'] = home
        args = [sh, '--rcfile', init + '/bashrc', '-i']
    os.execvp(sh, args)
sys.stderr.write('pid %d\\n' % pid); sys.stderr.flush()
def put(f, b):
    while b: b = b[os.write(f, b):]
watch, ctl = [0, fd, 3], b''
while True:
    try: ready = select.select(watch, [], [])[0]
    except InterruptedError: continue
    if fd in ready:
        try: b = os.read(fd, 65536)
        except OSError: b = b''
        if not b: break
        put(1, b)
    if 0 in ready:
        b = os.read(0, 65536)
        if not b:
            os.kill(pid, signal.SIGHUP); break
        put(fd, b)
    if 3 in ready:
        b = os.read(3, 4096)
        if not b: watch.remove(3)
        ctl += b
        while b'\\n' in ctl:
            l, ctl = ctl.split(b'\\n', 1)
            try:
                c, r = map(int, l.split()); size(fd, c, r)
            except ValueError: pass
try: st = os.waitpid(pid, 0)[1]
except ChildProcessError: st = 0
sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128 + os.WTERMSIG(st))
`;
const SHELL_INIT = path.join(DIR, 'shell-init');
// zsh: ZDOTDIR points here; each file reads yours (from your ZDOTDIR, kept in IRO_ZDOTDIR), the last one cds.
const zshStage = (f) => `IRO_WRAP=$ZDOTDIR\nZDOTDIR=$IRO_ZDOTDIR\n[[ -f $ZDOTDIR/${f} ]] && source $ZDOTDIR/${f}\nIRO_ZDOTDIR=$ZDOTDIR\nZDOTDIR=$IRO_WRAP\n`;
const SHELL_INIT_FILES = {
  'zsh/.zshenv': zshStage('.zshenv'),
  'zsh/.zprofile': zshStage('.zprofile'),
  'zsh/.zshrc': zshStage('.zshrc'),
  'zsh/.zlogin': 'ZDOTDIR=$IRO_ZDOTDIR\n[[ -f $ZDOTDIR/.zlogin ]] && source $ZDOTDIR/.zlogin\nunset IRO_WRAP IRO_ZDOTDIR\n[[ -n $IRO_CD ]] && builtin cd -- $IRO_CD\nunset IRO_CD\n',
  // bash: an interactive shell's rcfile that reads what a login shell would, then cds.
  bashrc: '[ -f /etc/profile ] && . /etc/profile\n'
    + 'if [ -f ~/.bash_profile ]; then . ~/.bash_profile; elif [ -f ~/.bash_login ]; then . ~/.bash_login; elif [ -f ~/.profile ]; then . ~/.profile; elif [ -f ~/.bashrc ]; then . ~/.bashrc; fi\n'
    + '[ -n "$IRO_CD" ] && builtin cd -- "$IRO_CD"\nunset IRO_CD\n',
};
function shellInit() {
  try {
    for (const [f, text] of Object.entries(SHELL_INIT_FILES)) {
      const p = path.join(SHELL_INIT, f);
      if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text) continue;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    return SHELL_INIT;
  } catch (e) {
    log('shell init files', e.message);
    return '';
  }
}
const SHELL_KEEP = 200_000; // characters of recent output a (re)opened tab is shown
const shells = new Map(); // tid -> { tid, sid, name, proc, buf, total, out, timer, exited }
const shellView = (t) => ({ tid: t.tid, name: t.name, exited: t.exited ?? null });
const shellsOf = (sid) => [...shells.values()].filter((t) => t.sid === sid);
const sendShells = (sid) => partial(sid, { op: 'shells', shells: shellsOf(sid).map(shellView) });
function shellOf(sid, tid) {
  const t = shells.get(tid);
  if (!t || t.sid !== sid) throw new Error('No such shell');
  return t;
}
// Output reaches the page in small batches; `at` (characters so far) lets a tab that just read the
// recent output skip what that read already had.
function shellOut(t, d) {
  if (!t.settled) { clearTimeout(t.quiet); t.quiet = setTimeout(() => homeIn(t), 300); } // the first prompt is up when output pauses
  t.buf = (t.buf + d).slice(-SHELL_KEEP);
  t.total += d.length;
  t.out += d;
  t.timer ??= setTimeout(() => {
    partial(t.sid, { op: 'shell', tid: t.tid, data: t.out, at: t.total });
    t.out = '';
    t.timer = null;
  }, 8);
}
function openShell(sid, cwd, cols, rows) {
  const n = shellsOf(sid).length;
  const base = path.basename(process.env.SHELL || 'sh');
  const t = { tid: randomUUID().slice(0, 8), sid, name: n ? `${base} ${n + 1}` : base, buf: '', total: 0, out: '', timer: null, exited: null };
  const size = (v, d) => String(Math.max(2, Math.min(1000, Math.floor(Number(v)) || d)));
  const home = fs.realpathSync(cwd);
  t.proc = spawn('python3', ['-c', PTY_PY, size(cols, 80), size(rows, 24), home], {
    cwd, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'IroWell', IRO_SHELL_INIT: shellInit() },
  });
  t.settled = ['fish', 'zsh', 'bash'].includes(base); // these start there themselves (above)
  t.proc.stdout.setEncoding('utf8');
  t.proc.stdout.on('data', (d) => shellOut(t, d));
  t.proc.stderr.setEncoding('utf8');
  t.proc.stderr.on('data', (d) => {
    const m = t.pid == null && /^pid (\d+)\n/.exec(d);
    if (m) { t.pid = Number(m[1]); d = d.slice(m[0].length); }
    if (d.trim()) log(`[shell ${t.tid}] ${d.trimEnd()}`);
  });
  t.dir = cwd;
  setTimeout(() => homeIn(t), 5000); // (a shell that has printed nothing by then)
  for (const s of [t.proc.stdin, t.proc.stdio[3]]) s.on('error', () => {}); // it has exited
  const ended = (code, why) => {
    if (t.exited != null) return;
    t.exited = code;
    shellOut(t, `\r\n\x1b[2m[${why}]\x1b[0m\r\n`);
    sendShells(sid);
  };
  t.proc.on('error', (e) => ended(-1, e.code === 'ENOENT' ? 'a shell needs python3 on this host' : e.message));
  t.proc.on('exit', (code, sig) => ended(code ?? -1, `exited${code ? ` with ${code}` : sig ? ` (${sig})` : ''}`));
  shells.set(t.tid, t);
  sendShells(sid);
  return t;
}
// The folder a process is in: /proc on Linux, lsof on a Mac.
function cwdOf(pid) {
  if (fs.existsSync(`/proc/${pid}/cwd`)) return Promise.resolve(fs.promises.realpath(`/proc/${pid}/cwd`).catch(() => null));
  return new Promise((done) => execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (e, out) => done(e ? null : /^n(.*)$/m.exec(out)?.[1] ?? null)));
}
async function homeIn(t) {
  if (t.settled) return;
  t.settled = true;
  clearTimeout(t.quiet);
  if (t.typed || t.exited != null || t.pid == null) return;
  const [now, want] = await Promise.all([cwdOf(t.pid), fs.promises.realpath(t.dir).catch(() => t.dir)]);
  if (now && now !== want && !want.includes("'") && !t.typed && t.exited == null) t.proc.stdin.write(` cd '${want}'\r`);
}
function closeShell(t) {
  shells.delete(t.tid);
  if (t.exited == null) { t.proc.stdin.end(); t.proc.kill('SIGHUP'); }
  sendShells(t.sid);
}

// ---- client commands ----
// A command with an `id` is a request: its return value (or thrown error) is sent back as a reply.
const handlers = {
  // Shells: listed per session; opened in its folder; their recent output read back on (re)open.
  shellList(c, { sid }) { return shellsOf(sid).map(shellView); },
  shellOpen(c, { sid, cwd, cols, rows }) {
    const dir = resolveDir(sessions.get(sid)?.cwd || cwd);
    if (!sid || !dir) throw new Error('No folder to open a shell in');
    return shellView(openShell(sid, dir, cols, rows));
  },
  shellRead(c, { sid, tid }) { const t = shellOf(sid, tid); return { data: t.buf, at: t.total }; },
  shellInput(c, { sid, tid, data }) {
    const t = shellOf(sid, tid);
    if (t.exited == null && typeof data === 'string') { t.typed = true; t.proc.stdin.write(data); }
  },
  shellResize(c, { sid, tid, cols, rows }) {
    const t = shellOf(sid, tid);
    if (t.exited == null && cols > 0 && rows > 0) t.proc.stdio[3].write(`${Math.floor(cols)} ${Math.floor(rows)}\n`);
  },
  shellRename(c, { sid, tid, name }) {
    const t = shellOf(sid, tid);
    const v = String(name || '').trim().slice(0, 60);
    if (v) { t.name = v; sendShells(sid); }
  },
  shellClose(c, { sid, tid }) { closeShell(shellOf(sid, tid)); },
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
  async resume(c, args) {
    const { claudeSessionId } = args;
    for (const s of sessions.values()) {
      if (s.claudeSessionId === claudeSessionId && alive(s)) return { sid: s.id, existing: true };
    }
    for (const [sid, r] of remote) if (r.claudeSessionId === claudeSessionId && !r.closed) return { sid, existing: true }; // still on the previous daemon
    // A second click while the first is still reading the transcript joins it: two CLIs must
    // never run the same Claude session (both would append to one transcript).
    if (resuming.has(claudeSessionId)) return { ...(await resuming.get(claudeSessionId)), existing: true };
    // Closed just now (archive, Detach): its CLI may still be writing the transcript's last entries.
    const closing = [...sessions.values()].filter((s) => s.claudeSessionId === claudeSessionId && s.closed && s.done);
    if (closing.length) await Promise.race([Promise.all(closing.map((s) => s.done)), new Promise((r) => setTimeout(r, 10000))]);
    const p = resumeSession(args);
    resuming.set(claudeSessionId, p);
    try { return await p; } finally { resuming.delete(claudeSessionId); }
  },
  // Rewind (the terminal's Esc Esc): back to just before the user message `uuid`. Files Claude changed
  // since are restored from their checkpoints, and the conversation goes on from the end of the turn
  // before it: the CLI restarts under the same sid, resuming the transcript at that point (the later
  // turns stay in the transcript file, off the path, as the terminal leaves them). `dryRun` only says
  // which files would change.
  async rewind(c, { sid, uuid, dryRun }) {
    const s = live(sid);
    const i = uuid ? events.findIndex((e) => e.sid === sid && e.kind === 'user_text' && e.uuid === uuid) : -1;
    if (i < 0) throw new Error('That message can\'t be rewound to');
    let files = await s.q.rewindFiles(uuid, { dryRun: true }).catch((e) => ({ canRewind: false, error: e.message }));
    if (dryRun) return files;
    if (s.rewinding || sessions.get(sid) !== s) throw new Error(REWINDING); // another rewind got here first
    if (!quiet(s)) throw new Error('Wait until nothing is running in this session (turn, question, queued message or background task), or stop it first');
    // From here until the CLI restarts, nothing else may use the session: a second rewind would
    // orphan the first one's CLI, a message would go to the CLI being closed, an update would move it.
    s.rewinding = true;
    try {
      if (files.canRewind && files.filesChanged?.length) files = { ...files, ...(await s.q.rewindFiles(uuid)) };
    } catch (e) { s.rewinding = false; throw e; }
    const prev = events.slice(0, i).filter((e) => e.sid === sid && e.kind === 'msg' && e.msg.type === 'assistant' && !e.msg.parent_tool_use_id && e.msg.uuid).pop();
    s.replaced = true;
    try { s.predQ?.close(); } catch {}
    try { s.q.close(); } catch {}
    await s.done;
    sessions.delete(sid);
    const n = newSession({ cwd: s.cwd, title: s.title, model: s.model, mode: s.mode, resume: prev ? s.claudeSessionId : undefined }, sid);
    Object.assign(n, { claudeSessionId: prev ? s.claudeSessionId : undefined, color: s.color, effort: s.effort, stats: s.stats, resumeAt: prev?.msg.uuid, turnNo: s.turnNo });
    if (prev) setRewindPoint(s.claudeSessionId, prev.msg.uuid);
    emit(sid, { kind: 'rewound', from: events[i].seq, files: files.filesChanged || [], insertions: files.insertions, deletions: files.deletions, fileError: files.canRewind ? undefined : files.error });
    run(n);
    return { text: events[i].text, files: files.filesChanged || [] };
  },
  // /branch and "Branch from here": a new session that starts as a copy of this one's conversation
  // (all of it, or up to the assistant message `at`); the original carries on unchanged.
  async branch(c, { sid, claudeSessionId, cwd, title, at, nonce }) {
    const src = sessions.get(sid);
    const id = src?.claudeSessionId || claudeSessionId;
    if (!id) throw new Error('Nothing to branch yet: send a message first');
    const dir = resolveDir(src?.cwd || cwd || transcriptCwd(id) || '');
    if (!dir) throw new Error('The session\'s directory no longer exists');
    let history = await historyEvents(id, dir);
    if (at) {
      const i = history.findIndex((e) => e.kind === 'msg' && e.msg.uuid === at);
      if (i < 0) throw new Error('That point of the conversation is not in its transcript');
      history = history.slice(0, i + 1);
    }
    const s = newSession({ cwd: dir, title: String(title || '').trim().slice(0, 120) || `${src?.title || 'Session'} (branch)`, resume: id,
      model: src?.model, mode: src?.mode });
    s.fork = { at };
    if (src?.effort) s.effort = src.effort;
    emit(s.id, { kind: 'created', cwd: dir, title: s.title, nonce, resumed: true, model: s.model, mode: s.mode });
    for (const ev of history) emit(s.id, ev);
    emit(s.id, { kind: 'sys', subtype: 'branched' });
    run(s); // the CLI copies the conversation when the first message arrives
    return { sid: s.id };
  },
  // The earlier conversation of a session remembered from before a daemon restart (read only).
  async transcript(c, { claudeSessionId, cwd }) {
    const dir = resolveDir(cwd || transcriptCwd(claudeSessionId) || '');
    if (!dir) throw new Error('The session\'s directory no longer exists');
    return upToRewind(claudeSessionId, await historyEvents(claudeSessionId, dir));
  },
  send(c, { sid, text, images }) {
    const s = sessions.get(sid);
    if (!alive(s)) throw new Error('Session is not running');
    if (s.rewinding) throw new Error(REWINDING);
    if (typeof text !== 'string' || !text.trim()) return;
    if (turnBusy(s) || s.outbox?.length) return enqueue(s, text, images);
    sendText(s, text, images);
  },
  // A queued message: 'now' sends it next, interrupting the turn; 'remove' takes it back (its text is returned).
  queue(c, { sid, op, qid }) {
    const s = sessions.get(sid);
    const i = s?.outbox?.findIndex((m) => m.qid === qid) ?? -1;
    if (i < 0) throw new Error('That message is no longer queued');
    const [m] = s.outbox.splice(i, 1);
    if (op === 'remove') { emitQueue(s); return { text: m.text, images: m.images }; }
    s.outbox.unshift(m);
    emitQueue(s);
    if (turnBusy(s)) s.q?.interrupt().catch((e) => log('interrupt failed', e));
    else drainQueue(s);
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
    const s = session(sid);
    return {
      state: s.state, turnStart: s.turnStart, quietMs: s.lastMsgAt ? Date.now() - s.lastMsgAt : null,
      tasks: runningTasks(s), procs: s.procs || [],
    };
  },
  // Background work per session, for the sidebar colours.
  async overview() {
    procScan();
    const mine = [...sessions.values()].map((s) => ({ sid: s.id, tasks: runningTasks(s).length, procs: (s.procs || []).length }));
    const theirs = await Promise.all([...links].map((l) => l.request({ type: 'overview' }).then((r) => r.data || [])));
    return [...mine, ...theirs.flat().filter((x) => remote.get(x.sid))];
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
  setColor(c, { sid, color, claudeSessionId }) {
    const s = sessions.get(sid);
    if (s) return setMeta(s, { color: color || null });
    // A session remembered from before a restart has no process here: just record its colour.
    if (!claudeSessionId) throw new Error('No such session');
    saveColor({ claudeSessionId, color });
    emit(sid, { kind: 'meta', color: color || null });
  },
  // Fresh numbers for the status line (the UI polls this for the session on screen).
  async stats(c, { sid }) {
    const s = session(sid);
    s.stats = await collectStats(s);
    return s.stats;
  },
  async commands(c, { sid }) {
    const s = live(sid);
    return (s.commandsCache ??= await s.q.supportedCommands());
  },
  async models(c, { sid }) {
    const s = sid ? live(sid) : [...sessions.values()].find((x) => x.q && alive(x));
    if (!s && links.size) return (await [...links][0].request({ type: 'models' })).data || [];
    if (s) return (s.modelsCache ??= await s.q.supportedModels());
    return (modelsProbe ??= probeModels());
  },
  complete(c, { sid, cwd, query: q = '' }) {
    const dir = sessions.get(sid)?.cwd || (cwd && resolveDir(cwd)); // a draft has only its folder
    if (!dir) throw new Error('No such session');
    q = String(q);
    return /^(~|\.\.)$|^(~|\.{1,2})?\//.test(q) ? browse(dir, q) : fuzzy(listFiles(dir), q);
  },
  // Is this video playable in a browser as is? If not, convert it (or join the running conversion).
  prepareMedia(c, { path: p }) {
    const file = userPath(p);
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
    const file = userPath(p);
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Not a file');
    const n = Math.max(0, Math.min(Number(length) || 0, 4 << 20, st.size - offset));
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, Number(offset) || 0); } finally { fs.closeSync(fd); }
    return { size: st.size, offset, data: buf.toString('base64'), eof: offset + n >= st.size };
  },
  // The level on screen now; asks the usage API too (at most once per USAGE_GAP), and a newer
  // answer is pushed when it comes.
  limits() {
    askUsage();
    return limitsNow;
  },
  usageHistory(c, { days = 7 } = {}) {
    const cut = Date.now() - Math.min(35, Number(days) || 7) * 24 * 3600 * 1000;
    // Only samples on the clock: an older daemon still running its busy sessions (see "rolling updates")
    // wrote one at every turn end, and those would show as stray points in the charts.
    return readUsage().filter((x) => x.t >= cut && onSlot(x.t));
  },
  // Estimate for the rest of the weekly cycle: a least-squares line through the last 24 hours of
  // samples in the current weekly window, carried on to its reset. The UI draws it dashed.
  usageForecast() {
    const xs = readUsage().filter((x) => x.week?.pct != null && x.week.resets);
    const last = xs[xs.length - 1];
    if (!last) return { week: null };
    const resets = new Date(last.week.resets).getTime();
    const pts = xs.filter((x) => x.t >= last.t - 24 * 3600e3 && Math.abs(new Date(x.week.resets) - resets) < 2 * 60e3);
    let slope = 0; // percent per millisecond
    if (pts.length >= 2 && pts[pts.length - 1].t - pts[0].t >= 3600e3) {
      const n = pts.length, mt = pts.reduce((a, x) => a + x.t, 0) / n, mv = pts.reduce((a, x) => a + x.week.pct, 0) / n;
      const num = pts.reduce((a, x) => a + (x.t - mt) * (x.week.pct - mv), 0), den = pts.reduce((a, x) => a + (x.t - mt) ** 2, 0);
      slope = den ? Math.max(0, num / den) : 0;
    }
    const pct = last.week.pct;
    const hitAt = pct >= 100 ? last.t : slope > 0 ? Math.round(last.t + (100 - pct) / slope) : null;
    const atReset = Math.min(100, pct + slope * Math.max(0, resets - last.t));
    return { week: { t: last.t, pct, resets: last.week.resets, slopePerHour: slope * 3600e3, hitAt: hitAt && hitAt <= resets ? hitAt : null, atReset } };
  },
  // Where a path mentioned in the conversation really is: relative ones are taken from the session directory.
  stat(c, { sid, path: p }) {
    const file = sessionPath(sid, p);
    try {
      const st = fs.statSync(file);
      return { path: file, exists: true, dir: st.isDirectory(), size: st.size };
    } catch {
      return { path: file, exists: false };
    }
  },
  readFile(c, { sid, path: p }) {
    return readForView(sessionPath(sid, p));
  },
  // Terminal sessions and the ones from this UI by default; `all` adds headless `claude -p` / Python SDK runs.
  async history(c, { all = false, cwd } = {}) {
    const list = await listSessions(cwd ? { dir: cwd, includeWorktrees: false, limit: 400 } : { limit: all ? 150 : 400 });
    const index = transcriptIndex();
    const open = new Map([...sessions.values()].filter(alive).map((s) => [s.claudeSessionId, s.id]));
    for (const [sid, r] of remote) if (r.claudeSessionId && !r.closed) open.set(r.claudeSessionId, sid);
    const out = [];
    for (const x of list) {
      const meta = transcriptMeta(index.get(x.sessionId));
      if (!meta.hasMessages) continue; // empty stubs
      const headless = meta.entrypoint === 'sdk-cli' || meta.entrypoint === 'sdk-py';
      if (headless && !all && !ours.has(x.sessionId)) continue;
      if (cwd && resolveDir(x.cwd || meta.cwd) !== resolveDir(cwd)) continue; // not its subdirectories or worktrees
      out.push({
        claudeSessionId: x.sessionId, title: titleOf(x),
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
    let t = bid && btwThread(bid);
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
    for (const l of links) l.request({ type: 'btwClose', bid }); // it may run on the previous daemon
    const t = btwThreads.get(bid);
    try { t?.proc?.q.close(); } catch {} // its loop then clears t.proc (and t.busy)
  },
  // The sidebar's folders. The first time, they are the directories of recent sessions from this UI.
  async folders() {
    folders = readJson(FOLDERS_FILE, folders); // (the other daemon may have changed them during an update)
    if (!folders) {
      const first = [...new Set([...sessions.values()].map((s) => s.cwd))];
      for (const d of await recentDirs(8, true).catch(() => [])) if (!first.includes(d)) first.push(d);
      changeFolders(() => first);
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
    changeFolders((all) => all.filter((d) => d !== p));
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
  // The permission mode a new session in `cwd` starts in (what a draft shows until you pick one).
  defaultMode(c, { cwd }) { return settingsDefaultMode(resolveDir(cwd) || os.homedir()); },
  // What a new session starts with in `cwd` when Settings names no default: the mode and effort Claude's own settings give.
  claudeDefaults(c, { cwd }) {
    const dir = resolveDir(cwd) || os.homedir();
    // modelSettings: an effort per model, which beats the plain effortLevel.
    const modelEfforts = {};
    for (const f of claudeSettingFiles(dir).reverse()) {
      const ms = readJson(f, {})?.modelSettings;
      for (const [m, v] of Object.entries(ms && typeof ms === 'object' ? ms : {})) if (typeof v?.effortLevel === 'string') modelEfforts[m] = v.effortLevel;
    }
    return { mode: settingsDefaultMode(dir), effort: claudeSetting(dir, (j) => j?.effortLevel), modelEfforts };
  },
  getSettings() { return shownSettings(); },
  // The defaults for new sessions ({ model, effort, mode }; null/'' clears one) and the usage sampling interval.
  setSettings(c, { defaults, usageInterval }) {
    if (defaults) {
      const next = { ...settings.defaults };
      for (const k of ['model', 'effort', 'mode']) {
        if (!(k in defaults)) continue;
        const v = defaults[k];
        if (v == null || v === '') delete next[k];
        else if (typeof v === 'string' && v.length < 100) next[k] = v;
        else throw new Error(`Bad default ${k}`);
      }
      settings.defaults = next;
    }
    if (usageInterval != null) {
      if (!USAGE_INTERVALS.includes(Number(usageInterval))) throw new Error(`The interval must be one of ${USAGE_INTERVALS.join(', ')} minutes`);
      settings.usageInterval = Number(usageInterval);
    }
    writeJson(SETTINGS_FILE, settings);
    const out = shownSettings();
    partial('', { op: 'settings', settings: out });
    if (usageInterval != null) sampleUsage(); // a shorter interval may already be due
    return out;
  },
  setSuggest(c, { on }) {
    settings.suggest = !!on;
    writeJson(SETTINGS_FILE, settings);
    return { suggest: settings.suggest };
  },
  async status(c, { sid }) {
    const s = session(sid);
    const out = { cwd: s.cwd, model: s.model, mode: s.mode, claudeSessionId: s.claudeSessionId, host: os.hostname(), state: s.state };
    if (s.q && alive(s)) {
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
    clearQueue(s);
    for (const rid of [...s.pending.keys()]) settle(s, rid, false);
    try { s.q?.close(); } catch {}
    emit(s.id, { kind: 'closed' });
  },
  // Archive a sidebar row: its CLI stops if it runs, and the row goes away (every copy of it, by Claude
  // session id). The transcript stays on disk, so Past sessions can reopen it.
  archive(c, { sid, claudeSessionId: id }) {
    const own = [...sessions.values()].filter((s) => s.id === sid || (id && s.claudeSessionId === id));
    for (const s of own) handlers.close(c, { sid: s.id });
    for (const x of new Set([sid, ...own.map((s) => s.id)])) for (const t of shellsOf(x)) closeShell(t); // its shells go with the row
    if (id) archive(id);
    for (const x of new Set([sid, ...own.map((s) => s.id)])) emit(x, { kind: 'archived', claudeSessionId: id || null });
  },
};

// ---- rolling updates: an update never interrupts a session ----
// The running daemon is told to retire (client/client.mjs, "Update server"): it moves its socket aside
// (old-<boot>.sock, still listening) and starts the new release, which takes the main socket.
// The new daemon relays the old one's live sessions (their events, and the commands for them), so the
// UI still sees one daemon. Each session moves over as soon as it is quiet (idle, nothing to approve,
// no background task or process): the old daemon closes its CLI and the new one resumes the Claude
// session under the same sid. A busy session keeps running the old code until then, the way a terminal
// `claude` keeps its version until it is restarted. When none is left, the old daemon exits.
const MOVED = 'This session has moved to the new daemon';
const SENT = Symbol('reply already sent');
const clients = new Set(); // every connection (the UI's pipes, and a new daemon adopting our sessions)
const moving = new Map(); // sid -> promise, settled once the new daemon has been told
const movedAway = (sid) => moving.has(sid);
let retiring = null; // { sock, target: the new daemon's connection, ready }

const liveOwn = () => [...sessions.values()].filter((s) => alive(s) && !moving.has(s.id));
const btwBusy = (s) => [...btwThreads.values()].some((t) => t.busy && (!s || (t.claudeSessionId && t.claudeSessionId === s.claudeSessionId)));
// Something of the session is going on: a turn, a question, a queued message, a background task or process.
const busy = (s) => s.rewinding || s.state === 'running' || s.state === 'waiting' || s.pending.size || s.queued || s.outbox?.length || runningTasks(s).length || (s.procs || []).length;
const quiet = (s) => !busy(s) && !btwBusy(s);

async function handOver(s) {
  let told;
  moving.set(s.id, new Promise((r) => (told = r)));
  try { s.predQ?.close(); } catch {}
  try { s.q?.close(); } catch {}
  await s.done; // its CLI has exited: two CLIs must never write one transcript
  sessions.delete(s.id);
  const m = { type: 'handover', sid: s.id, claudeSessionId: s.claudeSessionId || null, cwd: s.cwd, title: s.title, color: s.color || null,
    model: s.model, mode: s.mode, effort: s.effort, stats: s.stats, fork: !s.claudeSessionId && s.fork ? { from: s.resume, at: s.fork.at } : undefined };
  if (retiring.target) reply(retiring.target, m);
  else log(`[${s.id}] closed while no new daemon was connected: it shows as detached there`);
  told();
  log(`[${s.id}] handed over`);
}

let handing = false;
async function tryHandover() {
  if (!retiring?.ready || handing) return;
  handing = true;
  try {
    for (const s of liveOwn()) if (quiet(s) && retiring.ready) await handOver(s);
    if (retiring.ready && !liveOwn().length && !btwBusy()) {
      log('retired: every session has moved to the new daemon');
      fs.rmSync(retiring.sock, { force: true });
      reply(retiring.target, { type: 'retired' });
      setTimeout(() => process.exit(0), 300);
    }
  } finally { handing = false; }
}

Object.assign(handlers, {
  // From the client's update: start `daemon` (the new release) and hand every session over to it.
  // Asked again before a new daemon has adopted us (the last one died starting, say): start it again.
  // (One that is still starting keeps the lock or the socket, so the second one just exits.)
  retire(c, { daemon }) {
    const file = fs.realpathSync(String(daemon || '')); // its release's own path, so `ps` shows which release runs
    if (retiring?.target) return { sock: retiring.sock, already: true };
    if (!retiring) {
      const sock = path.join(DIR, `old-${BOOT.slice(0, 8)}.sock`); // short: socket paths are limited to ~100 bytes
      fs.renameSync(SOCK, sock); // still listening, under the new name
      releaseLock(); // the main socket is the new release's now
      retiring = { sock, target: null, ready: false };
      setInterval(tryHandover, 1000);
    }
    const out = fs.openSync(path.join(DIR, 'daemon.log'), 'a');
    spawn(process.execPath, [file], { detached: true, stdio: ['ignore', out, out], cwd: DIR }).unref();
    fs.closeSync(out);
    log('retiring: started', file);
    return { sock: retiring.sock };
  },
  // From the new daemon: our live sessions and their history, then their live events.
  adopt(c, cmd) {
    if (!retiring) throw new Error('This daemon is not retiring');
    if (retiring.target && retiring.target !== c) retiring.target.end(); // replaced by a newer daemon
    retiring.target = c;
    retiring.ready = false;
    c.on('close', () => { if (retiring.target === c) { retiring.target = null; retiring.ready = false; } });
    const own = liveOwn();
    const ids = new Set(own.map((s) => s.id));
    reply(c, { type: 'reply', id: cmd.id, data: {
      sessions: own.map((s) => ({ sid: s.id, claudeSessionId: s.claudeSessionId || null })),
      events: events.filter((e) => ids.has(e.sid)),
    } });
    subscribers.add(c); // right after the snapshot: no event falls in between
    return SENT;
  },
  // The new daemon is serving: send the UI over to it, then start handing sessions over.
  adopted(c) {
    if (!retiring || retiring.target !== c) return;
    retiring.ready = true;
    for (const x of clients) if (x !== c) x.end();
    tryHandover();
  },
});

// The new daemon's side: one link per retiring daemon.
const links = new Set();
// sid -> { link, claudeSessionId, closed } for sessions still on a retiring daemon. `closed`: detached there
// (it never moves over); its commands still go there, but a reattach starts it here.
const remote = new Map();

function relayEvent(e) {
  const { type, seq: _, ...rest } = e;
  const ev = { type: 'event', seq: ++seq, ...rest };
  events.push(ev);
  const l = line(ev);
  for (const c of subscribers) c.write(l);
}

function adoptFrom(sockPath) {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    const link = { sock, pending: new Map(), nextId: 1, adoptId: 0 };
    link.request = (cmd) => new Promise((done) => {
      if (sock.destroyed) return done({ error: 'The previous daemon stopped' });
      const id = link.nextId++;
      link.pending.set(id, done);
      sock.write(line({ ...cmd, id }));
    });
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      links.add(link);
      link.adoptId = link.nextId++;
      link.pending.set(link.adoptId, (m) => {
        if (m.error) { log('cannot adopt from', path.basename(sockPath), m.error); sock.end(); return resolve(); }
        // Handled in line order (not after an await), so none of the live events that follow is missed.
        for (const x of m.data.sessions) remote.set(x.sid, { link, claudeSessionId: x.claudeSessionId });
        for (const e of m.data.events) relayEvent(e);
        log(`adopted ${m.data.sessions.length} running session(s) from ${path.basename(sockPath)}`);
        resolve();
      });
      sock.write(line({ type: 'adopt', id: link.adoptId }));
    });
    sock.on('data', lines((l) => fromUpstream(link, l)));
    sock.on('error', (e) => {
      log('cannot reach the retiring daemon at', path.basename(sockPath), e.code || e.message);
      if (e.code === 'ECONNREFUSED') fs.rmSync(sockPath, { force: true }); // left behind by a daemon that died
      resolve();
    });
    sock.on('close', () => { lostLink(link); resolve(); });
  });
}

function fromUpstream(link, l) {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  const r = m.sid && remote.get(m.sid);
  if (m.type === 'reply') {
    const done = link.pending.get(m.id);
    if (done) { link.pending.delete(m.id); done(m); }
  } else if (m.type === 'event' && r?.link === link) {
    if (m.kind === 'init' && m.claudeSessionId) r.claudeSessionId = m.claudeSessionId;
    if (m.kind === 'closed') r.closed = true;
    relayEvent(m);
  } else if (m.type === 'partial' && r?.link === link) {
    const out = line(m);
    for (const c of subscribers) c.write(out);
  } else if (m.type === 'handover' && r?.link === link) {
    remote.delete(m.sid);
    const s = newSession({ cwd: m.cwd, title: m.title, model: m.model, mode: m.mode, resume: m.claudeSessionId || m.fork?.from || undefined }, m.sid);
    Object.assign(s, { claudeSessionId: m.claudeSessionId || undefined, color: m.color || undefined, effort: m.effort, stats: m.stats });
    if (!m.claudeSessionId && m.fork) s.fork = { at: m.fork.at }; // a branch nobody has written to yet
    s.resumeAt = rewindPoint(m.claudeSessionId);
    run(s); // like a reattach: the CLI waits for the next message
    log(`[${s.id}] taken over from the previous daemon`);
  } else if (m.type === 'retired') {
    setTimeout(pruneReleases, 2000);
  }
}

function lostLink(link) {
  if (!links.delete(link)) return;
  for (const done of link.pending.values()) done({ error: 'The previous daemon stopped' });
  link.pending.clear();
  // It went away with sessions still on it (killed, crashed): they show as detached, ready to reattach.
  for (const [sid, r] of remote) if (r.link === link) { remote.delete(sid); if (!r.closed) emit(sid, { kind: 'closed' }); }
}

// A command for a session on a retiring daemon goes there; its reply comes back as ours.
async function forward(c, cmd, link) {
  const { id, ...rest } = cmd;
  const r = await link.request(rest);
  if (r.error === MOVED) return dispatch(c, cmd); // it moved here meanwhile (the handover came first)
  if (id != null) reply(c, { type: 'reply', id, ...(r.error != null ? { error: r.error } : { data: r.data ?? null }) });
  else if (r.error != null) reply(c, { type: 'error', text: r.error });
}

// Releases (client/client.mjs installs each into releases/r<time>): keep this one, the one `current`
// points to, any a running process uses, and the newest two.
function pruneReleases() {
  const root = path.join(DIR, 'releases');
  let names;
  try { names = fs.readdirSync(root).filter((n) => /^r\d+$/.test(n)).sort(); } catch { return; }
  const keep = new Set(names.slice(-2));
  keep.add(RELEASE);
  try { keep.add(path.basename(fs.realpathSync(path.join(DIR, 'current')))); } catch {}
  let ps;
  try { ps = execFileSync('ps', ['-eo', 'args'], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 << 20 }).toString(); } catch { return; }
  for (const n of names) if (ps.includes(`/releases/${n}/`)) keep.add(n);
  for (const n of names) {
    if (keep.has(n)) continue;
    fs.rmSync(path.join(root, n), { recursive: true, force: true });
    log('removed old release', n);
  }
}

function session(sid) {
  const s = sessions.get(sid);
  if (!s) throw new Error('No such session');
  return s;
}
function live(sid) {
  const s = sessions.get(sid);
  if (!s?.q || !alive(s)) throw new Error('Session is not running');
  if (s.rewinding) throw new Error(REWINDING);
  return s;
}

function reply(c, obj) { c.write(line(obj)); }

function dispatch(c, cmd) {
  const r = cmd.sid && remote.get(cmd.sid);
  // (A branch is made here even from a session that still lives on the previous daemon: a session born
  // there would never reach us, its events being relayed only for sessions we adopted. It needs only the
  // transcript, which the page names.)
  if (r && cmd.type !== 'branch') return forward(c, cmd, r.link);
  let out;
  try {
    // A session being handed over answers "moved" once the new daemon knows it (which then runs the command).
    out = cmd.sid && moving.has(cmd.sid) ? moving.get(cmd.sid).then(() => { throw new Error(MOVED); }) : handlers[cmd.type](c, cmd);
  } catch (e) {
    out = Promise.reject(e);
  }
  if (out === SENT) return;
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
  clients.add(c);
  const drop = () => { subscribers.delete(c); clients.delete(c); };
  c.on('close', drop);
  c.on('error', drop);
  c.setEncoding('utf8');
  whenReady.then(() => serve(c)); // (unread data waits in the socket meanwhile)
}
// Commands between client.mjs and daemons only: the page can't send these (client.mjs forwards the
// page only what `hello` lists).
const INTERNAL = new Set(['sync', 'retire', 'adopt', 'adopted']);
function serve(c) {
  if (c.destroyed) return;
  reply(c, { type: 'hello', boot: BOOT, seq, pid: process.pid, host: os.hostname(), code: CODE, home: os.homedir(), sdk: SDK, auth: AUTH, user: USER_NAME, release: RELEASE,
    commands: Object.keys(handlers).filter((n) => !INTERNAL.has(n)) });
  if (AUTH.loggedIn !== false) checkAuth(); // (a logout from a terminal since: the next page load notices; while logged out it polls)
  c.on('data', lines((l) => {
    let cmd;
    try { cmd = JSON.parse(l); } catch (e) { log('bad command', l.slice(0, 200), e); return; }
    if (Object.hasOwn(handlers, cmd.type)) dispatch(c, cmd);
    else if (cmd.id != null) reply(c, { type: 'reply', id: cmd.id, error: `The server doesn't know "${cmd.type}": click Update server in the UI` });
  }));
}

// Newest SDK, checked at start and every 6 hours (quietly skipped when offline). Asked of npm, from this
// release's folder: the registry Update server installs from (a mirror in ~/.npmrc can lag behind
// registry.npmjs.org, and a version it doesn't have yet would keep the button up after every update).
async function checkSdk() {
  try {
    let pkg;
    if (process.env.IRO_TEST_SDK_LATEST) pkg = { version: process.env.IRO_TEST_SDK_LATEST }; // tests: no network
    else {
      const out = await new Promise((resolve, reject) => execFile('npm', ['view', '@anthropic-ai/claude-agent-sdk@latest', 'version', 'claudeCodeVersion', '--json'],
        { cwd: path.dirname(fileURLToPath(import.meta.url)), timeout: 60000 }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
      const v = JSON.parse(out);
      pkg = typeof v === 'string' ? { version: v } : v; // (just the version when the other field is missing)
      if (!pkg?.version) return;
    }
    if (pkg.version === SDK.latest) return;
    Object.assign(SDK, { latest: pkg.version, latestCc: pkg.claudeCodeVersion || null });
    partial('', { op: 'sdk', sdk: SDK });
  } catch {}
}
setTimeout(checkSdk, 3000);
checkAuth();
setInterval(checkSdk, 6 * 3600 * 1000).unref?.();

// ---- start: refuse to run twice, clean up a stale socket ----
fs.mkdirSync(DIR, { recursive: true });
// Sessions started from this UI that recent.json doesn't know yet (e.g. from before it existed, or
// from a daemon that stopped before recording them) are added from their transcripts, so a folder
// never loses its recent sessions to a restart.
async function seedRecent() {
  let list = [];
  try { list = await listSessions({ limit: 400 }); } catch (e) { log('cannot list sessions', e.message); }
  const index = transcriptIndex();
  const archived = new Set(readJson(ARCHIVED_FILE, []));
  const found = [];
  for (const x of list) {
    if (!ours.has(x.sessionId) || archived.has(x.sessionId)) continue;
    const meta = transcriptMeta(index.get(x.sessionId));
    if (!meta.hasMessages) continue;
    const cwd = x.cwd || meta.cwd;
    const dir = cwd && resolveDir(cwd); // (an empty path would resolve to ~)
    if (dir) found.push([dir, { id: x.sessionId, title: titleOf(x), t: x.lastModified || 0 }]);
  }
  recent = updateJson(RECENT_FILE, recent, (all) => {
    let added = 0;
    for (const [dir, e] of found) if (!(all[dir] || []).some((x) => x.id === e.id)) { (all[dir] ||= []).push(e); added++; }
    if (!added) return false;
    for (const dir of Object.keys(all)) all[dir] = all[dir].sort((a, b) => b.t - a.t).slice(0, RECENT_MAX);
  });
}
await seedRecent();
// The remembered sessions come back as detached rows (oldest first, like the event log), except the
// ones still running on a retiring daemon: those are live rows.
function emitDormant() {
  const running = new Set([...remote.values()].filter((r) => !r.closed).map((r) => r.claudeSessionId).filter(Boolean));
  for (const [dir, list] of Object.entries(recent)) {
    for (const x of [...list].reverse()) {
      if (running.has(x.id)) continue;
      const sid = randomUUID().slice(0, 8);
      emit(sid, { kind: 'created', cwd: dir, title: x.title || 'Session', claudeSessionId: x.id, dormant: true, lastActive: x.t, ...(colors[x.id] ? { color: colors[x.id] } : {}) });
      emit(sid, { kind: 'closed' });
    }
  }
}
// Clients are served once the sessions of any retiring daemon are adopted and the log is complete.
let ready;
const whenReady = new Promise((r) => (ready = r));
async function start() {
  for (const f of fs.readdirSync(DIR)) if (/^old-[0-9a-f]{8}\.sock$/.test(f)) await adoptFrom(path.join(DIR, f));
  emitDormant();
  ready();
  for (const l of links) l.sock.write(line({ type: 'adopted' }));
  pruneReleases();
}
// ---- stopping: Stop server in the UI, `client.mjs --stop`, or idle exit ----
// Every session is closed (they come back as detached rows, resumable) and the socket removed, so the
// next attach starts a fresh daemon. Clients are told first: a stop they asked for is no connection
// loss, so they don't reconnect (which would start a new daemon right away).
let exiting = false;
async function stopDaemon(why) {
  if (exiting) return;
  exiting = true;
  log(`${why}: exiting`);
  server?.close();
  fs.rmSync(retiring?.sock || SOCK, { force: true });
  releaseLock(); // the next daemon may start while this one closes its sessions
  for (const c of clients) c.write(line({ type: 'shutdown' }));
  for (const l of links) l.request({ type: 'shutdown' }); // a daemon still finishing sessions of an older release
  const own = liveOwn();
  for (const s of own) {
    for (const rid of [...s.pending.keys()]) settle(s, rid, false);
    try { s.predQ?.close(); } catch {}
    try { s.q?.close(); } catch {}
  }
  for (const t of btwThreads.values()) try { t.proc?.q.close(); } catch {}
  await Promise.race([Promise.all(own.map((s) => s.done)), new Promise((r) => setTimeout(r, 10000))]);
  setTimeout(() => process.exit(0), 200); // (lets the last writes go out)
}
handlers.shutdown = () => {
  const n = liveOwn().length + [...remote.values()].filter((r) => !r.closed).length;
  setImmediate(() => stopDaemon('asked to stop')); // after the reply
  return { sessions: n };
};

// An unused daemon exits after IRO_IDLE_HOURS (72 by default; 0 = never). Unused means no client
// attached and nothing going on: no turn, question waiting for approval, queued message, background
// task or process, or btw answer.
const IDLE_MS = Number(process.env.IRO_IDLE_HOURS ?? 72) * 3600e3;
let lastActive = Date.now();
function idleCheck() {
  if (exiting) return;
  if (clients.size || links.size || retiring || moving.size || btwBusy() || liveOwn().some(busy)) { lastActive = Date.now(); return; }
  if (Date.now() - lastActive >= IDLE_MS) stopDaemon(`idle for ${+(IDLE_MS / 3600e3).toFixed(3)} h`);
}
if (IDLE_MS > 0) setInterval(idleCheck, Math.max(1000, Math.min(10 * 60e3, IDLE_MS / 4)));

// ---- the event log stays as big as the live sessions ----
// A session whose CLI is gone keeps only what draws its sidebar row: its 'created' (turned into a
// detached row that reads its conversation from the transcript when opened, as after a restart),
// title changes, its last state and 'closed'. A row superseded by a reattach (same Claude session,
// newer sid) or archived goes entirely. Only deletes, never reorders: a client's `since` stays valid.
// Clients that synced earlier keep what they have; client.mjs trims its cache from 'compact'.
const COMPACT_MS = Number(process.env.IRO_COMPACT_MS) || 60_000;
function compactEvents() {
  const info = new Map(); // sid -> { created, cid, archived, state }
  for (const e of events) {
    const x = info.get(e.sid) || info.set(e.sid, {}).get(e.sid);
    if (e.kind === 'created') x.created = e;
    if (e.kind === 'init' || (e.kind === 'created' && e.claudeSessionId)) x.cid = e.claudeSessionId;
    if (e.kind === 'archived') x.archived = true;
    if (e.kind === 'state') x.state = e;
    if (e.kind === 'user_text' || (e.kind === 'msg' && e.msg.type === 'result')) x.last = e.ts; // as the page counts activity
  }
  const newest = new Map(); // Claude session id -> seq of its newest row's 'created'
  for (const [sid, x] of info) {
    const cid = sessions.get(sid)?.claudeSessionId || x.cid;
    if (cid && x.created && x.created.seq > (newest.get(cid) ?? 0)) newest.set(cid, x.created.seq);
  }
  const drop = new Set(), stub = new Map(); // sid -> the kept 'state' event
  for (const [sid, x] of info) {
    if (!sid || alive(sessions.get(sid)) || remote.has(sid) || moving.has(sid)) continue;
    const cid = sessions.get(sid)?.claudeSessionId || x.cid;
    // (no 'created' left: an earlier pass dropped the row, and this came in after, e.g. its CLI's end)
    if (!x.created || x.archived || (cid && newest.get(cid) !== x.created.seq)) drop.add(sid);
    else stub.set(sid, x.state); // again for one trimmed before: what came in since goes too
  }
  if (!drop.size && !stub.size) return;
  const removed = [], replaced = [];
  const keep = events.filter((e) => {
    const ok = drop.has(e.sid) ? false
      : !stub.has(e.sid) || e.kind === 'created' || e.kind === 'meta' || e.kind === 'closed' || e === stub.get(e.sid);
    if (!ok) removed.push(e.seq);
    return ok;
  });
  for (const sid of stub.keys()) {
    const x = info.get(sid), s = sessions.get(sid);
    if (x.created.compacted) continue;
    Object.assign(x.created, { dormant: true, compacted: true, claudeSessionId: s?.claudeSessionId || x.cid, lastActive: x.last || x.created.lastActive || x.created.ts });
    delete x.created.resumed; // (its 'resumed' line went with the rest)
    delete x.created.nonce;
    if (s?.color) x.created.color = s.color;
    replaced.push(x.created);
  }
  if (!removed.length && !replaced.length) return;
  events.length = 0;
  events.push(...keep);
  const l = line({ type: 'compact', removed, replaced });
  for (const c of subscribers) c.write(l);
}
setInterval(compactEvents, COMPACT_MS);

// ---- local machines (config.json; client.mjs --local writes these defaults, a host has none) ----
// A laptop sleeps, shuts down daily and has little memory to spare:
//   detachIdleMinutes: 60   a session quiet for that long is detached (its CLI, ~400 MB, exits;
//                           sending a message reattaches it); 0 = never
//   keepAwake: true         macOS: no idle sleep while a session is busy (caffeinate -i; closing
//                           the lid still sleeps)
// Read on every use, so an edit applies without a restart.
const CONFIG_FILE = path.join(DIR, 'config.json');
// A file that is there but doesn't parse (a stray comma, a save half done) keeps the last good settings.
let goodConfig = null, badConfig = '';
function config() {
  let own = {};
  try {
    own = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!own || typeof own !== 'object' || Array.isArray(own)) throw new Error('not an object');
    goodConfig = own; badConfig = '';
  } catch (e) {
    if (e.code !== 'ENOENT') {
      if (badConfig !== e.message) log(`cannot read ${CONFIG_FILE} (${e.message}): using ${goodConfig ? 'the last good settings' : 'the defaults'}`);
      badConfig = e.message;
      own = goodConfig || {};
    }
  }
  return { detachIdleMinutes: 0, keepAwake: false, ...own };
}
setInterval(() => {
  const min = Number(config().detachIdleMinutes) || 0;
  if (min <= 0 || retiring) return;
  for (const s of liveOwn()) {
    if (!quiet(s) || Date.now() - Math.max(s.lastMsgAt || 0, s.created) < min * 60e3) continue;
    log(`[${s.id}] quiet for ${min} min: detached`);
    handlers.close(null, { sid: s.id });
  }
}, 10e3);
let awake = null; // the caffeinate process while one is wanted
setInterval(() => {
  const want = process.platform === 'darwin' && !!config().keepAwake && (liveOwn().some(busy) || btwBusy());
  if (want && !awake) {
    const p = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }); // -w: it ends with this daemon
    p.on('error', () => {});
    p.on('exit', () => { if (awake === p) awake = null; });
    awake = p;
  } else if (!want && awake) {
    awake.kill();
    awake = null;
  }
}, 5000);

// Who owns the main socket: daemon.lock holds that daemon's pid. Two daemons started at once (two
// attaches after a reboot left a dead socket behind) both find nothing listening; without the lock the
// second would remove the first one's fresh socket, and the first would run on unreachable. A lock is
// stale when its daemon is gone, or when it never got listening (30 s: a pid can be reused).
const LOCK = path.join(DIR, 'daemon.lock');
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function takeLock() {
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); return true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let pid, age;
    try { pid = Number(fs.readFileSync(LOCK, 'utf8')); age = Date.now() - fs.statSync(LOCK).mtimeMs; } catch { continue; }
    if (pid && pidAlive(pid) && age < 30e3) return false;
    // Stale: moved aside, then checked. If what moved was not that stale lock, another daemon took
    // the lock in between: it goes back, and that daemon starts.
    const aside = `${LOCK}.${process.pid}`;
    try { fs.renameSync(LOCK, aside); } catch { continue; }
    if (Number(fs.readFileSync(aside, 'utf8')) !== pid) { try { fs.renameSync(aside, LOCK); } catch {} return false; }
    fs.rmSync(aside, { force: true });
  }
  return false;
}
function releaseLock() {
  try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK); } catch {}
}
process.on('exit', releaseLock);

let server;
const probe = net.connect(SOCK);
probe.on('connect', () => { log('daemon already running'); process.exit(0); });
probe.on('error', () => {
  fs.mkdirSync(DIR, { recursive: true });
  if (!takeLock()) { log('another daemon is starting'); process.exit(0); }
  fs.rmSync(SOCK, { force: true }); // left by a daemon that died (we hold the lock: nobody else listens there)
  server = net.createServer(onClient);
  server.on('error', (e) => { log('cannot listen on', SOCK, e.message); process.exit(1); });
  server.listen(SOCK, () => {
    fs.chmodSync(SOCK, 0o600);
    log('daemon listening on', SOCK, 'pid', process.pid);
    start().catch((e) => { log('start failed', e); ready(); });
  });
});
