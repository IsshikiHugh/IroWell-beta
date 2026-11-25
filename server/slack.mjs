// ---- Slack for away mode: a DM between the user and a Slack app of their own, over Socket Mode ----
// The user makes the app in their workspace (from SLACK_MANIFEST) and gives this daemon two tokens: the
// app-level one (xapp-…, connections:write), with which it opens a WebSocket to Slack (outbound: no port is
// opened on this host, so a server behind a firewall works), and the bot's (xoxb-…), for the Web API calls.
// Whoever else writes to the app is not listened to: away.mjs checks each message's and click's user.
import fs from 'node:fs';
import WebSocket from 'ws';

export const SLACK_MANIFEST = `display_information:
  name: IroWell
  description: Your IroWell sessions while you are away
features:
  bot_user:
    display_name: IroWell
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - files:write
      - im:history
      - im:write
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`;

// Errors after which trying again is no use until the tokens change.
const FATAL = /invalid_auth|not_authed|account_inactive|token_revoked|token_expired|missing_scope|not_allowed_token_type|invalid_token/;

// `onMessage(event)`: a message event (message.im); `onAction(payload)`: a click (block_actions); `onState()`: the
// connection came up or went down. (`api`: the Web API's address; the tests' own Slack.)
// `paused()`: true while this daemon must not take Slack's messages (it is retiring: an update): what comes is left
// unacknowledged, and the connection closes, so that Slack sends it again to the connection that is left (the new daemon's).
export function createSlack({ appToken, botToken, log, onMessage, onAction, onState = () => {}, paused = () => false, api = 'https://slack.com/api/' }) {
  let ws = null, stopped = false, tries = 0, timer = null;
  const status = { connected: false, error: '' };
  const set = (x) => { const was = status.connected; Object.assign(status, x); if (was !== status.connected || x.error) onState(); };
  // A Web API call (JSON, or a form: some file methods take no JSON); throws Slack's error. One rate-limited call
  // waits as long as Slack says, once.
  async function web(method, body = {}, token = botToken, again = true, form = false) {
    const r = await fetch(api + method, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
      body: form ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])) : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429 && again) {
      await new Promise((ok) => setTimeout(ok, Math.min(60, Number(r.headers.get('retry-after')) || 1) * 1000));
      return web(method, body, token, false, form);
    }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(`Slack ${method}: ${j.error || 'failed'}`);
    return j;
  }
  async function connect() {
    if (stopped || ws || paused()) return;
    let url;
    try { ({ url } = await web('apps.connections.open', {}, appToken)); } catch (e) {
      set({ connected: false, error: e.message });
      if (!FATAL.test(e.message)) again(); // (the tokens are wrong: no use until they change)
      return;
    }
    if (stopped) return;
    const sock = ws = new WebSocket(url);
    // Alive? A connection whose other end went away (a laptop that slept, a network that dropped) can stay open here and
    // never hear a thing: every frame from Slack counts, a ping of ours every 30 s draws a pong, and with nothing heard for
    // 90 s it is closed, and a new one opens.
    let heard = Date.now();
    const alive = () => { heard = Date.now(); };
    const watch = setInterval(() => {
      if (Date.now() - heard > 90_000) { log('slack: nothing heard for 90 s: connecting again'); sock.terminate(); return; }
      try { sock.ping(); } catch {}
    }, 30_000);
    watch.unref?.();
    sock.on('ping', alive);
    sock.on('pong', alive);
    sock.on('message', (data) => {
      alive();
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (paused() && m.envelope_id) { sock.close(); return; } // (not acknowledged: Slack sends it again, to the new daemon)
      if (m.envelope_id) sock.send(JSON.stringify({ envelope_id: m.envelope_id })); // (acknowledged at once: Slack retries after 3 s)
      try {
        if (m.type === 'hello') { tries = 0; set({ connected: true, error: '' }); }
        else if (m.type === 'disconnect') sock.close(); // (Slack refreshes connections every few hours: a new one opens)
        else if (m.type === 'events_api' && m.payload?.event?.type === 'message') onMessage(m.payload.event);
        else if (m.type === 'interactive' && m.payload?.type === 'block_actions') onAction(m.payload);
      } catch (e) { log('slack', e); }
    });
    sock.on('close', () => {
      clearInterval(watch);
      if (ws !== sock) return;
      ws = null;
      set({ connected: false });
      again();
    });
    sock.on('error', (e) => log('slack socket', e.message));
  }
  function again() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, Math.min(60_000, 1000 * 2 ** tries++));
    timer.unref?.();
  }
  // A file from this host into `channel` (in the thread `thread_ts`), with `comment` above it: Slack's three steps
  // (an upload address, the bytes sent there, the file shared). Needs the files:write scope.
  async function upload({ channel, thread_ts, file, name, size, comment }) {
    const u = await web('files.getUploadURLExternal', { filename: name, length: size }, botToken, true, true);
    // (read from disk as it is sent where Node can: a video can be large)
    const body = fs.openAsBlob ? await fs.openAsBlob(file) : new Blob([await fs.promises.readFile(file)]);
    const r = await fetch(u.upload_url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body,
      signal: AbortSignal.timeout(Math.max(120_000, size / 20)) }); // (20 kB/s at the slowest)
    if (!r.ok) throw new Error(`Slack upload: HTTP ${r.status}`);
    return web('files.completeUploadExternal', { files: JSON.stringify([{ id: u.file_id, title: name }]), channel_id: channel,
      ...(thread_ts ? { thread_ts } : {}), ...(comment ? { initial_comment: comment } : {}) }, botToken, true, true);
  }
  return {
    status,
    web,
    upload,
    start() { stopped = false; connect(); },
    stop() {
      stopped = true;
      clearTimeout(timer);
      const sock = ws;
      ws = null;
      try { sock?.close(); } catch {}
      set({ connected: false });
    },
  };
}

