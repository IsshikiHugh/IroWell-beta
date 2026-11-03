// ---- forward mode: one session's conversation goes on in a Slack thread, as it is (no agent in between) ----
// Turned on and off per session (the page: send held for a second; Slack: the Exit button), by Claude session id.
// Turning it on posts one message in the user's DM (the session's ID and title, Exit); everything goes into its thread:
//   - what Claude writes for the user: the `:::reply` and `:::ask[n]` parts of its texts (skills/system-prompt.md,
//     item 4; text with no marker counts as a reply), `:::log` left out, in Slack's own markup (toSlack). Images,
//     videos and PDFs it links to are uploaded after the text.
//   - while the main session works, one last message says so (⏳, with Stop); what comes next is written into it,
//     and a new one follows if the turn goes on. A turn that leaves nothing for the user takes it away again.
//   - what waits on the user (a tool permission, a question, a plan), with buttons; once settled, it says how.
//   - a turn that stops on an error or a limit: one line.
// What the user writes in the thread goes to the session as their message; while a request waits, it answers that
// request (a question: `1a 2b` or their own words; a tool permission or a plan: denied, with their words). Nothing
// else on Slack reaches it: a message outside the thread, or in the thread of one that has ended, is ignored.
// The session itself runs as it did (its permission mode, no time limits). A session forwarded is never watched by
// away mode (./away.mjs), and the other way round. Detached, archived or exited: forwarding ends.
// It shares away mode's Slack connection (`link`), and runs in the main daemon only, like away mode.
import fs from 'node:fs';
import path from 'node:path';
import { slackText } from './slack.mjs';

// ---- what Claude wrote, for Slack ----
// A text's parts by what they are for, as the page splits them (client/ui/render.js, roleParts): a line `:::log`,
// `:::reply` or `:::ask[n]` opens one, a line `:::` closes it; markers inside a code fence are text.
const ROLE_OPEN = /^ {0,3}:::[ \t]*(log|reply|ask(?:\[[ \t]*(\d{1,3})[ \t]*\])?)[ \t]*$/, ROLE_CLOSE = /^ {0,3}:::[ \t]*$/;
export function roleParts(text) {
  const lines = String(text || '').split('\n'), parts = [];
  let kind = '', n = '', from = 0, fence = '';
  const flush = (to) => { const t = lines.slice(from, to).join('\n'); if (t.trim()) parts.push({ kind, n, text: t }); from = to + 1; };
  lines.forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !f[2].trim()) fence = ''; return; }
    if (f) { fence = f[1]; return; }
    const open = ROLE_OPEN.exec(line);
    if (open || ROLE_CLOSE.test(line)) { flush(i); kind = open ? open[1].replace(/\[.*/, '') : ''; n = open?.[2] ? String(+open[2]) : ''; }
  });
  flush(lines.length);
  return parts;
}

// What is uploaded when Claude links to it (at most UPLOAD_MAX): a picture, a video, a PDF.
const UPLOAD = /\.(png|jpe?g|gif|webp|mp4|mov|pdf)$/i;
const UPLOAD_MAX = 50 * 1024 * 1024;
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A column's width as a fixed-width font shows it (CJK and full-width forms take two).
const width = (t) => [...t].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0);
const cellsOf = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const plain = (t) => t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2').replace(/`([^`]*)`/g, '$1');

// One line of Markdown (outside code blocks) in Slack's markup; `files`: the local files it links to are added.
function inline(line, files) {
  const keep = []; // (links and code, as they are: kept out of the escaping and the emphasis)
  const hold = (t) => `\u0000${keep.push(t) - 1}\u0000`;
  let t = line.replace(/`([^`\n]+)`/g, (_, c) => hold('`' + esc(c) + '`'));
  t = t.replace(/!?\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, text, url) => {
    if (/^(https?:|mailto:)/i.test(url)) return hold(`<${url.replace(/\|/g, '%7C')}|${esc(text.replace(/\|/g, '/')) || esc(url)}>`);
    const local = /^(~?\/[^:]*?)(?::(\d+(?:-\d+)?))?$/.exec(url);
    if (!local) return esc(text);
    const file = local[1], name = path.basename(file) + (local[2] ? `:${local[2]}` : '');
    if (!local[2] && UPLOAD.test(file)) files.push(file);
    const label = text.trim();
    return hold(!label || label === name || label === file || label.endsWith('/' + name) ? '`' + esc(name) + '`' : `${esc(label)} (\`${esc(name)}\`)`);
  });
  t = esc(t);
  const h = /^#{1,6}\s+(.*?)\s*#*$/.exec(t);
  if (h) return `*${plain(h[1]).replace(/\*/g, '')}*`.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
  t = t.replace(/^(\s*)[-*+]\s+(?=\S)/, '$1• ').replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '──────');
  t = t.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/g, (_, a, b) => `\u0001${a ?? b}\u0001`)
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '$1_$2_')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '~$1~')
    .replace(/\u0001/g, '*');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[i]);
}

