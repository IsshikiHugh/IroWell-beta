#!/usr/bin/env node
// A stand-in for Claude Code in the tests: no model, no network. The daemon starts it in place of the real
// CLI when IRO_FAKE_CLAUDE names this file (the SDK runs a .mjs with node), and the real SDK talks to it as
// to Claude Code: stream-json on stdin/stdout, the control protocol (initialize, can_use_tool, hooks,
// interrupt, set_model …), and a transcript in $CLAUDE_CONFIG_DIR/projects that resume, branch, rewind and
// Past sessions read.
//
// What it answers to a message is a list of steps (see STEPS below), found by the first rule that matches:
// the suite's own (a module named by IRO_FAKE_SCRIPT, read afresh each turn: `export default [{ match, steps }]`),
// then the built-in ones at the end of this file ("Reply with just: X" answers X, and so on).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const VERSION = '2.1.310';
const argv = process.argv.slice(2);

// A suite's own script (IRO_FAKE_SCRIPT) may also answer the CLI's one-off commands (`export function cli(argv)`:
// true when it did) and change what initialize reports (`export const init = { commands, models, account }`).
const script = process.env.IRO_FAKE_SCRIPT ? await import(pathToFileURL(process.env.IRO_FAKE_SCRIPT).href) : {};
if (argv[0] !== '--output-format' && !argv.includes('--input-format') && await script.cli?.(argv)) process.exit(process.exitCode ?? 0);

// ---- the CLI's one-off commands ----
if (argv[0] === '--version' || argv[0] === '-v') { console.log(`${VERSION} (Claude Code)`); process.exit(0); }
if (argv[0] === 'auth') {
  const loggedIn = !process.env.IRO_FAKE_LOGGED_OUT;
  if (argv[1] === 'status') { console.log(JSON.stringify(loggedIn ? { loggedIn: true, authMethod: 'claude.ai', email: 'test@example.com', orgId: 'org-test' } : { loggedIn: false })); process.exit(0); }
  console.error('the fake Claude Code does not log in'); process.exit(1);
}

const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3); };
const flag = (name) => argv.includes(`--${name}`);
const persist = !flag('no-session-persistence');
const oneShot = !!opt('max-turns') || opt('tools') === '';
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const now = () => new Date().toISOString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the session: its id, model, mode, and the transcript it writes ----
const S = {
  cwd: process.cwd(),
  model: opt('model') || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  mode: opt('permission-mode') || 'default',
  effort: opt('effort') || 'medium',
  allowed: new Set((opt('allowedTools') || '').split(',').filter(Boolean)),
  hooks: {}, // event -> callback ids (initialize)
  turns: 0, cost: 0,
};
const resume = opt('resume'), fork = flag('fork-session'), resumeAt = opt('resume-session-at');
S.id = resume && !fork ? resume : randomUUID();
const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const fileOf = (id) => {
  const own = path.join(CONFIG, 'projects', slug(S.cwd), `${id}.jsonl`);
  if (fs.existsSync(own)) return own;
  try { for (const d of fs.readdirSync(path.join(CONFIG, 'projects'))) { const f = path.join(CONFIG, 'projects', d, `${id}.jsonl`); if (fs.existsSync(f)) return f; } } catch {}
  return own;
};
S.file = path.join(CONFIG, 'projects', slug(S.cwd), `${S.id}.jsonl`);
// The conversation so far: the entries of the chain that ends at the leaf (a rewind or branch point cuts it).
const readEntries = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function chain(entries, leaf) {
  const by = new Map(entries.filter((e) => e.uuid).map((e) => [e.uuid, e]));
  let at = leaf ? by.get(leaf) : [...by.values()].filter((e) => e.type === 'user' || e.type === 'assistant').pop();
  const out = [];
  for (let i = 0; at && i < 100000; i++) { out.unshift(at); at = at.parentUuid && by.get(at.parentUuid); }
  return out;
}
S.chain = [];
if (resume) {
  S.chain = chain(readEntries(fileOf(resume)), resumeAt);
  // (write() adds each entry to S.chain again: copied from the chain read, not while walking it)
  if (fork && persist) { const read = S.chain; S.chain = []; for (const e of read) write({ ...e, sessionId: S.id }, true); }
}
S.last = S.chain.at(-1)?.uuid || null;
function write(entry, raw) {
  if (!persist) return;
  const e = raw ? entry : { parentUuid: S.last, isSidechain: false, userType: 'external', entrypoint: 'sdk-ts', cwd: S.cwd, sessionId: S.id, version: VERSION, ...entry };
  if (!raw) S.last = e.uuid;
  S.chain.push(e);
  fs.mkdirSync(path.dirname(S.file), { recursive: true });
  fs.appendFileSync(S.file, JSON.stringify(e) + '\n');
}

