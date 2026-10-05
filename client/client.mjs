#!/usr/bin/env node
// Entry point. Local side of IroWell: serves the UI on 127.0.0.1 and talks to each server's daemon.
//
//   node client.mjs                          open the UI; pick the server there (this machine, or a host from ~/.ssh/config)
//   node client.mjs --host devbox            ... connected to that host right away (installs IroWell there the first time)
//   node client.mjs --local                  ... connected to this machine right away (no ssh)
//   node client.mjs --host devbox --stop     stop the server (also: --local --stop, or ⏻ in the UI)
//
// Only the Node version is checked here, in syntax any Node parses: an older Node can't even parse
// main.mjs (Node 12 and 14 stop at `?.` and `||=` with a bare SyntaxError, before any check could run).
// 18 is what the Agent SDK needs, and this Node also runs the daemon on this machine.
var major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error('IroWell needs Node 18 or newer, but this is Node ' + process.version + ' (' + process.execPath + ').\n'
    + 'Install a current Node (https://nodejs.org/, or with nvm, fnm or Homebrew), then run this again.');
  process.exit(1);
}
import('./main.mjs');
