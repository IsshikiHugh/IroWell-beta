#!/usr/bin/env node
// Read other Claude Code sessions' transcripts (~/.claude/projects/<project>/<id>.jsonl) as plain text.
// No dependencies: on another host run it as  ssh <host> "\$SHELL -lc 'node --input-type=module - list'" < sessions.mjs
//
//   list [filter] [--limit N]         sessions, most recently active first (filter: id, folder or title)
//   outline <id>                      one line per turn: time, the user's request, tool count, the answer's start
//   show <id> [--turns A-B | --last N] [--tools none|brief|full]
//                                     the turns in full (default: the last 3, tool calls brief)
//   grep <id> <regex>                 the lines that match, with their turn numbers
//
// <id>: any unique prefix of a Claude session id (as `list` prints it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const IRO_DIR = process.env.IRO_DIR || path.join(os.homedir(), '.iro-coding');
const SELF = process.env.CLAUDE_CODE_SESSION_ID || '';

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const oneLine = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + `\n… [${t.length - n} more chars]` : t; };
const stamp = (ms) => ms ? new Date(ms).toLocaleString('sv-SE', { hour12: false }).slice(0, 16) : '?';
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function transcripts() {
  const root = path.join(CLAUDE_DIR, 'projects');
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, d)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(root, d, f);
      try { const st = fs.statSync(file); out.push({ id: f.slice(0, -6), file, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
  return out;
}

// Titles the IroWell sidebar shows (recent.json: { cwd: [{ id, title }] }).
function uiTitles() {
  const m = new Map();
  for (const [cwd, list] of Object.entries(readJson(path.join(IRO_DIR, 'recent.json'), {})))
    for (const x of list || []) m.set(x.id, { title: x.title, cwd });
  return m;
}

// cwd, first request and AI title from the head and tail of a transcript, without parsing all of it.
function peekMeta(file, size) {
  const read = (pos, len) => {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n');
  };
  const n = Math.min(size, 256 << 10);
  const head = read(0, n);
  const tail = size > n ? read(size - Math.min(size, 128 << 10), Math.min(size, 128 << 10)) : head;
  let cwd, first, title, entry;
  for (const l of head) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    cwd ||= e.cwd; entry ||= e.entrypoint;
    if (!first && e.type === 'user' && !e.isSidechain && !e.isMeta) first = promptText(e.message?.content) || undefined;
    if (e.type === 'ai-title') title = e.aiTitle;
  }
  for (const l of tail) { try { const e = JSON.parse(l); if (e.type === 'ai-title') title = e.aiTitle; } catch {} }
  return { cwd, first, title, entry };
}

// What the user typed; '' for injected text; null for tool results.
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
  if (/^\s*<task-notification>/.test(text)) return `[background task finished] ${oneLine(/<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] || '', 200)}`;
  if (/^\s*(<local-command-|<system-reminder>|Caveat: The messages below)/.test(text)) return '';
  return text;
}

function resolve(prefix) {
  if (!prefix) die('Give a session id (see `list`)');
  const hits = transcripts().filter((t) => t.id.startsWith(prefix));
  if (!hits.length) die(`No session id starts with "${prefix}"`);
  if (hits.length > 1) die(`"${prefix}" matches ${hits.length} sessions: ${hits.map((t) => t.id).join(', ')}`);
  return hits[0];
}

// The conversation as the session sees it: the chain of parentUuid links back from its last message
// (a rewind or a branch leaves abandoned entries in the file), through compactions (logicalParentUuid).
function conversation(t) {
  const byId = new Map();
  let last;
  for (const l of fs.readFileSync(t.file, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (!e.uuid || e.isSidechain) continue;
    byId.set(e.uuid, e);
    if (e.type === 'user' || e.type === 'assistant') last = e;
  }
  const rewound = readJson(path.join(IRO_DIR, 'rewinds.json'), {})[t.id];
  let cur = (rewound && byId.get(rewound)) || last;
  const chain = [];
  const seen = new Set();
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    cur = byId.get(cur.parentUuid ?? cur.logicalParentUuid);
  }
  return turns(chain.reverse());
}

// Split into turns: each starts at a request the user typed.
function turns(entries) {
  const out = [];
  let cur = null;
  const results = new Map(); // tool_use id -> result text
  for (const e of entries) {
    if (e.type === 'system' && e.subtype === 'compact_boundary') { cur?.items.push({ kind: 'note', text: '[conversation compacted here]' }); continue; }
    const c = e.message?.content;
    if (e.type === 'user') {
      if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || (x.type === 'image' ? '[image]' : '')).join('\n');
        results.set(b.tool_use_id, { text, error: !!b.is_error });
      }
      if (e.isMeta) continue;
      const p = e.isCompactSummary ? null : promptText(c);
      if (!p) continue;
      cur = { n: out.length + 1, at: Date.parse(e.timestamp) || 0, prompt: p, items: [] };
      out.push(cur);
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      if (!cur) { cur = { n: 1, at: Date.parse(e.timestamp) || 0, prompt: '(no request)', items: [] }; out.push(cur); }
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) cur.items.push({ kind: 'text', text: b.text.trim() });
        else if (b.type === 'tool_use') cur.items.push({ kind: 'tool', name: b.name, input: b.input, id: b.id });
      }
      cur.end = Date.parse(e.timestamp) || cur.end;
    }
  }
  for (const t of out) for (const it of t.items) if (it.kind === 'tool') it.result = results.get(it.id);
  return out;
}