// ---- stdout: the SDK's messages ----
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const msg = (m) => out({ ...m, uuid: m.uuid || randomUUID(), session_id: S.id });

// ---- the control protocol, both ways ----
const waiting = new Map(); // request_id -> resolve (what we asked the SDK)
let reqNo = 0;
function ask(request, signal) {
  const request_id = `fake-${++reqNo}`;
  out({ type: 'control_request', request_id, request });
  return new Promise((resolve) => {
    waiting.set(request_id, resolve);
    signal?.addEventListener('abort', () => {
      if (!waiting.delete(request_id)) return;
      out({ type: 'control_cancel_request', request_id });
      resolve(null);
    }, { once: true });
  });
}
const reply = (request_id, response) => out({ type: 'control_response', response: { subtype: 'success', request_id, response } });
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'For everyday tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest for quick answers', supportsEffort: false },
];
const COMMANDS = ['compact', 'context', 'cost', 'usage', 'help', 'status', 'mcp', 'model', 'agents', 'clear', 'review', 'init']
  .map((name) => ({ name, description: `The ${name} command`, argumentHint: '' }));
const resolved = (m) => MODELS.find((x) => x.value === m)?.resolvedModel || m;
function onControl(request_id, r) {
  switch (r.subtype) {
    case 'initialize':
      for (const [ev, list] of Object.entries(r.hooks || {})) S.hooks[ev] = list.flatMap((h) => h.hookCallbackIds || []);
      // (the SDK sends a systemPrompt only in place of Claude Code's own: its default is an empty one)
      S.prompt = r.systemPrompt == null ? null : [].concat(r.systemPrompt).join('\n');
      return reply(request_id, { commands: COMMANDS, agents: [{ name: 'general-purpose', description: 'General-purpose agent' }], output_style: 'default',
        available_output_styles: ['default', 'Explanatory', 'Learning'], models: MODELS,
        account: { email: 'test@example.com', organization: 'Test', subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
        pending_permission_requests: [], pending_user_dialog_requests: [], ...script.init });
    case 'interrupt': interrupt(); return reply(request_id, {});
    case 'set_model': S.model = r.model || 'default'; return reply(request_id, { model: S.model });
    case 'set_permission_mode':
      S.mode = r.mode;
      reply(request_id, { mode: r.mode });
      return msg({ type: 'system', subtype: 'status', status: null, permissionMode: r.mode });
    case 'apply_flag_settings': if (r.settings?.effortLevel) S.effort = r.settings.effortLevel; return reply(request_id, {});
    case 'get_context_usage': {
      const used = 20000 + S.turns * 1500, max = 200000, sys = S.prompt == null ? 5000 : Math.ceil(S.prompt.length / 4);
      const categories = [
        { id: 'system_prompt', name: 'System prompt', tokens: sys, color: 'promptBorder', kind: 'used' },
        { id: 'system_tools', name: 'System tools', tokens: 9000, color: 'inactive', kind: 'used' },
        { id: 'messages', name: 'Messages', tokens: used - 9000 - sys, color: 'purple', kind: 'used' },
        { id: 'free_space', name: 'Free space', tokens: max - used, color: 'promptBorder', kind: 'free' },
      ];
      // the square grid /context draws: 10 x 10, each square a hundredth of the window, in the categories' order
      const squares = categories.flatMap((c) => Array.from({ length: Math.round((c.tokens / max) * 100) }, () => c)).slice(0, 100);
      const gridRows = Array.from({ length: 10 }, (_, r) => squares.slice(r * 10, r * 10 + 10).map((c) => ({ color: c.color, isFilled: c.kind !== 'free', categoryName: c.name, tokens: c.tokens, percentage: (c.tokens / max) * 100, squareFullness: 1 })));
      return reply(request_id, { categories, gridRows, totalTokens: used, maxTokens: max, rawMaxTokens: max, percentage: Math.round((used / max) * 100), model: resolved(S.model),
      memoryFiles: [], mcpTools: [], agents: [], skills: [], isAutoCompactEnabled: true, autoCompactThreshold: max - 13000, apiUsage: null });
    }
    case 'get_settings': return reply(request_id, { effective: {}, sources: [], applied: { model: resolved(S.model), effort: S.effort } });
    case 'get_usage': return reply(request_id, {
      subscription_type: 'max', rate_limits_available: true, // (as a claude.ai login reports)
      rate_limits: { five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3 * 3600e3).toISOString() }, seven_day: { utilization: 34, resets_at: new Date(Date.now() + 4 * 86400e3).toISOString() } },
      session: { model_usage: { [resolved(S.model)]: { inputTokens: 1000 * S.turns, outputTokens: 200 * S.turns, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }, total_cost_usd: S.cost, total_duration_ms: 1000 * S.turns, total_lines_added: 0, total_lines_removed: 0 } });
    case 'mcp_status': return reply(request_id, { mcpServers: script.mcpServers || [] }); // (a suite's `export const mcpServers`)
    case 'stop_task': stopTask(r.task_id); return reply(request_id, {});
    case 'rewind_files': return reply(request_id, rewindFiles(r.user_message_id, r.dry_run));
    default: return reply(request_id, {});
  }
}

