// Bridge stdin/stdout <-> the daemon's Unix socket. Run over ssh by the client;
// starts the daemon (detached, so it outlives the ssh session) if needed. With --no-start (to stop
// the daemon) it exits with status 3 when none runs.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = process.env.IRO_DIR || path.join(os.homedir(), '.iro-coding');
const SOCK = path.join(DIR, 'daemon.sock');
// A host runs the release `current` points to (installed by client/client.mjs); a checkout runs
// the daemon next to this file. The real path, so `ps` shows which release a daemon runs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CURRENT = path.join(HERE, 'current', 'daemon.mjs');
const DAEMON = fs.existsSync(CURRENT) ? fs.realpathSync(CURRENT) : path.join(HERE, 'daemon.mjs');
const NO_START = process.argv.includes('--no-start');
// The daemon needs Node 18 or newer (an older one can't parse it): say so instead of a daemon that never
// comes up. (This file itself parses on old Node.) The client shows this line as the connection error.
if (Number(process.versions.node.split('.')[0]) < 18) {
  process.stderr.write(`IroWell needs Node 18 or newer on this host, but ${process.execPath} is ${process.version}: install a newer one, or pass --remote-node /path/to/node\n`);
  process.exit(1);
}

function startDaemon() {
  fs.mkdirSync(DIR, { recursive: true });
  const out = fs.openSync(path.join(DIR, 'daemon.log'), 'a');
  // detached => setsid(): the daemon survives the ssh hangup.
  spawn(process.execPath, [DAEMON], { detached: true, stdio: ['ignore', out, out], cwd: DIR }).unref();
}

function connect(triesLeft, started) {
  const sock = net.connect(SOCK);
  sock.on('connect', () => {
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
    sock.on('close', () => process.exit(0));
    process.stdin.on('end', () => sock.end());
  });
  sock.on('error', (e) => {
    if (NO_START) process.exit(3);
    if (triesLeft <= 0) {
      process.stderr.write(`attach: cannot reach daemon (${e.code}); see ~/.iro-coding/daemon.log\n`);
      process.exit(1);
    }
    if (!started) startDaemon();
    setTimeout(() => connect(triesLeft - 1, true), 250);
  });
}

connect(40, false);
