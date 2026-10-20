// The Output style page (opened from Settings): Claude Code's output styles on the tab's server, the same
// ones the terminal's `claude` uses. The three built in can be picked; the user's own
// (~/.claude/output-styles) can also be made, edited and deleted. The one picked is used by every session
// started from then on. An edit not saved yet stays as a draft while the page is closed.
import { h } from './render.js';
import { textArea, newItemRow } from './skills.js';
import { holdToRun } from './hold.js';
import { fullPage, askFor } from './page.js';

// `ctx`: { call, post: { data } or { error } without an alert }
export function createStylesPage(ctx) {
  // { styles: [{ name, setting, description, builtIn } or the user's { file, name, setting, description,
  //   keepCoding, body, version }], active: the setting in use, dir: where the user's styles are }
  let data = null;
  let sel = null; // the style shown: a user's style's file, else its setting
  let mode = 'edit'; // or 'preview', for its text
  const drafts = new Map(); // file -> { description, keepCoding, body } as edited (only while they differ from the file)
  const page = fullPage({
    id: 'stylesView', mode: 'styles-mode', title: 'Output style', save,
    sub: 'How Claude answers: Claude Code\'s output styles on this server, the same ones the terminal\'s claude uses.',
    build: () => {
      const wrap = h('div', 'sk-wrap');
      wrap.append(h('nav', 'sk-list'), h('div', 'sk-edit'));
      return [wrap];
    },
  });
  let view = null; // its <section>, once shown

  const keyOf = (s) => s.file ?? s.setting;
  const item = (key) => data?.styles.find((s) => keyOf(s) === key);
  const fieldsOf = (s) => ({ description: s.description, keepCoding: s.keepCoding, body: s.body });
  const same = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);
  const current = (key) => drafts.get(key) || fieldsOf(item(key));
  const inUse = (s) => s.setting === data.active;
  function edit(patch) {
    const next = { ...current(sel), ...patch };
    if (same(fieldsOf(item(sel)), next)) drafts.delete(sel);
    else drafts.set(sel, next);
    drawList();
    drawFoot();
  }

  // The server's answer to any of its commands: the list as it is now.
  function take(d) {
    data = d;
    // (the style in use is none of these: a plugin's, or a file since removed)
    if (!data.styles.some(inUse)) data.styles.push({ name: data.active, setting: data.active, other: true });
    for (const [k, f] of [...drafts]) if (!item(k) || same(fieldsOf(item(k)), f)) drafts.delete(k);
    if (!item(sel)) sel = keyOf(data.styles.find(inUse));
  }
  // Its error, if the list could not be had. A server from before this page doesn't know the command:
  // it needs an update.
  async function load() {
    const out = await askFor(ctx.post, 'outputStyles', 'This server was started before the Output style page existed: update it (Update server), then open the page again.');
    if (out.error != null) return out.error;
    take(out.data);
  }

  function drawList() {
    const entry = (s) => {
      const b = h('button', 'sk-item' + (keyOf(s) === sel ? ' on' : '') + (drafts.has(keyOf(s)) ? ' dirty' : ''));
      b.type = 'button';
      if (s.description) b.title = s.description;
      b.append(h('span', 'sk-name', s.name));
      if (inUse(s)) b.append(h('span', 'sk-tag', 'in use'));
      b.onclick = () => { sel = keyOf(s); mode = 'edit'; draw(); };
      return b;
    };
    view.querySelector('.sk-list').replaceChildren(
      h('div', 'sk-head', 'Built in'),
      ...data.styles.filter((s) => s.builtIn).map(entry),
      h('div', 'sk-head', 'Yours'),
      ...data.styles.filter((s) => !s.builtIn).map(entry),
      newItemRow('+ New style', 'name, like Concise', async (name) => {
        const d = await ctx.call('outputStyleNew', { name });
        if (d === undefined) return false;
        take(d);
        sel = d.file; mode = 'edit';
        draw();
        return true;
      }),
    );
  }

  function drawEditor() {
    const ed = view.querySelector('.sk-edit');
    const s = item(sel);
    const parts = [h('div', 'sk-ed-head', s.name)];
    if (s.builtIn) parts.push(h('div', 'sk-note', s.description), h('div', 'sk-note', 'Built into Claude Code: its text isn\'t shown or edited here.'));
    else if (s.other) parts.push(h('div', 'sk-note', `Not in ${data.dir}: a plugin's style, or one that has been removed.`));
    else {
      const f = current(sel);
      const desc = h('textarea', 'sk-desc');
      desc.value = f.description;
      desc.rows = 2;
      desc.placeholder = 'What it is for, in a line';
      desc.oninput = () => edit({ description: desc.value });
      const keep = h('label', 'hall');
      const box = h('input');
      box.type = 'checkbox';
      box.checked = f.keepCoding;
      box.onchange = () => edit({ keepCoding: box.checked });
      keep.append(box, 'Keep Claude Code\'s coding instructions');
      parts.push(
        h('div', 'sk-note', `${data.dir}/${s.file}`),
        h('div', 'sk-label', 'Description'), desc,
        h('div', 'sk-label', 'Text'),
        h('div', 'sk-note', 'Sent with the first message of every session that uses this style.'),
        textArea({ value: f.body, mode, placeholder: 'How Claude should answer', onMode: (m) => { mode = m; drawEditor(); }, onInput: (body) => edit({ body }) }),
        keep,
        h('div', 'sk-note', 'Unticked, Claude Code leaves its instructions for software work out of the system prompt.'),
      );
    }
    ed.replaceChildren(...parts, h('div', 'sk-foot'));
    drawFoot();
  }

  function drawFoot(said) {
    const foot = view.querySelector('.sk-foot');
    if (!foot) return;
    const s = item(sel), mine = !s.builtIn && !s.other, d = drafts.has(sel);
    // `held`: it drops your text, so it runs once held for half a second (hold.js)
    const button = (text, cls, on, run, held) => {
      const b = h('button', cls, text);
      b.type = 'button';
      b.disabled = !on;
      if (held) holdToRun(b, run); else b.onclick = run;
      return b;
    };
    const use = button(inUse(s) ? 'In use' : 'Use this style', mine ? null : 'primary', !inUse(s), async () => {
      const r = await ctx.call('outputStyleUse', { setting: s.setting });
      if (r === undefined) return;
      take(r);
      draw();
      drawFoot('In use · the next session uses it');
    });
    const state = h('span', 'sk-state', said || (d ? 'Not saved' : ''));
    if (!mine) return foot.replaceChildren(state, use);
    foot.replaceChildren(
      state,
      button('Delete', null, true, async () => {
        const r = await ctx.call('outputStyleDelete', { file: s.file, version: s.version });
        if (r === undefined) return;
        drafts.delete(s.file);
        take(r);
        draw();
      }, true),
      button('Revert', null, d, () => { drafts.delete(sel); draw(); }, true),
      use,
      button('Save', 'primary', d, save),
    );
  }

  async function save() {
    if (!data || !drafts.has(sel)) return;
    const key = sel, f = drafts.get(key);
    const d = await ctx.call('outputStyleSave', { file: key, version: item(key).version, ...f });
    if (d === undefined) { // refused (changed on disk since): the draft stays, Revert shows the file as it is now
      if (!await load()) draw();
      return;
    }
    drafts.delete(key);
    take(d);
    draw();
    const state = view.querySelector('.sk-state');
    if (state) state.textContent = 'Saved · the next session uses it';
  }

  function draw() {
    drawList();
    drawEditor();
  }

  async function show() {
    view = page.show();
    const error = await load();
    if (view.hidden) return;
    if (error) {
      data = null;
      view.querySelector('.sk-wrap').replaceChildren(h('div', 'sk-error', error));
      return;
    }
    if (!view.querySelector('.sk-list')) view.querySelector('.sk-wrap').replaceChildren(h('nav', 'sk-list'), h('div', 'sk-edit'));
    draw();
  }
  // Another server was picked: the styles, and edits of them, were that server's.
  function reset() {
    page.hide();
    data = null;
    sel = null;
    drafts.clear();
  }
  return { show, hide: page.hide, reset };
}