// ---- input: user messages queue up and run one turn at a time ----
const inbox = [];
let busy = false, current = null, stdinClosed = false;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    let m;
    try { m = JSON.parse(l); } catch { continue; }
    if (m.type === 'control_request') onControl(m.request_id, m.request);
    else if (m.type === 'control_response') { const r = waiting.get(m.response?.request_id); waiting.delete(m.response?.request_id); r?.(m.response?.subtype === 'success' ? m.response.response : { error: m.response?.error }); }
    else if (m.type === 'control_cancel_request') {}
    else if (m.type === 'user') { inbox.push(m); msg({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'queued' }); pump(); }
  }
});
process.stdin.on('end', () => { stdinClosed = true; if (!busy) finish(); });
const finish = () => { for (const t of tasks.values()) t.proc?.kill(); process.exit(0); };

async function pump() {
  if (busy) return;
  busy = true;
  while (inbox.length || selfTurns.length) {
    if (inbox.length) await userTurn(inbox.shift());
    else await selfTurns.shift()();
  }
  busy = false;
  if (stdinClosed) finish();
}

// ---- one turn ----
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
function begin() {
  msg({ type: 'system', subtype: 'session_state_changed', state: 'running', sdk_host_only: true });
  msg({ type: 'system', subtype: 'init', cwd: S.cwd, session_id: S.id, tools: ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'ExitPlanMode'],
    mcp_servers: [], model: resolved(S.model), permissionMode: S.mode, slash_commands: COMMANDS.map((c) => c.name), apiKeySource: 'none',
    claude_code_version: VERSION, output_style: 'default', agents: ['general-purpose'], skills: [], plugins: [] });
}
function end({ error, text = '' } = {}) {
  S.turns++;
  msg({ type: 'result', subtype: error ? 'error_during_execution' : 'success', is_error: !!error, duration_ms: 5, duration_api_ms: 5, num_turns: oneShot ? 1 : S.turns,
    result: text, stop_reason: error ? null : 'end_turn', total_cost_usd: S.cost, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], ...(error ? { errors: typeof error === 'string' ? [error] : [] } : {}) }); // (an error result without `errors` kills the SDK's reader)
  msg({ type: 'system', subtype: 'session_state_changed', state: 'idle', sdk_host_only: true });
}
async function userTurn(m) {
  const ctl = current = new AbortController();
  const content = m.message?.content, text = textOf(content).trim();
  msg({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'started' });
  begin();
  // A slash command: the CLI answers it itself (a "<synthetic>" message), no model turn.
  const cmd = /^\/([\w:-]+)\s*([\s\S]*)$/.exec(text);
  if (cmd) {
    const shown = `<command-name>/${cmd[1]}</command-name>\n            <command-message>${cmd[1]}</command-message>\n            <command-args>${cmd[2]}</command-args>`;
    out({ type: 'user', message: { role: 'user', content: shown }, session_id: S.id, parent_tool_use_id: null, uuid: m.uuid, timestamp: now(), isReplay: true });
    write({ type: 'user', message: { role: 'user', content: shown }, uuid: m.uuid, timestamp: now() });
    if (cmd[1] === 'compact') msg({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 20000, post_tokens: 3000 } });
    else assistant([{ type: 'text', text: `(fake) /${cmd[1]}${cmd[2] ? ' ' + cmd[2] : ''}` }], { synthetic: true });
    end();
    msg({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'completed' });
    current = null;
    return;
  }
  const extra = await hook('UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', prompt: text });
  out({ type: 'user', message: m.message, session_id: S.id, parent_tool_use_id: null, uuid: m.uuid, timestamp: now(), isReplay: true });
  write({ type: 'user', message: m.message, uuid: m.uuid, timestamp: now(), promptId: randomUUID() });
  checkpoint(m.uuid);
  const ctx = { text, content, extra, session: S, chain: () => S.chain, ctl, oneShot };
  try {
    const steps = await stepsFor(ctx);
    await run(steps, ctl.signal, null, ctx);
    end({ text: ctx.lastText });
  } catch (e) {
    if (ctl.signal.aborted) {
      msg({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null });
      end({ error: true });
    } else {
      assistant([{ type: 'text', text: `fake Claude: ${e.message}` }]);
      end({ error: true });
    }
  }
  msg({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'completed' });
  current = null;
}
function interrupt() {
  current?.abort();
  for (const t of tasks.values()) if (!t.background) t.proc?.kill();
}
// A hook the daemon registered: what it returned (its additionalContext, say), or null.
async function hook(event, input) {
  const ids = S.hooks[event];
  if (!ids?.length) return null;
  const outs = [];
  for (const id of ids) outs.push(await ask({ subtype: 'hook_callback', callback_id: id, input: { session_id: S.id, transcript_path: S.file, cwd: S.cwd, ...input } }));
  return outs.map((o) => o?.hookSpecificOutput?.additionalContext || o?.systemMessage || '').filter(Boolean).join('\n') || null;
}

