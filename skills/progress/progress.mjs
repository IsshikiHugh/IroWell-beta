#!/usr/bin/env node
// Reads and changes this session's progress list, which the IroWell UI shows to the user (who edits it
// too). It talks to the IroWell daemon of this host (the one that runs the session), which keeps the list
// and tells the pages. After every command it prints the list as it is now, with what the user changed
// since this session last read it.
import { ask, fail, exit } from '../daemon.mjs';

const USAGE = `usage: node progress.mjs [command]
  (none)                                        the list, and what the user changed since you last read it
  add [--after <id> | --top] <text> [<text>…]   new items, each todo (at the end unless told where); starts the list
  doing <id>…  |  done <id>…  |  todo <id>…     mark items
  edit <id> <text>                              reword an item
  move <id> (--after <id> | --top)              put an item somewhere else
  remove <id>…                                  take items off the list
  end                                           end the list: the task is over (only once the user said yes)
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
} else if (verb === 'end') {
  if (args.length) usage('end: takes nothing more');
  cmd = { op: 'end' };
} else if (['-h', '--help', 'help'].includes(verb)) { console.log(USAGE); process.exit(0); } else usage(`Unknown command: ${verb}`);

// The list belongs to the Claude session this runs in (Claude Code names it to what it starts).
const session = process.env.CLAUDE_CODE_SESSION_ID;
if (!session) fail('No Claude session here (CLAUDE_CODE_SESSION_ID is not set): run this from the session whose list it is.');
await ask([{ type: 'progressCli', session, ...cmd }], {
  unreachable: (why) => `Cannot reach the IroWell daemon of this host (${why}): this session was not started from the IroWell UI, so there is nowhere to show a progress list.`,
  onReply: (m) => { if (m.error != null) fail(m.error); process.stdout.write(m.data.text + '\n'); },
});
exit();
