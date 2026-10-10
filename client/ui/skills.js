// The UI Skills page (opened from Settings): what Claude is told about this web UI. It edits skills/ in the
// client's checkout, which servers only ever get from the client (install, update): the system
// prompt (system-prompt.md) and each skill's description, how it is used and its text. An edit not saved
// yet stays as a draft while the page is closed, until saved or reverted.
import { h, markdown, highlight, langOf } from './render.js';

const MODES = [
  ['passive', 'Passive', 'Claude uses it on its own when it fits; not a / command'],
  ['both', 'Claude and /', 'Claude uses it on its own, and you can run /irowell:<name>'],
  ['command', '/ only', 'Only when you run /irowell:<name>; Claude doesn\'t see it'],
  ['off', 'Off', 'Neither: Claude doesn\'t see it and it isn\'t a command'],
];
const MODE_TAG = { passive: 'passive', both: 'Claude + /', command: '/ only', off: 'off' };
const PROMPT = ':prompt'; // the system prompt's key (no skill name starts with ":")

// `ctx`: { call, post: { data } or { error } without an alert, openModal, ask, serverId(): the tab's server }
export function createSkillsPage(ctx) {
  let data = null; // { prompt: { text, version }, skills: [...], servers: [...] }
  let sel = PROMPT;
  let mode = 'edit'; // or 'preview', for the text being edited
  const drafts = new Map(); // key -> the fields as edited (only while they differ from the file)
  let view = null;

  const item = (key) => (key === PROMPT ? data?.prompt : data?.skills.find((s) => s.name === key));
  const fieldsOf = (key) => {
    const it = item(key);
    if (!it) return null;
    return key === PROMPT ? { text: it.text } : { description: it.description, mode: it.mode, body: it.body };
  };
  const current = (key) => drafts.get(key) || fieldsOf(key);
  const dirty = (key) => drafts.has(key);
  function edit(key, patch) {
    const next = { ...current(key), ...patch };
    const saved = fieldsOf(key);
    if (saved && Object.keys(saved).every((k) => saved[k] === next[k])) drafts.delete(key);
    else drafts.set(key, next);
    drawList();
    drawFoot();
  }

  // Its error, if the list could not be had. A client started before this page existed doesn't know the
  // command (it answers 400): it needs a restart, which the page says instead of a bare status code.
  async function load() {
    const out = await ctx.post('uiSkills');
    if (out.error != null) return /\b400$/.test(out.error) ? 'This client was started before the UI Skills page existed: restart it (client.mjs), then open the page again.' : out.error;
    data = out.data;
    for (const k of [...drafts.keys()]) if (!item(k)) drafts.delete(k); // its skill is gone from disk
    if (!item(sel)) sel = PROMPT;
  }

  // ---- layout: a list on the left, the editor on the right, where it applies underneath

  function build() {
    view = h('section');
    view.id = 'skillsView';
    view.hidden = true;
    const bar = h('div', 'usage-bar');
    const back = h('button', null, '← Back to the session');
    back.type = 'button';
    back.onclick = hide;
    const title = h('div', 'sk-title');
    title.append(h('h2', null, 'UI Skills'), h('div', 'sk-sub', 'What Claude is told about this web UI: skills/ in this client\'s checkout. Servers get it from here.'));
    bar.append(title, back);
    const wrap = h('div', 'sk-wrap');
    wrap.append(h('nav', 'sk-list'), h('div', 'sk-edit'));
    view.append(bar, wrap, h('div', 'sk-servers'));
    // ⌘/Ctrl-S saves what is open (on the document: a redraw can take the focus off the page's controls)
    document.addEventListener('keydown', (ev) => {
      if (!view.hidden && (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    });
    document.querySelector('main').prepend(view);
  }

  function drawList() {
    const nav = view.querySelector('.sk-list');
    const entry = (key, name, tag, hint) => {
      const b = h('button', 'sk-item' + (key === sel ? ' on' : '') + (dirty(key) ? ' dirty' : ''));
      b.type = 'button';
      b.title = hint;
      b.append(h('span', 'sk-name', name));
      if (tag) b.append(h('span', `sk-tag ${tag.replace(/\W+/g, '')}`, tag));
      b.onclick = () => { sel = key; mode = 'edit'; draw(); };
      return b;
    };
    nav.replaceChildren(
      h('div', 'sk-head', 'System prompt'),
      entry(PROMPT, 'system-prompt.md', '', 'Appended to Claude Code\'s system prompt in every IroWell session'),
      h('div', 'sk-head', 'Skills'),
      ...data.skills.map((s) => entry(s.name, s.name, MODE_TAG[s.mode] || '?', s.description)),
      newSkillRow(),
    );
  }

  function newSkillRow() {
    const box = h('div', 'sk-new');
    const add = h('button', 'sk-add', '+ New skill');
    add.type = 'button';
    add.onclick = () => {
      const input = h('input');
      input.placeholder = 'name, like show-files';
      input.spellcheck = false;
      const done = async (go) => {
        const name = input.value.trim();
        if (go && name) {
          if (await ctx.call('uiSkillNew', { name }) === undefined) return input.focus();
          await load();
          sel = name; mode = 'edit';
          return draw();
        }
        box.replaceChildren(add);
      };
      input.onkeydown = (ev) => { if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') done(false); };
      input.onblur = () => { if (!input.value.trim()) done(false); };
      box.replaceChildren(input);
      input.focus();
    };
    box.append(add);
    return box;
  }

  // The text being edited, or its rendering (the reply renderer: a diagram draws as it would in a reply).
  function textArea(value, onInput, placeholder) {
    const box = h('div', 'sk-text');
    const tabs = h('div', 'sk-tabs');
    for (const [m, label] of [['edit', 'Edit'], ['preview', 'Preview']]) {
      const t = h('button', mode === m ? 'on' : '', label);
      t.type = 'button';
      t.onclick = () => { mode = m; drawEditor(); };
      tabs.append(t);
    }
    box.append(tabs);
    if (mode === 'preview') {
      const p = markdown(value);
      p.classList.add('sk-preview');
      box.append(p);
    } else {
      const ta = h('textarea', 'sk-area');
      ta.value = value;
      ta.spellcheck = false;
      ta.placeholder = placeholder;
      ta.oninput = () => onInput(ta.value);
      box.append(ta);
    }
    return box;
  }

  function drawEditor() {
    const ed = view.querySelector('.sk-edit');
    const f = current(sel);
    if (sel === PROMPT) {
      const tokens = Math.ceil(f.text.length / 4);
      ed.replaceChildren(
        h('div', 'sk-ed-head', 'System prompt'),
        h('div', 'sk-note', `Appended to Claude Code's system prompt in every IroWell session, so it rides along with every request (about ${tokens} tokens). Keep it to what Claude needs in any reply; anything for one kind of task belongs in a skill.`),
        textArea(f.text, (text) => edit(PROMPT, { text }), 'What Claude should know about this UI in every reply'),
      );
    } else {
      const s = item(sel);
      const desc = h('textarea', 'sk-desc');
      desc.value = f.description;
      desc.rows = 3;
      desc.oninput = () => { edit(sel, { description: desc.value }); count.textContent = `${desc.value.trim().length} characters`; };
      const count = h('span', 'sk-count', `${f.description.trim().length} characters`);
      const modes = h('div', 'sk-modes');
      for (const [m, label, hint] of MODES) {
        const l = h('label', 'sk-mode' + (f.mode === m ? ' on' : ''));
        const r = h('input');
        r.type = 'radio';
        r.name = 'sk-mode';
        r.checked = f.mode === m;
        r.onchange = () => { edit(sel, { mode: m }); drawEditor(); };
        l.append(r, h('b', null, label), h('span', null, hint.replace('<name>', s.name)));
        modes.append(l);
      }
      const parts = [
        h('div', 'sk-ed-head', `irowell:${s.name}`),
        h('div', 'sk-label', 'Description'),
        h('div', 'sk-note', 'Always in Claude\'s context: it decides whether Claude loads the skill, so say when to use it, not what it is.'),
        desc, count,
        h('div', 'sk-label', 'How it is used'), modes,
        h('div', 'sk-label', 'Text'),
        h('div', 'sk-note', 'What Claude reads once it loads the skill.'),
        textArea(f.body, (body) => edit(sel, { body }), 'How to do it'),
      ];
      if (s.files.length) {
        const files = h('div', 'sk-files');
        for (const name of s.files) {
          const b = h('button', null, name);
          b.type = 'button';
          b.title = 'Look at it (the page doesn\'t edit the files beside SKILL.md)';
          b.onclick = async () => {
            const text = await ctx.call('uiSkillFile', { name: s.name, file: name });
            if (text == null) return;
            const body = ctx.openModal(`skills/${s.name}/${name}`);
            const pre = h('pre', 'sk-file');
            pre.innerHTML = `<code class="hljs">${highlight(text, langOf(name))}</code>`;
            body.append(pre);
          };
          files.append(b);
        }
        parts.push(h('div', 'sk-label', 'Files beside it'), files);
      }
      ed.replaceChildren(...parts);
    }
    const foot = h('div', 'sk-foot');
    ed.append(foot);
    drawFoot();
  }

  function drawFoot() {
    const foot = view.querySelector('.sk-foot');
    if (!foot) return;
    const d = dirty(sel);
    const revert = h('button', null, 'Revert');
    revert.type = 'button';
    revert.disabled = !d;
    revert.onclick = async () => {
      if (!await ctx.ask('Drop your changes and go back to the saved file?')) return;
      drafts.delete(sel);
      draw();
    };
    const saveBtn = h('button', 'primary', 'Save');
    saveBtn.type = 'button';
    saveBtn.disabled = !d;
    saveBtn.onclick = save;
    foot.replaceChildren(h('span', 'sk-state', d ? 'Not saved' : 'Saved'), revert, saveBtn);
  }

  async function save() {
    if (!dirty(sel)) return;
    const key = sel, f = drafts.get(key), it = item(key);
    const body = key === PROMPT ? { text: f.text, version: it.version } : { name: key, ...f, version: it.version };
    const d = await ctx.call('uiSkillSave', body);
    if (d === undefined) { // refused (the file changed on disk, an empty description…): the draft stays
      await load();
      return draw();
    }
    data = d;
    drafts.delete(key);
    draw();
    const state = view.querySelector('.sk-state');
    if (state) state.textContent = 'Saved · the next session uses it';
  }

  // Where these files apply: a session reads skills/ as it starts; a server runs the copy it was last
  // installed or updated with.
  function drawServers() {
    const box = view.querySelector('.sk-servers');
    const rows = (data.servers || []).map((s) => {
      const r = h('div', 'sk-server' + (s.current ? ' ok' : ''));
      r.append(h('span', 'dot'), h('b', null, s.host),
        h('span', null, s.current ? 'new sessions get these files' : 'runs older files (or older server code)'));
      if (!s.current) r.append(h('span', 'muted', 'the update installs by itself: Reconnect to update, when it shows'));
      return r;
    });
    box.replaceChildren(h('div', 'sk-head', 'Where it applies'), ...(rows.length ? rows : [h('div', 'muted', 'Not connected to a server.')]));
  }

  function draw() {
    drawList();
    drawEditor();
    drawServers();
  }

  async function show() {
    if (!view) build();
    document.querySelector('main').classList.add('skills-mode');
    view.hidden = false;
    const error = await load();
    if (view.hidden) return;
    if (error) {
      view.querySelector('.sk-wrap').replaceChildren(h('div', 'sk-error', error));
      view.querySelector('.sk-servers').replaceChildren();
      data = null;
      return;
    }
    if (!view.querySelector('.sk-list')) view.querySelector('.sk-wrap').replaceChildren(h('nav', 'sk-list'), h('div', 'sk-edit'));
    draw();
  }
  function hide() {
    if (!view || view.hidden) return;
    view.hidden = true;
    document.querySelector('main').classList.remove('skills-mode');
  }
  return { show, hide };
}
