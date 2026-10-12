#!/usr/bin/env node
// Reads and changes this session's progress list, which the IroWell UI shows to the user (who edits it
// too). It talks to the IroWell daemon of this host (the one that runs the session), which keeps the list
// and tells the pages. After every command it prints the list as it is now, with what the user changed
// since this session last read it.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const USAGE = `usage: node progress.mjs [command]
  (none)                                        the list, and what the user changed since you last read it
  add [--after <id> | --top] <text> [<text>…]   new items, each todo (at the end unless told where); starts the list
  doing <id>…  |  done <id>…  |  todo <id>…     mark items
  edit <id> <text>                              reword an item
  move <id> (--after <id> | --top)              put an item somewhere else
  remove <id>…                                  take items off the list
  log                                           every change so far, yours and the user's`;
const usage = (why) => { console.error(`${why}\n${USAGE}`); process.exit(2); };
const idOf = (a) => (/^\d+$/.test(a ?? '') ? Number(a) : usage(`Not an item id: ${a ?? '(nothing)'}`));

// `--after <id>` / `--top` anywhere among the arguments: where an item goes.
function place(args) {
  let after = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top') after = 0;
    else if (args[i] === '--after') after = idOf(args[++i]);
    else rest.push(args[i]);
  }
  return { after, rest };
}
const [verb = 'show', ...args] = process.argv.slice(2);
let cmd;
if (verb === 'show' || verb === 'log') cmd = { op: verb };
else if (verb === 'add') {
  const { after, rest } = place(args);
  if (!rest.length) usage('add: what is the item?');
  cmd = { op: 'add', texts: rest, ...(after == null ? {} : { after }) };
} else if (verb === 'doing' || verb === 'done' || verb === 'todo') {
  if (!args.length) usage(`${verb}: which item?`);
  cmd = { op: 'state', state: verb, ids: args.map(idOf) };
} else if (verb === 'edit') {
  if (args.length < 2) usage('edit: an id and the new text');
  cmd = { op: 'edit', item: idOf(args[0]), text: args.slice(1).join(' ') };
} else if (verb === 'move') {
  const { after, rest } = place(args);
  if (rest.length !== 1 || after == null) usage('move: an id, and --after <id> or --top');
  cmd = { op: 'move', item: idOf(rest[0]), after };
} else if (verb === 'remove') {
  if (!args.length) usage('remove: which item?');
  cmd = { op: 'remove', ids: args.map(idOf) };
} else if (['-h', '--help', 'help'].includes(verb)) { console.log(USAGE); process.exit(0); } else usage(`Unknown command: ${verb}`);

const fail = (text) => { console.error(text); process.exit(1); };
// The list belongs to the Claude session this runs in (Claude Code names it to what it starts).
const session = process.env.CLAUDE_CODE_SESSION_ID;
if (!session) fail('No Claude session here (CLAUDE_CODE_SESSION_ID is not set): run this from the session whose list it is.');
const SOCK = path.join(process.env.IRO_DIR || path.join(os.homedir(), '.iro-coding'), 'daemon.sock');
const sock = net.connect(SOCK);
sock.setEncoding('utf8');
sock.on('error', (e) => fail(`Cannot reach the IroWell daemon of this host (${e.code || e.message}): this session was not started from the IroWell UI, so there is nowhere to show a progress list.`));
setTimeout(() => fail('The IroWell daemon did not answer.'), 20000);

let buf = '';
sock.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0;) {
    let m;
    try { m = JSON.parse(buf.slice(0, i)); } catch {}
    buf = buf.slice(i + 1);
    if (m?.type === 'hello') sock.write(JSON.stringify({ type: 'progressCli', id: 1, session, ...cmd }) + '\n');
    else if (m?.type === 'reply' && m.id === 1) {
      if (m.error != null) fail(m.error);
      console.log(m.data.text);
      process.exit(0);
    }
  }
});
sock.on('close', () => fail('The IroWell daemon closed the connection.'));
