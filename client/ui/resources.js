// Opening a file from the conversation (⌘/Ctrl/Shift-click on a path): it shows in a dialog. Images, videos
// and big text files are fetched in chunks, the dialog showing how far along they are, and are then kept in
// memory as blobs, so the next open is immediate. A small text file is not kept: each open reads it from the
// server again.
//
// An image sits in the frame the diagrams have (diagram.js): drag to pan, ⌘/Ctrl-scroll or pinch to zoom,
// and on hover the buttons to zoom in, zoom out and reset. A video has a bar to go through it frame by frame (frames.js).
//
// What is kept looks after itself:
// - a file that changed on the server since it was fetched (its size or modification time) is fetched again;
// - a file not opened for KEEP is dropped. Nothing runs on a timer: this is checked when a file is opened;
// - at most MAX_TOTAL bytes are held: when a new file would not fit, the least recently opened ones go first.
// Files over the per-kind cap are not fetched. Two downloads at a time; a download goes on after its dialog
// is closed (opening the file again shows it). A page reload clears everything.
//
// A video this browser can't decode (e.g. OpenCV's 'mp4v') is converted on this computer: the bytes
// already downloaded go to the local client (client/main.mjs, POST /convert), which runs ffmpeg here.
// The server never needs ffmpeg.
import { h, viewPad } from './render.js';
import { watchView } from './diagram.js';
import { frameTimes, frameBar } from './frames.js';

const MB = 1 << 20;
const MAX_TOTAL = 512 * MB;
const CAP = { image: 64 * MB, video: 256 * MB, text: 16 * MB };
const SMALL_TEXT = 256 * 1024; // up to this, a text file is read on each open instead of kept
const CHUNK = 1 * MB;
const PARALLEL = 2;
const KEEP = 3600e3; // a file not opened for this long is dropped