// ---- messages ----
function assistant(content, { parent = null, synthetic = false, stream = !synthetic } = {}) {
  const id = randomUUID();
  if (stream) for (const [index, b] of content.entries()) {
    if (b.type !== 'text' && b.type !== 'thinking') continue;
    msg({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: b.type, [b.type]: '' } }, parent_tool_use_id: parent });
    const s = b.text ?? b.thinking;
    for (let i = 0; i < s.length; i += 40) msg({ type: 'stream_event', event: { type: 'content_block_delta', index, delta: b.type === 'text' ? { type: 'text_delta', text: s.slice(i, i + 40) } : { type: 'thinking_delta', thinking: s.slice(i, i + 40) } }, parent_tool_use_id: parent });
    msg({ type: 'stream_event', event: { type: 'content_block_stop', index }, parent_tool_use_id: parent });
  }
  const message = { id: `msg_${id.slice(0, 8)}`, type: 'message', role: 'assistant', model: synthetic ? '<synthetic>' : resolved(S.model), content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  msg({ type: 'assistant', message, parent_tool_use_id: parent, uuid: id });
  if (!parent) write({ type: 'assistant', message, uuid: id, timestamp: now() });
  return id;
}
function toolResult(toolUseId, result, { parent = null, isError = false, useResult } = {}) {
  const content = [{ type: 'tool_result', tool_use_id: toolUseId, content: result, ...(isError ? { is_error: true } : {}) }];
  const uuid = randomUUID();
  msg({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: parent, uuid, ...(useResult ? { tool_use_result: useResult } : {}), timestamp: now() });
  if (!parent) write({ type: 'user', message: { role: 'user', content }, uuid, timestamp: now(), ...(useResult ? { toolUseResult: useResult } : {}) });
}

