// The session's shells: a frosted panel that drops from under the header over the conversation (the
// icon in the header's corner, or ⌃`), one tab per shell. Each shell is a pseudo-terminal the daemon
// runs in the session's folder (server/daemon.mjs, "shells"); here it is an xterm.js terminal fed by
// the 'shell' partials. Double-click a tab to rename it.
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-fit/lib/addon-fit.mjs';
import { h } from './render.js';
import { tell } from './dialog.js';
import { matches } from './keys.js';

const HEIGHT_KEY = 'iro.shellHeight';
const THEME = {
  background: 'rgba(0, 0, 0, 0)', foreground: '#ece6dc', cursor: '#ece6dc', cursorAccent: '#101624',
  selectionBackground: 'rgba(224, 138, 103, .35)',
  black: '#3a3632', red: '#e0685f', green: '#8fd1a2', yellow: '#d9a441', blue: '#8fb6e8', magenta: '#c9a3e6', cyan: '#7fc8c2', white: '#d5cfc5',
  brightBlack: '#857f76', brightRed: '#f0a39b', brightGreen: '#b5e3c2', brightYellow: '#ecc77d', brightBlue: '#b3cff0', brightMagenta: '#ddc4f0', brightCyan: '#a9dcd7', brightWhite: '#f6f4ef',
};
// Your terminal's font first (client.mjs reads it from iTerm2), then the common Powerline / Nerd fonts.
const TERM_FONT = document.querySelector('meta[name="term-font"]')?.content.replace(/["\\]/g, '') || '';
const FONTS = [TERM_FONT, 'MesloLGS NF', 'MesloLGS Nerd Font', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'FiraCode Nerd Font',
  'DejaVu Sans Mono for Powerline', 'Meslo LG M for Powerline', 'SF Mono', 'Menlo'].filter((f) => f && f !== '__TERM_FONT__');
const OPTIONS = {
  fontFamily: [...FONTS.map((f) => `"${f}"`), 'ui-monospace', 'monospace'].join(', '), fontSize: 13, lineHeight: 1.15,
  cursorBlink: true, allowTransparency: true, scrollback: 5000, macOptionIsMeta: true, theme: THEME,
};
const icon = (d, size = 10) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  return s;
};
export const isShellToggle = (ev) => matches('shell.toggle', ev);

// `post(type, body)` sends a command ({ data } or { error }); `session()` is { sid, cwd } of the open
// conversation, or null (none, or a draft); `onHide()` runs when the panel goes up.
export function createShell({ post, session, onHide }) {
  const panel = document.getElementById('shell');
  const btn = document.getElementById('shellBtn');
  const tabs = panel.querySelector('.sh-tabs');
  const terms = panel.querySelector('.sh-terms');
  const lists = new Map();  // sid -> [{ tid, name, exited }]
  const views = new Map();  // tid -> { tid, sid, term, fit, el, at, queue, input, sending }
  const active = new Map(); // sid -> the tid shown
  const down = new Set();   // sids whose panel is open
  let editing = null;       // tid being renamed
  let shownSid = null;      // the session whose panel is down on screen
  let liftSid = null;       // the session whose panel is folding away
  let drawn = '';           // what the tab strip shows: rebuilt only when that changes (a rebuilt tab loses a double-click)

  try {
    const f = parseFloat(localStorage.getItem(HEIGHT_KEY));
    if (f >= 0.2 && f <= 0.92) panel.style.setProperty('--sh-h', `${f * 100}%`);
  } catch {}

  // A terminal for a shell, made when first shown: its recent output first, then what streams in.
  function viewOf(sid, tid) {
    let v = views.get(tid);
    if (v) return v;
    const el = h('div', 'sh-term');
    el.hidden = true;
    terms.append(el);
    const term = new Terminal(OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    term.attachCustomKeyEventHandler((ev) => !isShellToggle(ev)); // the shell key (⌃`) hides the panel (app.js), not sent
    v = { tid, sid, term, fit, el, at: null, queue: [], input: '', sending: false };
    term.onData((d) => { v.input += d; sendInput(v); });
    term.onResize(({ cols, rows }) => post('shellResize', { sid, tid, cols, rows }));
    views.set(tid, v);
    post('shellRead', { sid, tid }).then((r) => {
      if (r.error != null || views.get(tid) !== v) return;
      term.write(r.data.data);
      v.at = r.data.at;
      for (const d of v.queue.splice(0)) feed(v, d);
    });
    return v;
  }
  // A 'shell' partial: `at` counts the characters so far, so a chunk the read already had is skipped.
  function feed(v, d) {
    if (v.at == null) return void v.queue.push(d);
    const fresh = d.at - v.at;
    if (fresh <= 0) return;
    v.term.write(fresh >= d.data.length ? d.data : d.data.slice(d.data.length - fresh));
    v.at = d.at;
  }
  // Keystrokes go in order, batched while one request is out.
  async function sendInput(v) {
    if (v.sending) return;
    v.sending = true;
    while (v.input) {
      const data = v.input;
      v.input = '';
      await post('shellInput', { sid: v.sid, tid: v.tid, data });
    }
    v.sending = false;
  }
  function drop(tid) {
    const v = views.get(tid);
    if (!v) return;
    views.delete(tid);
    v.term.dispose();
    v.el.remove();
  }

  const shown = () => { const s = session(); return s && down.has(s.sid) ? s : null; };
  function fitShown() {
    const s = shown();
    const v = s && views.get(active.get(s.sid));
    if (!v || v.el.hidden || !v.el.clientWidth) return;
    try { v.fit.fit(); } catch {}
  }
  new ResizeObserver(() => requestAnimationFrame(fitShown)).observe(terms);

  function tabEl(sid, t) {
    const el = h('div', 'sh-tab' + (t.exited != null ? ' exited' : ''));
    el.setAttribute('role', 'tab');
    el.tabIndex = 0;
    el.title = 'Double-click to rename';
    el.dataset.tid = t.tid;
    if (editing === t.tid) {
      const inp = document.createElement('input');
      inp.value = t.name;
      inp.setAttribute('aria-label', 'Shell name');
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        editing = null;
        const name = inp.value.trim();
        if (keep && name && name !== t.name) { t.name = name; post('shellRename', { sid, tid: t.tid, name }); }
        render();
        focus();
      };
      inp.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') finish(true);
        else if (ev.key === 'Escape') finish(false);
      };
      inp.onblur = () => finish(true);
      el.append(inp);
      requestAnimationFrame(() => { inp.focus(); inp.select(); });
    } else {
      el.append(h('span', 'sh-name', t.name));
    }
    const x = h('button', 'sh-x');
    x.type = 'button';
    x.title = 'Close this shell';
    x.setAttribute('aria-label', `Close ${t.name}`);
    x.append(icon('M4 4l8 8M12 4l-8 8', 9));
    x.onclick = async (ev) => {
      ev.stopPropagation();
      const here = session(); // (by the reply you may be in another session: its panel is not this one)
      await post('shellClose', { sid, tid: t.tid });
      lists.set(sid, (lists.get(sid) || []).filter((x) => x.tid !== t.tid)); // (the 'shells' partial says so too)
      drop(t.tid);
      if (!lists.get(sid).length) return newShell(here); // the panel always has a shell: closing the last one opens a fresh one
      render();
      focus(); // the button went with its tab: the keys go back to the shell shown
    };
    el.append(x);
    el.onclick = () => { if (editing) return; active.set(sid, t.tid); render(); focus(); }; // (no rebuild: only the selection moves)
    el.ondblclick = () => { editing = t.tid; render(); };
    el.onkeydown = (ev) => { if (ev.target === el && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); el.click(); } };
    return el;
  }

  function render() {
    const s = session();
    btn.hidden = !s;
    const open = !!s && down.has(s.sid);
    btn.setAttribute('aria-expanded', String(open));
    const was = shownSid;
    shownSid = open ? s.sid : null;
    if (!open) {
      // Folding it away lifts the panel back under the header; leaving for another session just hides it.
      if (panel.classList.contains('sh-lifting') && liftSid === s?.sid) return; // (a render while it folds)
      if (!panel.hidden && was && was === s?.sid && !matchMedia('(prefers-reduced-motion: reduce)').matches) { liftSid = s.sid; lift(); }
      else { panel.classList.remove('sh-lifting'); panel.hidden = true; }
      return;
    }
    panel.classList.remove('sh-lifting');
    panel.hidden = false;
    const list = lists.get(s.sid) || [];
    let tid = active.get(s.sid);
    if (!list.some((t) => t.tid === tid)) tid = list[0]?.tid;
    active.set(s.sid, tid);
    const sig = JSON.stringify([s.sid, editing, list]);
    if (sig !== drawn) {
      drawn = sig;
      const add = h('button', 'sh-add');
      add.type = 'button';
      add.title = 'New shell';
      add.setAttribute('aria-label', 'New shell');
      add.append(icon('M8 3v10M3 8h10', 13));
      add.onclick = () => newShell();
      tabs.replaceChildren(...list.map((t) => tabEl(s.sid, t)), add);
    }
    for (const el of tabs.querySelectorAll('.sh-tab')) {
      el.classList.toggle('on', el.dataset.tid === tid);
      el.setAttribute('aria-selected', String(el.dataset.tid === tid));
    }
    if (tid) viewOf(s.sid, tid);
    for (const v of views.values()) v.el.hidden = v.tid !== tid;
    requestAnimationFrame(fitShown);
  }
  function lift() {
    if (panel.classList.contains('sh-lifting')) return;
    panel.classList.add('sh-lifting');
    panel.addEventListener('animationend', () => {
      if (!panel.classList.contains('sh-lifting')) return; // opened again meanwhile
      panel.classList.remove('sh-lifting');
      panel.hidden = true;
      for (const v of views.values()) v.el.hidden = true;
    }, { once: true });
  }
  function focus() {
    const s = shown();
    views.get(s && active.get(s.sid))?.term.focus();
  }

  // The size a new shell starts at: what fits the panel now (a shell resized right after it starts
  // redraws its first prompt, which zsh marks with a stray "%").
  function measure() {
    const el = h('div', 'sh-term');
    el.style.visibility = 'hidden';
    terms.append(el);
    const term = new Terminal(OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let d = null;
    try { d = fit.proposeDimensions(); } catch {}
    term.dispose();
    el.remove();
    return d?.cols > 0 && d?.rows > 0 ? d : { cols: 120, rows: 30 };
  }

  // In `s`, the session it was asked for: the session open when the reply comes may be another one.
  async function newShell(s = session()) {
    if (!s) return;
    const { cols, rows } = measure();
    const r = await post('shellOpen', { sid: s.sid, cwd: s.cwd, cols, rows });
    if (r.error != null) return tell(r.error);
    const list = lists.get(s.sid) || [];
    if (!list.some((t) => t.tid === r.data.tid)) lists.set(s.sid, [...list, r.data]);
    active.set(s.sid, r.data.tid);
    render();
    focus();
  }
  async function loadList(sid) {
    const r = await post('shellList', { sid });
    if (r.error == null) lists.set(sid, r.data);
    return r.error == null;
  }

  async function toggle() {
    const s = session();
    if (!s) return;
    if (down.has(s.sid)) {
      down.delete(s.sid);
      render();
      onHide?.();
      return;
    }
    down.add(s.sid);
    render();
    if (!lists.has(s.sid) && !(await loadList(s.sid))) return;
    if (!(lists.get(s.sid) || []).length) return newShell(s);
    render();
    focus();
  }

  // Drag the bottom edge: the panel's share of the conversation's height, remembered.
  panel.querySelector('.sh-grip').addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const box = panel.parentElement.getBoundingClientRect();
    let f = null;
    const move = (e) => {
      f = Math.min(0.92, Math.max(0.2, (e.clientY - box.top) / box.height));
      panel.style.setProperty('--sh-h', `${f * 100}%`);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.body.classList.remove('sh-resizing');
      if (f != null) try { localStorage.setItem(HEIGHT_KEY, String(f)); } catch {}
      focus();
    };
    document.body.classList.add('sh-resizing');
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  btn.onclick = () => toggle();

  return {
    toggle,
    render,
    isOpen: () => !!shown(),
    // 'shells' (a session's list changed) and 'shell' (output) partials.
    onPartial(d) {
      if (d.op === 'shells') {
        lists.set(d.sid, d.shells);
        const keep = new Set([...lists.values()].flat().map((t) => t.tid));
        for (const tid of [...views.keys()]) if (!keep.has(tid)) drop(tid);
        if (session()?.sid === d.sid && editing == null) render();
      } else if (d.op === 'shell') {
        const v = views.get(d.tid);
        if (v) feed(v, d);
      }
    },
    // A reconnect or another server: what was shown may be gone; the open panel asks again.
    reset() {
      for (const tid of [...views.keys()]) drop(tid);
      lists.clear();
      editing = null;
      drawn = '';
      const s = shown();
      if (s) loadList(s.sid).then(render);
      else render();
    },
  };
}
