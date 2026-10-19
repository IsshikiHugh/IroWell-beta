// Frame by frame through a video in the file viewer (resources.js): a bar under it with a step back, the
// number of the frame shown (type one to go to it; the first is 0) and a step forward.
//
// A browser plays by time and doesn't say where a video's frames are, so they are read from the file. An
// MP4/MOV lists them in its moov box: how long each lasts (stts), how far from there a reordered frame is
// shown (ctts), and where the presentation starts (elst). A file that doesn't list them (WebM, Ogg, a
// fragmented MP4) gets no bar.
import { h, chevronButton } from './render.js';

const MAX_FRAMES = 2_000_000;
const fourcc = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
// The boxes in v[from, to): each one's type and where its content is.
function* boxes(v, from, to) {
  for (let o = from; o + 8 <= to;) {
    let size = v.getUint32(o), head = 8;
    if (size === 1) { size = Number(v.getBigUint64(o + 8)); head = 16; } else if (size === 0) size = to - o;
    if (size < head || o + size > to) return;
    yield { type: fourcc(v, o + 4), from: o + head, to: o + size };
    o += size;
  }
}
const child = (v, box, type) => { if (box) for (const b of boxes(v, box.from, box.to)) if (b.type === type) return b; return null; };
// A track's or the movie's time units per second (mdhd, mvhd).
const scaleOf = (v, box) => (box ? v.getUint32(box.from + (v.getUint8(box.from) === 1 ? 20 : 12)) : 0);

// An MP4's moov box. It may come after the media data: only the box headers are read on the way to it.
async function moovOf(blob) {
  for (let o = 0, n = 0; o + 8 <= blob.size && n < 64; n++) {
    const v = new DataView(await blob.slice(o, o + 16).arrayBuffer());
    let size = v.getUint32(0), head = 8;
    if (size === 1 && v.byteLength === 16) { size = Number(v.getBigUint64(8)); head = 16; } else if (size === 0) size = blob.size - o;
    if (size < head) return null;
    if (fourcc(v, 4) === 'moov') return new DataView(await blob.slice(o + head, o + size).arrayBuffer());
    o += size;
  }
  return null;
}

// When each frame of the video in `blob` is shown, in seconds and in order; null when the file doesn't list them.
export async function frameTimes(blob) {
  try {
    const v = await moovOf(blob);
    if (!v) return null;
    const moov = { from: 0, to: v.byteLength };
    for (const trak of boxes(v, moov.from, moov.to)) {
      const mdia = trak.type === 'trak' && child(v, trak, 'mdia'), hdlr = child(v, mdia, 'hdlr');
      if (!hdlr || fourcc(v, hdlr.from + 8) !== 'vide') continue;
      const stbl = child(v, child(v, mdia, 'minf'), 'stbl'), stts = child(v, stbl, 'stts'), ctts = child(v, stbl, 'ctts');
      const scale = scaleOf(v, child(v, mdia, 'mdhd'));
      if (!stts || !scale) return null;
      // (stts and ctts are runs: this many frames, each with this value)
      const runs = (box, each) => { for (let i = 0, n = v.getUint32(box.from + 4), o = box.from + 8; i < n; i++, o += 8) each(v.getUint32(o), v.getInt32(o + 4)); };
      const at = []; // in the track's units
      let t = 0;
      runs(stts, (count, lasts) => {
        if (at.length + count > MAX_FRAMES) throw new Error('too many frames');
        for (let k = 0; k < count; k++, t += lasts) at.push(t);
      });
      if (ctts) { let i = 0; runs(ctts, (count, later) => { for (let k = 0; k < count && i < at.length; k++) at[i++] += later; }); }
      // The edit list: an empty edit (nothing shown for that long, in the movie's units), then where in the track the presentation starts.
      let start = 0, wait = 0;
      const elst = child(v, child(v, trak, 'edts'), 'elst');
      if (elst) {
        const long = v.getUint8(elst.from) === 1, movie = scaleOf(v, child(v, moov, 'mvhd'));
        for (let i = 0, n = v.getUint32(elst.from + 4), o = elst.from + 8; i < n; i++, o += long ? 20 : 12) {
          const lasts = long ? Number(v.getBigUint64(o)) : v.getUint32(o), from = long ? Number(v.getBigInt64(o + 8)) : v.getInt32(o + 4);
          if (from >= 0) { start = from; break; }
          if (movie) wait += lasts / movie;
        }
      }
      const times = Float64Array.from(at, (x) => (x - start) / scale + wait).sort();
      const first = times.findIndex((x) => x > -1e-9); // (a frame from before the start is never shown)
      return first < 0 ? null : times.subarray(first);
    }
  } catch {} // (a file cut short, or not laid out as expected)
  return null;
}

// The bar for `video`, whose frames are shown at `times` (frameTimes).
export function frameBar(video, times) {
  const n = times.length;
  // The frame shown at time t: the last one that has started by then.
  const frameAt = (t) => {
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t + 1e-4) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const bar = h('div', 'res-frames');
  const back = chevronButton('Previous frame', true, () => go(cur - 1)), on = chevronButton('Next frame', false, () => go(cur + 1));
  const num = h('input', 'res-frame');
  num.inputMode = 'numeric';
  num.autocomplete = 'off';
  num.spellcheck = false;
  num.title = 'Frame (the first is 0): type a number to go to it';
  num.setAttribute('aria-label', 'Frame');
  num.style.width = `${String(n - 1).length + 3}ch`;
  bar.append(back, num, h('span', 'res-frame-of', `/ ${n - 1}`), on);

  let cur = 0, typing = false;
  const show = (i) => {
    cur = i;
    if (!typing) num.value = String(i);
    back.disabled = i <= 0;
    on.disabled = i >= n - 1;
  };
  // To a frame: paused, at the middle of its time (at its very start, rounding could show the one before).
  function go(i) {
    i = Math.max(0, Math.min(n - 1, i));
    const end = i + 1 < n ? times[i + 1] : times[i] + (n > 1 ? times[i] - times[i - 1] : 1 / 30);
    video.pause();
    video.currentTime = (times[i] + end) / 2;
    typing = false;
    show(i);
  }
  num.oninput = () => { typing = true; };
  num.onchange = () => { const i = parseInt(num.value, 10); go(Number.isFinite(i) ? i : cur); };
  num.onblur = () => { typing = false; show(cur); };

  // While it plays, or is moved by its own controls: the number follows the frame on screen. (Not in the
  // middle of a seek: several steps in a row would be counted from a frame on the way.)
  const follow = (t) => { if (!video.seeking) show(frameAt(t)); };
  if (video.requestVideoFrameCallback) {
    const each = (now, meta) => { follow(meta.mediaTime); if (bar.isConnected) video.requestVideoFrameCallback(each); };
    video.requestVideoFrameCallback(each);
  } else video.addEventListener('timeupdate', () => follow(video.currentTime));
  video.addEventListener('seeked', () => follow(video.currentTime));
  show(frameAt(video.currentTime));
  return bar;
}
