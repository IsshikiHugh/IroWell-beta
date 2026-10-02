// Keyboard shortcuts: one table of actions and their default keys, with the user's own choices
// (Keyboard shortcuts dialog, /keys) kept in localStorage over it. A key is written as its modifiers
// and the KeyboardEvent.code of the key, e.g. 'Alt+KeyM': the code, not the character, so a
// layout's dead keys and ⌥-symbols (⌥M is µ on a Mac) still match.

// scope 'global' works anywhere outside the shell's terminal; 'model' only while the ⌥M panel is open.
export const ACTIONS = [
  { id: 'shell.toggle', scope: 'global', key: 'Ctrl+Backquote', desc: 'Show or hide the shell' },
  { id: 'model.panel', scope: 'global', key: 'Alt+KeyM', desc: 'Open the model and effort panel' },
  { id: 'mode.cycle', scope: 'global', key: 'Shift+Tab', desc: 'Cycle the permission mode' },
  { id: 'turn.interrupt', scope: 'global', key: 'Ctrl+KeyC', desc: 'Interrupt the running turn' },
  { id: 'model.prev', scope: 'model', key: 'ArrowUp', desc: 'Previous model' },
  { id: 'model.next', scope: 'model', key: 'ArrowDown', desc: 'Next model' },
  { id: 'effort.down', scope: 'model', key: 'ArrowLeft', desc: 'Lower effort' },
  { id: 'effort.up', scope: 'model', key: 'ArrowRight', desc: 'Higher effort' },
];
export const SCOPES = { global: 'Anywhere', model: 'In the model panel' };
export const DEFAULTS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.key]));

const STORE = 'iro-keybindings';
const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MOD_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
const isMac = /Mac/.test(globalThis.navigator?.platform || '');

let custom = {};
try { custom = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch {}
for (const id of Object.keys(custom)) if (!(id in DEFAULTS)) delete custom[id]; // an action that is gone
const listeners = new Set();
function save() {
  try { if (Object.keys(custom).length) localStorage.setItem(STORE, JSON.stringify(custom)); else localStorage.removeItem(STORE); } catch {}
  for (const f of listeners) f();
}

export const keyOf = (id) => custom[id] ?? DEFAULTS[id];
export const isDefault = (id) => !(id in custom);
export function setKey(id, key) {
  if (key === DEFAULTS[id]) delete custom[id]; else custom[id] = key;
  save();
}
export function resetKey(id) { delete custom[id]; save(); }
export function resetAll() { custom = {}; save(); }
export function onKeysChange(f) { listeners.add(f); }

// 'Ctrl+Shift+KeyK' for a keydown, or null for a bare modifier.
export function comboOf(ev) {
  if (!ev.code || MOD_CODES.test(ev.code)) return null;
  const mods = [ev.ctrlKey && 'Ctrl', ev.altKey && 'Alt', ev.shiftKey && 'Shift', ev.metaKey && 'Meta'].filter(Boolean);
  return [...mods, ev.code].join('+');
}
export const matches = (id, ev) => comboOf(ev) === keyOf(id);
export const actionFor = (ev, scope) => { const c = comboOf(ev); return c && ACTIONS.find((a) => a.scope === scope && keyOf(a.id) === c)?.id; };

// For a global action, a key that types something on its own (no Ctrl/Alt/⌘) would stop that key
// from typing; returns why a key can't be used for the action, or ''.
export function problem(id, key) {
  const a = ACTIONS.find((x) => x.id === id);
  const parts = key.split('+');
  const code = parts.pop();
  if (code === 'Escape' && !parts.length) return 'Esc is kept for closing dialogs and interrupting';
  if (a.scope === 'global' && !parts.some((m) => m !== 'Shift') && !/^F\d+$/.test(code) && key !== 'Shift+Tab') {
    return `Add ${isMac ? '⌃, ⌥ or ⌘' : 'Ctrl or Alt'}: without one that key already does something`;
  }
  const other = ACTIONS.find((x) => x.id !== id && x.scope === a.scope && keyOf(x.id) === key);
  return other ? `Already used for “${other.desc}”` : '';
}

const NAMES = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
  Comma: ',', Period: '.', Slash: '/', Space: 'Space', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: isMac ? '↩' : 'Enter', Backspace: isMac ? '⌫' : 'Backspace', Tab: isMac ? '⇥' : 'Tab',
};
const MAC_MODS = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
const PC_MODS = { Ctrl: 'Ctrl+', Alt: 'Alt+', Shift: 'Shift+', Meta: 'Win+' };
// How a key reads: '⌥M' on a Mac, 'Alt+M' elsewhere.
export function keyLabel(key) {
  if (!key) return '';
  const parts = key.split('+');
  const code = parts.pop();
  const name = NAMES[code] || code.replace(/^(Key|Digit|Numpad)/, '');
  const mods = MODS.filter((m) => parts.includes(m)).map((m) => (isMac ? MAC_MODS : PC_MODS)[m]).join('');
  return mods + name;
}
export const label = (id) => keyLabel(keyOf(id));