function toolLine(it) {
  const i = it.input || {};
  const arg = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.skill ?? (Object.keys(i).length ? JSON.stringify(i) : '');
  return `${it.name}(${oneLine(arg, 160)})`;
}

// An edit's text in short, for the brief view: its first lines, each clipped.
function diffLines(s, sign, max = 4) {
  const ls = String(s ?? '').split('\n');
  const shown = ls.slice(0, max).map((l) => `      ${sign} ${oneLine(l, 140)}`);
  if (ls.length > max) shown.push(`      ${sign} … ${ls.length - max} more lines`);
  return shown.join('\n');
}

function render(t, tools) {
  const out = [`## Turn ${t.n} · ${stamp(t.at)}`, '', `USER: ${t.prompt}`, ''];
  for (const it of t.items) {
    if (it.kind === 'note') out.push(it.text, '');
    else if (it.kind === 'text') out.push(`ASSISTANT: ${it.text}`, '');
    else if (tools === 'brief') {
      out.push(`  · ${toolLine(it)}${it.result?.error ? '  [error]' : ''}`);
      for (const ed of it.input?.edits || (it.input?.old_string != null ? [it.input] : [])) out.push(diffLines(ed.old_string, '-'), diffLines(ed.new_string, '+'));
    }
    else if (tools === 'full') {
      out.push(`  · ${it.name} ${JSON.stringify(it.input)}`);
      if (it.result) out.push(clip(it.result.text, 4000).replace(/^/gm, '    | '));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function die(msg) { process.stderr.write(msg + '\n'); process.exit(1); }

function flag(args, name, dflt) {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'list') {
  const limit = Number(flag(args, '--limit', 20));
  const q = (args[0] || '').toLowerCase();
  const ui = uiTitles();
  const rows = [];
  for (const t of transcripts().sort((a, b) => b.mtime - a.mtime)) {
    const m = peekMeta(t.file, t.size);
    if (!m.first && !m.title) continue; // nothing was ever said in it
    const title = ui.get(t.id)?.title || m.title || m.first;
    const cwd = m.cwd || ui.get(t.id)?.cwd || '?';
    if (q && ![t.id, cwd, title, m.first].some((x) => String(x || '').toLowerCase().includes(q))) continue;
    rows.push(`${t.id}  ${ago(t.mtime).padEnd(8)} ${(m.entry === 'cli' ? 'terminal' : 'IroWell').padEnd(8)} ${cwd}\n    ${oneLine(title, 110)}${t.id === SELF ? '   ← this session' : ''}`);
    if (rows.length >= limit) break;
  }
  console.log(rows.length ? rows.join('\n') : 'No sessions match.');
} else if (cmd === 'outline') {
  const t = resolve(args[0]);
  const all = conversation(t);
  console.log(`${t.id} · ${all.length} turns · last written ${stamp(t.mtime)} (${ago(t.mtime)})\n`);
  for (const x of all) {
    const tools = x.items.filter((i) => i.kind === 'tool').length;
    const answer = x.items.filter((i) => i.kind === 'text').at(-1)?.text;
    console.log(`#${x.n}  ${stamp(x.at)}  ${oneLine(x.prompt, 120)}${tools ? `  [${tools} tools]` : ''}${answer ? `\n      → ${oneLine(answer, 140)}` : ''}`);
  }
} else if (cmd === 'show') {
  const tools = flag(args, '--tools', 'brief');
  const range = flag(args, '--turns');
  const lastN = Number(flag(args, '--last', 3));
  const t = resolve(args[0]);
  const all = conversation(t);
  let pick;
  if (range) {
    const [a, b = a] = range.split('-').map(Number);
    pick = all.filter((x) => x.n >= a && x.n <= b);
  } else pick = all.slice(-lastN);
  console.log(`${t.id} · turns ${pick[0]?.n ?? '-'}–${pick.at(-1)?.n ?? '-'} of ${all.length} · last written ${stamp(t.mtime)} (${ago(t.mtime)})\n`);
  console.log(pick.map((x) => render(x, tools)).join('\n\n'));
} else if (cmd === 'grep') {
  const t = resolve(args[0]);
  if (!args[1]) die('Give a regex to search for');
  const re = new RegExp(args[1], 'i');
  let hits = 0;
  for (const x of conversation(t)) {
    const lines = render(x, 'full').split('\n').filter((l) => re.test(l));
    for (const l of lines) { console.log(`#${x.n}  ${oneLine(l, 240)}`); if (++hits >= 200) process.exit(0); }
  }
  if (!hits) console.log('No matches.');
} else {
  die('Usage: sessions.mjs list [filter] [--limit N] | outline <id> | show <id> [--turns A-B | --last N] [--tools none|brief|full] | grep <id> <regex>');
}
