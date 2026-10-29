// A stand-in for Slack (the Web API and Socket Mode) for the away-mode tests: it records every call, answers
// as Slack would, and sends frames down the socket as Slack sends events and clicks.
import http from 'node:http';
import { createRequire } from 'node:module';

const { WebSocketServer } = createRequire(import.meta.url)('../server/node_modules/ws');

export async function fakeSlack() {
  const calls = [], acks = new Set(), socks = [], uploads = new Map(); // file id -> the bytes sent to its address
  let ts = 1000, fileNo = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      // (a file's bytes, sent to the address files.getUploadURLExternal gave)
      if (req.url.startsWith('/upload/')) {
        uploads.set(req.url.slice(8), Buffer.concat(chunks));
        res.writeHead(200);
        return res.end('OK');
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const method = req.url.replace(/^\/api\//, '');
      let json = {};
      if (/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) json = Object.fromEntries(new URLSearchParams(body));
      else try { json = JSON.parse(body || '{}'); } catch {}
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const call = { method, body: json, token, at: Date.now() };
      calls.push(call);
      const bad = /bad/.test(token);
      const answer = bad ? { ok: false, error: 'invalid_auth' }
        : method === 'auth.test' ? { ok: true, user_id: 'UBOT0001' }
        : method === 'apps.connections.open' ? { ok: true, url: `ws://127.0.0.1:${server.address().port}/socket` }
        : method === 'conversations.open' ? { ok: true, channel: { id: 'D0DM0001' } }
        : method === 'chat.postMessage' ? { ok: true, channel: json.channel, ts: `${++ts}.0001` }
        : method === 'chat.update' ? { ok: true }
        : method === 'files.getUploadURLExternal' ? (json.filename && Number(json.length) > 0 ? { ok: true, upload_url: `http://127.0.0.1:${server.address().port}/upload/F${++fileNo}`, file_id: `F${fileNo}` } : { ok: false, error: 'invalid_arguments' })
        : method === 'files.completeUploadExternal' ? { ok: true, files: JSON.parse(json.files || '[]') }
        : { ok: false, error: 'unknown_method' };
      call.answer = answer;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  const wss = new WebSocketServer({ server, path: '/socket' });
  wss.on('connection', (ws) => {
    socks.push(ws);
    ws.on('message', (d) => { try { const m = JSON.parse(String(d)); if (m.envelope_id) acks.add(m.envelope_id); } catch {} });
    ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let n = 0;
  const live = () => socks.filter((s) => s.readyState === 1);
  return {
    api: `http://127.0.0.1:${server.address().port}/api/`,
    calls, acks, uploads,
    connected: () => live().length > 0,
    posts: () => calls.filter((c) => c.method === 'chat.postMessage' && c.answer?.ok).map((c) => ({ ...c.body, ts: c.answer.ts })),
    updates: () => calls.filter((c) => c.method === 'chat.update').map((c) => c.body),
    // The files shared: { channel_id, thread_ts, initial_comment, files, bytes }.
    files: () => calls.filter((c) => c.method === 'files.completeUploadExternal' && c.answer?.ok).map((c) => ({ ...c.body, bytes: uploads.get(JSON.parse(c.body.files)[0]?.id) })),
    // A frame as Slack sends it; its envelope id (the daemon must acknowledge it).
    send(type, payload) {
      const envelope_id = `env-${++n}`;
      for (const s of live()) s.send(JSON.stringify({ envelope_id, type, payload, accepts_response_payload: false }));
      return envelope_id;
    },
    message(user, text, thread_ts) { return this.send('events_api', { event: { type: 'message', channel_type: 'im', channel: 'D0DM0001', user, text, ts: `${Date.now() / 1000}`, ...(thread_ts ? { thread_ts } : {}) } }); },
    click(user, action_id, value, message_ts = '1.0') { return this.send('interactive', { type: 'block_actions', user: { id: user }, channel: { id: 'D0DM0001' }, container: { message_ts, channel_id: 'D0DM0001' }, actions: [{ action_id, value: JSON.stringify(value) }] }); },
    drop() { for (const s of live()) s.close(); },
    close() { for (const s of socks) s.terminate(); wss.close(); server.close(); },
  };
}
