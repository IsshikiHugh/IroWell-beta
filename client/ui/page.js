// A full page in place of the conversation, opened from Settings (UI Skills, Output style): a bar with its
// title, a line about it and the way back, then what `build()` gives. ⌘/Ctrl-S calls `save` while it shows.
// It is made the first time it shows; <main> has the class `mode` while it does (style.css).
import { h } from './render.js';

export function fullPage({ id, mode, title, sub, build, save }) {
  let view = null;
  const main = () => document.querySelector('main');
  function make() {
    view = h('section');
    view.id = id;
    view.hidden = true;
    const bar = h('div', 'usage-bar');
    const back = h('button', null, '← Back to the session');
    back.type = 'button';
    back.onclick = hide;
    const head = h('div', 'sk-title');
    head.append(h('h2', null, title), h('div', 'sk-sub', sub));
    bar.append(head, back);
    view.append(bar, ...build());
    // (on the document: a redraw can take the focus off the page's controls)
    document.addEventListener('keydown', (ev) => {
      if (!view.hidden && (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
    });
    main().prepend(view);
  }
  // Its <section>.
  function show() {
    if (!view) make();
    main().classList.add(mode);
    view.hidden = false;
    return view;
  }
  function hide() {
    if (!view || view.hidden) return;
    view.hidden = true;
    main().classList.remove(mode);
  }
  return { show, hide };
}

// `post(type)`'s answer, { data } or { error }. A client or server from before the command answers 400
// for it: then the error is `old`, what to do about it, instead of a bare status code.
export async function askFor(post, type, old) {
  const out = await post(type);
  return out.error != null && /\b400$/.test(out.error) ? { error: old } : out;
}