// Text for Slack's mrkdwn: its three special characters escaped, and, escaped, no longer than `n` (an escape is never cut).
export const slackText = (t, n = 2900) => {
  t = String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (t.length <= n) return t;
  t = t.slice(0, Math.max(0, n - 1));
  return t.replace(/&[a-z]{0,3}$/, '') + '…';
};

// A long text in parts Slack takes (a section holds 3000 characters; `n` leaves room for what is added round it): cut
// between paragraphs, a code block kept whole while it fits; one longer is cut between lines, each part closing its
// ``` and the next opening it again.
export function chunks(text, n = 2900) {
  const paras = [];
  for (const p of String(text).split('\n\n')) {
    const last = paras.length - 1;
    if (last >= 0 && (paras[last].match(/```/g) || []).length % 2) paras[last] += '\n\n' + p; else paras.push(p);
  }
  const room = n - 8; // (for a ``` closed and opened again)
  const out = [''];
  const add = (p, sep) => {
    if (out.at(-1) && out.at(-1).length + sep.length + p.length > room) out.push('');
    out[out.length - 1] += (out.at(-1) ? sep : '') + p;
  };
  for (const p of paras) {
    if (p.length <= room) { add(p, '\n\n'); continue; }
    add('', '\n\n');
    for (const l of p.split('\n')) for (let i = 0; i < Math.max(1, l.length); i += room) add(l.slice(i, i + room), '\n');
  }
  let open = false;
  return out.map((x) => x.trim()).filter(Boolean).map((x) => {
    if (open) x = '```\n' + x;
    open = (x.match(/```/g) || []).length % 2 === 1;
    return open ? x + '\n```' : x;
  });
}

// A message's blocks: `text` in sections (one is at most 3000 characters: a longer text goes in several, cut as `chunks`
// cuts it, rather than Slack refusing the message; 100 are left for a name put before it), then `buttons`, if any. And
// its `text`, for notifications.
export function message(text, buttons) {
  text = String(text ?? '');
  const parts = text.length <= 2900 ? [text] : chunks(text, 2900).slice(0, 45);
  return { text: text.length > 3000 ? text.slice(0, 2990) + '…' : text,
    blocks: [...parts.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })), ...(buttons?.length ? [{ type: 'actions', elements: buttons }] : [])] };
}
