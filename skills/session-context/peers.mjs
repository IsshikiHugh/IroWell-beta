#!/usr/bin/env node
// Context from a session on another of the user's servers, through the IroWell client on the user's computer:
// it talks to the IroWell daemon of this host, which asks the client, which asks the daemon of that server to
// start a reader there (a Claude that reads the transcript and changes nothing). Its report is printed.
//   node peers.mjs                    the servers the user's client is connected to
//   node peers.mjs ask <server>       the brief on stdin; prints the report of the reader on <server>
import { ask, exit, fail } from '../daemon.mjs';

const [op = 'list', server, ...rest] = process.argv.slice(2);
if (!['list', 'ask'].includes(op) || (op === 'ask' && (!server || rest.length)) || (op === 'list' && server)) {
  console.error('usage: node peers.mjs                 (the servers the user\'s IroWell client is connected to)\n       node peers.mjs ask <server>    (the brief on stdin)');
  process.exit(2);
}
let brief = '';
if (op === 'ask') {
  if (process.stdin.isTTY) fail('Give the brief on stdin, e.g. node peers.mjs ask <server> <<\'EOF\' … EOF');
  for await (const d of process.stdin) brief += d;
  if (!brief.trim()) fail('The brief is empty: say which session, and what to bring back from it.');
}
let failed = false;
await ask([{ type: 'peersCli', op, server, brief }], {
  ms: op === 'ask' ? 11 * 60e3 : 30e3,
  unreachable: (why) => `Cannot reach the IroWell daemon of this host (${why}): this session was not started from the IroWell UI, so the user's other servers are not reachable this way.`,
  onReply: (m) => {
    if (m.error != null) {
      failed = true;
      console.log(/doesn't know "peersCli"/.test(m.error) ? 'This server runs an older IroWell: the user updates it (Reconnect to update) first.' : m.error);
    } else if (op === 'list') {
      const rows = m.data.servers.map((s) => [s.name, s.self ? 'this server' : s.up ? 'connected' : 'not connected right now', s.host ? `(the user's computer: ${s.host})` : '']);
      const w = Math.max(...rows.map((r) => r[0].length));
      for (const r of rows) console.log(`${r[0].padEnd(w)}  ${r[1]}${r[2] ? '  ' + r[2] : ''}`.trimEnd());
    } else console.log(`Report from the reader on ${server} (${m.data.host}):\n\n${m.data.report.trim()}`);
  },
});
exit(failed ? 1 : 0);
