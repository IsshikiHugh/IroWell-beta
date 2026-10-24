#!/usr/bin/env node
// Tells the IroWell UI which git worktree this session mainly works in: the page shows it, with its
// branch, beside the session's title. It talks to the IroWell daemon of this host (the one that runs the
// session), which keeps it and reads the branch from git.
import path from 'node:path';
import { ask, fail, exit } from '../daemon.mjs';

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

// It belongs to the Claude session this runs in (Claude Code names it to what it starts).
const session = process.env.CLAUDE_CODE_SESSION_ID;
if (!session) fail('No Claude session here (CLAUDE_CODE_SESSION_ID is not set): run this from the session it is about.');
await ask([{ type: 'workplaceCli', session, ...cmd }], {
  unreachable: (why) => `Cannot reach the IroWell daemon of this host (${why}): this session was not started from the IroWell UI, so there is nowhere to show it.`,
  onReply: (m) => { if (m.error != null) fail(m.error); process.stdout.write(m.data.text + '\n'); },
});
exit();
