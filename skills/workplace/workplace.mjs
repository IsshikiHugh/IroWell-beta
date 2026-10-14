#!/usr/bin/env node
// Tells the IroWell UI which git worktree this session mainly works in: the page shows it, with its
// branch, beside the session's title. It talks to the IroWell daemon of this host (the one that runs the
// session), which keeps it and reads the branch from git.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const USAGE = `usage: node workplace.mjs [command]
  (none)        what the title shows now
  set <dir>     this session now mainly works in the git worktree <dir> is in
  reset         back to the folder this session started in`;
const usage = (why) => { console.error(`${why}\n${USAGE}`); process.exit(2); };
const [verb = 'show', ...args] = process.argv.slice(2);
let cmd;
if (verb === 'show' || verb === 'reset') cmd = { op: verb };
else if (verb === 'set') {
  if (args.length !== 1) usage('set: which directory?');
  cmd = { op: 'set', dir: path.resolve(args[0]) };
} else if (['-h', '--help', 'help'].includes(verb)) { console.log(USAGE); process.exit(0); } else usage(`Unknown command: ${verb}`);

const fail = (text) => { console.error(text); process.exit(1); };
// It belongs to the Claude session this runs in (Claude Code names it to what it starts).
const session = process.env.CLAUDE_CODE_SESSION_ID;
if (!session) fail('No Claude session here (CLAUDE_CODE_SESSION_ID is not set): run this from the session it is about.');
const SOCK = path.join(process.env.IRO_DIR || path.join(os.homedir(), '.iro-coding'), 'daemon.sock');
const sock = net.connect(SOCK);
sock.setEncoding('utf8');
sock.on('error', (e) => fail(`Cannot reach the IroWell daemon of this host (${e.code || e.message}): this session was not started from the IroWell UI, so there is nowhere to show it.`));
setTimeout(() => fail('The IroWell daemon did not answer.'), 20000);

let buf = '';
sock.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    let m;
    try { m = JSON.parse(buf.slice(0, i)); } catch {}
    buf = buf.slice(i + 1);
    if (m?.type === 'hello') sock.write(JSON.stringify({ type: 'workplaceCli', id: 1, session, ...cmd }) + '\n');
    else if (m?.type === 'reply' && m.id === 1) {
      if (m.error != null) fail(m.error);
      console.log(m.data.text);
      process.exit(0);
    }
  }
});
sock.on('close', () => fail('The IroWell daemon closed the connection.'));
