// What server/daemon.mjs and client/main.mjs both need and must do alike: the fingerprint that tells
// an outdated server, reading a stream line by line, and the plan-usage math. A release carries it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// The code of server/ a release carries (package*.json: npm rewrites them)
export const CODE_FILES = ['daemon.mjs', 'attach.mjs', 'install.sh', 'shared.mjs', 'away.mjs', 'slack.mjs'];

// What an editor or the OS leaves in a folder (Finder's .DS_Store, vim's swap files, emacs' backups and
// locks, a half-written file): not part of skills/, so a fingerprint doesn't change with it.
const LITTER = /^(\.DS_Store|.*\.sw[po]|.*~|#.*#|\.#.*|.*\.tmp)$/;
export const isLitter = (name) => LITTER.test(name);
// Every regular file under `dir`, as paths relative to it (with /, on Windows too), sorted.
export function filesUnder(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const f = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, f) : e.isFile() && !LITTER.test(e.name) ? [f] : [];
  }).sort();
}

// The fingerprint of a server: `code`, [[name, contents], …] of CODE_FILES in that order, and skills/:
// the files of the folder `skills` as they are now, or [[path, contents], …] sorted by path (null: none).
// 12 hex characters.
export function fingerprint(code, skills) {
  const h = createHash('sha1');
  for (const [name, data] of code) h.update(name + '\0').update(data);
  const list = typeof skills === 'string' ? filesUnder(skills).map((f) => [f, fs.readFileSync(path.join(skills, f))]) : skills || [];
  for (const [f, data] of list) h.update(`skills/${f}\0`).update(data);
  return h.digest('hex').slice(0, 12);
}

// A 'data' listener that calls `fn` with each complete, non-empty line.
// Only the new chunk is searched: a 48 MB message (pasted images) arrives in ~750 chunks, and
// rescanning the whole buffer each time would stall the event loop for seconds.
// `part`: called after each chunk with how much of a line still unfinished has arrived.
export function lines(fn, part) {
  let buf = '';
  return (chunk) => {
    let from = 0, i;
    while ((i = chunk.indexOf('\n', from)) >= 0) {
      const l = (buf + chunk.slice(from, i)).trim();
      buf = '';
      from = i + 1;
      if (l) fn(l);
    }
    buf += chunk.slice(from);
    part?.(buf.length);
  };
}

// ---- plan usage: a reading is { pct, resets } of one limit (the five-hour or the weekly one) ----
// A limit's reading as it may be kept, or null: a level of 0 or more, and a reset that is a date or none.
export const reading = (w) => (w && typeof w.pct === 'number' && w.pct >= 0 && (w.resets == null || !Number.isNaN(Date.parse(w.resets))) ? { pct: w.pct, resets: w.resets ?? null } : null);
// An older reading: from an earlier window, or lower within the same one (the level only rises).
export function olderReading(cur, prev) {
  if (cur?.pct == null || prev?.pct == null || !cur.resets || !prev.resets) return false;
  const d = new Date(cur.resets) - new Date(prev.resets);
  return d < -2 * 60 * 1000 || (Math.abs(d) < 2 * 60 * 1000 && cur.pct < prev.pct);
}
// Estimate for the rest of the weekly cycle, from `samples` ({ t, five, week }, oldest first): the line
// through the level now and the level 24 hours before (read between the two samples around that moment;
// the window's first sample when the window is younger than that), carried on to its reset. The UI draws
// it dashed, and backwards as well.
export function weekForecast(samples) {
  const xs = samples.filter((x) => x.week?.pct != null && x.week.resets);
  const last = xs[xs.length - 1];
  if (!last) return { week: null };
  const resets = new Date(last.week.resets).getTime();
  const win = xs.filter((x) => Math.abs(new Date(x.week.resets) - resets) < 2 * 60e3);
  const ago = last.t - 24 * 3600e3;
  const after = win.findIndex((x) => x.t > ago);
  const before = after > 0 ? win[after - 1] : null;
  const from = before ? { t: ago, pct: before.week.pct + ((win[after].week.pct - before.week.pct) * (ago - before.t)) / (win[after].t - before.t) } : { t: win[0].t, pct: win[0].week.pct };
  const slope = last.t - from.t >= 3600e3 ? Math.max(0, (last.week.pct - from.pct) / (last.t - from.t)) : 0; // percent per millisecond
  const pct = last.week.pct;
  const hitAt = pct >= 100 ? last.t : slope > 0 ? Math.round(last.t + (100 - pct) / slope) : null;
  const atReset = Math.min(100, pct + slope * Math.max(0, resets - last.t));
  return { week: { t: last.t, pct, resets: last.week.resets, slopePerHour: slope * 3600e3, hitAt: hitAt && hitAt <= resets ? hitAt : null, atReset } };
}