// ---- STEPS: what a turn does ----
// { text }                     says it (streamed, then the assistant message)
// { thinking }                 thinks it
// { tool, input, result?, ask?, error? }
//                              calls a tool: asks for approval as Claude Code would (the mode, the session's
//                              allow rules; `ask` forces it either way), then runs it: Bash, Read, Write and Edit
//                              for real (in the session's folder), AskUserQuestion with the user's answers;
//                              `result` (a string, or (input, answers) => string) stands in for the output
// { sleep: ms }                holds the turn busy (an interrupt ends it)
// { agent: { description, prompt?, steps, background? } }
//                              a subagent: its steps run under its own tool_use, then its report
// { background: { command, description?, after? } }
//                              a Bash run in the background: done, it reports back and starts a turn of its own
// { deliver: { content, entry?, replay?, after?, steps? } }
//                              a message the CLI queues itself (another session's message, a schedule firing):
//                              `after` ms on, a turn of its own for it. Its transcript entry (`entry`: the fields it
//                              adds, e.g. turnOrigin, origin, isMeta) is written first, then command_lifecycle says
//                              it started; `replay` also echoes it on stdout (with entry.origin). `steps`, else the
//                              rules answer `content`.
// { raw: message }             an SDK message as it is (a sys row, a rate limit event …)
// { fail: text }               the turn fails
// { exit: code }               the CLI dies
const NEEDS_OK = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch']);
const EDITS = new Set(['Write', 'Edit', 'NotebookEdit']);
const ALWAYS_ASK = new Set(['AskUserQuestion', 'ExitPlanMode']);
const needsOk = (tool, force) => force ?? (ALWAYS_ASK.has(tool) || (NEEDS_OK.has(tool) && !S.allowed.has(tool)
  && S.mode !== 'bypassPermissions' && !(S.mode === 'acceptEdits' && EDITS.has(tool))));
