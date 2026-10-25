// The clock: a demo of what a plugin's ui.js gives the page (client/ui/widgets.js). The tile shows the
// time; a click opens a dialog with the seconds, the date and the time zone.
const pad = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const div = (cls) => Object.assign(document.createElement('div'), { className: cls });

// Calls fn(now) now and at the start of every second after; returns what stops it.
function eachSecond(fn) {
  let timer;
  const tick = () => { fn(new Date()); timer = setTimeout(tick, 1005 - (Date.now() % 1000)); };
  tick();
  return () => clearTimeout(timer);
}

// UTC+8, UTC−3:30, UTC
function utcOffset(d) {
  const m = -d.getTimezoneOffset();
  if (!m) return 'UTC';
  return `UTC${m > 0 ? '+' : '−'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? `:${pad(Math.abs(m) % 60)}` : ''}`;
}

export default {
  tile(el) {
    return eachSecond((d) => { el.textContent = hm(d); });
  },
  open(el) {
    const time = div('time'), date = div('date'), zone = div('zone');
    el.append(time, date, zone);
    return eachSecond((d) => {
      time.textContent = `${hm(d)}:${pad(d.getSeconds())}`;
      date.textContent = d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      zone.textContent = `${Intl.DateTimeFormat().resolvedOptions().timeZone} · ${utcOffset(d)}`;
    });
  },
};
