// The widgets: small tiles above the Usage card, one for each plugin of this checkout (plugins/<name>/,
// listed by the local client: client/main.mjs, "plugins"). Up to four share a row; a tile shows a little
// live information, and a click opens the plugin's own page in a dialog.
//
// A plugin's ui.js is a module whose default export draws them:
//
//   export default {
//     tile(el) { …; return stop },  // draws into the tile (el); returns what stops it, if anything
//     open(el) { …; return stop },  // optional: draws the dialog's page into el; `stop` runs when it closes
//   };
//
// The tile and the dialog's body have the class plugin-<name>, for the plugin's ui.css (loaded when there is
// one) to style them with the page's own colours (var(--fg), var(--muted), …). Its plugin.json gives the
// title the tile's tooltip and the dialog show.
import { h } from './render.js';

const MAX_COLS = 4;

// `post`: a command to the local client. `openModal(title)`: a dialog, as its body. `onClose(fn)`: what
// closing that dialog also does. `reload()` draws them again: after the tab went to another server, or the
// Plugins page changed where they show.
export function createWidgets({ post, openModal, onClose }) {
  const box = document.getElementById('widgets');
  let stops = []; // what stops each tile drawn now
  let round = 0;
  async function reload() {
    const me = ++round;
    const r = await post('plugins');
    if (me !== round) return; // (a newer reload is under way)
    for (const stop of stops.splice(0)) try { stop(); } catch {}
    if (!Array.isArray(r.data)) { // (a client started before plugins existed answers 400: no widgets)
      if (r.error) console.warn('plugins:', r.error);
      box.replaceChildren();
      box.hidden = true;
      return;
    }
    const tiles = r.data.map((p) => {
      const tile = h('div', `widget plugin-${p.name}`);
      tile.title = p.title || p.name;
      return { p, tile };
    });
    box.style.setProperty('--cols', String(Math.min(tiles.length, MAX_COLS)));
    box.replaceChildren(...tiles.map((t) => t.tile));
    box.hidden = !tiles.length;
    await Promise.all(tiles.map(async ({ p, tile }) => {
      const stop = await mount(p, tile, { openModal, onClose });
      if (typeof stop !== 'function') return;
      if (me === round) stops.push(stop); else stop(); // (drawn again meanwhile)
    }));
  }
  reload();
  return { reload };
}

// A tile that could not be drawn says why in its tooltip.
function broken(tile, p, why) {
  tile.classList.add('bad');
  tile.textContent = '!';
  tile.title = `${p.title || p.name}: ${why}`;
  console.warn(`plugin ${p.name}:`, why);
}

async function mount(p, slot, { openModal, onClose }) {
  if (p.error) return broken(slot, p, p.error);
  const css = `/plugins/${p.name}/ui.css`;
  if (p.css && !document.querySelector(`link[href="${css}"]`)) document.head.append(Object.assign(h('link'), { rel: 'stylesheet', href: css }));
  let ui;
  try {
    ui = (await import(`/plugins/${p.name}/ui.js`)).default;
    if (typeof ui?.tile !== 'function') throw new Error('ui.js has no default export with tile(el)');
  } catch (e) { return broken(slot, p, e.message); }
  // A tile that opens a page is a button.
  const opens = typeof ui.open === 'function';
  const tile = opens ? h('button', slot.className) : slot;
  if (opens) { tile.type = 'button'; tile.title = slot.title; slot.replaceWith(tile); }
  let stop;
  try { stop = ui.tile(tile); } catch (e) { return broken(tile, p, e.message); }
  if (!opens) return stop;
  tile.onclick = () => {
    const body = openModal(p.title || p.name);
    body.classList.add('widget-page', `plugin-${p.name}`);
    tile.classList.add('on');
    let stopPage;
    try { stopPage = ui.open(body); } catch (e) { body.textContent = `This plugin's page failed: ${e.message}`; }
    onClose(() => { tile.classList.remove('on'); if (typeof stopPage === 'function') stopPage(); });
  };
  return stop;
}