async function run(steps, signal, parent, ctx) {
  for (const st of steps) {
    if (signal.aborted) throw new Error('interrupted');
    if (st.text != null) { assistant([{ type: 'text', text: String(st.text) }], { parent }); if (!parent) ctx.lastText = String(st.text); }
    else if (st.thinking != null) assistant([{ type: 'thinking', thinking: String(st.thinking), signature: 'fake' }], { parent });
    else if (st.sleep) await sleep(st.sleep, signal);
    else if (st.tool) await tool(st, signal, parent, ctx);
    else if (st.agent) await agent(st.agent, signal, parent, ctx);
    else if (st.background) background(st.background, parent);
    else if (st.deliver) deliver(st.deliver);
    else if (st.raw) msg({ parent_tool_use_id: parent, ...st.raw });
    else if (st.fail) throw new Error(st.fail);
    else if (st.exit != null) process.exit(st.exit);
  }
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('interrupted')); }, { once: true });
});
async function tool(st, signal, parent, ctx) {
  const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  let input = st.input || {};
  assistant([{ type: 'tool_use', id, name: st.tool, input }], { parent });
  let answers;
  if (needsOk(st.tool, st.ask)) {
    const suggestions = ALWAYS_ASK.has(st.tool) ? undefined : [{ type: 'addRules', rules: [{ toolName: st.tool }], behavior: 'allow', destination: 'session' }];
    const r = await ask({ subtype: 'can_use_tool', tool_name: st.tool, input, tool_use_id: id, ...(suggestions ? { permission_suggestions: suggestions } : {}), ...(parent ? { agent_id: parent } : {}) }, signal);
    if (!r || signal.aborted) throw new Error('interrupted');
    if (r.behavior !== 'allow') {
      toolResult(id, r.message || 'The user denied this action.', { parent, isError: true });
      if (/interrupt/i.test(r.message || '') || r.interrupt) throw new Error('interrupted');
      return;
    }
    for (const u of r.updatedPermissions || []) for (const rule of u.rules || []) if (u.behavior === 'allow') S.allowed.add(rule.toolName);
    input = r.updatedInput || input;
    answers = input.answers;
  }
  let result, useResult, isError = false;
  try {
    ({ result, useResult } = await perform(st.tool, input, signal, answers, ctx));
    if (st.result != null) result = typeof st.result === 'function' ? st.result(input, answers) : st.result;
  } catch (e) {
    if (signal.aborted) throw e;
    result = String(e.message); isError = true;
  }
  if (st.error) { result = st.error; isError = true; }
  toolResult(id, result, { parent, isError, useResult });
  const note = await hook('PostToolUse', { hook_event_name: 'PostToolUse', tool_name: st.tool, tool_input: input, tool_response: useResult ?? result, tool_use_id: id });
  if (note) ctx.notes = [...(ctx.notes || []), note];
}
const abs = (f) => path.resolve(S.cwd, f || '');
async function perform(name, input, signal, answers) {
  switch (name) {
    case 'Bash': {
      if (input.run_in_background) { const t = background({ command: input.command, description: input.description }); return { result: `Command running in background with ID: ${t.id}. Output is being written to: ${t.file}` }; }
      const r = await sh(input.command, signal);
      return { result: (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || '(no output)' + (r.code ? `\nExit code ${r.code}` : ''),
        useResult: { stdout: r.stdout, stderr: r.stderr, interrupted: false, isImage: false } };
    }
    case 'Read': {
      const text = fs.readFileSync(abs(input.file_path), 'utf8'), lines = text.split('\n');
      return { result: lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'),
        useResult: { type: 'text', file: { filePath: abs(input.file_path), content: text, numLines: lines.length, startLine: 1, totalLines: lines.length } } };
    }
    case 'Write': {
      const f = abs(input.file_path), before = exists(f) ? fs.readFileSync(f, 'utf8') : null;
      remember(f, before);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, input.content ?? '');
      return { result: before == null ? `File created successfully at: ${f}` : `The file ${f} has been updated.`,
        useResult: { type: before == null ? 'create' : 'update', filePath: f, content: input.content, structuredPatch: patch(before ?? '', input.content ?? ''), originalFile: before } };
    }
    case 'Edit': {
      const f = abs(input.file_path), before = fs.readFileSync(f, 'utf8');
      if (!before.includes(input.old_string)) throw new Error(`String to replace not found in file.\nString: ${input.old_string}`);
      const after = input.replace_all ? before.split(input.old_string).join(input.new_string) : before.replace(input.old_string, () => input.new_string);
      remember(f, before);
      fs.writeFileSync(f, after);
      return { result: `The file ${f} has been updated.`, useResult: { filePath: f, oldString: input.old_string, newString: input.new_string, originalFile: before, structuredPatch: patch(before, after), userModified: false, replaceAll: !!input.replace_all } };
    }
    case 'AskUserQuestion': {
      const a = answers || {};
      return { result: `User has answered your questions: ${Object.entries(a).map(([q, v]) => `"${q}"="${v}"`).join(', ')}. You can now continue with the user's answers in mind.`, useResult: { questions: input.questions, answers: a } };
    }
    case 'ExitPlanMode': return { result: 'User has approved your plan. You can now start coding.' };
    default: return { result: 'ok' };
  }
}
const exists = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
// One hunk from the first to the last line that differ (what the diff view needs: real line numbers).
function patch(a, b) {
  const x = a === '' ? [] : a.split('\n'), y = b.split('\n');
  let s = 0; while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0; while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const c0 = Math.max(0, s - 3), c1x = Math.min(x.length, x.length - e + 3), c1y = Math.min(y.length, y.length - e + 3);
  const lines = [...x.slice(c0, s).map((l) => ' ' + l), ...x.slice(s, x.length - e).map((l) => '-' + l), ...y.slice(s, y.length - e).map((l) => '+' + l), ...x.slice(x.length - e, c1x).map((l) => ' ' + l)];
  return [{ oldStart: c0 + 1, oldLines: c1x - c0, newStart: c0 + 1, newLines: c1y - c0, lines }];
}
// Runs a shell command as the Bash tool does: in the session's folder, with the session's id in its environment
// (the daemon finds what a session left running by it).
const procs = new Set();
function sh(command, signal) {
  return new Promise((resolve) => {
    const p = spawn('/bin/bash', ['-c', command], { cwd: S.cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: S.id, CLAUDE_PID: String(process.pid), CLAUDECODE: '1' } });
    procs.add(p);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
    const kill = () => p.kill();
    signal?.addEventListener('abort', kill, { once: true });
    p.on('close', (code) => { procs.delete(p); signal?.removeEventListener('abort', kill); resolve({ stdout, stderr, code }); });
  });
}

