// A session on one server reads a session on another, through the client (skills/session-context/peers.mjs →
// this daemon → the client → the other server's daemon, whose reader reads the transcript there and reports).
// No model calls: the fake Claude plays the reader (peers.fake.mjs); the other server is a fake ssh host.
import { REPO, PORT, check, until, finish, startClient, eventStream, fakeHost, killDaemon, outDir, cleanEnv } from '../lib.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

// peerbox keeps its transcripts apart from this machine's: one session there, about ZEBRA.
const PEER_CC = path.join(outDir(), 'peerbox-claude');
fs.rmSync(PEER_CC, { recursive: true, force: true });
fs.mkdirSync(path.join(PEER_CC, 'projects', '-x-proj'), { recursive: true });
const SID = '4f1e9a2b-7c3d-4e8f-9a1b-2c3d4e5f6a7b';
fs.writeFileSync(path.join(PEER_CC, 'projects', '-x-proj', `${SID}.jsonl`), [
  { type: 'user', message: { role: 'user', content: 'Train the ZEBRA model' }, cwd: '/x/proj', timestamp: new Date(Date.now() - 600e3).toISOString(), sessionId: SID, entrypoint: 'cli', uuid: 'u1' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Final loss 0.0421' }] }, timestamp: new Date().toISOString(), uuid: 'a1', parentUuid: 'u1' },
].map((e) => JSON.stringify(e)).join('\n') + '\n');
const { dir: RDIR, env } = fakeHost('peerbox', { shellEnv: { CLAUDE_CONFIG_DIR: PEER_CC }, extra: { IRO_NO_USAGE_RECORD: '1' } });
const TOUCH = path.join(outDir(), 'peers-touched');
fs.rmSync(TOUCH, { force: true });

// The skill's script, run on this machine as a session's Bash would (the brief on stdin).
const script = (args, input = '') => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(REPO, 'skills', 'session-context', 'peers.mjs'), ...args], { env: cleanEnv() });
  let out = '';
  p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
  p.stdin.end(input);
});

const { client, token } = await startClient(PORT, { env });
try {
  const st = eventStream(PORT, token);
  await until(() => st.up, 30000, 'this machine is connected');
  // ---- before the client is connected to peerbox ----
  const before = await script(['ask', 'peerbox'], 'Target: the ZEBRA session\n');
  check(before.code === 1 && /not connected to "peerbox"/.test(before.out), `a server the client is not connected to is named as such (${before.out.trim()})`);

  // a tab on peerbox connects the client to it
  let up = false;
  const peer = http.get({ host: '127.0.0.1', port: PORT, path: `/events?t=${token}&target=ssh:peerbox` }, (r) => r.on('data', (d) => { if (/"type":"transport","up":true/.test(String(d))) up = true; }));
  peer.on('error', () => {});
  await until(() => up, 30000, 'peerbox is connected');

  const list = await script([]);
  check(list.code === 0 && /^local +this server +\(the user's computer: /m.test(list.out) && /^peerbox +connected$/m.test(list.out), `the script lists the servers the client is connected to (${list.out.trim().replace(/\n/g, ' | ')})`);

  // ---- a session here asks for the ZEBRA session on peerbox ----
  const t0 = Date.now();
  const r = await script(['ask', 'peerbox'], `Target: the ZEBRA session\nWhat to fetch: its final loss\nTouch: ${TOUCH}\n`);
  const out = r.out;
  check(r.code === 0 && out.startsWith(`Report from the reader on peerbox (${os.hostname()}):`), `the reader's report comes back (${Date.now() - t0} ms; ${out.slice(0, 200)})`);
  check(out.includes(`REPORT for a session on ${os.hostname()} (the user's computer)`), 'the reader is told which server asks');
  check(/list: #1 +USER: Train the ZEBRA model\n#1 +ASSISTANT: Final loss 0\.0421/.test(out), `it read peerbox's transcript with the reader, a quoted | and all (${/list: .*/.exec(out)?.[0]})`);
  check(/redirect: Only the transcript reader runs here/.test(out) && /touch: Only the transcript reader runs here/.test(out) && !fs.existsSync(TOUCH),
    'it may not redirect the reader\'s output, nor run anything else: nothing was written');

  // ---- what cannot be asked ----
  const self = await script(['ask', 'local'], 'Target: x\n');
  check(self.code === 1 && /is the server this session runs on/.test(self.out), `this server itself is read here, not through the client (${self.out.trim()})`);
  const none = await script(['ask', 'nosuch'], 'Target: x\n');
  check(none.code === 1 && /not connected to "nosuch" \(its other servers: peerbox\)/.test(none.out), `an unknown server is refused, with the ones there are (${none.out.trim()})`);
  const empty = await script(['ask', 'peerbox'], '  \n');
  check(empty.code === 1 && /brief is empty/.test(empty.out), `an empty brief is refused (${empty.out.trim()})`);

  // ---- no client: the script says so ----
  peer.destroy();
  st.req.destroy();
  client.kill();
  await until(async () => /No IroWell client/.test((await script(['ask', 'peerbox'], 'Target: x\n')).out), 15000, 'with no client connected the script says the other servers are out of reach');
} finally {
  client.kill();
  killDaemon(RDIR);
}
finish();
