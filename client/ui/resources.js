// Resource list (the right rail's Resources tab): every file opened from the conversation (⌘/Ctrl/Shift-click
// on a path) is listed here. Images, videos and big text files are fetched in chunks so they can load in the
// background, and kept in memory as blobs under a budget. A small text file is not kept: each open reads it
// from the server again, so it always shows the file as it is now.
//
// Budget: at most MAX_TOTAL bytes held at once; files over the per-kind cap are not fetched.
// When a new file would not fit, the least recently viewed loaded files are released (they stay
// listed as "released", one click fetches them again). Two downloads at a time; a page reload
// clears everything.
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
export function createResources({ call, openModal, toast, listEl, onAdd, viewText }) {
  const items = []; // { id, path, name, kind, size, got, status, url, used, chunks }
  let active = 0;

  const held = () => items.filter((i) => i.status === 'ready' || i.status === 'loading').reduce((a, i) => a + (i.size || 0), 0);

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
      case 'checking': return 'checking the video format…';
      case 'converting': return `converting ${it.codec || ''} → H.264 for the browser · ${Math.round((it.progress || 0) * 100)}%`;
      case 'queued': return `waiting · ${fmtSize(it.size)}`;
      case 'loading': return `loading ${Math.round((it.got / (it.size || 1)) * 100)}% · ${fmtSize(it.size)}`;
      case 'remote': return `${fmtSize(it.size)} · read from the server each time you open it`;
      case 'ready': return `ready · ${fmtSize(it.size)}${it.converted ? ' · converted to H.264' : ''}`;
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
      it.status = 'ready';
      it.used = Date.now();
      toast(`${it.name} is ready`, listEl);
    } catch (e) {
      it.status = 'error';
      it.error = e.message;
    }
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
      const src = it.codec && `${it.codec}${it.pixFmt ? `, ${it.pixFmt}` : ''}${it.audio ? `, audio ${it.audio}` : ''}`;
      const why = it.noFfmpeg ? ' ffmpeg/ffprobe were not found on the server, so the video could not be checked or converted (install ffmpeg there and restart the daemon).'
        : src ? ` (${it.converted ? `converted to H.264 from ${src}` : src})` : '';
      body.append(h('div', 'err', `This browser can't show this file.${why}`));
    };
    body.append(media);
  }

  // Videos first ask the server whether the browser can decode them; if not, it converts them.
  async function prepare(it) {
    it.status = 'checking';
    render();
    const r = await call('prepareMedia', { path: it.source });
    if (!r) { it.status = 'error'; it.error = 'could not check the video'; return render(); }
    Object.assign(it, { codec: r.codec, pixFmt: r.pixFmt, audio: r.audio, noFfmpeg: !!r.noFfmpeg });
    if (r.converting) {
      it.status = 'converting'; it.key = r.key; it.progress = r.progress || 0;
      const early = finished.get(r.key); // a short video can finish before this reply arrives
      if (early) return onMedia(early);
      return render();
    }
    Object.assign(it, { path: r.path, size: r.size, converted: !!r.converted });
    it.status = it.size > CAP.video ? 'too-big' : 'queued';
    render();
    pump();
  }
  const finished = new Map(); // conversion results by key, in case they beat the prepare reply
  function onMedia(d) {
    if (d.done) finished.set(d.key, d);
    const it = items.find((i) => i.key === d.key && i.status === 'converting');
    if (!it) return;
    it.progress = d.progress;
    if (d.done) {
      if (d.error) { it.status = 'error'; it.error = `conversion failed: ${d.error}`; }
      else { Object.assign(it, { path: d.path, size: d.size, converted: true, status: d.size > CAP.video ? 'too-big' : 'queued' }); pump(); }
    }
    render();
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
      status: kind !== 'video' && size > CAP[kind] ? 'too-big' : kind === 'text' && size <= SMALL_TEXT ? 'remote' : 'queued' };
    items.unshift(it);
    onAdd?.(); // show the Resources tab
    if (it.status === 'remote') { render(); open(it); return it; }
    toast(it.status === 'too-big' ? `${it.name} is too big to preview` : `Loading ${it.name} in Resources`, listEl.offsetParent ? listEl : document.querySelector('#railtabs [data-tab=resources]') || listEl);
    if (kind === 'video') prepare(it);
    else { render(); pump(); }
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

  return { add, onMedia, reset };
}
