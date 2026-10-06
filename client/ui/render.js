// Rendering helpers: Markdown + LaTeX, code highlighting, diffs, tool cards.
import { Marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/purify/purify.es.mjs';
import katex from '/vendor/katex/katex.mjs';
import hljs from '/vendor/hljs/es/highlight.min.js';
import { structuredPatch } from '/vendor/diff/index.js';

export function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- Markdown + math

function tex(src, display) {
  try {
    return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
  } catch {
    return `<code>${esc(src)}</code>`;
  }
}

// $$…$$ and \[…\] on their own lines; $…$, \(…\) and inline $$…$$ inside text.
const mathBlock = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => src.match(/^ {0,3}(\$\$|\\\[)/m)?.index,
  tokenizer(src) {
    const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/.exec(src);
    if (m) return { type: 'mathBlock', raw: m[0], text: (m[1] ?? m[2]).trim() };
  },
  renderer: (t) => `<div class="math-block">${tex(t.text, true)}</div>`,
};
const mathInline = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => src.match(/\$|\\\(/)?.index,
  tokenizer(src) {
    let m = /^\$\$([^$]+?)\$\$/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: true };
    // Pandoc rule: no space just inside the $…$, no digit right after the closing $ ("$5 and $6" is money),
    // and never across a backtick (that would swallow an inline code span).
    m = /^\$(?![\s$])((?:\\.|[^\\$\n`])+?)(?<!\s)\$(?!\d)/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1], display: false };
    m = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1].trim(), display: false };
  },
  renderer: (t) => tex(t.text, t.display),
};

export function highlight(code, lang) {
  const l = (lang || '').toLowerCase();
  if (l && hljs.getLanguage(l)) {
    try { return hljs.highlight(code, { language: l, ignoreIllegals: true }).value; } catch {}
  }
  return esc(code);
}

const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';
// The fence's info string: "python", "python calc.py", "python title=calc.py" or just "calc.py".
function fenceInfo(info) {
  const parts = (info || '').trim().split(/\s+/).filter(Boolean);
  let lang = parts[0] || '', file = parts.slice(1).join(' ').replace(/^title=/, '').replace(/^["']|["']$/g, '');
  if (!file && /\.\w+$/.test(lang) && !hljs.getLanguage(lang)) { file = lang; lang = lang.split('.').pop(); }
  return { lang, file };
}

function codeBlockHtml(code, info) {
  const { lang: l, file } = fenceInfo(info);
  if (l === 'math' || l === 'latex' && /^\s*\\begin\{/.test(code)) return `<div class="math-block">${tex(code, true)}</div>`;
  return `<div class="codeblock"><div class="codehead">${file ? `<span class="code-file">${esc(file)}</span>` : ''}<span class="code-lang">${esc(l)}</span>`
    + `<button class="copy" type="button">${COPY_ICON}Copy</button></div>`
    + `<pre><code class="hljs">${highlight(code.replace(/\n$/, ''), l)}</code></pre></div>`;
}

const md = new Marked({
  gfm: true,
  breaks: false,
  extensions: [mathBlock, mathInline],
  renderer: {
    code: ({ text, lang }) => codeBlockHtml(text, lang),
    html: ({ text }) => esc(text), // show raw HTML as text, like the terminal does
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  // A remote image would load as soon as the text shows: a prompt injection could put data in its
  // URL. It becomes a link instead, fetched only on a click (index.html's CSP backs this up).
  if (node.tagName === 'IMG' && !/^data:image\//i.test(node.getAttribute('src') || '')) {
    const src = node.getAttribute('src') || '';
    const a = document.createElement('a');
    a.textContent = `🖼 ${node.getAttribute('alt') || src}`;
    if (/^https?:/i.test(src)) { a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    node.replaceWith(a);
  }
});

export function markdown(text) {
  const div = h('div', 'md');
  div.innerHTML = DOMPurify.sanitize(md.parse(text || ''), { ADD_ATTR: ['target'] });
  // A table sits in a wrapper so a wide one can spread past the text column (style.css: .table-wrap).
  for (const t of div.querySelectorAll('table')) { const w = h('div', 'table-wrap'); t.replaceWith(w); w.append(t); }
  linkPaths(div);
  return div;
}

// ---------------------------------------------------------------- file references
// Paths Claude mentions become clickable (app.js shows the absolute path on the server).
const EXT = '(?:py|ipynb|js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|mdx|txt|rst|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|fish|c|h|cc|cpp|hpp|cu|cuh|rs|go|java|kt|scala|rb|php|swift|m|html?|css|scss|less|vue|svelte|sql|r|jl|lua|pl|csv|tsv|log|lock|xml|svg|png|jpe?g|gif|webp|bmp|tiff?|pdf|mp4|mov|webm|avi|mkv|wav|mp3|npy|npz|pt|pth|ckpt|safetensors|onnx|h5|hdf5|pkl|pickle|parquet|arrow|tex|bib|sty|cls|dockerfile|mk|cmake|proto|gradle)';
const EXT_END = new RegExp(`\\.${EXT}$`, 'i');
function looksLikePath(p) {
  if (!p || p.length < 3 || /^\d+([./]\d+)*$/.test(p) || p.includes('//')) return false;
  if (EXT_END.test(p)) return true; // name.ext, dir/name.ext
  if (/^(~|\.{1,2})?\//.test(p) && p.length > 2) return true; // /abs, ~/x, ./x, ../x
  return (p.match(/\//g) || []).length >= 2 && !/\s/.test(p); // a/b/c
}

// Only a Markdown link whose target is a file ([name](/abs/a.py#L3)) is a reference: it shows the
// link text and keeps the target. A path in `inline code` only says a name, which may be anywhere,
// so a click copies its text as written. Paths in running prose are left alone.
function linkPaths(root) {
  for (const code of root.querySelectorAll('code')) {
    if (code.closest('pre, a, .katex')) continue;
    const m = /^([^\s:]+?)((?::\d+){0,2})$/.exec(code.textContent.trim());
    if (m && looksLikePath(m[1])) { code.classList.add('code-copy'); code.title = 'Click: copy'; }
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('#')) continue; // http:, mailto:, in-page
    const [p, frag] = href.split('#');
    let file = p;
    try { file = decodeURIComponent(p); } catch {}
    const line = /^L(\d+)/.exec(frag || '')?.[1] || /:(\d+)$/.exec(file)?.[1] || '';
    if (!file) continue;
    a.removeAttribute('target');
    markRef(a, file.replace(/:\d+(:\d+)?$/, ''), line);
  }
}

function markRef(el, p, line) {
  el.classList.add('path-ref');
  el.dataset.path = p;
  if (line) el.dataset.line = line;
  el.title = 'Click: copy the absolute path · ⌘/Ctrl/Shift-click: open';
}

// ---------------------------------------------------------------- misc helpers

// 12345 -> "12k", 1.5e6 -> "1.5M"
export const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n)));
const clipText = (s, n = 6000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

export function relPath(p, cwd) {
  if (!p || typeof p !== 'string') return p ?? '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

const EXT_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp',
  hpp: 'cpp', cu: 'cpp', cs: 'csharp', swift: 'swift', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', json: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', md: 'markdown', html: 'xml', xml: 'xml', vue: 'xml', svelte: 'xml',
  css: 'css', scss: 'scss', sql: 'sql', tex: 'latex', lua: 'lua', php: 'php', r: 'r', m: 'objectivec', dockerfile: 'dockerfile',
};
export const langOf = (file) => EXT_LANG[(file || '').split('.').pop().toLowerCase()] || '';

// `pre` (inside `wrap`) clamped to a few lines, with a button that shows the rest, once it has over `max` lines.
function clampIn(wrap, pre, lines, max) {
  if (lines <= max) return wrap;
  pre.classList.add('clamp');
  const more = h('button', 'more', `Show all ${lines} lines`);
  more.type = 'button';
  more.onclick = () => { pre.classList.remove('clamp'); more.remove(); };
  wrap.append(more);
  return wrap;
}

// Preformatted text (tool output, JSON).
function clamped(text, cls = '') {
  const pre = h('pre', 'out ' + cls);
  pre.textContent = text;
  const wrap = h('div');
  wrap.append(pre);
  return clampIn(wrap, pre, text.split('\n').length, 14);
}

// A highlighted code block (what Write writes).
function codeView(code, lang) {
  const wrap = h('div');
  wrap.innerHTML = codeBlockHtml(code, lang);
  return clampIn(wrap, wrap.querySelector('pre'), code.split('\n').length, 20);
}

// ---------------------------------------------------------------- diffs

// hunks: [{ oldStart, newStart, lines: [' ctx', '-old', '+new'] }]
function diffView(hunks, lang) {
  const table = h('table', 'diff');
  hunks.forEach((hk, i) => {
    if (i > 0) {
      const sep = h('tr', 'sep');
      const td = h('td', null, '⋯');
      td.colSpan = 3;
      sep.append(td);
      table.append(sep);
    }
    let o = hk.oldStart, n = hk.newStart;
    for (const l of hk.lines) {
      const sign = l[0];
      if (sign === '\\') continue; // "\ No newline at end of file"
      const tr = h('tr', sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx');
      const ln = h('td', 'ln', sign === '+' ? '' : String(o));
      const ln2 = h('td', 'ln', sign === '-' ? '' : String(n));
      const code = h('td', 'code');
      code.innerHTML = `<span class="sign">${sign === ' ' ? ' ' : esc(sign)}</span>` + highlight(l.slice(1), lang);
      tr.append(ln, ln2, code);
      table.append(tr);
      if (sign !== '+') o++;
      if (sign !== '-') n++;
    }
  });
  const wrap = h('div', 'diffwrap');
  wrap.append(table);
  return wrap;
}

function diffStrings(oldStr, newStr, lang) {
  const p = structuredPatch('a', 'b', oldStr ?? '', newStr ?? '', '', '', { context: 3 });
  return diffView(p.hunks, lang);
}

const countChanges = (hunks) => hunks.reduce((a, hk) => {
  for (const l of hk.lines) { if (l[0] === '+') a.add++; else if (l[0] === '-') a.del++; }
  return a;
}, { add: 0, del: 0 });

// ---------------------------------------------------------------- tool cards

const ICON = {
  Bash: '›_', Read: '📄', Write: '✎', Edit: '✎', Grep: '⌕', Glob: '⌕', WebFetch: '🌐', WebSearch: '🌐',
  TodoWrite: '☑', Agent: '⧉', Task: '⧉', ExitPlanMode: '📋', EnterPlanMode: '📋', AskUserQuestion: '❓', NotebookEdit: '✎', Artifact: '◰', ArtifactComments: '◰', ArtifactData: '◰',
};

// Returns { card, name, label, children, changes, status, expand(), setResult(block, patch, agent), setApproval(el) }.
// Cards start collapsed to one line; click the head (or expand()) for details.
export function toolCard(b, cwd) {
  const input = b.input || {};
  const card = h('div', 'tool running');
  card.dataset.id = b.id;
  const head = h('div', 'tool-head');
  const status = h('span', 'tool-status');
  const mcp = b.name.startsWith('mcp__') ? b.name.split('__') : null;
  const name = h('span', 'tool-name', mcp ? `${mcp[1]} · ${mcp.slice(2).join('__')}` : b.name);
  const sum = h('span', 'tool-sum');
  const extra = h('span', 'tool-extra');
  head.append(status, h('span', 'tool-icon', ICON[b.name] || '⚙'), name, sum, extra);
  const body = h('div', 'tool-body');
  const result = h('div', 'tool-result');
  const approval = h('div', 'tool-approval');
  card.append(head, body, approval, result);
  let open = false; // body+result visibility for collapsible tools
  let collapsible = true;
  const setOpen = (v) => { open = v; card.classList.toggle('open', v); };
  head.onclick = (e) => { if (collapsible && !e.target.closest('a,button,.file-link')) setOpen(!open); };

  const file = relPath(input.file_path || input.notebook_path, cwd);
  let changes = null; // { file, add, del } for Edit/Write
  const setChanges = (c) => {
    changes = { file: input.file_path, add: c.add, del: c.del };
    extra.innerHTML = `<span class="plus">+${c.add}</span> <span class="minus">−${c.del}</span>`;
  };
  // Paths open in the file viewer (see app.js).
  const linkFile = () => { sum.classList.add('file-link'); sum.dataset.path = input.file_path || input.notebook_path; sum.title = 'Click: copy the absolute path · ⌘/Ctrl/Shift-click: open'; };
  switch (b.name) {
    case 'Bash': {
      sum.textContent = input.description || '';
      const cmd = h('div');
      cmd.innerHTML = `<pre class="cmd"><code class="hljs">${highlight('$ ' + (input.command || ''), 'bash')}</code></pre>`;
      body.append(cmd);
      if (input.run_in_background) extra.textContent = 'background';
      break;
    }
    case 'Read': {
      sum.textContent = file;
      linkFile();
      if (input.offset || input.limit) extra.textContent = `lines ${input.offset || 1}–${(input.offset || 1) + (input.limit || 0) - 1}`;
      if (input.pages) extra.textContent = `pages ${input.pages}`;
      break;
    }
    case 'Edit': {
      sum.textContent = file;
      linkFile();
      if (input.replace_all) extra.textContent = 'replace all';
      body.append(diffStrings(input.old_string, input.new_string, langOf(file)));
      const p = structuredPatch('a', 'b', input.old_string ?? '', input.new_string ?? '', '', '', { context: 0 });
      setChanges(countChanges(p.hunks));
      break;
    }
    case 'Write': {
      sum.textContent = file;
      linkFile();
      body.append(codeView(input.content || '', langOf(file)));
      setChanges({ add: (input.content || '').split('\n').length, del: 0 });
      break;
    }
    case 'Grep': {
      sum.textContent = `"${input.pattern}"`;
      extra.textContent = [relPath(input.path, cwd), input.glob, input.type && `type:${input.type}`].filter(Boolean).join(' · ');
      break;
    }
    case 'Glob': {
      sum.textContent = input.pattern;
      extra.textContent = relPath(input.path, cwd) || '';
      break;
    }
    case 'WebFetch': {
      // Only web links: a javascript: URL here would run in this page, which can approve tools.
      if (/^https?:\/\//i.test(input.url || '')) {
        const a = h('a', null, input.url);
        a.href = input.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        sum.append(a);
      } else sum.textContent = input.url || '';
      if (input.prompt) body.append(h('div', 'muted', input.prompt));
      break;
    }
    case 'WebSearch': sum.textContent = input.query; break;
    case 'TodoWrite': {
      const list = h('ul', 'todos');
      for (const t of input.todos || []) {
        const li = h('li', 'todo ' + t.status, t.status === 'in_progress' ? (t.activeForm || t.content) : t.content);
        list.append(li);
      }
      const done = (input.todos || []).filter((t) => t.status === 'completed').length;
      sum.textContent = `${done}/${(input.todos || []).length} done`;
      body.append(list);
      break;
    }
    case 'TaskCreate': {
      sum.textContent = input.subject || '';
      break;
    }
    case 'TaskUpdate': {
      const mark = { completed: '● done', in_progress: '◐ in progress', pending: '○ pending', deleted: '✗ deleted' }[input.status];
      sum.textContent = input.subject || (input.taskId ? `#${input.taskId}` : '');
      if (mark) extra.textContent = mark;
      break;
    }
    case 'Agent':
    case 'Task': {
      sum.textContent = input.description || '';
      extra.textContent = input.subagent_type || '';
      const prompt = h('details', 'sub-prompt');
      prompt.append(h('summary', null, 'Prompt'), markdown(input.prompt || ''));
      body.append(prompt, h('div', 'children'));
      break;
    }
    case 'ExitPlanMode': {
      sum.textContent = 'Plan ready for review';
      body.append(markdown(input.plan || ''));
      setOpen(true);
      break;
    }
    case 'Artifact': case 'ArtifactComments': case 'ArtifactData': {
      sum.textContent = [input.action || 'publish', input.title || input.file_path || input.url || input.collection].filter(Boolean).join(' · ');
      body.append(clamped(JSON.stringify(input, null, 2), 'json'));
      break;
    }
    case 'AskUserQuestion': {
      // The question's subject, not the tool's name.
      sum.textContent = (input.questions || []).map((q) => q.header || q.question).join(' · ');
      name.hidden = true;
      sum.classList.add('ask-title');
      collapsible = false;
      break;
    }
    default: {
      const hint = input.query ?? input.description ?? input.subject ?? input.name;
      if (typeof hint === 'string') sum.textContent = hint.split('\n')[0].slice(0, 120);
      const keys = Object.keys(input);
      if (keys.length) body.append(clamped(JSON.stringify(input, null, 2), 'json'));
    }
  }

  function setResult(r, patch, agent) {
    card.classList.remove('running');
    card.classList.add(r.is_error ? 'error' : 'done');
    const txt = stripAnsi(typeof r.content === 'string' ? r.content
      : (r.content || []).map((c) => c.text ?? `[${c.type}]`).join('\n'));
    result.innerHTML = '';
    if (r.is_error) {
      result.append(clamped(txt, 'err'));
      setOpen(true);
      return;
    }
    if (patch?.hunks?.length && (b.name === 'Edit' || b.name === 'Write')) {
      // Replace the preview with the real patch (true file line numbers).
      body.innerHTML = '';
      body.append(diffView(patch.hunks, langOf(file)));
      setChanges(countChanges(patch.hunks));
      return;
    }
    switch (b.name) {
      case 'Edit': case 'Write': case 'TodoWrite': case 'ExitPlanMode': case 'EnterPlanMode':
      case 'TaskCreate': case 'TaskUpdate': case 'AskUserQuestion':
        return; // the input view already says it all
      case 'Read': {
        const n = txt.split('\n').length;
        if (!extra.textContent) extra.textContent = `${n} lines`;
        result.append(clamped(txt));
        return;
      }
      case 'Agent': case 'Task': {
        if (agent?.status === 'async_launched') { extra.textContent = 'running in background'; return; }
        const stats = [agent?.toolUses != null && `${agent.toolUses} tools`, agent?.durationMs != null && `${(agent.durationMs / 1000).toFixed(0)}s`,
          agent?.tokens != null && `${(agent.tokens / 1000).toFixed(1)}k tokens`].filter(Boolean).join(' · ');
        if (stats) extra.textContent = [input.subagent_type, stats].filter(Boolean).join(' · ');
        const report = h('div', 'report');
        report.append(markdown(agent?.text ?? txt));
        result.append(report);
        return;
      }
      case 'WebFetch':
        result.append(markdown(clipText(txt)));
        return;
      case 'Artifact': case 'ArtifactComments': case 'ArtifactData': {
        // The published page lives on claude.ai: offer its link (only claude.ai https links).
        const urls = [...new Set(txt.match(/https:\/\/claude\.ai\/[\w\/.\-~%?=&#]+/g) || [])];
        if (urls.length) {
          const links = h('div', 'artifact-links');
          for (const u of urls.slice(0, 5)) {
            const a = h('a', null, u.length > 70 ? u.slice(0, 67) + '…' : u);
            a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = u;
            links.append(a);
          }
          result.append(links);
          if (b.name === 'Artifact' && !extra.textContent) { const a = links.firstChild.cloneNode(true); a.textContent = 'open ↗'; extra.append(a); }
        }
        if (txt.trim()) result.append(clamped(txt));
        return;
      }
      default:
        if (txt.trim()) result.append(clamped(txt));
    }
  }

  return {
    card,
    name: b.name,
    label: sum.textContent || name.textContent,
    children: body.querySelector('.children'),
    get changes() { return changes; },
    get status() { return card.classList.contains('asking') ? 'asking' : card.classList.contains('running') ? 'running' : card.classList.contains('error') ? 'error' : 'done'; },
    expand() { setOpen(true); },
    setResult,
    setApproval(el) { approval.innerHTML = ''; if (el) { approval.append(el); setOpen(true); } card.classList.toggle('asking', !!el); },
  };
}
