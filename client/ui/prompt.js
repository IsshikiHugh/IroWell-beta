// The System prompt page (opened from Settings): Claude Code's own system prompt on the tab's server, as a
// new session gets it, in a text editor. A saved edit takes its place in every session started from then
// on; Restore goes back to Claude Code's own. An edit not saved yet stays as a draft while the page is closed.
import { h } from './render.js';
import { textArea } from './skills.js';
import { holdToRun } from './hold.js';

// `ctx`: { call, post: { data } or { error } without an alert, ask }
export function createPromptPage(ctx) {
  // { own: Claude Code's prompt ({ model, before, text, after }; null with `error`), custom: the saved edit or null }
  let data = null;
  let draft = null; // the text as edited, while it differs from what is kept
  let mode = 'edit'; // or 'preview'
  let view = null;

  const kept = () => data.custom ?? data.own?.text ?? '';

  // Its error, if the prompt could not be had. A server from before this page doesn't know the command
  // (the client answers 400 for it): the page says to update it instead of a bare status code.
  async function load() {
    const out = await ctx.post('claudePrompt');
    if (out.error != null) return /\b400$/.test(out.error) ? 'This server was started before the System prompt page existed: update it (Update server), then open the page again.' : out.error;
    data = out.data;
    if (!data.own && data.custom == null) return data.error;
    if (draft === kept()) draft = null;
  }

  function build() {
    view = h('section');
    view.id = 'promptView';
    view.hidden = true;
    const bar = h('div', 'usage-bar');
    const back = h('button', null, '← Back to the session');
    back.type = 'button';
    back.onclick = hide;
    const title = h('div', 'sk-title');
    title.append(h('h2', null, 'System prompt'), h('div', 'sk-sub', 'What Claude Code tells Claude before anything else, in every session on this server.'));
    bar.append(title, back);
    view.append(bar, h('div', 'sk-edit'));
    // ⌘/Ctrl-S saves (on the document: a redraw can take the focus off the page's controls)
    document.addEventListener('keydown', (ev) => {
      if (!view.hidden && (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    });
    document.querySelector('main').prepend(view);
  }

  function draw() {
    const own = data.own;
    const about = data.custom != null
      ? 'Your text: every session started from now on gets it in the place of Claude Code\'s own prompt, whatever its model.'
      : `Claude Code's own, as it writes it for ${own.model} (other models get another). Save an edit and every session started from then on gets your text instead, whatever its model.`;
    const parts = [h('div', 'sk-note', `${about} {{memory_dir}} stands for the memory folder of the session's folder.${own ? ' The grey text around it is sent with any prompt: Claude Code\'s opening line, and after it what Claude Code adds itself and the UI skills prompt.' : ''}`)];
    if (!own) parts.push(h('div', 'sk-note', `Claude Code's own prompt could not be read: ${data.error}`));
    const editor = textArea({
      value: draft ?? kept(), mode, placeholder: 'The system prompt',
      onMode: (m) => { mode = m; draw(); },
      onInput: (text) => { draft = text === kept() ? null : text; drawFoot(); },
    });
    if (own?.before) editor.querySelector('.sk-tabs').after(h('pre', 'sp-fixed', own.before));
    if (own?.after) editor.append(h('pre', 'sp-fixed', own.after));
    parts.push(editor, h('div', 'sk-foot'));
    view.querySelector('.sk-edit').replaceChildren(...parts);
    drawFoot();
  }

  function drawFoot(said) {
    const foot = view.querySelector('.sk-foot');
    if (!foot) return;
    // `held`: it drops your text, so it runs once held for half a second (hold.js)
    const button = (text, cls, on, run, held) => {
      const b = h('button', cls, text);
      b.type = 'button';
      b.disabled = !on;
      if (held) holdToRun(b, run); else b.onclick = run;
      return b;
    };
    foot.replaceChildren(
      h('span', 'sk-state', said || (draft != null ? 'Not saved' : data.custom != null ? 'Your text' : 'Claude Code\'s own')),
      button('Restore Claude Code\'s', null, data.custom != null, restore, true),
      button('Revert', null, draft != null, () => {
        draft = null;
        draw();
      }, true),
      button('Save', 'primary', draft != null, save),
    );
  }

  // (a text edited back to Claude Code's own is kept as none: sessions then follow Claude Code again)
  async function save() {
    if (!data || draft == null) return;
    const text = draft;
    const d = await ctx.call('setClaudePrompt', { text: text.trim() === data.own?.text.trim() ? null : text });
    if (d === undefined) return; // refused: the draft stays
    data.custom = d.custom;
    if (draft === text) draft = null;
    draw();
    drawFoot('Saved · the next session uses it');
  }

  async function restore() {
    const d = await ctx.call('setClaudePrompt', { text: null });
    if (d === undefined) return;
    data.custom = null;
    draft = null;
    if (data.own) return draw();
    const error = await load(); // (it could not be read before)
    if (error) return fail(error);
    draw();
  }

  const fail = (error) => view.querySelector('.sk-edit').replaceChildren(h('div', 'sk-error', error));

  async function show() {
    if (!view) build();
    document.querySelector('main').classList.add('prompt-mode');
    view.hidden = false;
    // Claude Code is asked for it (a CLI started only for that, a second or two). Nothing of an earlier
    // visit is shown meanwhile: a save made on it would be undone by the answer on its way.
    view.querySelector('.sk-edit').replaceChildren(h('div', 'sk-note', 'Asking Claude Code for its prompt…'));
    const error = await load();
    if (view.hidden) return;
    if (error) { data = null; return fail(error); }
    draw();
  }
  function hide() {
    if (!view || view.hidden) return;
    view.hidden = true;
    document.querySelector('main').classList.remove('prompt-mode');
  }
  // Another server was picked: the prompt, and an edit of it, were that server's.
  function reset() {
    hide();
    data = null;
    draft = null;
  }
  return { show, hide, reset };
}
