// Resource list (the right rail's Resources tab): every file opened from the conversation (⌘/Ctrl/Shift-click
// on a path) is listed here. Images, videos and big text files are fetched in chunks so they can load in the
// background, and kept in memory as blobs under a budget. A small text file is not kept: each open reads it
// from the server again, so it always shows the file as it is now.
//
// Budget: at most MAX_TOTAL bytes held at once; files over the per-kind cap are not fetched.
// When a new file would not fit, the least recently viewed loaded files are released (they stay
// listed as "released", one click fetches them again). Two downloads at a time; a page reload
// clears everything.
//
// A video this browser can't decode (e.g. OpenCV's 'mp4v') is converted on this computer: the bytes
// already downloaded go to the local client (client/main.mjs, POST /convert), which runs ffmpeg here.
// The server never needs ffmpeg.
import { h } from './render.js';

const MB = 1 << 20;
const MAX_TOTAL = 512 * MB;
const CAP = { image: 64 * MB, video: 256 * MB, text: 16 * MB };
const SMALL_TEXT = 256 * 1024; // up to this, a text file is read on each open instead of kept
const CHUNK = 1 * MB;
const PARALLEL = 2;

export const KIND = (p) => {
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
  return null; // anything else is shown as text
};
const ICON = {
  video: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M7 6.5v3l2.5-1.5z" fill="currentColor"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="7" r="1.2"/><path d="M3 12l3.5-3 2.5 2 2-1.5L14 12"/>',
  text: '<path d="M4 2h5.5L12 4.5V14H4z"/><path d="M9.5 2v2.5H12M6 8h4M6 10.5h4"/>',
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg' };

const fmtSize = (n) => (n >= MB ? `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// `viewText(path, load)` shows a text file; `load()` resolves to { path, size, text, binary, truncated } or null.
export function createResources({ call, openModal, toast, listEl, onAdd, viewText, token }) {
  const items = []; // { id, path, name, kind, size, got, status, url, used, chunks }
  let active = 0;

  const held = () => items.filter((i) => ['ready', 'loading', 'checking', 'converting'].includes(i.status)).reduce((a, i) => a + (i.size || 0), 0);

  function render() {
    listEl.innerHTML = '';
    const box = listEl.parentElement;
    box.classList.toggle('empty', !items.length);
    if (!items.length) listEl.append(h('div', 'side-empty', 'No files opened yet. ⌘-click a path in the conversation to open it here.'));
    const count = document.getElementById('resCount');
    if (count) { count.textContent = String(items.length); count.hidden = !items.length; }
    for (const it of items) {
      const row = h('div', `res res-${it.status}`);
      const icon = h('span', 'res-icon');
      icon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">${ICON[it.kind]}</svg>`;
      const name = h('span', 'res-name', it.name);
      const x = h('button', 'res-x', '✕');
      x.title = 'Remove';
      x.onclick = (ev) => { ev.stopPropagation(); remove(it); };
      const top = h('div', 'res-top');
      top.append(icon, name, x);
      const sub = h('div', 'res-sub', statusText(it));
      row.append(top, sub);
      if ((it.status === 'loading' && it.size) || it.status === 'converting') {
        const bar = h('div', 'res-bar' + (it.status === 'converting' ? ' converting' : ''));
        const fill = h('div', 'res-fill');
        fill.style.width = `${Math.round((it.status === 'converting' ? it.progress || 0 : it.got / it.size) * 100)}%`;
        bar.append(fill);
        row.append(bar);
      }
      row.title = it.source;
      row.onclick = () => open(it);
      listEl.append(row);
    }
    const foot = box.querySelector('.res-budget');
    if (foot) foot.textContent = `${fmtSize(held())} of ${fmtSize(MAX_TOTAL)} in memory`;
    const meter = box.querySelector('.res-meter-fill');
    if (meter) meter.style.width = `${Math.min(100, (held() / MAX_TOTAL) * 100)}%`;
  }

  function statusText(it) {
    switch (it.status) {
      case 'checking': return 'checking whether this browser can play it…';
      case 'converting': return `this browser can't play it; converting on this computer · ${Math.round((it.progress || 0) * 100)}%`;
      case 'queued': return `waiting · ${fmtSize(it.size)}`;
      case 'loading': return `loading ${Math.round((it.got / (it.size || 1)) * 100)}% · ${fmtSize(it.size)}`;
      case 'remote': return `${fmtSize(it.size)} · read from the server each time you open it`;
      case 'ready': return `ready · ${fmtSize(it.size)}${it.converted ? ` · converted to ${it.converted}` : ''}`;
      case 'released': return `released to save memory · click to load again`;
      case 'too-big': return `${fmtSize(it.size)} · over the ${fmtSize(CAP[it.kind])} limit for ${it.kind}s`;
      default: return `failed: ${it.error || 'unknown error'} · click to retry`;
    }
  }

  // Free least recently used loaded files until `need` more bytes fit.
  function makeRoom(need, except) {
    const loaded = items.filter((i) => i.status === 'ready' && i !== except).sort((a, b) => a.used - b.used);
    while (held() + need > MAX_TOTAL && loaded.length) {
      const it = loaded.shift();
      URL.revokeObjectURL(it.url);
      it.url = it.blob = null;
      it.status = 'released';
    }
    return held() + need <= MAX_TOTAL;
  }

  async function pump() {
    while (active < PARALLEL) {
      const it = items.find((i) => i.status === 'queued');
      if (!it) return;
      if (!makeRoom(it.size, it)) { it.status = 'error'; it.error = 'not enough room in the memory budget'; render(); continue; }
      active++;
      it.status = 'loading';
      it.got = 0;
      render();
      load(it).finally(() => { active--; render(); pump(); });
    }
  }

  async function load(it) {
    const parts = [];
    it.converted = null; // (a released video loads the original again)
    try {
      while (it.got < it.size) {
        if (it.status !== 'loading') return; // removed meanwhile
        const r = await call('readChunk', { path: it.path, offset: it.got, length: CHUNK }, { quiet: true });
        if (!r) throw new Error('connection lost');
        const bin = atob(r.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        parts.push(bytes);
        it.got += bytes.length;
        if (!bytes.length) break;
        render();
      }
      if (it.status !== 'loading') return; // removed while the last chunk was on its way
      const ext = (it.path.split('.').pop() || '').toLowerCase();
      it.blob = new Blob(parts, { type: MIME[ext] || (it.kind === 'text' ? 'text/plain' : 'application/octet-stream') });
      // An SVG gets a data: URL, not a blob: one. A blob: URL has this page's origin, so an SVG opened
      // from it in a tab of its own would run its scripts with the page's token.
      it.url = ext === 'svg' ? await dataUrl(it.blob) : URL.createObjectURL(it.blob);
      if (it.status !== 'loading') return;
      if (it.kind === 'video') { verify(it); return; } // not holding a download slot meanwhile
      ready(it);
    } catch (e) {
      it.status = 'error';
      it.error = e.message;
    }
  }

  function ready(it) {
    it.status = 'ready';
    it.used = Date.now();
    toast(`${it.name} is ready`, listEl);
  }

  // Can this browser decode the video? A codec it doesn't know fails to load; one it knows decodes a frame.
  const playable = (url) => new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    const end = (ok) => { clearTimeout(timer); v.removeAttribute('src'); v.load(); resolve(ok); };
    const timer = setTimeout(() => end(true), 8000); // undecided: let the viewer try
    v.onloadeddata = () => end(v.videoWidth > 0);
    v.onerror = () => end(false);
    v.src = url;
  });

  async function verify(it) {
    it.status = 'checking';
    render();
    if (await playable(it.url)) { if (it.status === 'checking') ready(it); return render(); }
    if (it.status === 'checking') convert(it);
  }

  // Send the downloaded bytes to the local client, which converts them with this computer's ffmpeg.
  async function convert(it) {
    const h264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '';
    const target = h264 ? 'mp4' : 'webm';
    it.status = 'converting';
    it.progress = 0;
    render();
    const fail = (msg) => { if (it.status !== 'converting') return; it.status = 'error'; it.error = msg; render(); };
    try {
      const r = await fetch(`/convert?target=${target}`, { method: 'POST', headers: { 'x-token': token() }, body: it.blob });
      if (!r.ok) return fail(r.status === 413 ? 'too big to convert' : `conversion failed (${r.status})`);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '', result = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (ln.startsWith('progress ')) { it.progress = Number(ln.slice(9)); if (it.status === 'converting') render(); }
          else result = ln;
        }
      }
      if (it.status !== 'converting') return; // removed meanwhile
      if (result === 'error no-ffmpeg') return fail("this browser can't play it, and ffmpeg isn't installed on this computer to convert it (brew install ffmpeg / apt install ffmpeg)");
      if (!result?.startsWith('done ')) return fail(`conversion failed: ${result ? result.replace(/^error /, '') : 'no answer'}`);
      const f = await fetch(`/converted?id=${result.slice(5)}`, { headers: { 'x-token': token() } });
      if (!f.ok) return fail(`conversion failed (${f.status})`);
      const blob = await f.blob();
      if (it.status !== 'converting') return;
      URL.revokeObjectURL(it.url);
      Object.assign(it, { blob, url: URL.createObjectURL(blob), size: blob.size, converted: h264 ? 'H.264' : 'VP9' });
      ready(it);
      render();
    } catch (e) { fail(`conversion failed: ${e.message}`); }
  }

  const dataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  function remove(it) {
    if (it.url) URL.revokeObjectURL(it.url);
    it.status = 'removed';
    items.splice(items.indexOf(it), 1);
    render();
  }

  function open(it) {
    if (it.status === 'remote') return viewText(it.source, () => call('readFile', { path: it.source }));
    if (it.status === 'released' || it.status === 'error') { it.status = 'queued'; render(); pump(); return; }
    if (it.status !== 'ready') return;
    it.used = Date.now();
    if (it.kind === 'text') {
      const blob = it.blob;
      return viewText(it.source, async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { path: it.source, size: it.size, binary: bytes.subarray(0, 8000).includes(0), text: new TextDecoder().decode(bytes) };
      });
    }
    const body = openModal(it.source);
    const media = it.kind === 'video' ? h('video') : h('img');
    media.src = it.url;
    media.className = 'res-media';
    if (it.kind === 'video') { media.controls = true; media.autoplay = true; media.playsInline = true; }
    media.onerror = () => {
      if (it.kind === 'video' && !it.converted && it.status === 'ready') { body.append(h('div', 'err', "This browser can't play this file; converting it on this computer, see Resources.")); return convert(it); }
      body.append(h('div', 'err', "This browser can't show this file."));
    };
    body.append(media);
  }

  // Add a file (absolute path on the server, size from stat) and start fetching it.
  // A small text file opens right away; the rest load first (click them once they are ready).
  function add(absPath, size) {
    const kind = KIND(absPath) || 'text';
    let it = items.find((i) => i.source === absPath);
    if (it) {
      if (it.kind === 'text' && it.status === 'remote') it.size = size;
      if (['ready', 'remote', 'released', 'error'].includes(it.status)) open(it);
      return it;
    }
    it = { id: Math.random().toString(36).slice(2), source: absPath, path: absPath, name: absPath.split('/').pop(), kind, size, got: 0, used: 0,
      status: size > CAP[kind] ? 'too-big' : kind === 'text' && size <= SMALL_TEXT ? 'remote' : 'queued' };
    items.unshift(it);
    onAdd?.(); // show the Resources tab
    if (it.status === 'remote') { render(); open(it); return it; }
    toast(it.status === 'too-big' ? `${it.name} is too big to preview` : `Loading ${it.name} in Resources`, listEl.offsetParent ? listEl : document.querySelector('#railtabs [data-tab=resources]') || listEl);
    render();
    pump();
    return it;
  }

  const clearBtn = listEl.parentElement.querySelector('.res-clear');
  if (clearBtn) clearBtn.onclick = () => { for (const it of [...items]) remove(it); };
  render();
  // Another server: its files go (and what is still loading stops at its next chunk).
  function reset() {
    for (const it of items) { if (it.url) URL.revokeObjectURL(it.url); it.status = 'removed'; }
    items.length = 0;
    render();
  }

  return { add, reset };
}
