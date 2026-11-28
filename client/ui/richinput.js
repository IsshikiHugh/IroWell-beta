// The message box: an editable <div> that the rest of the page uses as it would a <textarea> (value,
// selectionStart/End, setSelectionRange, disabled, placeholder), with references to the message's
// attachments shown in the text as chips: <p1> (picture 1) and <q1> (quote 1) in the value, one chip each
// on the page, which the caret steps over and Backspace takes away whole.
//
// The box stays flat: text nodes (newlines are '\n' in them; the box is pre-wrap) and chips. Whatever the
// browser puts in besides (a <div> per line from a paste or a test's fill, a <br>) is turned back into that
// after the edit. A value ending in '\n' carries one more in the box: the browser draws no empty last line
// without it (and puts one there itself when Shift+Enter makes one).

export const REF = /<([pq][1-9]\d*)>/g;

// `chip(label)`: the element for a reference, or null when the message has no such attachment (then the
// text stays as it was typed).
export function richInput(el, { chip }) {
  let saved = { start: 0, end: 0 }; // the selection while the box doesn't have it (a textarea keeps its own)
  let composing = false;
  // (plain text only where the browser has it: no bold from ⌘B, no markup from a paste)
  const probe = document.createElement('div');
  try { probe.contentEditable = 'plaintext-only'; } catch {}
  const editable = probe.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true';
  if (el.getAttribute('aria-disabled') !== 'true') el.contentEditable = editable;
  el.setAttribute('role', 'textbox');
  el.setAttribute('aria-multiline', 'true');
  el.spellcheck = false;

  const lengthOf = (n) => (n.nodeType === 3 ? n.data.length : n.dataset?.ref ? n.dataset.ref.length + 2 : 0);

  // The text of a part of the box (its nodes, or a fragment of them), in the value's terms.
  function textOf(root) {
    let out = '';
    const walk = (node) => {
      for (const n of node.childNodes) {
        if (n.nodeType === 3) out += n.data;
        else if (n.nodeType !== 1) continue;
        else if (n.dataset.ref) out += `<${n.dataset.ref}>`;
        else if (n.tagName === 'BR') out += '\n';
        else if (/^(DIV|P)$/.test(n.tagName)) {
          if (out && !out.endsWith('\n')) out += '\n'; // a line of its own
          walk(n);
          if (n.nextSibling && !out.endsWith('\n')) out += '\n';
        } else walk(n);
      }
    };
    walk(root);
    return out;
  }
  const valueOf = () => { const t = textOf(el); return t.endsWith('\n') ? t.slice(0, -1) : t; };

  // The box drawn from a value: text, with a chip for each reference that has its attachment.
  function draw(v) {
    const nodes = [];
    let last = 0;
    for (const m of v.matchAll(REF)) {
      const c = chip(m[1]);
      if (!c) continue;
      if (m.index > last) nodes.push(document.createTextNode(v.slice(last, m.index)));
      c.dataset.ref = m[1];
      c.contentEditable = 'false';
      nodes.push(c);
      last = m.index + m[0].length;
    }
    const rest = v.slice(last) + (v.endsWith('\n') ? '\n' : '');
    if (rest) nodes.push(document.createTextNode(rest));
    el.replaceChildren(...nodes);
    blank();
  }
  const blank = () => el.classList.toggle('blank', !el.firstChild || valueOf() === '');

  // Offsets in the value <-> places in the (flat) box.
  function offsetAt(node, off) {
    if (node !== el && !el.contains(node)) return null;
    const r = document.createRange();
    r.setStart(el, 0);
    try { r.setEnd(node, off); } catch { return null; }
    const chipIn = node.nodeType === 1 && node !== el ? node.closest('[data-ref]') : node.parentElement?.closest('[data-ref]');
    if (chipIn && el.contains(chipIn)) r.setEndAfter(chipIn); // (never inside a chip)
    return textOf(r.cloneContents()).length;
  }
  function placeAt(n) {
    let acc = 0;
    const kids = [...el.childNodes];
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i], len = lengthOf(k);
      if (k.nodeType === 3 && n <= acc + len) return [k, n - acc];
      if (k.nodeType !== 3 && n <= acc) return [el, i];
      acc += len;
    }
    return [el, kids.length];
  }
  const inside = (sel) => sel.rangeCount && el.contains(sel.anchorNode) && el.contains(sel.focusNode);
  function liveRange() {
    const sel = getSelection();
    if (!inside(sel)) return null;
    const r = sel.getRangeAt(0);
    const a = offsetAt(r.startContainer, r.startOffset), b = offsetAt(r.endContainer, r.endOffset);
    return a == null || b == null ? null : { start: a, end: b };
  }
  const range = () => liveRange() || saved;
  function apply({ start, end }) {
    const sel = getSelection();
    const r = document.createRange();
    r.setStart(...placeAt(start));
    r.setEnd(...placeAt(end));
    sel.removeAllRanges();
    sel.addRange(r);
  }
  // A chip in the selection shows it (the browser draws no selection over it): .picked.
  document.addEventListener('selectionchange', () => {
    const r = liveRange();
    if (r) saved = r;
    const sel = getSelection();
    for (const c of el.querySelectorAll('[data-ref]')) c.classList.toggle('picked', !!r && r.start !== r.end && sel.containsNode(c, false));
  });

  // After an edit: back to flat, and a reference typed out in full becomes its chip (where the caret was, it stays).
  function tidy() {
    const odd = [...el.childNodes].some((n) => n.nodeType === 1 && !n.dataset.ref);
    const typed = [...el.childNodes].some((n) => n.nodeType === 3 && [...n.data.matchAll(REF)].some((m) => chip(m[1])));
    if (odd || typed) {
      const at = range(), v = valueOf();
      draw(v);
      const len = v.length;
      apply({ start: Math.min(at.start, len), end: Math.min(at.end, len) });
    }
    blank();
  }
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => { composing = false; tidy(); el.dispatchEvent(new Event('input')); });
  // (first, before the page's own listeners read the value)
  el.addEventListener('input', (ev) => { if (!composing && !ev.isComposing) tidy(); });

  // Copied or cut, a part of the box is its text as the value has it: a chip as its <q1> (pasted back, the chip
  // again), not the words it shows.
  const clip = (ev, cut) => {
    const { start, end } = range();
    if (start === end || !ev.clipboardData) return;
    ev.preventDefault();
    const v = valueOf();
    ev.clipboardData.setData('text/plain', v.slice(start, end));
    if (!cut || el.contentEditable === 'false') return;
    el.value = v.slice(0, start) + v.slice(end);
    el.setSelectionRange(start);
    el.dispatchEvent(new Event('input'));
  };
  el.addEventListener('copy', (ev) => clip(ev, false));
  el.addEventListener('cut', (ev) => clip(ev, true));

  // Focus puts the caret back where it was, as a textarea's does; a click puts it where it lands.
  let pressed = false;
  el.addEventListener('pointerdown', () => { pressed = true; });
  el.addEventListener('focus', () => { if (!pressed) apply(saved); pressed = false; });
  el.addEventListener('blur', () => { pressed = false; });

  Object.defineProperties(el, {
    value: {
      get: valueOf,
      set(v) {
        v = String(v ?? '');
        draw(v);
        saved = { start: v.length, end: v.length };
        if (document.activeElement === el) apply(saved);
      },
    },
    selectionStart: { get: () => range().start },
    selectionEnd: { get: () => range().end },
    setSelectionRange: {
      value(a, b = a) {
        const len = valueOf().length;
        saved = { start: Math.max(0, Math.min(a, len)), end: Math.max(0, Math.min(b, len)) };
        if (document.activeElement === el) apply(saved);
      },
    },
    disabled: {
      get: () => el.contentEditable === 'false',
      set(off) {
        el.contentEditable = off ? 'false' : editable;
        el.setAttribute('aria-disabled', String(!!off));
        el.classList.toggle('disabled', !!off);
      },
    },
    placeholder: {
      get: () => el.getAttribute('aria-placeholder') || '',
      set(t) { el.setAttribute('aria-placeholder', t || ''); },
    },
    // The chips again, for attachments that came or went (the value as it is: a reference without its
    // attachment shows as text).
    redraw: { value() { const at = range(); draw(valueOf()); if (document.activeElement === el) apply(at); else saved = at; } },
    // Text put in at the caret (what a drop or a picked item adds), as typing would.
    insertAtCaret: {
      value(text) {
        const { start, end } = range(), v = valueOf();
        this.value = v.slice(0, start) + text + v.slice(end);
        this.setSelectionRange(start + text.length);
        el.dispatchEvent(new Event('input'));
      },
    },
  });
  return el;
}