// Markdown in Slack's markup: code blocks stay (a diagram is not shown), a table becomes an aligned block, the rest
// line by line (inline).
function mdToSlack(md, files) {
  const lines = md.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(lines[i]);
    if (f) {
      const body = [];
      for (i++; i < lines.length && !(lines[i].trim().startsWith(f[1]) && !lines[i].trim().slice(f[1].length).trim()); i++) body.push(lines[i]);
      out.push(f[2].toLowerCase() === 'mermaid' ? '_(diagram: open in IroWell)_' : '```\n' + esc(body.join('\n')) + '\n```');
      continue;
    }
    if (lines[i].trim().startsWith('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('-')) {
      const rows = [cellsOf(lines[i])];
      for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cellsOf(lines[i]));
      i--;
      const cells = rows.map((r) => r.map(plain));
      const w = cells[0].map((_, c) => Math.max(...cells.map((r) => width(r[c] || ''))));
      out.push('```\n' + esc(cells.map((r) => r.map((x, c) => (x || '') + ' '.repeat(Math.max(0, w[c] - width(x || '')))).join('  ').trimEnd()).join('\n')) + '\n```');
      continue;
    }
    out.push(inline(lines[i], files));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// What of a text of Claude's goes to Slack: its replies and questions, in Slack's markup (empty: nothing), and the
// files to upload after it.
export function toSlack(text) {
  const files = [], out = [];
  for (const p of roleParts(text)) {
    if (p.kind === 'log') continue;
    const body = mdToSlack(p.text.trim(), files).trim();
    if (!body) continue;
    out.push(p.kind === 'ask' ? `🙋 *${p.n ? `${p.n}.` : ''}*\n${body.split('\n').map((l) => `> ${l}`).join('\n')}`.replace('🙋 **\n', '🙋\n') : body);
  }
  return { text: out.join('\n\n'), files: [...new Set(files)] };
}

// A long text in messages Slack takes (a section holds 3000 characters): cut between paragraphs, never inside a code block.
export function chunks(text, n = 2900) {
  const paras = [];
  for (const p of text.split('\n\n')) {
    const last = paras.length - 1;
    if (last >= 0 && (paras[last].match(/```/g) || []).length % 2) paras[last] += '\n\n' + p; else paras.push(p);
  }
  const out = [''];
  const add = (p, sep) => {
    if (out.at(-1) && out.at(-1).length + sep.length + p.length > n) out.push('');
    out[out.length - 1] += (out.at(-1) ? sep : '') + p;
  };
  for (const p of paras) {
    if (p.length <= n) { add(p, '\n\n'); continue; }
    add('', '\n\n');
    for (const l of p.split('\n')) for (let i = 0; i < Math.max(1, l.length); i += n) add(l.slice(i, i + n), '\n');
  }
  return out.map((x) => x.trim()).filter(Boolean);
}

// What the user wrote on Slack, as plain text: links as their text (and address), names, Slack's escapes undone.
export function fromSlack(t) {
  return String(t || '')
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_, url, label) => (url.replace(/^(https?:\/\/|mailto:)/, '').replace(/\/$/, '') === label ? url : `${label} (${url})`))
    .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
    .replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, name) => `@${name || id}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
// A question's answer from what the user wrote: { answers } (the question -> its answer, as the page gives it: labels
// joined with ", ", or the user's own words), or { error }. One question: a letter, an option's label, or their own
// words. Several: `1a 2b`, one of them in the user's own words (`2 use sqlite`); each must be answered.
export function parseAnswers(questions, text) {
  const qs = Array.isArray(questions) ? questions : [];
  const t = String(text || '').trim();
  const pick = (q, v) => {
    v = v.trim().replace(/[,;。，；]+$/, '').trim();
    if (!v) return null;
    const opts = q.options || [];
    const letters = /^[a-z](?:\s*[,，+&]?\s*[a-z])*$/i.test(v) ? v.toLowerCase().replace(/[^a-z]/g, '').split('') : null;
    if (letters && letters.every((l) => LETTERS.indexOf(l) < opts.length) && (q.multiSelect || letters.length === 1)) return [...new Set(letters)].map((l) => opts[LETTERS.indexOf(l)].label).join(', ');
    const same = opts.find((o) => o.label.toLowerCase() === v.toLowerCase());
    return same ? same.label : v;
  };
  if (qs.length === 1) {
    const one = pick(qs[0], t.replace(/^1\s*[.):：]?\s*(?=\S)/, (m) => (/^1\s*[.):：]?\s*[a-z]\b/i.test(t) || /^1\s*[.):：]/.test(t) ? '' : m)));
    return one ? { answers: { [qs[0].question]: one } } : { error: 'empty' };
  }
  // the numbers that begin an answer: 1..n, in order, at the start or after a space (or , ;)
  const marks = [];
  const re = /(^|[\s,;，；])(\d{1,2})(?=\s*[.):：]?\s*\S)/g;
  let m, next = 1;
  while ((m = re.exec(t))) {
    const k = Number(m[2]);
    if (k === next && k <= qs.length) { marks.push({ k, at: m.index + m[1].length, body: m.index + m[0].length }); next++; }
  }
  if (marks.length !== qs.length) return { error: `Answer each of the ${qs.length} questions, e.g. \`1a 2b\`` };
  const answers = {};
  for (let i = 0; i < marks.length; i++) {
    const v = t.slice(marks[i].body, i + 1 < marks.length ? marks[i + 1].at : undefined).replace(/^\s*[.):：]?\s*/, '');
    const a = pick(qs[i], v);
    if (!a) return { error: `Answer each of the ${qs.length} questions, e.g. \`1a 2b\`` };
    answers[qs[i].question] = a;
  }
  return { answers };
}

export function createForward({ DIR, log, events, call, partial, retiring, link }) {
  const FILE = path.join(DIR, 'away', 'forward.json');
  const read = () => { try { const v = JSON.parse(fs.readFileSync(FILE, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  // { sessions: { <cid>: { uid, since, title, root: { channel, ts }, ph: the last message (⏳) or null, reqs: { <rid>: { ts, body } } } } }
  const state = { sessions: {}, ...read() };
  if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};
  const acting = () => !retiring();
  function save() {
    if (!acting()) return; // (a retiring daemon leaves the file to the new one)
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch (e) { log('forward: cannot save its state', e.message); }
  }
  const later = (fn) => setImmediate(() => { try { fn(); } catch (e) { log('forward', e); } });
  // ---- what the event log says of each row (sid): { cid, title, state, closed }; and the requests waiting ----
  const rows = new Map();
  const rowOf = (sid) => rows.get(sid) || rows.set(sid, { cid: null, title: '', state: '', closed: false }).get(sid);
  const liveRow = (cid) => { let at = null; for (const [sid, r] of rows) if (r.cid === cid && !r.closed) at = sid; return at; };
  const open = new Map(); // rid -> { sid, rid, tool, input, kind, title, description }
  const on = (cid) => (cid && state.sessions[cid]) || null;
  const said = new Map(); // rid -> the words the user denied it with (for its message)

  // ---- Slack: one queue per session, so what is posted keeps its order; it waits while Slack can't be reached ----
  const queues = new Map(); // cid -> { items, busy, lost }
  const DAY = 24 * 3600 * 1000;
  const NETWORK = /fetch failed|HTTP 5\d\d|aborted|timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|ratelimited/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
  function enqueue(cid, item) {
    const q = queues.get(cid) || queues.set(cid, { items: [], busy: null, lost: 0 }).get(cid);
    item.f ||= state.sessions[cid]; // (what it goes into: kept for what is still queued once forwarding ends)
    if (!item.f?.root) return;
    // (an edit of a message whose earlier edit has not gone yet replaces it: a backlog is short)
    if (item.op === 'edit') {
      const was = q.items.find((x) => x !== q.busy && x.op === 'edit' && x.slot === item.slot);
      if (was) { Object.assign(was, item, { at: was.at }); return; }
    }
    q.items.push({ ...item, at: Date.now() });
    pump(cid, q);
  }
  async function pump(cid, q) {
    if (q.busy) return;
    while (q.items.length) {
      const it = q.items[0];
      q.busy = it;
      const f = it.f;
      let wait = 1000;
      for (;;) {
        if (Date.now() - it.at > DAY) { q.lost++; break; }
        const s = link.now();
        if (!s || !acting()) { await sleep(2000); continue; }
        try {
          await run(s, f, it);
          if (q.lost && f?.root) {
            const n = q.lost;
            q.lost = 0;
            await s.web('chat.postMessage', { channel: f.root.channel, thread_ts: f.root.ts, text: `_(${n} update${n > 1 ? 's' : ''} lost while Slack was unreachable)_` }).catch(() => {});
          }
          break;
        } catch (e) {
          if (!NETWORK.test(e.message)) { log('forward: slack', it.op, e.message); break; }
          await sleep(wait);
          wait = Math.min(30_000, wait * 2);
        }
      }
      q.items.shift();
    }
    q.busy = null;
  }
  const section = (text, buttons) => [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } }, ...(buttons?.length ? [{ type: 'actions', elements: buttons }] : [])];
  async function run(s, f, it) {
    const channel = f.root.channel;
    if (it.op === 'post') {
      const m = await s.web('chat.postMessage', { channel, thread_ts: f.root.ts, text: it.text, blocks: section(it.text, it.buttons), unfurl_links: false, unfurl_media: false });
      if (it.slot) { it.slot.ts = m.ts; save(); }
    } else if (it.op === 'edit') {
      if (!it.slot?.ts) return;
      await s.web('chat.update', { channel, ts: it.slot.ts, text: it.text, blocks: section(it.text, it.buttons) });
    } else if (it.op === 'delete') {
      if (it.slot?.ts) await s.web('chat.delete', { channel, ts: it.slot.ts });
    } else if (it.op === 'upload') {
      let st;
      try { st = fs.statSync(it.file); } catch { return; }
      if (!st.isFile() || st.size > UPLOAD_MAX || !st.size) return;
      await s.upload({ channel, thread_ts: f.root.ts, file: it.file, name: path.basename(it.file), size: st.size });
    } else if (it.op === 'react') {
      await s.web('reactions.add', { channel: it.channel, timestamp: it.ts, name: it.name }).catch((e) => { if (!/already_reacted/.test(e.message)) throw e; });
    } else if (it.op === 'say') {
      await s.web('chat.postMessage', { channel, thread_ts: f.root.ts, text: it.text, unfurl_links: false });
    }
  }
  const post = (cid, text, buttons) => { const slot = { ts: null }; enqueue(cid, { op: 'post', slot, text, buttons }); return slot; };
  const edit = (cid, slot, text, buttons) => slot && enqueue(cid, { op: 'edit', slot, text, buttons });

  // ---- how things read on Slack ----
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const span = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`; };
  const at = (t) => `<!date^${Math.floor(t / 1000)}^{time}|${hhmm(t)}>`;
  const atDay = (t) => `<!date^${Math.floor(t / 1000)}^{date_short_pretty} {time}|${hhmm(t)}>`;
  const short = (t) => { t = String(t || '').split('\n')[0].trim(); return t.length > 60 ? t.slice(0, 59) + '…' : t; };
  const titleOf = (cid) => { const sid = liveRow(cid); return (sid ? rows.get(sid) : [...rows.values()].find((r) => r.cid === cid))?.title || state.sessions[cid]?.title || 'A session'; };
  const button = (text, action_id, value, style) => ({ type: 'button', action_id, text: { type: 'plain_text', text: text.slice(0, 75) }, value: JSON.stringify(value).slice(0, 1900), ...(style ? { style } : {}) });
  const rootText = (cid, f, until) => `${until ? '' : '📨 '}\`${f.uid}\` *${slackText(short(titleOf(cid)))}*\n\n`
    + (until ? `_Forwarded ${atDay(f.since)} – ${at(until)} (${span(until - f.since)})_` : `_Forwarding since ${atDay(f.since)} · reply in this thread_`);
  const rootButtons = (cid) => [button('Exit', 'fwd_exit', { cid })];
  const workingText = (t) => `⏳ Working… · since ${at(t)}`;
  // A request's message, and its buttons.
  function requestText(a) {
    const i = a.input || {};
    if (a.kind === 'question') {
      const qs = i.questions || [];
      const many = qs.length > 1;
      const body = qs.map((q, n) => `*${many ? `${n + 1}. ` : ''}${slackText(q.question, 500)}*${q.multiSelect ? ' _(one or more)_' : ''}\n`
        + (q.options || []).map((o, k) => `${LETTERS[k]}. ${slackText(o.label, 150)}${o.description ? ` — _${slackText(o.description, 300)}_` : ''}`).join('\n')).join('\n\n');
      const how = many ? 'Or reply `1a 2b`; your own words for one: `2 …`' : 'Or reply with a letter, or your own answer';
      return `🙋 ${body}\n\n_${how}._`;
    }
    if (a.kind === 'plan') return `🙋 *Plan*\n\`\`\`\n${slackText(i.plan, 2400)}\n\`\`\`\n_Or reply with what to change._`;
    const one = i.command || i.file_path || i.notebook_path || i.url || i.pattern;
    return `🙋 *${slackText(a.tool, 80)}*${one ? ` \`${slackText(String(one).replace(/`/g, "'"), 600)}\`` : ''}${a.description ? `\n${slackText(a.description, 300)}` : ''}`
      + '\n\n_Or reply with what Claude should do instead (that denies it)._';
  }
  function requestButtons(a) {
    const qs = a.input?.questions || [];
    if (a.kind === 'tool') return [button('Allow', 'fwd_allow', { rid: a.rid }, 'primary'), button('Deny', 'fwd_deny', { rid: a.rid }, 'danger')];
    if (a.kind === 'plan') return [button('Approve the plan', 'fwd_allow', { rid: a.rid }, 'primary'), button('Keep planning', 'fwd_deny', { rid: a.rid })];
    if (qs.length === 1 && !qs[0].multiSelect) return [...(qs[0].options || []).slice(0, 20).map((o, n) => button(o.label, `fwd_answer_${n}`, { rid: a.rid, q: qs[0].question, l: o.label })), button('Skip', 'fwd_deny', { rid: a.rid })];
    return [button('Skip', 'fwd_deny', { rid: a.rid })];
  }
  const settledText = (a, e, words) => (e.allow ? (e.answers ? `✅ Answered: ${slackText(Object.values(e.answers).join('; '), 400)}` : a?.kind === 'plan' ? '✅ Plan approved.' : '✅ Allowed.')
    : words ? `✋ ${a?.kind === 'plan' ? 'Keep planning' : a?.kind === 'question' ? 'Skipped' : 'Denied'}: “${slackText(words, 400)}”`
    : a?.kind === 'plan' ? '✋ Keep planning.' : a?.kind === 'question' ? '✋ Skipped.' : '✋ Denied.');

  // ---- the conversation, as it goes ----
  // The main session works: the last message says so (posted if there is none).
  function working(cid) {
    const f = on(cid);
    if (!f || f.ph || !acting()) return;
    f.phAt = Date.now();
    f.ph = post(cid, workingText(f.phAt), [button('Stop', 'fwd_stop', { cid })]);
    save();
  }
  // Something for the user: written into the last message (⏳) when there is one, else posted.
  function put(cid, text, buttons) {
    const f = on(cid);
    if (!f) return null;
    let slot;
    if (f.ph) { slot = f.ph; edit(cid, slot, text, buttons); f.ph = null; } else slot = post(cid, text, buttons);
    save();
    return slot;
  }
  function claudeSaid(cid, text) {
    const { text: t, files } = toSlack(text);
    if (!t.trim()) return;
    const parts = chunks(t);
    put(cid, parts[0]);
    for (const p of parts.slice(1)) post(cid, p);
    for (const file of files) enqueue(cid, { op: 'upload', file: file.replace(/^~(?=\/)/, process.env.HOME || '~') });
  }
  function request(rid) {
    const a = open.get(rid);
    const cid = a && rows.get(a.sid)?.cid;
    const f = on(cid);
    if (!f || f.reqs[rid]) return;
    const body = requestText(a);
    f.reqs[rid] = { body, slot: put(cid, body, requestButtons(a)) };
    save();
  }
  function settled(a, e) {
    const cid = rows.get(a?.sid)?.cid;
    const f = on(cid);
    const r = f?.reqs[e.rid];
    if (!r) return;
    delete f.reqs[e.rid];
    edit(cid, r.slot, `${r.body}\n\n${settledText(a, e, said.get(e.rid))}`);
    said.delete(e.rid);
    save();
  }
  // A line about how the turn stopped, in the last message (or posted).
  function trouble(cid, text) {
    const f = on(cid);
    if (!f) return;
    put(cid, text);
    f.trouble = true;
    save();
  }
  function turnEnded(cid, end) {
    const f = on(cid);
    if (!f) return;
    const sub = end.msg.subtype;
    if (sub === 'success' || f.trouble) { if (f.ph) { enqueue(cid, { op: 'delete', slot: f.ph }); f.ph = null; } }
    else put(cid, `⚠️ Stopped: ${sub === 'error_max_turns' ? 'the turn limit was reached' : sub === 'error_max_budget_usd' ? 'the budget was used up' : 'an error'}${end.msg.result ? ` · ${slackText(String(end.msg.result), 300)}` : ''}`);
    f.trouble = false;
    save();
  }
  // The text of a turn's last answer (the main session's), before the event `end`.
  const lastText = (sid, before = Infinity) => {
    const evs = events.filter((e) => e.sid === sid && e.seq < before && e.kind === 'msg' && e.msg.type === 'assistant' && !e.msg.parent_tool_use_id);
    for (let i = evs.length - 1; i >= 0; i--) { const b = (evs[i].msg.message?.content || []).filter((x) => x.type === 'text'); if (b.length) return b.map((x) => x.text).join('\n'); }
    return '';
  };

  // ---- every event the UI sees comes here too (`replay`: one of the past, logged again: read, never acted on) ----
  function tap(e, replay = false) {
    const r = rowOf(e.sid);
    const live = !replay && acting();
    switch (e.kind) {
      case 'created': Object.assign(r, { cid: e.claudeSessionId || r.cid, title: e.title || r.title, closed: false }); break;
      case 'init': r.cid = e.claudeSessionId || r.cid; break;
      case 'meta':
        if ('title' in e && e.title && e.title !== r.title) {
          r.title = e.title;
          const f = on(r.cid);
          if (f && live) { f.title = e.title; edit(r.cid, f.root, rootText(r.cid, f), rootButtons(r.cid)); save(); }
        }
        break;
      case 'state':
        r.state = e.state;
        if (e.state === 'ended') r.closed = true;
        if (live && on(r.cid)) {
          if (e.state === 'running') later(() => working(r.cid));
          // (a turn that ended with no result: its last message goes)
          else if (e.state === 'idle' || e.state === 'ended') later(() => { const f = on(r.cid); if (f?.ph && rows.get(e.sid)?.state !== 'running') { enqueue(r.cid, { op: 'delete', slot: f.ph }); f.ph = null; save(); } });
        }
        break;
      case 'closed':
        r.closed = true;
        // (detached, or its daemon gone; an update's handover runs it on under the same sid: that is not an end)
        if (live && on(r.cid)) { const cid = r.cid; setTimeout(() => { if (on(cid) && !liveRow(cid)) stop(cid); }, 3000).unref?.(); }
        break;
      case 'archived':
        rows.delete(e.sid);
        if (live && on(r.cid)) stop(r.cid);
        break;
      case 'approval': {
        const kind = e.tool === 'AskUserQuestion' ? 'question' : e.tool === 'ExitPlanMode' ? 'plan' : 'tool';
        open.set(e.rid, { sid: e.sid, rid: e.rid, tool: e.tool, input: e.input, kind, title: e.title, description: e.description });
        if (live && on(r.cid)) later(() => request(e.rid));
        break;
      }
      case 'approval_done': {
        const a = open.get(e.rid);
        open.delete(e.rid);
        if (live && a) later(() => settled(a, e));
        break;
      }
      case 'msg': {
        if (!live || !on(r.cid) || e.msg.parent_tool_use_id) break;
        const m = e.msg;
        if (m.type === 'assistant') {
          const blocks = m.message?.content || [];
          const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          if (text.trim()) claudeSaid(r.cid, text);
          if (blocks.some((b) => b.type === 'tool_use') && r.state === 'running') working(r.cid);
        } else if (m.type === 'user' && r.state === 'running') working(r.cid); // (a tool's result: the turn goes on)
        else if (m.type === 'result') turnEnded(r.cid, e);
        break;
      }
      case 'error':
        if (live && on(r.cid)) trouble(r.cid, `⚠️ ${slackText(String(e.text || 'Something went wrong').slice(0, 600))}`);
        break;
      case 'limit':
        if (live && on(r.cid) && e.status === 'rejected') {
          const t = e.resetsAt && (e.resetsAt < 1e12 ? e.resetsAt * 1000 : e.resetsAt);
          trouble(r.cid, `⚠️ Stopped: rate limited${t ? ` until ${atDay(t)}` : ''}`);
        }
        break;
    }
  }

  // ---- on and off ----
  const newUid = () => {
    const taken = new Set(Object.values(state.sessions).map((f) => f.uid));
    for (;;) {
      const u = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
      if (!taken.has(u)) return u;
    }
  };
  let starting = 0; // (forwardStart waiting for Slack: the connection is wanted meanwhile)
  async function start(sid) {
    const r = rows.get(sid);
    if (!r || r.closed) throw new Error('The session is not running: reattach it first');
    const cid = r.cid;
    if (!cid) throw new Error('The session has not started yet: send it a message first');
    if (state.sessions[cid]) return view();
    if (!link.set()) throw Object.assign(new Error('Set up Slack first (Settings → Slack)'), { code: 'slack-not-set' });
    starting++;
    let s;
    try {
      link.sync();
      const t0 = Date.now();
      while (!(s = link.now())?.status.connected && Date.now() - t0 < 10_000) {
        if (s?.status.error) break;
        await sleep(200);
      }
      if (!s?.status.connected) throw new Error(`Slack: ${s?.status.error || 'could not connect'}`);
      const f = { uid: newUid(), since: Date.now(), title: r.title, root: null, ph: null, reqs: {} };
      const channel = await link.dm(s);
      const m = await s.web('chat.postMessage', { channel, text: rootText(cid, f), blocks: section(rootText(cid, f), rootButtons(cid)), unfurl_links: false });
      f.root = { channel, ts: m.ts };
      if (state.sessions[cid]) return view(); // (started twice at once)
      state.sessions[cid] = f;
      Promise.resolve(link.release(cid)).catch((e) => log('forward: away mode kept it', e.message)); // (away mode watches it no more)
    } finally { starting--; }
    save();
    // What waits on the user already: the last answer when it asks something, the requests open, the work going on.
    const busy = r.state === 'running' || r.state === 'waiting';
    if (!busy) { const t = lastText(sid); if (roleParts(t).some((p) => p.kind === 'ask')) claudeSaid(cid, t); }
    for (const a of open.values()) if (rows.get(a.sid)?.cid === cid) request(a.rid);
    if (r.state === 'running') working(cid);
    changed();
    return view();
  }
  // Forwarding ends: its message says when it ran; what still waits there loses its buttons.
  function stop(cid) {
    const f = state.sessions[cid];
    if (!f) return;
    const until = Date.now();
    if (f.ph) enqueue(cid, { op: 'delete', slot: f.ph });
    for (const r of Object.values(f.reqs)) enqueue(cid, { op: 'edit', slot: r.slot, text: `${r.body}\n\n_Forwarding ended: answer it in IroWell._`, f });
    enqueue(cid, { op: 'edit', slot: f.root, text: rootText(cid, f, until), buttons: [], f });
    delete state.sessions[cid];
    save();
    changed();
  }

  // ---- from Slack ----
  const rootOf = (ts) => Object.keys(state.sessions).find((cid) => state.sessions[cid].root?.ts === ts) || null;
  // A message in the DM: one in a forwarded session's thread is handled here (true); anything else is not.
  function heard(e, user) {
    const cid = e.thread_ts && rootOf(e.thread_ts);
    if (!cid) return false;
    if (e.user !== user || e.bot_id || (e.subtype && e.subtype !== 'thread_broadcast' && e.subtype !== 'file_share')) return true;
    const text = fromSlack(e.text);
    if (!text) return true;
    later(() => fromUser(cid, text, e).catch((err) => { log('forward: from slack', err.message); enqueue(cid, { op: 'say', text: `⚠️ Not delivered: ${slackText(err.message, 300)}` }); }));
    return true;
  }
  async function fromUser(cid, text, e) {
    const sid = liveRow(cid);
    if (!sid) throw new Error('the session is not running');
    const a = [...open.values()].find((x) => rows.get(x.sid)?.cid === cid);
    if (a?.kind === 'question') {
      const p = parseAnswers(a.input?.questions, text);
      if (p.error) { enqueue(cid, { op: 'say', text: `_${p.error === 'empty' ? 'Reply with a letter, or your own answer.' : p.error}_` }); return; }
      await call({ type: 'approve', sid: a.sid, rid: a.rid, allow: true, answers: p.answers });
    } else if (a) {
      said.set(a.rid, text);
      await call({ type: 'approve', sid: a.sid, rid: a.rid, allow: false, message: `The user said (on Slack): ${text}` });
    } else await call({ type: 'send', sid, text, via: 'slack' });
    enqueue(cid, { op: 'react', channel: e.channel, ts: e.ts, name: 'eyes' });
  }
  // A click on one of forward mode's buttons (true), or on someone else's (false).
  function clicked(p, user) {
    const acts = (p.actions || []).filter((x) => String(x.action_id).startsWith('fwd_'));
    if (!acts.length) return false;
    if (p.user?.id !== user) return true;
    for (const act of acts) {
      let v;
      try { v = JSON.parse(act.value); } catch { continue; }
      if (act.action_id === 'fwd_exit') { if (on(v?.cid)) stop(v.cid); continue; }
      if (act.action_id === 'fwd_stop') {
        const f = on(v?.cid), sid = liveRow(v?.cid);
        if (!f || !sid) continue;
        if (f.ph) { edit(v.cid, f.ph, '✋ Stopped (by you)'); f.ph = null; f.trouble = true; save(); }
        call({ type: 'interrupt', sid }).catch((e) => log('forward: stop', e.message));
        continue;
      }
      const a = open.get(v?.rid);
      if (!a || !on(rows.get(a.sid)?.cid)) continue;
      const allow = act.action_id !== 'fwd_deny';
      const answers = act.action_id.startsWith('fwd_answer') ? { [v.q]: v.l } : undefined;
      call({ type: 'approve', sid: a.sid, rid: a.rid, allow, ...(answers ? { answers } : {}) }).catch((e) => log('forward: approve', e.message));
    }
    return true;
  }

  // ---- what the pages are told ----
  function view() {
    const s = link.now();
    return { sessions: Object.entries(state.sessions).map(([cid, f]) => ({ cid, sid: liveRow(cid), uid: f.uid, since: f.since })),
      slack: { set: !!link.set(), connected: !!s?.status.connected, error: s?.status.error || '' } };
  }
  function changed() { partial('', { op: 'forward', forward: view() }); }
  const handlers = {
    forwardState() { return view(); },
    forwardStart(c, { sid }) { return start(sid); },
    forwardStop(c, { cid, sid }) { stop(cid || rows.get(sid)?.cid); return view(); },
  };
  return {
    tap, handlers, heard, clicked, changed,
    stop: (cid) => { if (state.sessions[cid]) stop(cid); },
    has: (cid) => !!state.sessions[cid],
    // (the Slack connection is wanted while a session is forwarded, or one is being, or what was is still being posted)
    wants: () => acting() && (starting > 0 || Object.keys(state.sessions).length > 0 || [...queues.values()].some((q) => q.items.length)),
  };
}