// ---- subagents and background tasks ----
const tasks = new Map();
const selfTurns = []; // turns of its own (a background task reporting back), run when nothing else is
async function agent(a, signal, parent, ctx) {
  const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`, taskId = `a${randomUUID().slice(0, 8)}`;
  const input = { description: a.description || 'Subagent', prompt: a.prompt || a.description || '', subagent_type: a.type || 'general-purpose', ...(a.background ? { run_in_background: true } : {}) };
  assistant([{ type: 'tool_use', id, name: 'Agent', input }], { parent });
  msg({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, description: input.description, subagent_type: input.subagent_type, task_type: 'local_agent', is_backgrounded: !!a.background });
  const body = async (sig) => {
    const t0 = Date.now();
    await run(a.steps || [], sig, id, { ...ctx, lastText: '' });
    const report = a.report ?? [...(a.steps || [])].reverse().find((s) => s.text != null)?.text ?? 'Done.';
    return { report, ms: Date.now() - t0 };
  };
  if (a.background) {
    toolResult(id, `Async agent launched successfully.\nagentId: ${taskId}`, { parent });
    const t = { id: taskId, background: true, description: input.description };
    tasks.set(taskId, t);
    body(new AbortController().signal).then(({ report, ms }) => notify(t, 'completed', `Agent "${input.description}" finished`, report, ms));
    return;
  }
  const { report, ms } = await body(signal);
  msg({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: id, status: 'completed', summary: report, usage: { total_tokens: 1234, tool_uses: (a.steps || []).filter((s) => s.tool).length, duration_ms: ms } });
  toolResult(id, [{ type: 'text', text: report }], { parent, useResult: { status: 'completed', prompt: input.prompt, agentId: taskId, content: [{ type: 'text', text: report }], totalDurationMs: ms, totalTokens: 1234, totalToolUseCount: (a.steps || []).filter((s) => s.tool).length } });
}
function background(b, parent = null) {
  const id = `b${randomUUID().slice(0, 8)}`, file = path.join(os.tmpdir(), `fake-claude-${id}.output`);
  const t = { id, file, background: true, description: b.description || b.command };
  tasks.set(id, t);
  msg({ type: 'system', subtype: 'task_started', task_id: id, description: t.description, task_type: 'local_bash', is_backgrounded: true });
  const p = t.proc = spawn('/bin/bash', ['-c', b.command], { cwd: S.cwd, env: { ...process.env, CLAUDE_CODE_SESSION_ID: S.id, CLAUDE_PID: String(process.pid) }, stdio: ['ignore', fs.openSync(file, 'w'), fs.openSync(file, 'a')] });
  p.on('exit', (code, sig) => {
    t.proc = null;
    if (t.stopped) return;
    const status = sig ? 'killed' : 'completed';
    let output = ''; try { output = fs.readFileSync(file, 'utf8'); } catch {}
    notify(t, status, `Background command "${t.description}" ${status} (exit code ${code ?? 1})`, output, 0, b.reply);
  });
  return t;
}
function stopTask(id) { const t = tasks.get(id); if (!t) return; t.stopped = true; t.proc?.kill(); msg({ type: 'system', subtype: 'task_notification', task_id: id, status: 'stopped', summary: `"${t.description}" stopped` }); }
// A task done: the CLI tells the SDK, then takes the report in as a message and answers it in a turn of its own.
function notify(t, status, summary, result, ms, answer) {
  msg({ type: 'system', subtype: 'task_notification', task_id: t.id, status, summary, output_file: t.file, usage: { total_tokens: 0, tool_uses: 0, duration_ms: ms } });
  const content = `<task-notification>\n<task-id>${t.id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n<result>${result}</result>\n</task-notification>`;
  selfTurns.push(async () => {
    const ctl = current = new AbortController(), uuid = randomUUID();
    begin();
    out({ type: 'user', message: { role: 'user', content }, session_id: S.id, parent_tool_use_id: null, uuid, timestamp: now(), isReplay: true, origin: { kind: 'task-notification' } });
    write({ type: 'user', message: { role: 'user', content }, uuid, timestamp: now(), origin: { kind: 'task-notification' } });
    const ctx = { text: content, notification: true, session: S, chain: () => S.chain, ctl };
    try { await run(answer || [{ text: `Noted: ${summary}.` }], ctl.signal, null, ctx); } catch {}
    end({ text: ctx.lastText });
    current = null;
  });
  pump();
}
// A message the CLI queues itself (the `deliver` step): announced by command_lifecycle, its text and where it
// came from only in the transcript (and the echo, with `replay`).
function deliver(d) {
  const uuid = randomUUID(), message = { role: 'user', content: d.content };
  setTimeout(() => {
    msg({ type: 'command_lifecycle', command_uuid: uuid, state: 'queued' });
    selfTurns.push(async () => {
      const ctl = current = new AbortController();
      write({ type: 'user', message, uuid, timestamp: now(), promptId: randomUUID(), promptSource: 'system', ...d.entry });
      msg({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' });
      begin();
      if (d.replay) out({ type: 'user', message, session_id: S.id, parent_tool_use_id: null, uuid, timestamp: now(), isReplay: true, ...(d.entry?.origin ? { origin: d.entry.origin } : {}) });
      const ctx = { text: textOf(d.content).trim(), content: d.content, delivered: true, session: S, chain: () => S.chain, ctl };
      try { await run(d.steps || await stepsFor(ctx), ctl.signal, null, ctx); end({ text: ctx.lastText }); } catch { end({ error: true }); }
      msg({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed' });
      current = null;
    });
    pump();
  }, d.after || 0);
}

// ---- file checkpoints (rewind) ----
const CP = path.join(CONFIG, 'fake-file-history', `${S.id}.json`);
let cp = (() => { try { return JSON.parse(fs.readFileSync(path.join(CONFIG, 'fake-file-history', `${resume || S.id}.json`), 'utf8')); } catch { return { order: [], pre: {} }; } })();
let cpAt = null;
function checkpoint(uuid) { cpAt = uuid; cp.order.push(uuid); cp.pre[uuid] = {}; saveCp(); }
function remember(file, before) { if (cpAt && !(file in cp.pre[cpAt])) { cp.pre[cpAt][file] = before; saveCp(); } }
function saveCp() { if (!persist) return; fs.mkdirSync(path.dirname(CP), { recursive: true }); fs.writeFileSync(CP, JSON.stringify(cp)); }
function rewindFiles(uuid, dryRun) {
  const i = cp.order.indexOf(uuid);
  if (i < 0) return { canRewind: false, error: 'No file checkpoint for that message' };
  const first = new Map();
  for (const u of cp.order.slice(i)) for (const [f, before] of Object.entries(cp.pre[u] || {})) if (!first.has(f)) first.set(f, before);
  let insertions = 0, deletions = 0;
  for (const [f, before] of first) {
    const now = exists(f) ? fs.readFileSync(f, 'utf8') : '';
    for (const h of patch(now, before ?? '')) for (const l of h.lines) { if (l[0] === '+') insertions++; else if (l[0] === '-') deletions++; }
    if (!dryRun) { if (before == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, before); }
  }
  return { canRewind: true, filesChanged: [...first.keys()], insertions, deletions };
}

// ---- which steps: the suite's rules, then the built-in ones ----
async function stepsFor(ctx) {
  const file = process.env.IRO_FAKE_SCRIPT;
  if (file) {
    const mod = await import(`${pathToFileURL(file).href}?t=${fs.statSync(file).mtimeMs}`);
    for (const r of mod.default || []) {
      const hit = typeof r.match === 'function' ? r.match(ctx.text, ctx) : r.match instanceof RegExp ? r.match.exec(ctx.text) : ctx.text.includes(r.match) && [ctx.text];
      if (hit) return typeof r.steps === 'function' ? r.steps(hit, ctx) : r.steps;
    }
  }
  for (const r of BUILT_IN) { const hit = r.match.exec(ctx.text); if (hit) return r.steps(hit, ctx); }
  return [{ text: 'ok' }];
}
// What the user said earlier in this conversation (resumed, branched or rewound: only the chain it goes on from).
const said = (ctx) => ctx.chain().filter((e) => e.type === 'user').map((e) => textOf(e.message?.content));
const BUILT_IN = [
  // one-off questions of the daemon's (the next-message guess, the usage turn): nothing to say
  { match: oneShot ? /[\s\S]/ : /$^/, steps: () => [{ text: '-' }] },
  { match: /(?:what|which) (?:is|was) the codeword/i, steps: (m, ctx) => {
    const words = said(ctx).flatMap((t) => [...t.matchAll(/codeword (?:is now |to |is )?([A-Z]{3,})/g)].map((x) => x[1]));
    return [{ text: words.pop() || 'I don\'t know the codeword.' }];
  } },
  { match: /Reply with just(?: the word)?:?\s*(.+?)\.?\s*$/i, steps: (m) => [{ text: m[1].trim() }] },
  { match: /codeword/i, steps: () => [{ text: 'ok' }] },
  { match: /\bsleep (\d+)/i, steps: (m) => [{ tool: 'Bash', input: { command: `sleep ${m[1]}`, description: `Sleep ${m[1]} s` } }, { text: 'done' }] },
];
