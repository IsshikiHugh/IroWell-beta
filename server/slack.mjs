// ---- Slack for away mode: a DM between the user and a Slack app of their own, over Socket Mode ----
// The user makes the app in their workspace (from SLACK_MANIFEST) and gives this daemon two tokens: the
// app-level one (xapp-…, connections:write), with which it opens a WebSocket to Slack (outbound: no port is
// opened on this host, so a server behind a firewall works), and the bot's (xoxb-…), for the Web API calls.
// Whoever else writes to the app is not listened to: away.mjs checks each message's and click's user.
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
      - im:history
      - im:write
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
export function createSlack({ appToken, botToken, log, onMessage, onAction, onState = () => {}, api = 'https://slack.com/api/' }) {
  let ws = null, stopped = false, tries = 0, timer = null;
  const status = { connected: false, error: '' };
  const set = (x) => { const was = status.connected; Object.assign(status, x); if (was !== status.connected || x.error) onState(); };
  // A Web API call (JSON); throws Slack's error. One rate-limited call waits as long as Slack says, once.
  async function web(method, body = {}, token = botToken, again = true) {
    const r = await fetch(api + method, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429 && again) {
      await new Promise((ok) => setTimeout(ok, Math.min(60, Number(r.headers.get('retry-after')) || 1) * 1000));
      return web(method, body, token, false);
    }
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!j.ok) throw new Error(`Slack ${method}: ${j.error || 'failed'}`);
    return j;
  }
  async function connect() {
    if (stopped || ws) return;
    let url;
    try { ({ url } = await web('apps.connections.open', {}, appToken)); } catch (e) {
      set({ connected: false, error: e.message });
      if (!FATAL.test(e.message)) again(); // (the tokens are wrong: no use until they change)
      return;
    }
    if (stopped) return;
    const sock = ws = new WebSocket(url);
    sock.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.envelope_id) sock.send(JSON.stringify({ envelope_id: m.envelope_id })); // (acknowledged at once: Slack retries after 3 s)
      try {
        if (m.type === 'hello') { tries = 0; set({ connected: true, error: '' }); }
        else if (m.type === 'disconnect') sock.close(); // (Slack refreshes connections every few hours: a new one opens)
        else if (m.type === 'events_api' && m.payload?.event?.type === 'message') onMessage(m.payload.event);
        else if (m.type === 'interactive' && m.payload?.type === 'block_actions') onAction(m.payload);
      } catch (e) { log('slack', e); }
    });
    sock.on('close', () => {
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
  return {
    status,
    web,
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

// Text for Slack's mrkdwn: its three special characters escaped, and no longer than `n`.
export const slackText = (t, n = 2900) => {
  t = String(t ?? '');
  if (t.length > n) t = t.slice(0, n) + '…';
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};
