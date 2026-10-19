#!/usr/bin/env node
// Asks the IroWell client on the user's computer to forward ports of this machine, and prints where each is
// there. It talks to the IroWell daemon of this host (the one that runs the session), which asks the
// clients connected to it.
//   node port.mjs <port>[:<local port>] ...
// <port> is the port on this machine; <local port> the one on the user's computer, when it matters which
// (left out: the same number if it is free there, else a free one).
import { ask, exit } from '../daemon.mjs';

const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const asks = process.argv.slice(2).map((a) => {
  const m = /^(\d+)(?::(\d+))?$/.exec(a);
  return m && { port: Number(m[1]), local: m[2] ? Number(m[2]) : null };
});
if (!asks.length || asks.some((a) => !a || !isPort(a.port) || (a.local != null && !isPort(a.local)))) {
  console.error('usage: node port.mjs <port>[:<local port>] ...   (<port>: on this machine; <local port>: on the user\'s computer; 1-65535)');
  process.exit(2);
}
// Why the port on the user's computer is another number than the one here.
const WHY = {
  taken: (port) => `${port} is taken on the user's computer`,
  low: () => 'a port below 1024 cannot be listened on there',
  chosen: () => 'the local port chosen for it',
  config: () => 'set in the user\'s ~/.ssh/config',
};
let failed = false;
await ask(asks.map((a) => ({ type: 'portRequest', ...a })), {
  ms: 50000,
  unreachable: (why) => `Cannot reach the IroWell daemon of this host (${why}): this session was not started from the IroWell UI, so there is no client to forward a port.`,
  onReply: (m, { port }) => {
    if (m.error != null) { failed = true; console.log(`${port}: ${m.error}`); }
    else if (m.data.here) console.log(`${port} -> http://localhost:${port}/   (the user is on this machine: nothing to forward)`);
    else if (m.data.local === port) console.log(`${port} -> http://localhost:${port}/`);
    else console.log(`${port} -> http://localhost:${m.data.local}/   (port ${port} here is local port ${m.data.local} for the user${WHY[m.data.why] ? ': ' + WHY[m.data.why](port) : ''})`);
  },
});
exit(failed ? 1 : 0);