const KIND = (p) => {
  const ext = (p.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
  return null; // anything else is shown as text
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', avif: 'image/avif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', ogv: 'video/ogg' };

const fmtSize = (n) => (n >= MB ? `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const tooBig = (size, kind) => `too big to preview (${fmtSize(size)}; ${kind}s up to ${fmtSize(CAP[kind])})`;

// `call` / `post`: the page's commands to the server (`post` resolves to { data } or { error }, showing nothing).
// `openModal(title)` opens the dialog and gives its body; `label(path)` is a text file's title in it;
// `showText(body, r, lines)` fills it with a text file, r being { path, size, text, binary, truncated }.
export function createResources({ call, post, openModal, closeModal, label, showText, toast, token }) {
  const items = []; // { path, name, kind, size, mtime, got, status, blob, url, used, lines, body }
  let active = 0;

  const held = () => items.reduce((a, i) => a + (i.status === 'queued' ? 0 : i.blob?.size ?? i.size), 0);
  const shown = (it) => !!it.body?.isConnected; // its dialog is open

  function drop(it) {
    if (it.url) URL.revokeObjectURL(it.url);
    it.status = 'dropped'; // (a download under way stops at its next chunk)
    it.url = it.blob = it.body = null;
    const i = items.indexOf(it);
    if (i >= 0) items.splice(i, 1);
  }

  // Free the least recently opened files until `need` more bytes fit.
  function makeRoom(need) {
    const old = items.filter((i) => i.status === 'ready' && !shown(i)).sort((a, b) => a.used - b.used);
    while (held() + need > MAX_TOTAL && old.length) drop(old.shift());
    return held() + need <= MAX_TOTAL;
  }

  // What the dialog of a file shows: the file once it is here, how far along it is until then.
  function paint(it) {
    if (!shown(it)) return;
    if (it.status === 'ready') return show(it);
    if (it.status === 'error') return it.body.replaceChildren(h('div', 'err', `Could not load ${it.name}: ${it.error || 'unknown error'}`));
    const wait = h('div', 'res-wait');
    wait.append(h('div', 'meta', statusText(it)));
    if ((it.status === 'loading' && it.size) || it.status === 'converting') {
      const bar = h('div', 'res-bar' + (it.status === 'converting' ? ' converting' : ''));
      const fill = h('div', 'res-fill');
      fill.style.width = `${Math.round((it.status === 'converting' ? it.progress || 0 : it.got / it.size) * 100)}%`;
      bar.append(fill);
      wait.append(bar);
    }
    it.body.replaceChildren(wait);
  }

  function statusText(it) {
    switch (it.status) {
      case 'checking': return 'checking whether this browser can play it…';
      case 'converting': return `this browser can't play it; converting on this computer · ${Math.round((it.progress || 0) * 100)}%`;
      case 'queued': return `waiting · ${fmtSize(it.size)}`;
      default: return `loading ${Math.round((it.got / (it.size || 1)) * 100)}% · ${fmtSize(it.size)}`;
    }
  }

  function fail(it, msg) {
    it.status = 'error';
    it.error = msg;
    paint(it);
    drop(it); // (the next open starts over)
  }

  async function pump() {
    while (active < PARALLEL) {
      const it = items.find((i) => i.status === 'queued');
      if (!it) return;
      if (!makeRoom(it.size)) { fail(it, 'not enough room in the memory budget'); continue; }
      active++;
      it.status = 'loading';
      it.got = 0;
      paint(it);
      load(it).finally(() => { active--; pump(); });
    }
  }

  async function load(it) {
    const parts = [];
    try {
      while (it.got < it.size) {
        if (it.status !== 'loading') return; // dropped meanwhile
        // (a failure in the server's words: a file it can't read, one changed meanwhile, "connection lost")
        const r = await post('readChunk', { path: it.path, offset: it.got, length: CHUNK });
        if (r.error != null) throw new Error(r.error);
        const bin = atob(r.data.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        parts.push(bytes);
        it.got += bytes.length;
        if (!bytes.length) break;
        paint(it);
      }
      if (it.status !== 'loading') return; // dropped while the last chunk was on its way
      const ext = (it.path.split('.').pop() || '').toLowerCase();
      const blob = new Blob(parts, { type: MIME[ext] || (it.kind === 'text' ? 'text/plain' : 'application/octet-stream') });
      // An SVG gets a data: URL, not a blob: one. A blob: URL has this page's origin, so an SVG opened
      // from it in a tab of its own would run its scripts with the page's token.
      const url = ext === 'svg' ? await dataUrl(blob) : URL.createObjectURL(blob);
      if (it.status !== 'loading') return URL.revokeObjectURL(url);
      Object.assign(it, { blob, url });
      if (it.kind === 'video') { verify(it); return; } // not holding a download slot meanwhile
      ready(it);
    } catch (e) {
      if (it.status === 'loading') fail(it, e.message);
    }
  }

  function ready(it) {
    it.status = 'ready';
    paint(it);
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
    paint(it);
    const ok = await playable(it.url);
    if (it.status !== 'checking') return; // dropped meanwhile
    if (ok) ready(it); else convert(it);
  }

  // Send the downloaded bytes to the local client, which converts them with this computer's ffmpeg.
  async function convert(it) {
    const h264 = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '';
    const target = h264 ? 'mp4' : 'webm';
    it.status = 'converting';
    it.progress = 0;
    paint(it);
    const stop = (msg) => { if (it.status === 'converting') fail(it, msg); };
    try {
      const r = await fetch(`/convert?target=${target}`, { method: 'POST', headers: { 'x-token': token() }, body: it.blob });
      if (!r.ok) return stop(r.status === 413 ? 'too big to convert' : `conversion failed (${r.status})`);
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
          if (ln.startsWith('progress ')) { it.progress = Number(ln.slice(9)); if (it.status === 'converting') paint(it); }
          else result = ln;
        }
      }
      if (it.status !== 'converting') return; // dropped meanwhile
      if (result === 'error no-ffmpeg') return stop("this browser can't play it, and ffmpeg isn't installed on this computer to convert it (brew install ffmpeg / apt install ffmpeg)");
      if (!result?.startsWith('done ')) return stop(`conversion failed: ${result ? result.replace(/^error /, '') : 'no answer'}`);
      const f = await fetch(`/converted?id=${result.slice(5)}`, { headers: { 'x-token': token() } });
      if (!f.ok) return stop(`conversion failed (${f.status})`);
      const blob = await f.blob();
      if (it.status !== 'converting') return;
      if (blob.size > CAP.video) return stop(tooBig(blob.size, 'video'));
      URL.revokeObjectURL(it.url);
      Object.assign(it, { blob, url: URL.createObjectURL(blob), converted: h264 ? 'H.264' : 'VP9' });
      if (!makeRoom(0)) return stop('not enough room in the memory budget'); // (it may be larger than what it replaced)
      ready(it);
    } catch (e) { stop(`conversion failed: ${e.message}`); }
  }

  const dataUrl = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

  // A loaded file, in its dialog.
  async function show(it) {
    const body = it.body;
    if (it.kind === 'text') {
      const bytes = new Uint8Array(await it.blob.arrayBuffer());
      if (it.body !== body || !shown(it)) return; // closed, or opened again, meanwhile
      return showText(body, { path: it.path, size: it.size, binary: bytes.subarray(0, 8000).includes(0), text: new TextDecoder().decode(bytes) }, it.lines);
    }
    const media = it.kind === 'video' ? h('video') : h('img');
    media.src = it.url;
    media.className = 'res-media';
    if (it.kind === 'video') { media.controls = true; media.autoplay = true; media.playsInline = true; }
    media.onerror = () => {
      if (it.kind === 'video' && !it.converted && it.status === 'ready') return convert(it);
      body.append(h('div', 'err', "This browser can't show this file."));
    };
    if (it.kind === 'video') {
      body.replaceChildren(media);
      const times = await frameTimes(it.blob);
      if (times && media.isConnected) body.append(frameBar(media, times));
      return;
    }
    // Shown whole to begin with (at its own size when that is smaller), zooming up to 40 times that. Zoomed
    // until one of its pixels covers three or more of the screen's, they are drawn as squares, not blurred.
    const block = h('div', 'diagram-block expanded res-image');
    block.innerHTML = `<div class="diagram" data-max-zoom="40"><div class="diagram-view"></div>${viewPad(['zoom-in', 'zoom-out', 'reset'])}</div>`;
    block.querySelector('.diagram-view').append(media);
    media.draggable = false;
    if (!it.url.startsWith('data:image/svg')) {
      watchView(block.firstChild, (t) => media.classList.toggle('pixels',
        t.s * Math.min(1, media.clientWidth / media.naturalWidth, media.clientHeight / media.naturalHeight) >= 3));
    }
    body.replaceChildren(block);
  }

  // Open a file: its absolute path on the server, with its size and modification time there (from stat).
  // `lines` ({ from, to } or null): the lines the reference pointed at, for a text file.
  // `anchor`: the reference, for the note that a file is too big.
  async function open(path, { size, mtime }, { lines = null, anchor } = {}) {
    const now = Date.now();
    for (const it of [...items]) if (it.status === 'ready' && !shown(it) && now - it.used > KEEP) drop(it);
    const kind = KIND(path) || 'text';
    const name = path.split('/').pop();
    if (kind === 'text' && size <= SMALL_TEXT) {
      const body = openModal(label(path));
      body.append(h('div', 'meta', 'loading…'));
      const r = await call('readFile', { path });
      if (!body.isConnected) return; // closed meanwhile
      return r ? showText(body, r, lines) : closeModal();
    }
    let it = items.find((i) => i.path === path);
    // (changed on the server since it was fetched; a server that doesn't say when is judged by the size alone)
    if (it && (it.size !== size || (mtime != null && it.mtime != null && it.mtime !== mtime))) { drop(it); it = null; }
    if (!it) {
      if (size > CAP[kind]) return toast(`${name} is ${tooBig(size, kind)}`, anchor);
      it = { path, name, kind, size, mtime, got: 0, status: 'queued' };
      items.push(it);
    }
    it.used = now;
    it.lines = lines;
    it.body = openModal(kind === 'text' ? label(path) : path);
    if (kind !== 'text') it.body.parentElement.classList.add('media-modal'); // an image or a video: a dialog of 90% of the page
    paint(it);
    pump();
  }

  // Another server: its files go (and what is still loading stops at its next chunk).
  function reset() {
    for (const it of [...items]) drop(it);
  }

  return { open, reset };
}
